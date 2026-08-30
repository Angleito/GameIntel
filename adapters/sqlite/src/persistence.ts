import { readFile } from "node:fs/promises";
import type { Database, Statement } from "bun:sqlite";
import {
  IngestionLeaseLostError,
  SubmissionRateLimitError,
  defaultPublicSubmissionRateLimits,
  type AnalysisRunInfo,
  type AnalysisVersions,
  type ArticleEvidenceForReview,
  type Clock,
  type CoverMediaCandidate,
  type GameIntelPersistence,
  type IdGenerator,
  type InsertedClaim,
  type InsertedSourceItem,
  type PublicSubmissionForModeration,
  type PublicSubmissionModerationAction,
  type PublicSubmissionPurgeResult,
  type RevisionForAnalysis,
  type SourceContentPurgeResult,
  type SourceInput,
} from "@gameintel/contracts";
import {
  ArticleCoverMediaSchema,
  ArticleSchema,
  assertUniqueMedia,
  calculateConfidence,
  canonicalClaimKey,
  deriveClaimState,
  evidenceReviewGate,
  MediaCatalogSchema,
  mediaCoverScore,
  publicSubmissionFingerprint,
  SourcePolicySchema,
  SourceStrengthSchema,
  toSafeArticle,
  type Article,
  type ArticleBody,
  type ClaimState,
  type Evidence,
  type GameProfile,
  type NormalizedSourceItem,
  type PublicSubmission,
  type SafeArticle,
  type SourcePolicy,
  type SourceStrength,
} from "@gameintel/core";
import { bool, isoAddSeconds, isoNow, isoToMs, json, openSqliteDatabase, parseJson } from "./database.ts";

const sourceStrengthOrder: Record<SourceStrength, number> = {
  UNVERIFIED: 0,
  COMMUNITY: 1,
  TRUSTED_SECONDARY: 2,
  DIRECT_EVIDENCE: 3,
  PRIMARY: 4,
};

function timestamp(value: string | null | undefined): number {
  return isoToMs(value);
}

function parsePolicy(policy: SourcePolicy): SourcePolicy {
  return SourcePolicySchema.parse(policy);
}

type SqliteTransaction = {
  commit(): void;
  rollback(): void;
  run(sql: string, ...params: unknown[]): void;
  get<T>(sql: string, ...params: unknown[]): T | null;
  all<T>(sql: string, ...params: unknown[]): T[];
};

// SQLite reference persistence: a portability proof of the same capability
// contracts as the PostgreSQL reference adapter. Writes are serialized on a
// single connection (BEGIN IMMEDIATE), advisory locks and SKIP LOCKED are
// intentionally absent, and JSON is stored as TEXT.
export class SQLitePersistence implements GameIntelPersistence {
  protected readonly db: Database;
  protected readonly ids: IdGenerator;
  protected readonly clock: Clock;

  constructor(db: Database, ids: IdGenerator, clock: Clock) {
    this.db = db;
    this.ids = ids;
    this.clock = clock;
  }

  static open(path: string, ids: IdGenerator, clock: Clock): SQLitePersistence {
    return new SQLitePersistence(openSqliteDatabase(path), ids, clock);
  }

  get database(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  protected run(sql: string, ...params: Array<string | number | bigint | boolean | null | Uint8Array>): void {
    this.db.query(sql).run(...params as never);
  }

  protected get<T>(sql: string, ...params: Array<string | number | bigint | boolean | null | Uint8Array>): T | null {
    return this.db.query(sql).get(...params as never) as T | null;
  }

  protected all<T>(sql: string, ...params: Array<string | number | bigint | boolean | null | Uint8Array>): T[] {
    return this.db.query(sql).all(...params as never) as T[];
  }

  async transaction<T>(callback: (transaction: GameIntelPersistence) => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    const transaction = new SQLitePersistence(this.db, this.ids, this.clock);
    try {
      const result = await callback(transaction);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // SourceRepository
  // -------------------------------------------------------------------------

  async ensureGame(profile: GameProfile): Promise<void> {
    this.run(
      `INSERT INTO games (id, canonical_name, aliases, profile) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET canonical_name = excluded.canonical_name, aliases = excluded.aliases, profile = excluded.profile`,
      profile.id, profile.canonicalName, json(profile.aliases), json(profile),
    );
  }

  async ensureSource(source: SourceInput): Promise<void> {
    this.run(
      `INSERT INTO sources (id, type, canonical_url, public_citation_url, source_strength, publication_mode, policy, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET type = excluded.type, canonical_url = excluded.canonical_url,
         public_citation_url = excluded.public_citation_url, source_strength = excluded.source_strength,
         publication_mode = excluded.publication_mode, policy = excluded.policy, enabled = excluded.enabled`,
      source.id, source.type, source.canonicalUrl, source.publicCitationUrl, source.sourceStrength,
      source.publicationMode, json(parsePolicy(source.policy)), source.enabled ? 1 : 0,
    );
  }

  private provenanceFamilyForSourceItem(sourceItemId: string, collectionId: string, lineageId: string): string {
    const existing = this.get<{ provenance_family_id: string }>("SELECT provenance_family_id FROM source_item_provenance WHERE source_item_id = ?", sourceItemId);
    if (existing) return existing.provenance_family_id;
    const familyKey = `lineage:${lineageId}`;
    const family = this.get<{ id: string }>(
      "SELECT id FROM provenance_families WHERE collection_id = ? AND family_key = ?",
      collectionId, familyKey,
    );
    const familyId = family?.id ?? this.ids.generate("pf");
    this.run(
      `INSERT INTO provenance_families (id, collection_id, family_key, root_source_item_id)
       VALUES (?, ?, ?, ?) ON CONFLICT (collection_id, family_key) DO UPDATE SET family_key = excluded.family_key`,
      familyId, collectionId, familyKey, sourceItemId,
    );
    this.run(
      `INSERT INTO source_item_provenance (source_item_id, provenance_family_id, relationship, derived_from_source_item_id, clustering_method, reviewer_id, notes, updated_at)
       VALUES (?, ?, 'original', NULL, 'lineage', NULL, '', ?) ON CONFLICT (source_item_id) DO NOTHING`,
      sourceItemId, familyId, isoNow(),
    );
    return familyId;
  }

  async getSourceItemProvenance(sourceItemId: string): Promise<{ provenanceFamilyId: string; relationship: import("@gameintel/core").ProvenanceRelationship; clusteringMethod: import("@gameintel/core").ProvenanceClusteringMethod } | null> {
    const row = this.get<{ provenance_family_id: string; relationship: string; clustering_method: string }>(
      "SELECT provenance_family_id, relationship, clustering_method FROM source_item_provenance WHERE source_item_id = ?",
      sourceItemId,
    );
    return row ? { provenanceFamilyId: row.provenance_family_id, relationship: row.relationship as import("@gameintel/core").ProvenanceRelationship, clusteringMethod: row.clustering_method as import("@gameintel/core").ProvenanceClusteringMethod } : null;
  }

  async insertSourceItem(
    item: NormalizedSourceItem,
    rawHash: string,
    lineageId: string,
    policy: SourcePolicy,
    submittedBy: string | null = null,
  ): Promise<InsertedSourceItem> {
    const now = isoNow();
    const excerpt = policy.retainRawTextDays === 0 ? "" : item.text.slice(0, policy.mayStoreFullText ? 4_000 : 1_000);
    const retentionUntil = Date.now() + policy.retainRawTextDays * 86_400_000;

    const currentRevisionId = (sourceItemId: string): string => {
      const current = this.get<{ id: string }>(
        "SELECT id FROM source_item_revisions WHERE source_item_id = ? AND is_current = 1 ORDER BY created_at DESC, id DESC LIMIT 1",
        sourceItemId,
      );
      if (current) return current.id;
      const first = this.get<{ id: string }>(
        "SELECT id FROM source_item_revisions WHERE source_item_id = ? ORDER BY created_at ASC, id ASC LIMIT 1",
        sourceItemId,
      );
      if (!first) throw new Error(`Source item ${sourceItemId} has no source revisions`);
      return first.id;
    };

    const existingByExternal = this.get<{ id: string; raw_hash: string }>(
      "SELECT id, raw_hash FROM source_items WHERE source_id = ? AND external_id = ?",
      item.sourceId, item.externalId,
    );
    if (existingByExternal && existingByExternal.raw_hash === rawHash) {
      return {
        id: existingByExternal.id,
        revisionId: currentRevisionId(existingByExternal.id),
        provenanceFamilyId: this.provenanceFamilyForSourceItem(existingByExternal.id, item.collectionId, lineageId),
        duplicate: true,
        materialChange: false,
      };
    }
    const existingByHash = this.get<{ id: string }>(
      "SELECT id FROM source_items WHERE source_id = ? AND raw_hash = ? LIMIT 1",
      item.sourceId, rawHash,
    );
    if (existingByHash) {
      return {
        id: existingByHash.id,
        revisionId: currentRevisionId(existingByHash.id),
        provenanceFamilyId: this.provenanceFamilyForSourceItem(existingByHash.id, item.collectionId, lineageId),
        duplicate: true,
        materialChange: false,
      };
    }

    const revisionId = this.ids.generate("srcrev");
    if (existingByExternal) {
      const itemId = existingByExternal.id;
      this.run("UPDATE source_item_revisions SET is_current = 0 WHERE source_item_id = ? AND is_current = 1", itemId);
      this.run(
        `UPDATE source_items SET game_id = ?, url = ?, canonical_url = ?, title = ?, text_excerpt = ?, raw_hash = ?,
          lineage_id = ?, source_strength = ?, publication_mode = ?, discovered_at = ?, published_at = ?,
          input_kind = ?, content_type = ?, language = ?, retention_until = ?, provenance_status = 'normalized',
          content_purged_at = NULL, submitted_by = ? WHERE id = ?`,
        item.collectionId, item.url, item.url.startsWith("urn:") ? null : item.url, item.title, excerpt, rawHash,
        lineageId, item.sourceStrength, item.publicationMode, item.discoveredAt, item.publishedAt,
        item.inputKind, item.contentType, item.language, retentionUntil, submittedBy, itemId,
      );
      this.run(
        `INSERT INTO source_item_revisions (id, source_item_id, raw_hash, excerpt, content_type, http_status, is_current, processing_version, title, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        revisionId, itemId, rawHash, excerpt, item.contentType, item.inputKind === "url" || item.inputKind === "rss" ? 200 : null, item.processingVersion ?? null, item.title, excerpt, now,
      );
      return {
        id: itemId,
        revisionId,
        provenanceFamilyId: this.provenanceFamilyForSourceItem(itemId, item.collectionId, lineageId),
        duplicate: false,
        materialChange: true,
      };
    }

    const itemId = this.ids.generate("src");
    this.run(
      `INSERT INTO source_items (id, source_id, game_id, external_id, url, canonical_url, title, text_excerpt, raw_hash,
        lineage_id, source_strength, publication_mode, discovered_at, published_at, input_kind, content_type, language,
        retention_until, provenance_status, content_purged_at, submitted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'normalized', NULL, ?, ?)`,
      itemId, item.sourceId, item.collectionId, item.externalId, item.url, item.url.startsWith("urn:") ? null : item.url,
      item.title, excerpt, rawHash, lineageId, item.sourceStrength, item.publicationMode, item.discoveredAt,
      item.publishedAt, item.inputKind, item.contentType, item.language, retentionUntil, submittedBy, now,
    );
    this.run(
      `INSERT INTO source_item_revisions (id, source_item_id, raw_hash, excerpt, content_type, http_status, is_current, processing_version, title, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      revisionId, itemId, rawHash, excerpt, item.contentType, item.inputKind === "url" || item.inputKind === "rss" ? 200 : null, item.processingVersion ?? null, item.title, excerpt, now,
    );
    return {
      id: itemId,
      revisionId,
      provenanceFamilyId: this.provenanceFamilyForSourceItem(itemId, item.collectionId, lineageId),
      duplicate: false,
      materialChange: false,
    };
  }

  // -------------------------------------------------------------------------
  // ObservationRepository
  // -------------------------------------------------------------------------

  async createEvent(input: { collectionId: string; sourceItemId: string; newsworthiness: number; disposition: string; existingArticleId?: string | null }): Promise<string> {
    const eventId = this.ids.generate("evt");
    this.run(
      "INSERT INTO events (id, game_id, source_item_id, newsworthiness, disposition, existing_article_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      eventId, input.collectionId, input.sourceItemId, input.newsworthiness, input.disposition, input.existingArticleId ?? null, isoNow(),
    );
    return eventId;
  }

  async linkSourceItemProvenance(input: {
    sourceItemId: string;
    relatedSourceItemId: string;
    relationship: import("@gameintel/core").ProvenanceRelationship;
    clusteringMethod?: import("@gameintel/core").ProvenanceClusteringMethod;
    reviewerId: string;
    notes?: string;
  }): Promise<void> {
    if (!input.reviewerId.trim()) throw new Error("A provenance reviewer is required");
    if (input.sourceItemId === input.relatedSourceItemId) throw new Error("A source item cannot be related to itself");
    const sourceItem = this.get<{ game_id: string; lineage_id: string }>("SELECT game_id, lineage_id FROM source_items WHERE id = ?", input.sourceItemId);
    const relatedItem = this.get<{ game_id: string; lineage_id: string }>("SELECT game_id, lineage_id FROM source_items WHERE id = ?", input.relatedSourceItemId);
    if (!sourceItem || !relatedItem) throw new Error("Both source items must exist");
    if (sourceItem.game_id !== relatedItem.game_id) throw new Error("Provenance relationships cannot cross collections");
    const sourceFamilyId = this.provenanceFamilyForSourceItem(input.sourceItemId, sourceItem.game_id, sourceItem.lineage_id);
    const relatedFamilyId = this.provenanceFamilyForSourceItem(input.relatedSourceItemId, relatedItem.game_id, relatedItem.lineage_id);
    const sharesFamily = ["copied_from", "quoted_from", "derived_from", "same_media", "same_source_family"].includes(input.relationship);
    const provenanceFamilyId = sharesFamily ? relatedFamilyId : sourceFamilyId;
    const notes = input.notes?.slice(0, 2_000) ?? "";
    this.run(
      `INSERT INTO provenance_relationships (id, source_item_id, related_source_item_id, relationship, clustering_method, reviewer_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.ids.generate("provrel"), input.sourceItemId, input.relatedSourceItemId, input.relationship,
      input.clusteringMethod ?? "manual", input.reviewerId, notes, isoNow(),
    );
    this.run(
      `INSERT INTO source_item_provenance (source_item_id, provenance_family_id, relationship, derived_from_source_item_id, clustering_method, reviewer_id, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_item_id) DO UPDATE SET provenance_family_id = excluded.provenance_family_id,
         relationship = excluded.relationship, derived_from_source_item_id = excluded.derived_from_source_item_id,
         clustering_method = excluded.clustering_method, reviewer_id = excluded.reviewer_id,
         notes = excluded.notes, updated_at = excluded.updated_at`,
      input.sourceItemId, provenanceFamilyId, input.relationship, input.relatedSourceItemId,
      input.clusteringMethod ?? "manual", input.reviewerId, notes, isoNow(),
    );
    this.run("UPDATE evidence SET provenance_family_id = ? WHERE source_item_id = ?", provenanceFamilyId, input.sourceItemId);
    const affectedArticles = this.all<{ article_id: string }>(
      `SELECT DISTINCT article_source.article_id FROM article_sources article_source
       JOIN claims claim ON claim.id = article_source.claim_id
       LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
       JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
       JOIN evidence linked_evidence ON linked_evidence.claim_id = member.id
       WHERE linked_evidence.source_item_id = ?`,
      input.sourceItemId,
    );
    for (const article of affectedArticles) await this.refreshArticleConfidence(article.article_id);
    await this.audit(input.reviewerId, `provenance.${input.relationship}`, "source_item", input.sourceItemId, notes || `Related to ${input.relatedSourceItemId}`);
  }

  // -------------------------------------------------------------------------
  // ClaimRepository
  // -------------------------------------------------------------------------

  async insertClaim(
    item: NormalizedSourceItem,
    sourceItemId: string,
    sourceItemRevisionId: string,
    analysisRunId: string,
    provenanceFamilyId: string,
    claim: NormalizedSourceItem["claims"][number],
    lineageId: string,
  ): Promise<InsertedClaim> {
    const claimKey = canonicalClaimKey({ subject: claim.subject, predicate: claim.predicate, value: claim.value, qualifiers: claim.qualifiers });
    const existingClaim = this.get<{ id: string; canonical_claim_id: string | null; qualifiers: string }>(
      "SELECT id, canonical_claim_id, qualifiers FROM claims WHERE source_item_id = ? AND claim_key = ?",
      sourceItemId, claimKey,
    );
    let claimId: string;
    let canonicalClaimId: string;
    if (existingClaim) {
      claimId = existingClaim.id;
      const qualifiers = parseJson<Record<string, string>>(existingClaim.qualifiers);
      canonicalClaimId = existingClaim.canonical_claim_id ?? this.resolveCanonicalClaimForRow(claimId, item.collectionId, claim.subject, claim.predicate, claim.value, qualifiers);
    } else {
      claimId = this.ids.generate("clm");
      this.run(
        `INSERT INTO claims (id, game_id, source_item_id, subject, predicate, value, qualifiers, claim_key, spoiler_tags, exploit_class, evidence_level, attribution_type, statement, editorial_assessment, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unverified', ?)`,
        claimId, item.collectionId, sourceItemId, claim.subject, claim.predicate, claim.value,
        json(claim.qualifiers), claimKey, json(claim.spoilerTags), claim.exploitClass, claim.evidenceLevel,
        claim.attributionType, claim.statement, claim.editorialAssessment, isoNow(),
      );
      canonicalClaimId = this.resolveCanonicalClaimForRow(claimId, item.collectionId, claim.subject, claim.predicate, claim.value, claim.qualifiers);
    }
    const existingEvidence = this.get<{ id: string }>(
      "SELECT id FROM evidence WHERE claim_id = ? AND analysis_run_id = ? LIMIT 1",
      claimId, analysisRunId,
    );
    if (!existingEvidence) {
      this.run(
        `INSERT INTO evidence (id, claim_id, source_item_id, source_item_revision_id, analysis_run_id, provenance_family_id, stance, evidence_type, excerpt, start_ms, end_ms, lineage_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.ids.generate("evd"), claimId, sourceItemId, sourceItemRevisionId, analysisRunId, provenanceFamilyId,
        claim.stance, claim.evidenceType, claim.excerpt, claim.startMs, claim.endMs, lineageId, isoNow(),
      );
    }
    return { claimId, canonicalClaimId };
  }

  private resolveCanonicalClaimForRow(
    claimId: string,
    collectionId: string,
    subject: string,
    predicate: string,
    value: string,
    qualifiers: Record<string, string>,
  ): string {
    const key = canonicalClaimKey({ subject, predicate, value, qualifiers });
    const existing = this.get<{ id: string }>(
      "SELECT id FROM canonical_claims WHERE game_id = ? AND canonical_key = ?",
      collectionId, key,
    );
    const canonicalClaimId = existing?.id ?? this.ids.generate("cc");
    this.run(
      `INSERT INTO canonical_claims (id, game_id, subject, predicate, value, qualifiers, canonical_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, canonical_key) DO UPDATE SET canonical_key = excluded.canonical_key`,
      canonicalClaimId, collectionId, subject, predicate, value, json(qualifiers), key, isoNow(),
    );
    this.run("UPDATE claims SET canonical_claim_id = ?, claim_key = ? WHERE id = ?", canonicalClaimId, key, claimId);
    return canonicalClaimId;
  }

  private ensureCanonicalClaimsForSourceItem(sourceItemId: string): number {
    const unresolved = this.all<{ id: string; game_id: string; subject: string; predicate: string; value: string; qualifiers: string }>(
      "SELECT id, game_id, subject, predicate, value, qualifiers FROM claims WHERE source_item_id = ? AND canonical_claim_id IS NULL",
      sourceItemId,
    );
    for (const claim of unresolved) {
      this.resolveCanonicalClaimForRow(claim.id, claim.game_id, claim.subject, claim.predicate, claim.value, parseJson<Record<string, string>>(claim.qualifiers));
    }
    return unresolved.length;
  }

  private latestAnalysisRunForRevision(sourceItemRevisionId: string): string | null {
    return this.get<{ id: string }>(
      "SELECT id FROM analysis_runs WHERE source_item_revision_id = ? AND status = 'completed' ORDER BY completed_at DESC, id DESC LIMIT 1",
      sourceItemRevisionId,
    )?.id ?? null;
  }

  private parseAnalysisRun(row: Record<string, unknown>): AnalysisRunInfo {
    return {
      id: row.id as string,
      sourceItemRevisionId: row.source_item_revision_id as string,
      processingVersion: (row.processing_version as string | null) ?? null,
      normalizationVersion: (row.normalization_version as string | null) ?? null,
      claimExtractorVersion: (row.claim_extractor_version as string | null) ?? null,
      confidenceModelVersion: (row.confidence_model_version as string | null) ?? null,
      status: row.status as "completed" | "superseded",
      triggeredBy: (row.triggered_by as string | null) ?? null,
      triggerReason: (row.trigger_reason as string) ?? "",
      createdAt: new Date(row.created_at as string).toISOString(),
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    };
  }

  async getAnalysisRun(sourceItemRevisionId: string, versions: AnalysisVersions): Promise<AnalysisRunInfo | null> {
    const row = this.get<Record<string, unknown>>(
      `SELECT * FROM analysis_runs
       WHERE source_item_revision_id = ? AND status = 'completed'
          AND normalization_version = ? AND claim_extractor_version = ? AND confidence_model_version = ?
       LIMIT 1`,
       sourceItemRevisionId, versions.normalizationVersion, versions.claimExtractorVersion, versions.confidenceModelVersion,
    );
    return row ? this.parseAnalysisRun(row) : null;
  }

  async createAnalysisRun(input: { sourceItemRevisionId: string; versions: AnalysisVersions; triggeredBy?: string | null; triggerReason: string }): Promise<AnalysisRunInfo> {
    const existing = await this.getAnalysisRun(input.sourceItemRevisionId, input.versions);
    if (existing) return existing;
    this.run("UPDATE analysis_runs SET status = 'superseded' WHERE source_item_revision_id = ? AND status = 'completed'", input.sourceItemRevisionId);
    const runId = this.ids.generate("arun");
    const now = isoNow();
    const revision = this.get<{ processing_version: string | null }>("SELECT processing_version FROM source_item_revisions WHERE id = ?", input.sourceItemRevisionId);
    if (!revision) throw new Error("Source revision not found");
    this.run(
      `INSERT INTO analysis_runs (id, source_item_revision_id, processing_version, normalization_version, claim_extractor_version, confidence_model_version, status, triggered_by, trigger_reason, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      runId, input.sourceItemRevisionId, revision.processing_version, input.versions.normalizationVersion, input.versions.claimExtractorVersion,
      input.versions.confidenceModelVersion, input.triggeredBy ?? null, input.triggerReason, now, now,
    );
    return this.parseAnalysisRun(this.get<Record<string, unknown>>("SELECT * FROM analysis_runs WHERE id = ?", runId)!);
  }

  async listAnalysisRuns(sourceItemRevisionId: string): Promise<AnalysisRunInfo[]> {
    return this.all<Record<string, unknown>>(
      "SELECT * FROM analysis_runs WHERE source_item_revision_id = ? ORDER BY completed_at DESC, id DESC",
      sourceItemRevisionId,
    ).map((row) => this.parseAnalysisRun(row));
  }

  async getRevisionForAnalysis(revisionId: string): Promise<RevisionForAnalysis | null> {
    const row = this.get<Record<string, unknown>>(
      `SELECT revision.id, revision.source_item_id, revision.title, revision.content, revision.raw_hash,
        revision.processing_version, revision.content_purged_at,
        item.game_id, item.external_id, item.url, item.source_strength, item.publication_mode,
        item.discovered_at, item.published_at, item.input_kind, item.content_type, item.language,
        item.lineage_id, item.submitted_by, item.source_id,
        source.type, source.canonical_url, source.public_citation_url,
        source.publication_mode AS source_publication_mode, source.policy, source.enabled
       FROM source_item_revisions revision
       JOIN source_items item ON item.id = revision.source_item_id
       JOIN sources source ON source.id = item.source_id
       WHERE revision.id = ?
       LIMIT 1`,
      revisionId,
    );
    if (!row) return null;
    return {
      id: row.id as string,
      sourceItemId: row.source_item_id as string,
      title: (row.title as string | null) ?? "",
      content: (row.content as string | null) ?? "",
      rawHash: row.raw_hash as string,
      processingVersion: (row.processing_version as string | null) ?? null,
      contentPurged: row.content_purged_at !== null || row.content === null,
      sourceItem: {
        collectionId: row.game_id as string,
        externalId: row.external_id as string,
        url: row.url as string,
        sourceStrength: SourceStrengthSchema.parse(row.source_strength),
        publicationMode: row.publication_mode as import("@gameintel/core").PublicationMode,
        discoveredAt: new Date(row.discovered_at as string).toISOString(),
        publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
        inputKind: row.input_kind as string,
        contentType: (row.content_type as string | null) ?? null,
        language: (row.language as string | null) ?? null,
        lineageId: row.lineage_id as string,
        submittedBy: (row.submitted_by as string | null) ?? null,
      },
      source: {
        id: row.source_id as string,
        type: row.type as string,
        canonicalUrl: row.canonical_url as string,
        publicCitationUrl: (row.public_citation_url as string | null) ?? null,
        sourceStrength: SourceStrengthSchema.parse(row.source_strength),
        publicationMode: row.source_publication_mode as import("@gameintel/core").PublicationMode,
        policy: SourcePolicySchema.parse(parseJson(row.policy)),
        enabled: bool(row.enabled),
      },
    };
  }

  async resolveExistingArticleForCanonicalClaims(canonicalClaimIds: string[]): Promise<string | null> {
    const unique = [...new Set(canonicalClaimIds)];
    if (!unique.length) return null;
    const placeholders = unique.map(() => "?").join(", ");
    const row = this.get<{ id: string }>(
      `SELECT DISTINCT article.id
       FROM articles article
       JOIN article_sources article_source ON article_source.article_id = article.id
       JOIN claims claim ON claim.id = article_source.claim_id
       WHERE COALESCE(claim.canonical_claim_id, claim.id) IN (${placeholders})
         AND article.status <> 'retracted'
       ORDER BY article.created_at DESC
       LIMIT 1`,
      ...unique,
    );
    return row?.id ?? null;
  }

  async refreshArticlesForCanonicalClaims(canonicalClaimIds: string[], auditAction: string, auditReason: string): Promise<string[]> {
    const unique = [...new Set(canonicalClaimIds)];
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const articles = this.all<{ article_id: string }>(
      `SELECT DISTINCT article_source.article_id
       FROM article_sources article_source
       JOIN claims claim ON claim.id = article_source.claim_id
       WHERE COALESCE(claim.canonical_claim_id, claim.id) IN (${placeholders})`,
      ...unique,
    );
    const articleIds = articles.map((article) => article.article_id);
    for (const articleId of articleIds) {
      await this.refreshArticleEvidenceState(articleId);
      await this.refreshArticleConfidence(articleId);
      await this.audit("system", auditAction, "article", articleId, auditReason);
    }
    return articleIds;
  }

  async canonicalClaimIdsForSourceItem(sourceItemId: string): Promise<string[]> {
    return this.all<{ canonical_claim_id: string }>(
      "SELECT DISTINCT COALESCE(canonical_claim_id, id) AS canonical_claim_id FROM claims WHERE source_item_id = ?",
      sourceItemId,
    ).map((row) => row.canonical_claim_id);
  }

  private evidenceApprovalState(evidenceId: string, sourceItemRevisionId: string, policy: SourcePolicy): { approved: boolean; latestReviewAt: number; blockedBy: "rejected" | "disputed" | null } {
    const reviews = this.all<{ reviewer_id: string; decision: string; created_at: string }>(
      `SELECT reviewer_id, decision, created_at FROM (
         SELECT reviewer_id, decision, created_at, seq,
           ROW_NUMBER() OVER (PARTITION BY reviewer_id ORDER BY seq DESC) AS rn
         FROM evidence_reviews
         WHERE evidence_id = ? AND source_item_revision_id = ?
       ) WHERE rn = 1`,
      evidenceId, sourceItemRevisionId,
    );
    const gate = evidenceReviewGate(
      reviews.map((review) => ({
        reviewerId: review.reviewer_id,
        decision: review.decision as "approved" | "rejected" | "disputed",
        createdAt: timestamp(review.created_at),
      })),
      policy.evidenceReview,
    );
    const latestReviewAt = reviews.reduce((latest, review) => Math.max(latest, timestamp(review.created_at)), 0);
    return { approved: gate.eligible, latestReviewAt, blockedBy: gate.blockedBy };
  }

  async calculateClaimConfidence(claimId: string): Promise<number> {
    const claim = this.get<{ game_id: string; qualifiers: string; canonical_claim_id: string | null }>(
      "SELECT game_id, qualifiers, canonical_claim_id FROM claims WHERE id = ?",
      claimId,
    );
    if (!claim) throw new Error("Claim not found");
    const qualifiers = parseJson<Record<string, unknown>>(claim.qualifiers);
    const identity = claim.canonical_claim_id ?? claimId;
    const evidenceRows = this.all<Record<string, unknown>>(
      `SELECT e.id AS evidence_id, e.source_item_id, e.provenance_family_id, e.stance, e.evidence_type, e.excerpt, e.start_ms, e.end_ms, e.lineage_id,
        item.source_strength, source.policy, revision.id AS source_item_revision_id, provenance.relationship AS provenance_relationship
       FROM claims comparable_claim
       JOIN evidence e ON e.claim_id = comparable_claim.id
       JOIN analysis_runs run ON run.id = e.analysis_run_id
         AND run.status = 'completed'
         AND run.id = (
           SELECT latest_run.id
           FROM analysis_runs latest_run
           WHERE latest_run.source_item_revision_id = e.source_item_revision_id AND latest_run.status = 'completed'
           ORDER BY latest_run.completed_at DESC, latest_run.id DESC
           LIMIT 1
         )
       JOIN source_items item ON item.id = e.source_item_id
       JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id AND revision.is_current = 1
       JOIN sources source ON source.id = item.source_id
       LEFT JOIN source_item_provenance provenance ON provenance.source_item_id = e.source_item_id
       WHERE comparable_claim.game_id = ?
         AND COALESCE(comparable_claim.canonical_claim_id, comparable_claim.id) = ?`,
      claim.game_id, identity,
    );
    let strongest: SourceStrength = "UNVERIFIED";
    const approvedEvidence: Array<Evidence & { sourceStrength?: SourceStrength }> = [];
    for (const row of evidenceRows) {
      const policy = SourcePolicySchema.parse(parseJson(row.policy));
      const review = this.evidenceApprovalState(row.evidence_id as string, row.source_item_revision_id as string, policy);
      if (!review.approved) continue;
      const sourceStrength = SourceStrengthSchema.parse(row.source_strength);
      if (sourceStrengthOrder[sourceStrength] > sourceStrengthOrder[strongest]) strongest = sourceStrength;
      approvedEvidence.push({
        sourceItemId: row.source_item_id as string,
        provenanceFamilyId: row.provenance_family_id as string | undefined,
        stance: row.provenance_relationship === "contradiction" ? "contradicts" : row.stance as Evidence["stance"],
        evidenceType: row.evidence_type as Evidence["evidenceType"],
        excerpt: row.excerpt as string,
        startMs: row.start_ms === null ? null : Number(row.start_ms),
        endMs: row.end_ms === null ? null : Number(row.end_ms),
        lineageId: row.lineage_id as string,
        sourceStrength,
      });
    }
    return calculateConfidence(strongest, approvedEvidence, Object.keys(qualifiers).length > 0 ? 0.9 : 0.5);
  }

  async refreshClaimState(claimId: string): Promise<ClaimState> {
    const claim = this.get<{ canonical_claim_id: string | null }>("SELECT canonical_claim_id FROM claims WHERE id = ?", claimId);
    if (!claim) throw new Error("Claim not found");
    const identity = claim.canonical_claim_id ?? claimId;
    const rows = this.all<Record<string, unknown>>(
      `SELECT e.stance, e.provenance_family_id, item.source_strength, revision.is_current AS current_rev
       FROM claims member
       JOIN evidence e ON e.claim_id = member.id
       JOIN analysis_runs run ON run.id = e.analysis_run_id
         AND run.status = 'completed'
         AND run.id = (
           SELECT latest_run.id
           FROM analysis_runs latest_run
           WHERE latest_run.source_item_revision_id = e.source_item_revision_id AND latest_run.status = 'completed'
           ORDER BY latest_run.completed_at DESC, latest_run.id DESC
           LIMIT 1
         )
       JOIN source_items item ON item.id = e.source_item_id
       JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
       WHERE COALESCE(member.canonical_claim_id, member.id) = ?`,
      identity,
    );
    const currentRows = rows.filter((row) => row.current_rev === 1 || row.current_rev === true);
    const supportingFamilies = new Set<string>();
    const contradictingFamilies = new Set<string>();
    let strongest: SourceStrength = "UNVERIFIED";
    for (const row of currentRows) {
      const familyId = row.provenance_family_id as string | null;
      const strength = SourceStrengthSchema.parse(row.source_strength);
      if (sourceStrengthOrder[strength] > sourceStrengthOrder[strongest]) strongest = strength;
      if (!familyId) continue;
      if (row.stance === "contradicts") contradictingFamilies.add(familyId);
      else supportingFamilies.add(familyId);
    }
    const state = deriveClaimState({
      supportingFamilies: supportingFamilies.size,
      contradictingFamilies: contradictingFamilies.size,
      strongestStrength: strongest,
      hasCurrentEvidence: currentRows.length > 0,
      hasHistoricalEvidence: rows.length > 0,
    });
    this.run("UPDATE claims SET state = ? WHERE COALESCE(canonical_claim_id, id) = ?", state, identity);
    return state;
  }

  async refreshClaimStatesForSourceItem(sourceItemId: string): Promise<number> {
    this.ensureCanonicalClaimsForSourceItem(sourceItemId);
    const claims = this.all<{ id: string }>("SELECT id FROM claims WHERE source_item_id = ?", sourceItemId);
    for (const claim of claims) await this.refreshClaimState(claim.id);
    return claims.length;
  }

  async invalidateEvidenceApprovalsForSourceItem(sourceItemId: string): Promise<void> {
    const articles = this.all<{ article_id: string }>(
      `SELECT DISTINCT article_source.article_id
       FROM article_sources article_source
       JOIN claims claim ON claim.id = article_source.claim_id
       LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
       JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
       WHERE member.source_item_id = ?`,
      sourceItemId,
    );
    for (const article of articles) {
      const articleId = article.article_id;
      await this.refreshArticleEvidenceState(articleId);
      await this.refreshArticleConfidence(articleId);
      await this.audit("system", "evidence_review.invalidated", "article", articleId, "Underlying source evidence changed");
    }
  }

  async listArticleEvidence(articleId: string): Promise<ArticleEvidenceForReview[]> {
    const rows = this.all<Record<string, unknown>>(
      `SELECT DISTINCT e.id, e.claim_id, e.source_item_id, e.source_item_revision_id, e.excerpt, e.evidence_type,
        revision.processing_version,
        COALESCE(revision.is_current, 0) = 1
          AND e.analysis_run_id IS NOT NULL
          AND e.analysis_run_id = (
            SELECT latest_run.id
            FROM analysis_runs latest_run
            WHERE latest_run.source_item_revision_id = e.source_item_revision_id AND latest_run.status = 'completed'
            ORDER BY latest_run.completed_at DESC, latest_run.id DESC
            LIMIT 1
          ) AS current
       FROM article_sources article_source
       JOIN claims claim ON claim.id = article_source.claim_id
       LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
       JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
       JOIN evidence e ON e.claim_id = member.id
       LEFT JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
       WHERE article_source.article_id = ?
       ORDER BY e.id`,
      articleId,
    );
    return rows.map((row) => ({
      id: row.id as string,
      claimId: row.claim_id as string,
      sourceItemId: row.source_item_id as string,
      sourceItemRevisionId: row.source_item_revision_id as string | null,
      processingVersion: (row.processing_version as string | null) ?? null,
      excerpt: row.excerpt as string,
      evidenceType: row.evidence_type as string,
      current: row.current === 1 || row.current === true,
    }));
  }

  // -------------------------------------------------------------------------
  // ReviewRepository
  // -------------------------------------------------------------------------

  async reviewSourcePolicy(
    sourceId: string,
    reviewerId: string,
    decision: "approved" | "rejected" | "revoked" = "approved",
    notes = "",
  ): Promise<void> {
    const source = this.get<{ id: string }>("SELECT id FROM sources WHERE id = ?", sourceId);
    if (!source) throw new Error("Source not found");
    this.run(
      "INSERT INTO source_policy_reviews (id, source_id, reviewer_id, decision, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      this.ids.generate("srcpol"), sourceId, reviewerId, decision, notes, isoNow(),
    );
    await this.audit(reviewerId, `source_policy_review.${decision}`, "source", sourceId, notes);
  }

  async reviewSource(sourceId: string, reviewerId: string, notes = ""): Promise<void> {
    await this.reviewSourcePolicy(sourceId, reviewerId, "approved", notes);
  }

  async reviewEvidence(
    evidenceId: string,
    reviewerId: string,
    decision: "approved" | "rejected" | "disputed" = "approved",
    notes = "",
  ): Promise<void> {
    const evidence = this.get<Record<string, unknown>>(
      `SELECT e.id, e.source_item_revision_id, revision.is_current AS current, item.submitted_by, source.policy,
        run.id = (
          SELECT latest_run.id
          FROM analysis_runs latest_run
          WHERE latest_run.source_item_revision_id = revision.id AND latest_run.status = 'completed'
          ORDER BY latest_run.completed_at DESC, latest_run.id DESC
          LIMIT 1
        ) AS analysis_run_current
       FROM evidence e
       JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
       JOIN analysis_runs run ON run.id = e.analysis_run_id
       JOIN source_items item ON item.id = e.source_item_id
       JOIN sources source ON source.id = item.source_id
       WHERE e.id = ?`,
      evidenceId,
    );
    if (!evidence) throw new Error("Evidence not found or cannot be reviewed without a source revision");
    if ((evidence.current !== 1 && evidence.current !== true) || evidence.analysis_run_current !== 1) {
      throw new Error("Evidence review requires the current source revision and analysis run");
    }
    const policy = SourcePolicySchema.parse(parseJson(evidence.policy));
    if (decision === "approved" && policy.evidenceReview.preventSubmitterApproval && evidence.submitted_by === reviewerId) {
      throw new Error("Submitters cannot approve their own evidence");
    }
    const maxSeq = this.get<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM evidence_reviews")?.seq ?? 0;
    this.run(
      `INSERT INTO evidence_reviews (id, evidence_id, source_item_revision_id, reviewer_id, decision, notes, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      this.ids.generate("evrev"), evidenceId, evidence.source_item_revision_id as string, reviewerId, decision, notes, maxSeq + 1, isoNow(),
    );
    const articles = this.all<{ article_id: string }>(
      `SELECT DISTINCT article_source.article_id
       FROM article_sources article_source
       JOIN claims claim ON claim.id = article_source.claim_id
       LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
       JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
       JOIN evidence linked_evidence ON linked_evidence.claim_id = member.id
       WHERE linked_evidence.id = ?`,
      evidenceId,
    );
    for (const article of articles) {
      await this.refreshArticleEvidenceState(article.article_id);
      await this.refreshArticleConfidence(article.article_id);
    }
    await this.audit(reviewerId, `evidence_review.${decision}`, "evidence", evidenceId, notes);
  }

  private articleEvidenceState(articleId: string): Promise<{ sourceCount: number; evidenceCount: number; approvedCount: number; complete: boolean; latestChangeAt: number }> {
    const rows = this.all<Record<string, unknown>>(
      `SELECT
        ass.id AS article_source_id, ass.updated_at AS article_source_updated_at,
        e.id AS evidence_id, e.claim_id = claim.id AS direct_evidence,
        e.source_item_revision_id, e.created_at AS evidence_created_at,
        revision.is_current AS source_item_revision_current, revision.created_at AS source_item_revision_created_at,
        CASE WHEN run.id IS NULL THEN 0 WHEN run.status = 'completed'
          AND run.id = (
            SELECT latest_run.id
            FROM analysis_runs latest_run
            WHERE latest_run.source_item_revision_id = revision.id AND latest_run.status = 'completed'
            ORDER BY latest_run.completed_at DESC, latest_run.id DESC
            LIMIT 1
          ) THEN 1 ELSE 0 END AS analysis_run_current,
        source.policy AS source_policy
       FROM article_sources ass
       LEFT JOIN claims claim ON claim.id = ass.claim_id
       LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
       LEFT JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
       LEFT JOIN evidence e ON e.claim_id = member.id
       LEFT JOIN analysis_runs run ON run.id = e.analysis_run_id
       LEFT JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
       LEFT JOIN source_items item ON item.id = e.source_item_id
       LEFT JOIN sources source ON source.id = item.source_id
       WHERE ass.article_id = ?`,
      articleId,
    );
    const references = new Map<string, Set<string>>();
    const evidenceRows = new Map<string, { row: Record<string, unknown>; direct: boolean }>();
    let latestChangeAt = 0;
    for (const row of rows) {
      const referenceId = row.article_source_id as string;
      if (!references.has(referenceId)) references.set(referenceId, new Set());
      latestChangeAt = Math.max(latestChangeAt, timestamp(row.article_source_updated_at as string));
      const evidenceId = row.evidence_id as string | null;
      if (!evidenceId) continue;
      const direct = row.direct_evidence === 1 || row.direct_evidence === true;
      if (direct) references.get(referenceId)!.add(evidenceId);
      evidenceRows.set(evidenceId, { row, direct });
    }
    let approvedCount = 0;
    let directEvidenceCount = 0;
    let blockedBy: "rejected" | "disputed" | null = null;
    for (const [evidenceId, evidence] of evidenceRows) {
      const { row, direct } = evidence;
      const sourceItemRevisionId = row.source_item_revision_id as string | null;
      latestChangeAt = Math.max(latestChangeAt, timestamp(row.evidence_created_at as string), timestamp(row.source_item_revision_created_at as string));
      if (!sourceItemRevisionId || (row.source_item_revision_current !== 1 && row.source_item_revision_current !== true)
        || row.analysis_run_current !== 1 || !row.source_policy) continue;
      const policy = SourcePolicySchema.parse(parseJson(row.source_policy));
      const review = this.evidenceApprovalState(evidenceId, sourceItemRevisionId, policy);
      latestChangeAt = Math.max(latestChangeAt, review.latestReviewAt);
      if (review.blockedBy === "rejected" || (review.blockedBy === "disputed" && blockedBy !== "rejected")) blockedBy = review.blockedBy;
      if (direct) {
        directEvidenceCount += 1;
        if (review.approved) approvedCount += 1;
      }
    }
    const sourceCount = references.size;
    const evidenceCount = directEvidenceCount;
    const complete = blockedBy === null && sourceCount > 0 && evidenceCount > 0 && approvedCount === evidenceCount
      && [...references.values()].every((evidenceIds) => evidenceIds.size > 0);
    return Promise.resolve({ sourceCount, evidenceCount, approvedCount, complete, latestChangeAt });
  }

  private async refreshArticleEvidenceState(articleId: string): Promise<void> {
    const evidence = await this.articleEvidenceState(articleId);
    this.run(
      `UPDATE articles
       SET source_review_completed = ?, article_sources_complete = ?,
           editor_review_completed = CASE WHEN ? THEN editor_review_completed ELSE 0 END,
          approved_by = CASE WHEN ? THEN approved_by ELSE NULL END,
          approved_at = CASE WHEN ? THEN approved_at ELSE NULL END,
          status = CASE
            WHEN status = 'retracted' THEN status
            WHEN ? AND status IN ('published', 'updated') THEN status
            WHEN ? THEN 'source_review'
            ELSE 'draft'
          END
        WHERE id = ?`,
      evidence.complete ? 1 : 0, evidence.sourceCount > 0 ? 1 : 0,
      evidence.complete ? 1 : 0, evidence.complete ? 1 : 0, evidence.complete ? 1 : 0,
      evidence.complete ? 1 : 0, evidence.complete ? 1 : 0, articleId,
    );
  }

  private async refreshArticleConfidence(articleId: string): Promise<number> {
    const claims = this.all<{ claim_id: string }>("SELECT DISTINCT claim_id FROM article_sources WHERE article_id = ? AND claim_id IS NOT NULL", articleId);
    if (!claims.length) return 0;
    const confidences: number[] = [];
    for (const claim of claims) confidences.push(await this.calculateClaimConfidence(claim.claim_id));
    const confidence = Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100) / 100;
    this.run("UPDATE articles SET confidence = ? WHERE id = ?", confidence, articleId);
    return confidence;
  }

  private async assertPublicationRequirements(articleId: string): Promise<void> {
    const evidence = await this.articleEvidenceState(articleId);
    if (!evidence.complete) {
      throw new Error("Publication approval requires current evidence review for every source reference");
    }
    const reviews = this.get<{ reviewed_at: string | null }>(
      "SELECT MAX(created_at) AS reviewed_at FROM reviews WHERE target_type = 'article' AND target_id = ? AND decision = 'approved'",
      articleId,
    );
    const reviewedAt = timestamp(reviews?.reviewed_at);
    if (!reviewedAt || reviewedAt < evidence.latestChangeAt) {
      throw new Error("Publication approval requires a current editorial review");
    }
  }

  async reviewArticle(articleId: string, reviewerId: string, notes = ""): Promise<void> {
    const evidence = await this.articleEvidenceState(articleId);
    if (!evidence.complete) {
      throw new Error("Editorial review requires every source reference to have current evidence approval");
    }
    this.run(
      "INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision, notes, created_at) VALUES (?, 'article', ?, ?, 'approved', ?, ?)",
      this.ids.generate("revw"), articleId, reviewerId, notes, isoNow(),
    );
    this.run(
      `UPDATE articles SET source_review_completed = 1, editor_review_completed = 1, article_sources_complete = 1,
        status = CASE WHEN status IN ('draft', 'source_review') THEN 'editor_review' ELSE status END
       WHERE id = ?`,
      articleId,
    );
    await this.audit(reviewerId, "article_review.approved", "article", articleId, notes);
  }

  async approveArticle(articleId: string, approver: string): Promise<void> {
    const article = this.get<{ status: string }>("SELECT status FROM articles WHERE id = ?", articleId);
    if (!article) throw new Error("Article not found");
    if (article.status !== "editor_review") throw new Error("Publication approval requires a current editorial review");
    await this.assertPublicationRequirements(articleId);
    this.run(
      `UPDATE articles SET source_review_completed = 1, editor_review_completed = 1, article_sources_complete = 1,
        status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`,
      approver, isoNow(), articleId,
    );
    await this.audit(approver, "article.publication_approved", "article", articleId, "Human publication approval");
  }

  async markPublished(articleId: string, operator: string): Promise<Article> {
    const article = this.get<{ status: string }>("SELECT status FROM articles WHERE id = ?", articleId);
    if (!article) throw new Error("Article not found");
    if (article.status !== "approved") throw new Error("Only approved articles can be published");
    await this.assertPublicationRequirements(articleId);
    const cover = this.get<{ assignment_review_status: string; asset_review_status: string }>(
      `SELECT am.review_status AS assignment_review_status, ma.review_status AS asset_review_status
       FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
       WHERE am.article_id = ? AND am.role = 'cover'`,
      articleId,
    );
    if (cover && (cover.assignment_review_status !== "approved" || cover.asset_review_status !== "approved")) {
      throw new Error("Selected cover media must be approved before publication");
    }
    this.run("UPDATE articles SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", isoNow(), isoNow(), articleId);
    await this.audit(operator, "article.published", "article", articleId, "Published sanitized artifact");
const published = await this.getArticle(articleId);
    if (!published) throw new Error("Published article is not readable");
    return published;
  }

  // -------------------------------------------------------------------------
  // PublicationRepository
  // -------------------------------------------------------------------------

  async createArticleDraft(input: {
    collectionId: string;
    title: string;
    description: string;
    body: ArticleBody;
    newsworthiness: number;
    confidence: number;
    sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
  }): Promise<string> {
    const articleId = this.ids.generate("art");
    const slug = `${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}-${articleId.slice(-8)}`;
    const now = isoNow();
    this.run(
      `INSERT INTO articles (id, game_id, slug, title, seo_title, description, body, newsworthiness, confidence, article_sources_complete, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?)`,
      articleId, input.collectionId, slug, input.title, input.title, input.description, json(input.body),
      input.newsworthiness, input.confidence, now, now,
    );
    this.run(
      "INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary, created_at) VALUES (?, ?, 1, ?, 'Initial AI-assisted draft', ?)",
      this.ids.generate("rev"), articleId, json(input.body), now,
    );
    for (const source of input.sourceRefs) {
      this.run(
        "INSERT INTO article_sources (id, article_id, source_id, claim_id, citation_label, public_citation_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        this.ids.generate("arts"), articleId, source.sourceId, source.claimId, source.citationLabel, source.publicCitationUrl, now,
      );
    }
    return articleId;
  }

  async updateExistingArticle(input: {
    articleId: string;
    sourceItemId: string;
    sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
    body?: ArticleBody | null;
    changeSummary?: string;
  }): Promise<void> {
    const article = this.get<{ id: string; body: string }>("SELECT id, body FROM articles WHERE id = ?", input.articleId);
    if (!article) throw new Error("Article not found");
    const maxRevision = this.get<{ revision_number: number | null }>(
      "SELECT MAX(revision_number) AS revision_number FROM article_revisions WHERE article_id = ?",
      input.articleId,
    )?.revision_number ?? 0;
    const now = isoNow();
    if (input.body) this.run("UPDATE articles SET body = ?, updated_at = ? WHERE id = ?", json(input.body), now, input.articleId);
    this.run(
      "INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      this.ids.generate("rev"), input.articleId, maxRevision + 1, input.body ? json(input.body) : article.body, input.changeSummary ?? "Re-analyzed source revision", now,
    );
    this.run(
      "DELETE FROM article_sources WHERE article_id = ? AND claim_id IN (SELECT id FROM claims WHERE source_item_id = ?)",
      input.articleId, input.sourceItemId,
    );
    for (const source of input.sourceRefs) {
      this.run(
        "INSERT INTO article_sources (id, article_id, source_id, claim_id, citation_label, public_citation_url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        this.ids.generate("arts"), input.articleId, source.sourceId, source.claimId, source.citationLabel, source.publicCitationUrl, now,
      );
    }
    await this.refreshArticleEvidenceState(input.articleId);
    await this.refreshArticleConfidence(input.articleId);
  }

  async listClaimsForArticle(articleId: string): Promise<import("@gameintel/contracts").ArticleClaimForDraft[]> {
    return this.all<Record<string, unknown>>(
      `SELECT DISTINCT claim.id, claim.source_item_id, claim.subject, claim.predicate, claim.value, claim.evidence_level,
        claim.attribution_type, claim.statement, claim.editorial_assessment, claim.spoiler_tags
       FROM article_sources article_source JOIN claims claim ON claim.id = article_source.claim_id
       WHERE article_source.article_id = ? ORDER BY claim.id`,
      articleId,
    ).map((row) => ({
        id: row.id as string,
        sourceItemId: row.source_item_id as string,
      subject: row.subject as string,
      predicate: row.predicate as string,
      value: row.value as string,
      evidenceLevel: row.evidence_level as import("@gameintel/core").EvidenceLevel,
      attributionType: row.attribution_type as import("@gameintel/core").AttributionType,
      statement: row.statement as string | null,
      editorialAssessment: row.editorial_assessment as string | null,
      spoilerTags: parseJson<string[]>(row.spoiler_tags),
    }));
  }

  private articleSelect(row: Record<string, unknown>): Article {
    const parsedCover = row.cover_media ? parseJson<Record<string, unknown>>(row.cover_media) : null;
    return ArticleSchema.parse({
      id: row.id, collectionId: row.game_id, slug: row.slug, title: row.title, seoTitle: row.seo_title,
      description: row.description, body: ArticleBodySchema(row.body), status: row.status,
      newsworthiness: Number(row.newsworthiness), confidence: Number(row.confidence),
      sourceReviewCompleted: bool(row.source_review_completed), editorReviewCompleted: bool(row.editor_review_completed),
      articleSourcesComplete: bool(row.article_sources_complete),
      sourceRefs: parseJson<Array<Record<string, unknown>>>(row.source_refs ?? []),
      coverMedia: parsedCover ? ArticleCoverMediaSchema.parse({
        ...parsedCover,
        tags: typeof parsedCover.tags === "string" ? JSON.parse(parsedCover.tags) : parsedCover.tags,
        spoilerTags: typeof parsedCover.spoilerTags === "string" ? JSON.parse(parsedCover.spoilerTags) : parsedCover.spoilerTags,
      }) : null,
      approvedBy: row.approved_by as string | null,
      publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
    });
  }

  private articleSelectSql(where: string): string {
    return `SELECT a.*,
      COALESCE((SELECT json_group_array(json_object(
        'sourceId', ass.source_id, 'claimId', ass.claim_id,
        'citationLabel', ass.citation_label, 'publicCitationUrl', ass.public_citation_url
      )) FROM (SELECT DISTINCT source_id, claim_id, citation_label, public_citation_url FROM article_sources WHERE article_id = a.id) ass), '[]') AS source_refs,
      COALESCE((SELECT json_object(
        'id', ma.id, 'caption', ma.caption, 'altText', ma.alt_text, 'collection', ma.collection,
        'tags', ma.tags, 'spoilerTags', ma.spoiler_tags, 'attribution', ma.attribution,
        'sourceUrl', ma.source_url, 'publicUrl', ma.public_url, 'selectionSource', am.selection_source,
        'reviewStatus', CASE WHEN am.review_status = 'approved' AND ma.review_status = 'approved' THEN 'approved'
          WHEN am.review_status = 'rejected' THEN 'rejected' ELSE 'pending' END
      ) FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
        WHERE am.article_id = a.id AND am.role = 'cover' LIMIT 1), NULL) AS cover_media
      FROM articles a ${where}`;
  }

  async getArticle(idOrSlug: string): Promise<Article | null> {
    const row = this.get<Record<string, unknown>>(this.articleSelectSql("WHERE (a.id = ? OR a.slug = ?) LIMIT 1"), idOrSlug, idOrSlug);
    return row ? this.articleSelect(row) : null;
  }

  async listArticles(collectionId: string): Promise<Article[]> {
    return this.all<Record<string, unknown>>(this.articleSelectSql("WHERE a.game_id = ? ORDER BY a.created_at DESC"), collectionId).map((row) => this.articleSelect(row));
  }

  // The public article surface is the sanitized SafeArticle projection;
  // single-process adapters compute it from their own articles, which is the
  // same guarantee the PostgreSQL adapter enforces at the storage layer.
  async getPublicArticle(idOrSlug: string): Promise<SafeArticle | null> {
    const article = await this.getArticle(idOrSlug);
    if (!article || (article.status !== "published" && article.status !== "updated")) return null;
    return toSafeArticle(article);
  }

  async listPublicArticles(collectionId: string): Promise<SafeArticle[]> {
    const rows = this.all<Record<string, unknown>>(
      this.articleSelectSql("WHERE a.game_id = ? AND a.status IN ('published', 'updated') ORDER BY COALESCE(a.published_at, a.created_at) DESC"),
      collectionId,
    );
    return rows.map((row) => this.articleSelect(row)).map((article) => toSafeArticle(article)).filter((safe): safe is SafeArticle => safe !== null);
  }

  async publicArticles(collectionId: string): Promise<unknown[]> {
    return this.listPublicArticles(collectionId);
  }

  async purgeExpiredSourceContent(options: { execute?: boolean } = {}): Promise<SourceContentPurgeResult> {
    const candidates = this.all<{ id: string }>(
      `SELECT si.id FROM source_items si
       WHERE si.retention_until IS NOT NULL AND si.retention_until <= ? AND si.content_purged_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM articles a
           JOIN article_sources ass ON ass.article_id = a.id
           LEFT JOIN claims c ON c.id = ass.claim_id
           WHERE a.status IN ('draft', 'source_review', 'editor_review', 'approved', 'updated')
             AND (c.source_item_id = si.id OR (ass.claim_id IS NULL AND ass.source_id = si.source_id))
         )`,
      Date.now(),
    );
    const ids = candidates.map((candidate) => candidate.id);
    if (!options.execute || !ids.length) {
      return { eligibleSourceItems: ids.length, purgedSourceItems: 0, purgedRevisions: 0, purgedEvidence: 0, dryRun: !options.execute };
    }
    const revisionResult = this.db.query(
      "UPDATE source_item_revisions SET excerpt = '', title = '', content = '', content_purged_at = ? WHERE source_item_id IN (SELECT value FROM json_each(?)) AND (excerpt <> '' OR title IS NOT NULL OR content IS NOT NULL)",
    ).run(Date.now(), json(ids));
    const evidenceResult = this.db.query(
      "UPDATE evidence SET excerpt = '' WHERE source_item_id IN (SELECT value FROM json_each(?)) AND excerpt <> ''",
    ).run(json(ids));
    const sourceResult = this.db.query(
      "UPDATE source_items SET text_excerpt = '', content_purged_at = ? WHERE id IN (SELECT value FROM json_each(?))",
    ).run(Date.now(), json(ids));
    return {
      eligibleSourceItems: ids.length,
      purgedSourceItems: Number(sourceResult.changes),
      purgedRevisions: Number(revisionResult.changes),
      purgedEvidence: Number(evidenceResult.changes),
      dryRun: false,
    };
  }

  // -------------------------------------------------------------------------
  // SubmissionRepository
  // -------------------------------------------------------------------------

  private submissionCount(condition: "ip" | "session" | "account" | "global", identity?: string): Promise<number> {
    const now = Date.now();
    if (condition === "ip") {
      const row = this.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM public_submissions WHERE submitter_ip_hash = ? AND created_at >= ?",
        identity!, new Date(now - 60_000).toISOString(),
      );
      return Promise.resolve(Number(row?.count ?? 0));
    }
    if (condition === "session") {
      const row = this.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM public_submissions WHERE submitter_session_hash = ? AND created_at >= ?",
        identity!, new Date(now - 60_000).toISOString(),
      );
      return Promise.resolve(Number(row?.count ?? 0));
    }
    if (condition === "account") {
      const row = this.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM public_submissions WHERE submitter_account_id = ? AND created_at >= ?",
        identity!, new Date(now - 86_400_000).toISOString(),
      );
      return Promise.resolve(Number(row?.count ?? 0));
    }
    const row = this.get<{ count: number }>("SELECT COUNT(*) AS count FROM public_submissions WHERE created_at >= ?", new Date(now - 60_000).toISOString());
    return Promise.resolve(Number(row?.count ?? 0));
  }

  private validIdentityHash(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value);
  }

  async createQuarantinedSubmission(input: {
    submission: PublicSubmission;
    submitterSessionHash: string;
    submitterIpHash: string;
    submitterAccountId?: string | null;
    retentionDays?: number;
    limits?: { perIpPerMinute: number; perSessionPerMinute: number; perAccountPerDay: number; globalPerMinute: number };
  }): Promise<{ id: string; duplicate: boolean }> {
    const submission = input.submission;
    if (!this.validIdentityHash(input.submitterSessionHash) || !this.validIdentityHash(input.submitterIpHash)) {
      throw new Error("Submission identity hashes must be SHA-256 digests");
    }
    const accountId = input.submitterAccountId?.trim() || null;
    const retentionDays = input.retentionDays ?? 30;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
      throw new Error("Submission retention must be between 1 and 90 days");
    }
    const limits = input.limits ?? defaultPublicSubmissionRateLimits;
    if (Object.values(limits).some((limit) => !Number.isInteger(limit) || limit < 1)) {
      throw new Error("Submission rate limits must be positive integers");
    }
    const collection = this.get<{ id: string }>("SELECT id FROM games WHERE id = ?", submission.collectionId);
    if (!collection) throw new Error("Collection not found");
    const contentHash = publicSubmissionFingerprint(submission);
    const duplicate = this.get<{ id: string }>(
      `SELECT id FROM public_submissions
       WHERE collection_id = ? AND submitter_session_hash = ? AND content_hash = ? AND created_at >= ?
       LIMIT 1`,
      submission.collectionId, input.submitterSessionHash, contentHash, new Date(Date.now() - 86_400_000).toISOString(),
    );
    if (duplicate) return { id: duplicate.id, duplicate: true };
    if (await this.submissionCount("global") >= limits.globalPerMinute
      || await this.submissionCount("ip", input.submitterIpHash) >= limits.perIpPerMinute
      || await this.submissionCount("session", input.submitterSessionHash) >= limits.perSessionPerMinute
      || (accountId !== null && await this.submissionCount("account", accountId) >= limits.perAccountPerDay)) {
      throw new SubmissionRateLimitError();
    }
    const submissionId = this.ids.generate("sub");
    this.run(
      `INSERT INTO public_submissions (id, collection_id, submitter_account_id, submitter_session_hash, submitter_ip_hash,
        title, report, urls, media_refs, content_hash, retention_until, state, content_purged_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', NULL, ?, ?)`,
      submissionId, submission.collectionId, accountId, input.submitterSessionHash, input.submitterIpHash,
      submission.title ?? null, submission.report, json(submission.urls), json(submission.mediaRefs),
      contentHash, Date.now() + retentionDays * 86_400_000, isoNow(), isoNow(),
    );
    this.run(
      "INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes, created_at) VALUES (?, ?, 'system', 'submitted', 'Submission entered quarantine', ?)",
      this.ids.generate("subact"), submissionId, isoNow(),
    );
    await this.audit("system", "submission.quarantined", "public_submission", submissionId, "Unverified public submission");
    return { id: submissionId, duplicate: false };
  }

  private moderationSubmission(row: Record<string, unknown>): PublicSubmissionForModeration {
    return {
      id: row.id as string,
      collectionId: row.collection_id as string,
      state: row.state as PublicSubmissionForModeration["state"],
      title: row.title as string | null,
      report: row.report as string,
      urls: parseJson<PublicSubmission["urls"]>(row.urls),
      mediaRefs: parseJson<PublicSubmission["mediaRefs"]>(row.media_refs),
      promotedSourceItemId: row.promoted_source_item_id as string | null,
      retentionUntil: new Date(Number(row.retention_until)).toISOString(),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    };
  }

  async listPublicSubmissionsForModeration(
    collectionId: string,
    options: { state?: PublicSubmissionForModeration["state"]; limit?: number } = {},
  ): Promise<PublicSubmissionForModeration[]> {
    const limit = options.limit ?? 100;
    const rows = options.state === undefined
      ? this.all<Record<string, unknown>>(
        "SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at FROM public_submissions WHERE collection_id = ? AND content_purged_at IS NULL ORDER BY created_at DESC LIMIT ?",
        collectionId, limit,
      )
      : this.all<Record<string, unknown>>(
        "SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at FROM public_submissions WHERE collection_id = ? AND state = ? AND content_purged_at IS NULL ORDER BY created_at DESC LIMIT ?",
        collectionId, options.state, limit,
      );
    return rows.map((row) => this.moderationSubmission(row));
  }

  async getPublicSubmissionForModeration(submissionId: string): Promise<PublicSubmissionForModeration | null> {
    const row = this.get<Record<string, unknown>>(
      "SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at FROM public_submissions WHERE id = ? AND content_purged_at IS NULL",
      submissionId,
    );
    return row ? this.moderationSubmission(row) : null;
  }

  async listPublicSubmissionModerationActions(submissionId: string): Promise<PublicSubmissionModerationAction[]> {
    return this.all<Record<string, unknown>>(
      "SELECT id, actor_id, action, notes, created_at FROM submission_moderation_actions WHERE submission_id = ? ORDER BY created_at ASC",
      submissionId,
    ).map((row) => ({
      id: row.id as string,
      actorId: row.actor_id as string,
      action: row.action as string,
      notes: row.notes as string,
      createdAt: new Date(row.created_at as string).toISOString(),
    }));
  }

  private moderationActor(actorId: string): string {
    const actor = actorId.trim();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(actor)) throw new Error("A valid moderation actor is required");
    return actor;
  }

  private moderationNotes(notes: string | undefined): string {
    const value = notes?.trim() ?? "";
    if (value.length > 2_000) throw new Error("Moderation notes exceed the 2,000 character limit");
    return value;
  }

  async reviewPublicSubmission(input: {
    submissionId: string;
    actorId: string;
    decision: "under_review" | "rejected" | "blocked";
    notes?: string;
  }): Promise<{ id: string; state: "under_review" | "rejected" | "blocked" }> {
    const actorId = this.moderationActor(input.actorId);
    const notes = this.moderationNotes(input.notes);
    const row = this.get<{ state: string; content_purged_at: number | null }>(
      "SELECT state, content_purged_at FROM public_submissions WHERE id = ?",
      input.submissionId,
    );
    if (!row) throw new Error("Submission not found");
    if (row.content_purged_at !== null || row.state === "expired" || row.state === "promoted") {
      throw new Error("Submission is no longer available for moderation");
    }
    const currentState = row.state as PublicSubmissionForModeration["state"];
    const permitted = currentState === "quarantined" || currentState === "under_review";
    if (!permitted) throw new Error(`Submission cannot transition from ${currentState} to ${input.decision}`);
    this.run("UPDATE public_submissions SET state = ?, updated_at = ? WHERE id = ?", input.decision, isoNow(), input.submissionId);
    this.run(
      "INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      this.ids.generate("subact"), input.submissionId, actorId, `state:${input.decision}`, notes, isoNow(),
    );
    await this.audit(actorId, `submission.${input.decision}`, "public_submission", input.submissionId, notes);
    return { id: input.submissionId, state: input.decision };
  }

  async getPublicSubmissionForPromotion(submissionId: string): Promise<PublicSubmissionForModeration> {
    const row = this.get<Record<string, unknown>>(
      "SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at FROM public_submissions WHERE id = ?",
      submissionId,
    );
    if (!row) throw new Error("Submission not found");
    const submission = this.moderationSubmission(row);
    if (submission.state !== "under_review" || !submission.report) {
      throw new Error("Submission must be under review and retained before promotion");
    }
    return submission;
  }

  async markPublicSubmissionPromoted(input: { submissionId: string; sourceItemId: string; actorId: string; notes?: string }): Promise<void> {
    const actorId = this.moderationActor(input.actorId);
    const notes = this.moderationNotes(input.notes);
    const promoted = this.db.query(
      "UPDATE public_submissions SET state = 'promoted', promoted_source_item_id = ?, updated_at = ? WHERE id = ? AND state = 'under_review' AND content_purged_at IS NULL",
    ).run(input.sourceItemId, isoNow(), input.submissionId);
    if (promoted.changes === 0) throw new Error("Submission is no longer eligible for promotion");
    this.run(
      "INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes, created_at) VALUES (?, ?, ?, 'promoted', ?, ?)",
      this.ids.generate("subact"), input.submissionId, actorId, notes, isoNow(),
    );
    await this.audit(actorId, "submission.promoted", "public_submission", input.submissionId, notes);
  }

  async recordSubmissionModerationAction(submissionId: string, actorId: string, action: string, notes = ""): Promise<void> {
    const submission = this.get<{ id: string }>("SELECT id FROM public_submissions WHERE id = ?", submissionId);
    if (!submission) throw new Error("Submission not found");
    this.run(
      "INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      this.ids.generate("subact"), submissionId, actorId, action.slice(0, 100), notes.slice(0, 2_000), isoNow(),
    );
    await this.audit(actorId, `submission.${action.slice(0, 100)}`, "public_submission", submissionId, notes.slice(0, 2_000));
  }

  async purgeExpiredPublicSubmissions(options: { execute?: boolean } = {}): Promise<PublicSubmissionPurgeResult> {
    const candidates = this.all<{ id: string }>(
      "SELECT id FROM public_submissions WHERE retention_until <= ? AND content_purged_at IS NULL",
      Date.now(),
    );
    const ids = candidates.map((candidate) => candidate.id);
    if (!options.execute || !ids.length) return { eligibleSubmissions: ids.length, purgedSubmissions: 0, dryRun: !options.execute };
    const purged = this.db.query(
      `UPDATE public_submissions
       SET title = NULL, report = '', urls = '[]', media_refs = '[]', content_purged_at = ?, updated_at = ?,
         state = CASE WHEN state IN ('quarantined', 'under_review', 'blocked') THEN 'expired' ELSE state END
       WHERE id IN (SELECT value FROM json_each(?))`,
    ).run(Date.now(), isoNow(), json(ids));
    return { eligibleSubmissions: ids.length, purgedSubmissions: Number(purged.changes), dryRun: false };
  }

  async audit(actor: string, action: string, targetType: string, targetId: string, reason: string): Promise<void> {
    this.run(
      "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.ids.generate("audit"), actor, action, targetType, targetId, reason, isoNow(),
    );
  }

  // -------------------------------------------------------------------------
  // MediaRepository
  // -------------------------------------------------------------------------

  async importMediaCatalog(catalogPath: string): Promise<{ imported: number; collectionIds: string[] }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(catalogPath, "utf8"));
    } catch {
      throw new Error(`Could not read media catalog '${catalogPath}'`);
    }
    const catalog = MediaCatalogSchema.safeParse(parsed);
    if (!catalog.success) throw new Error(`Invalid media catalog: ${catalog.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    assertUniqueMedia(catalog.data.media);
    for (const item of catalog.data.media) {
      this.run(
        `INSERT INTO media_assets (id, game_id, collection, caption, alt_text, tags, spoiler_tags, attribution, source_url, source_page_url, original_key, display_key, public_url, content_type, width, height, checksum, review_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (id) DO UPDATE SET game_id = excluded.game_id, collection = excluded.collection,
           caption = excluded.caption, alt_text = excluded.alt_text, tags = excluded.tags,
           spoiler_tags = excluded.spoiler_tags, attribution = excluded.attribution,
           source_url = excluded.source_url, source_page_url = excluded.source_page_url,
           original_key = excluded.original_key, display_key = excluded.display_key, public_url = excluded.public_url,
           content_type = excluded.content_type, width = excluded.width, height = excluded.height,
           checksum = excluded.checksum, review_status = 'pending', approved_by = NULL, approved_at = NULL,
           updated_at = excluded.updated_at`,
        item.id, item.collectionId, item.collection, item.caption, item.altText, json(item.tags), json(item.spoilerTags),
        item.attribution, item.sourceUrl, item.sourcePageUrl, item.originalKey, item.displayKey, item.publicUrl,
        item.contentType, item.width, item.height, item.checksum, isoNow(),
      );
    }
    return { imported: catalog.data.media.length, collectionIds: [...new Set(catalog.data.media.map((item) => item.collectionId))].sort() };
  }

  private jsonArray(value: unknown): string[] {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  }

  async listCoverCandidates(articleId: string): Promise<CoverMediaCandidate[]> {
    return this.all<Record<string, unknown>>(
      `SELECT ma.id, ma.collection, ma.caption, ma.alt_text, ma.tags, ma.spoiler_tags, ma.attribution, ma.source_url, ma.public_url
       FROM media_assets ma JOIN articles a ON a.game_id = ma.game_id
       WHERE a.id = ? AND ma.review_status = 'approved' AND json_array_length(ma.spoiler_tags) = 0
       ORDER BY ma.id ASC`,
      articleId,
    ).map((row) => ({
      id: row.id as string,
      collection: row.collection as string,
      caption: row.caption as string,
      altText: row.alt_text as string,
      tags: this.jsonArray(row.tags),
      spoilerTags: this.jsonArray(row.spoiler_tags),
      attribution: row.attribution as string,
      sourceUrl: row.source_url as string,
      publicUrl: row.public_url as string,
    }));
  }

  async setCoverMedia(articleId: string, mediaId: string, selectionSource: "automatic" | "editor" = "editor"): Promise<void> {
    const rows = this.get<{ article_game_id: string; media_game_id: string; spoiler_tags: string }>(
      "SELECT a.game_id AS article_game_id, ma.game_id AS media_game_id, ma.spoiler_tags FROM articles a CROSS JOIN media_assets ma WHERE a.id = ? AND ma.id = ?",
      articleId, mediaId,
    );
    if (!rows) throw new Error("Article or media asset not found");
    if (rows.article_game_id !== rows.media_game_id) throw new Error("Cover media must belong to the article collection");
    if (this.jsonArray(rows.spoiler_tags).length) throw new Error("Spoiler-tagged media cannot be a cover");
    this.run(
      `INSERT INTO article_media (article_id, media_id, role, selection_source, review_status, reviewed_by, reviewed_at, created_at)
       VALUES (?, ?, 'cover', ?, 'pending', NULL, NULL, ?)
       ON CONFLICT (article_id, role) DO UPDATE SET media_id = excluded.media_id,
         selection_source = excluded.selection_source, review_status = 'pending', reviewed_by = NULL,
         reviewed_at = NULL, created_at = excluded.created_at`,
      articleId, mediaId, selectionSource, isoNow(),
    );
  }

  async recommendArticleCover(input: { articleId: string; title: string; description: string; safeClaimText: string[] }): Promise<string | null> {
    const candidates = await this.listCoverCandidates(input.articleId);
    if (!candidates.length) return null;
    const normalized = (value: string) => value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    const articleText = normalized([input.title, input.description, ...input.safeClaimText].join(" "));
    const selected = candidates.map((candidate) => ({ candidate, score: mediaCoverScore(candidate, articleText) }))
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0].candidate;
    await this.setCoverMedia(input.articleId, selected.id, "automatic");
    return selected.id;
  }

  async approveMediaAsset(mediaId: string, reviewer: string): Promise<void> {
    const result = this.db.query(
      "UPDATE media_assets SET review_status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?",
    ).run(reviewer, isoNow(), isoNow(), mediaId);
    if (result.changes === 0) throw new Error("Media asset not found");
  }

  async approveMediaCollection(collectionId: string, reviewer: string): Promise<number> {
    const result = this.db.query(
      "UPDATE media_assets SET review_status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE game_id = ? AND review_status = 'pending' AND json_array_length(spoiler_tags) = 0",
    ).run(reviewer, isoNow(), isoNow(), collectionId);
    return Number(result.changes);
  }

  async approveCoverMedia(articleId: string, reviewer: string): Promise<void> {
    const rows = this.get<{ asset_review_status: string }>(
      `SELECT ma.review_status AS asset_review_status
       FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
       WHERE am.article_id = ? AND am.role = 'cover'`,
      articleId,
    );
    if (!rows) throw new Error("Article has no selected cover media");
    if (rows.asset_review_status !== "approved") throw new Error("Cover media asset must be approved before its assignment");
    this.run("UPDATE article_media SET review_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE article_id = ? AND role = 'cover'", reviewer, isoNow(), articleId);
  }

  async rejectCoverMedia(articleId: string, reviewer: string): Promise<void> {
    const result = this.db.query(
      "UPDATE article_media SET review_status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE article_id = ? AND role = 'cover'",
    ).run(reviewer, isoNow(), articleId);
    if (result.changes === 0) throw new Error("Article has no selected cover media");
  }

  async clearCoverMedia(articleId: string): Promise<void> {
    this.run("DELETE FROM article_media WHERE article_id = ? AND role = 'cover'", articleId);
  }

  // -------------------------------------------------------------------------
  // Lease fencing
  // -------------------------------------------------------------------------

  async assertIngestionJobLeaseHeld(jobKey: string, leaseToken: string): Promise<void> {
    const held = this.get<{ job_key: string }>(
      "SELECT job_key FROM jobs WHERE job_key = ? AND status = 'running' AND lease_token = ?",
      jobKey, leaseToken,
    );
    if (!held) throw new IngestionLeaseLostError(jobKey);
  }
}

function ArticleBodySchema(value: unknown): ArticleBody {
  return typeof value === "string" ? JSON.parse(value) as ArticleBody : value as ArticleBody;
}
