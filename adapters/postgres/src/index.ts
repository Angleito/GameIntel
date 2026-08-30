import postgres, { type Sql } from "postgres";
import {
  IngestionLeaseLostError,
  SubmissionRateLimitError,
  defaultPublicSubmissionRateLimits,
} from "@gameintel/contracts";
import type {
  ArticleEvidenceForReview,
  CoverMediaCandidate,
  IngestionJob,
  IngestionQueueStatus,
  IngestionWorkerHeartbeat,
  PublicSubmissionForModeration,
  PublicSubmissionModerationAction,
  PublicSubmissionPurgeResult,
  PublicSubmissionRateLimits,
  SourceContentPurgeResult,
  SourceDiscoverJobPayload,
  SourceIngestEnqueueResult,
  SourceIngestJobPayload,
} from "@gameintel/contracts";
import {
  ArticleBodySchema,
  ArticleSchema,
  type Article,
  type ArticleBody,
  ArticleCoverMediaSchema,
  calculateConfidence,
  canonicalClaimKey,
  canonicalizeUrl,
  ClaimStateSchema,
  type ClaimState,
  deriveClaimState,
  EvidenceReviewDecisionSchema,
  evidenceReviewGate,
  hashText,
  type Evidence,
  type EvidenceReviewDecision,
  type GameProfile,
  type NormalizedSourceItem,
  type PublicationMode,
  ProvenanceClusteringMethodSchema,
  type ProvenanceClusteringMethod,
  ProvenanceRelationshipSchema,
  type ProvenanceRelationship,
  publicSubmissionFingerprint,
  PublicHttpUrlSchema,
  PublicSubmissionSchema,
  type PublicSubmission,
  PublicSubmissionReviewDecisionSchema,
  type PublicSubmissionReviewDecision,
  PublicSubmissionStateSchema,
  type PublicSubmissionState,
  type SourcePolicy,
  SourcePolicyReviewDecisionSchema,
  type SourcePolicyReviewDecision,
  SourcePolicySchema,
  SourceStrengthSchema,
  type SourceStrength,
  type SafeArticle,
  toSafeArticle,
} from "@gameintel/core";

export {
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  clearCoverMedia,
  importMediaCatalog,
  listCoverCandidates,
  recommendArticleCover,
  rejectCoverMedia,
  setCoverMedia,
} from "./media.ts";

// Shared capability types and errors live in @gameintel/contracts. These
// re-exports keep the legacy function-based surface source-compatible while
// the adapter classes take over.
export {
  ADAPTER_API_VERSION,
  IngestionLeaseLostError,
  SubmissionRateLimitError,
  defaultPublicSubmissionRateLimits,
} from "@gameintel/contracts";
export type {
  AnalysisRunInfo,
  AnalysisVersions,
  ArticleEvidenceForReview,
  CoverMediaCandidate,
  IngestionJob,
  IngestionQueueStatus,
  IngestionWorkerHeartbeat,
  InsertedClaim,
  PublicSubmissionForModeration,
  PublicSubmissionModerationAction,
  PublicSubmissionPurgeResult,
  PublicSubmissionRateLimits,
  RevisionForAnalysis,
  SourceContentPurgeResult,
  SourceIngestEnqueueResult,
  SourceIngestJobPayload,
} from "@gameintel/contracts";

export type Db = Sql<{}>;

export {
  PostgresJobQueue,
  PostgresPacingStore,
  PostgresPersistence,
  createPostgresRuntime,
} from "./adapter.ts";

type TransactionRunner = {
  begin?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  savepoint?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
};

export async function inTransaction<T>(db: Db, callback: (transaction: Db) => Promise<T>): Promise<T> {
  const runner = db as unknown as TransactionRunner;
  const run = async (transaction: unknown): Promise<unknown> => callback(transaction as Db);
  // postgres.js exposes savepoints on transaction handles; use one rather than
  // attempting to start a nested top-level transaction.
  if (typeof runner.savepoint === "function") return await runner.savepoint(run) as T;
  if (typeof runner.begin === "function") return await runner.begin(run) as T;
  throw new Error("Database handle does not support transactions");
}

export function createDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.username || !parsed.password) {
    throw new Error("DATABASE_URL must include PostgreSQL credentials");
  }
  return postgres(url, { max: 5, idle_timeout: 20 });
}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function ensureGame(db: Db, profile: GameProfile): Promise<void> {
  await db`
    INSERT INTO games (id, canonical_name, aliases, profile)
    VALUES (${profile.id}, ${profile.canonicalName}, ${JSON.stringify(profile.aliases)}, ${JSON.stringify(profile)})
    ON CONFLICT (id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name, aliases = EXCLUDED.aliases, profile = EXCLUDED.profile
  `;
}

export async function ensureSource(db: Db, source: {
  id: string; type: string; canonicalUrl: string; publicCitationUrl: string | null;
  sourceStrength: string; publicationMode: string; policy: unknown; enabled?: boolean;
}): Promise<void> {
  await db`
    INSERT INTO sources (id, type, canonical_url, public_citation_url, source_strength, publication_mode, policy, enabled)
    VALUES (${source.id}, ${source.type}, ${source.canonicalUrl}, ${source.publicCitationUrl}, ${source.sourceStrength}, ${source.publicationMode}, ${JSON.stringify(source.policy)}, ${source.enabled ?? true})
    ON CONFLICT (id) DO UPDATE SET
      type = EXCLUDED.type,
      canonical_url = EXCLUDED.canonical_url,
      public_citation_url = EXCLUDED.public_citation_url,
      source_strength = EXCLUDED.source_strength,
      publication_mode = EXCLUDED.publication_mode,
      policy = EXCLUDED.policy,
      enabled = EXCLUDED.enabled
  `;
}

function retainedExcerpt(text: string, policy: SourcePolicy): string {
  if (policy.retainRawTextDays === 0) return "";
  return text.slice(0, policy.mayStoreFullText ? 4_000 : 1_000);
}

function retentionUntil(policy: SourcePolicy): Date {
  return new Date(Date.now() + policy.retainRawTextDays * 86_400_000);
}

async function provenanceFamilyForSourceItem(
  db: Db,
  sourceItemId: string,
  collectionId: string,
  lineageId: string,
): Promise<string> {
  const existing = await db`
    SELECT provenance_family_id
    FROM source_item_provenance
    WHERE source_item_id = ${sourceItemId}
    LIMIT 1
  `;
  if (existing.length) return existing[0].provenance_family_id as string;

  const familyKey = `lineage:${lineageId}`;
  const family = await db`
    INSERT INTO provenance_families (id, collection_id, family_key, root_source_item_id)
    VALUES (${id("pf")}, ${collectionId}, ${familyKey}, ${sourceItemId})
    ON CONFLICT (collection_id, family_key) DO UPDATE SET family_key = EXCLUDED.family_key
    RETURNING id
  `;
  const familyId = family[0].id as string;
  await db`
    INSERT INTO source_item_provenance (source_item_id, provenance_family_id, relationship, clustering_method)
    VALUES (${sourceItemId}, ${familyId}, 'original', 'lineage')
    ON CONFLICT (source_item_id) DO NOTHING
  `;
  return familyId;
}

export async function insertSourceItem(
  db: Db,
  item: NormalizedSourceItem,
  rawHash: string,
  lineageId: string,
  policy: SourcePolicy,
  submittedBy: string | null = null,
): Promise<{ id: string; revisionId: string; provenanceFamilyId: string; duplicate: boolean; materialChange: boolean }> {
  // Lock both identities so concurrent updates cannot turn a changed URL into a duplicate.
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`${item.sourceId}:external:${item.externalId}`}, 0))`;
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`${item.sourceId}:hash:${rawHash}`}, 0))`;
  const existingByExternal = await db`
    SELECT id, raw_hash
    FROM source_items
    WHERE source_id = ${item.sourceId} AND external_id = ${item.externalId}
    FOR UPDATE
  `;
  if (existingByExternal.length && existingByExternal[0].raw_hash === rawHash) {
    const itemId = existingByExternal[0].id as string;
    const currentRevision = await db`
      SELECT id
      FROM source_item_revisions
      WHERE source_item_id = ${itemId} AND is_current
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    return {
      id: itemId,
      revisionId: (currentRevision[0]?.id as string | undefined) ?? (await firstRevisionForSourceItem(db, itemId)),
      provenanceFamilyId: await provenanceFamilyForSourceItem(db, itemId, item.collectionId, lineageId),
      duplicate: true,
      materialChange: false,
    };
  }
  const existingByHash = await db`
    SELECT id
    FROM source_items
    WHERE source_id = ${item.sourceId} AND raw_hash = ${rawHash}
    LIMIT 1
  `;
  if (existingByHash.length) {
    const itemId = existingByHash[0].id as string;
    const currentRevision = await db`
      SELECT id
      FROM source_item_revisions
      WHERE source_item_id = ${itemId} AND is_current
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    return {
      id: itemId,
      revisionId: (currentRevision[0]?.id as string | undefined) ?? (await firstRevisionForSourceItem(db, itemId)),
      provenanceFamilyId: await provenanceFamilyForSourceItem(db, itemId, item.collectionId, lineageId),
      duplicate: true,
      materialChange: false,
    };
  }

  const excerpt = retainedExcerpt(item.text, policy);
  const revisionId = id("srcrev");
  if (existingByExternal.length) {
    const itemId = existingByExternal[0].id as string;
    await db`UPDATE source_item_revisions SET is_current = false WHERE source_item_id = ${itemId} AND is_current`;
    await db`
      UPDATE source_items
      SET game_id = ${item.collectionId}, url = ${item.url}, canonical_url = ${item.url.startsWith("urn:") ? null : item.url},
        title = ${item.title}, text_excerpt = ${excerpt}, raw_hash = ${rawHash}, lineage_id = ${lineageId},
        source_strength = ${item.sourceStrength}, publication_mode = ${item.publicationMode}, discovered_at = ${item.discoveredAt},
        published_at = ${item.publishedAt}, input_kind = ${item.inputKind}, content_type = ${item.contentType}, language = ${item.language},
        retention_until = ${retentionUntil(policy)}, provenance_status = 'normalized', content_purged_at = null,
        submitted_by = ${submittedBy}
      WHERE id = ${itemId}
    `;
    await db`
      INSERT INTO source_item_revisions (id, source_item_id, raw_hash, excerpt, content_type, http_status, is_current, processing_version, title, content)
      VALUES (${revisionId}, ${itemId}, ${rawHash}, ${excerpt}, ${item.contentType}, ${item.inputKind === "url" || item.inputKind === "rss" ? 200 : null}, true, ${item.processingVersion ?? null}, ${item.title}, ${excerpt})
    `;
    return {
      id: itemId,
      revisionId,
      provenanceFamilyId: await provenanceFamilyForSourceItem(db, itemId, item.collectionId, lineageId),
      duplicate: false,
      materialChange: true,
    };
  }

  const itemId = id("src");
  await db`
    INSERT INTO source_items (id, source_id, game_id, external_id, url, canonical_url, title, text_excerpt, raw_hash, lineage_id, source_strength, publication_mode, public_visibility, discovered_at, published_at, input_kind, content_type, language, retention_until, provenance_status, submitted_by)
    VALUES (${itemId}, ${item.sourceId}, ${item.collectionId}, ${item.externalId}, ${item.url}, ${item.url.startsWith("urn:") ? null : item.url}, ${item.title}, ${excerpt}, ${rawHash}, ${lineageId}, ${item.sourceStrength}, ${item.publicationMode}, false, ${item.discoveredAt}, ${item.publishedAt}, ${item.inputKind}, ${item.contentType}, ${item.language}, ${retentionUntil(policy)}, 'normalized', ${submittedBy})
  `;
  await db`
    INSERT INTO source_item_revisions (id, source_item_id, raw_hash, excerpt, content_type, http_status, is_current, processing_version, title, content)
    VALUES (${revisionId}, ${itemId}, ${rawHash}, ${excerpt}, ${item.contentType}, ${item.inputKind === "url" || item.inputKind === "rss" ? 200 : null}, true, ${item.processingVersion ?? null}, ${item.title}, ${excerpt})
  `;
  return {
    id: itemId,
    revisionId,
    provenanceFamilyId: await provenanceFamilyForSourceItem(db, itemId, item.collectionId, lineageId),
    duplicate: false,
    materialChange: false,
  };
}

async function firstRevisionForSourceItem(db: Db, sourceItemId: string): Promise<string> {
  const revisions = await db`
    SELECT id
    FROM source_item_revisions
    WHERE source_item_id = ${sourceItemId}
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `;
  if (!revisions.length) throw new Error(`Source item ${sourceItemId} has no source revisions`);
  return revisions[0].id as string;
}

export async function createEvent(db: Db, input: { collectionId: string; sourceItemId: string; newsworthiness: number; disposition: string; existingArticleId?: string | null }): Promise<string> {
  const eventId = id("evt");
  await db`
    INSERT INTO events (id, game_id, source_item_id, newsworthiness, disposition, existing_article_id)
    VALUES (${eventId}, ${input.collectionId}, ${input.sourceItemId}, ${input.newsworthiness}, ${input.disposition}, ${input.existingArticleId ?? null})
  `;
  return eventId;
}

// Resolves (or creates) the canonical claim for a claim row and links it.
// Claims are the per-source-item records; canonical claims are the stable
// cross-source identity. Legacy claim rows without a canonical link resolve
// lazily here on their next touch.
async function resolveCanonicalClaimForRow(db: Db, claimId: string, collectionId: string, subject: string, predicate: string, value: string, qualifiers: Record<string, string>): Promise<string> {
  const key = canonicalClaimKey({ subject, predicate, value, qualifiers });
  const canonical = await db`
    INSERT INTO canonical_claims (id, game_id, subject, predicate, value, qualifiers, canonical_key)
    VALUES (${id("cc")}, ${collectionId}, ${subject}, ${predicate}, ${value}, ${JSON.stringify(qualifiers)}, ${key})
    ON CONFLICT (game_id, canonical_key) DO UPDATE SET canonical_key = EXCLUDED.canonical_key
    RETURNING id
  `;
  const canonicalClaimId = canonical[0].id as string;
  await db`UPDATE claims SET canonical_claim_id = ${canonicalClaimId} WHERE id = ${claimId}`;
  return canonicalClaimId;
}

export async function ensureCanonicalClaimsForSourceItem(db: Db, sourceItemId: string): Promise<number> {
  const unresolved = await db`
    SELECT id, game_id, subject, predicate, value, qualifiers
    FROM claims
    WHERE source_item_id = ${sourceItemId} AND canonical_claim_id IS NULL
  `;
  for (const claim of unresolved as Array<Record<string, unknown>>) {
    const qualifiers = typeof claim.qualifiers === "string" ? JSON.parse(claim.qualifiers) : claim.qualifiers as Record<string, string>;
    await resolveCanonicalClaimForRow(db, claim.id as string, claim.game_id as string, claim.subject as string, claim.predicate as string, claim.value as string, qualifiers);
  }
  return unresolved.length;
}

// The latest completed analysis run for a revision. A revision may have many
// runs over time; only the newest completed one is current for state
// derivation, review gates, and confidence.
export async function insertClaim(
  db: Db,
  item: NormalizedSourceItem,
  sourceItemId: string,
  sourceItemRevisionId: string,
  analysisRunId: string,
  provenanceFamilyId: string,
  claim: NormalizedSourceItem["claims"][number],
  lineageId: string,
): Promise<{ claimId: string; canonicalClaimId: string }> {
  let claimId = id("clm");
  const existing = await db`SELECT id, canonical_claim_id, qualifiers FROM claims WHERE source_item_id = ${sourceItemId} AND subject = ${claim.subject} AND predicate = ${claim.predicate} AND value = ${claim.value}`;
  let canonicalClaimId: string;
  if (existing.length) {
    claimId = existing[0].id as string;
    const qualifiers = typeof (existing[0] as Record<string, unknown>).qualifiers === "string"
      ? JSON.parse((existing[0] as Record<string, unknown>).qualifiers as string)
      : (existing[0] as Record<string, unknown>).qualifiers as Record<string, string>;
    canonicalClaimId = (existing[0].canonical_claim_id as string | null) ?? await resolveCanonicalClaimForRow(db, claimId, item.collectionId, claim.subject, claim.predicate, claim.value, qualifiers);
  } else {
    await db`
      INSERT INTO claims (id, game_id, source_item_id, subject, predicate, value, qualifiers, spoiler_tags, exploit_class, evidence_level, attribution_type, statement, editorial_assessment, state)
      VALUES (${claimId}, ${item.collectionId}, ${sourceItemId}, ${claim.subject}, ${claim.predicate}, ${claim.value}, ${JSON.stringify(claim.qualifiers)}, ${JSON.stringify(claim.spoilerTags)}, ${claim.exploitClass}, ${claim.evidenceLevel}, ${claim.attributionType}, ${claim.statement}, ${claim.editorialAssessment}, 'unverified')
    `;
    canonicalClaimId = await resolveCanonicalClaimForRow(db, claimId, item.collectionId, claim.subject, claim.predicate, claim.value, claim.qualifiers);
  }
  const existingEvidence = await db`
    SELECT id FROM evidence
    WHERE claim_id = ${claimId} AND analysis_run_id = ${analysisRunId}
    LIMIT 1
  `;
  if (!existingEvidence.length) {
    await db`
      INSERT INTO evidence (id, claim_id, source_item_id, source_item_revision_id, analysis_run_id, provenance_family_id, stance, evidence_type, excerpt, start_ms, end_ms, lineage_id)
      VALUES (${id("evd")}, ${claimId}, ${sourceItemId}, ${sourceItemRevisionId}, ${analysisRunId}, ${provenanceFamilyId}, ${claim.stance}, ${claim.evidenceType}, ${claim.excerpt}, ${claim.startMs}, ${claim.endMs}, ${lineageId})
    `;
  }
  return { claimId, canonicalClaimId };
}

function parseAnalysisRun(row: Record<string, unknown>): import("@gameintel/contracts").AnalysisRunInfo {
  return {
    id: row.id as string,
    sourceItemRevisionId: row.source_item_revision_id as string,
    processingVersion: (row.processing_version as string | null) ?? null,
    claimExtractorVersion: (row.claim_extractor_version as string | null) ?? null,
    confidenceModelVersion: (row.confidence_model_version as string | null) ?? null,
    status: row.status as "completed" | "superseded",
    triggeredBy: (row.triggered_by as string | null) ?? null,
    triggerReason: (row.trigger_reason as string) ?? "",
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
  };
}

export async function getAnalysisRun(
  db: Db,
  sourceItemRevisionId: string,
  versions: import("@gameintel/contracts").AnalysisVersions,
): Promise<import("@gameintel/contracts").AnalysisRunInfo | null> {
  const rows = await db`
    SELECT *
    FROM analysis_runs
    WHERE source_item_revision_id = ${sourceItemRevisionId}
      AND status = 'completed'
      AND processing_version = ${versions.processingVersion}
      AND claim_extractor_version = ${versions.claimExtractorVersion}
      AND confidence_model_version = ${versions.confidenceModelVersion}
    LIMIT 1
  `;
  return rows.length ? parseAnalysisRun(rows[0] as Record<string, unknown>) : null;
}

export async function createAnalysisRun(
  db: Db,
  input: { sourceItemRevisionId: string; versions: import("@gameintel/contracts").AnalysisVersions; triggeredBy?: string | null; triggerReason: string },
): Promise<import("@gameintel/contracts").AnalysisRunInfo> {
  const existing = await getAnalysisRun(db, input.sourceItemRevisionId, input.versions);
  if (existing) return existing;
  const runId = id("arun");
  await db`
    UPDATE analysis_runs
    SET status = 'superseded'
    WHERE source_item_revision_id = ${input.sourceItemRevisionId} AND status = 'completed'
  `;
  await db`
    INSERT INTO analysis_runs (id, source_item_revision_id, processing_version, claim_extractor_version, confidence_model_version, status, triggered_by, trigger_reason, completed_at)
    VALUES (${runId}, ${input.sourceItemRevisionId}, ${input.versions.processingVersion}, ${input.versions.claimExtractorVersion}, ${input.versions.confidenceModelVersion}, 'completed', ${input.triggeredBy ?? null}, ${input.triggerReason}, now())
    ON CONFLICT (source_item_revision_id, processing_version, claim_extractor_version, confidence_model_version) WHERE status = 'completed' DO NOTHING
  `;
  const rows = await db`
    SELECT *
    FROM analysis_runs
    WHERE id = ${runId} OR (
      source_item_revision_id = ${input.sourceItemRevisionId}
        AND status = 'completed'
        AND processing_version = ${input.versions.processingVersion}
        AND claim_extractor_version = ${input.versions.claimExtractorVersion}
        AND confidence_model_version = ${input.versions.confidenceModelVersion}
    )
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `;
  if (!rows.length) throw new Error("Analysis run could not be created");
  return parseAnalysisRun(rows[0] as Record<string, unknown>);
}

export async function listAnalysisRuns(db: Db, sourceItemRevisionId: string): Promise<import("@gameintel/contracts").AnalysisRunInfo[]> {
  const rows = await db`
    SELECT *
    FROM analysis_runs
    WHERE source_item_revision_id = ${sourceItemRevisionId}
    ORDER BY completed_at DESC, id DESC
  `;
  return rows.map((row) => parseAnalysisRun(row as Record<string, unknown>));
}

export async function getRevisionForAnalysis(db: Db, revisionId: string): Promise<import("@gameintel/contracts").RevisionForAnalysis | null> {
  const rows = await db`
    SELECT revision.id, revision.source_item_id, revision.title, revision.content, revision.raw_hash,
      revision.processing_version, revision.content_purged_at,
      item.game_id, item.external_id, item.url, item.source_strength, item.publication_mode,
      item.discovered_at, item.published_at, item.input_kind, item.content_type, item.language,
      item.lineage_id, item.submitted_by, item.source_id,
      source.type, source.canonical_url, source.public_citation_url,
      source.publication_mode AS source_publication_mode, source.policy, source.enabled
    FROM source_item_revisions revision
    JOIN source_items item ON item.id = revision.source_item_id
    JOIN sources source ON source.id = item.source_id
    WHERE revision.id = ${revisionId}
    LIMIT 1
  `;
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    id: row.id as string,
    sourceItemId: row.source_item_id as string,
    title: (row.title as string | null) ?? "",
    content: (row.content as string | null) ?? "",
    rawHash: row.raw_hash as string,
    processingVersion: (row.processing_version as string | null) ?? null,
    contentPurged: row.content_purged_at !== null,
    sourceItem: {
      collectionId: row.game_id as string,
      externalId: row.external_id as string,
      url: row.url as string,
      sourceStrength: SourceStrengthSchema.parse(row.source_strength),
      publicationMode: row.publication_mode as PublicationMode,
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
      publicationMode: row.source_publication_mode as PublicationMode,
      policy: SourcePolicySchema.parse(typeof row.policy === "string" ? JSON.parse(row.policy) : row.policy),
      enabled: row.enabled === true,
    },
  };
}

// Canonical resolution: the newest non-retracted article whose references
// point at any member claim of the given canonical claims. This routes a
// revised high-newsworthiness source to its existing knowledge/publication
// object (update_existing) instead of spawning a parallel draft.
export async function resolveExistingArticleForCanonicalClaims(db: Db, canonicalClaimIds: string[]): Promise<string | null> {
  if (!canonicalClaimIds.length) return null;
  const rows = await db`
    SELECT candidate.id
    FROM (
      SELECT DISTINCT article.id, article.created_at
      FROM articles article
      JOIN article_sources article_source ON article_source.article_id = article.id
      JOIN claims claim ON claim.id = article_source.claim_id
      WHERE COALESCE(claim.canonical_claim_id, claim.id) = ANY(${db.array([...new Set(canonicalClaimIds)])})
        AND article.status <> 'retracted'
    ) candidate
    ORDER BY candidate.created_at DESC
    LIMIT 1
  `;
  return rows.length ? rows[0].id as string : null;
}

// Refreshes every article that references any member claim of the given
// canonical claims. Used after a source revision is re-analyzed so that new
// evidence (which needs fresh review) demotes stale publication state and
// contradiction from any member source propagates to every referencing
// article.
export async function refreshArticlesForCanonicalClaims(db: Db, canonicalClaimIds: string[], auditAction: string, auditReason: string): Promise<string[]> {
  if (!canonicalClaimIds.length) return [];
  const articles = await db`
    SELECT DISTINCT article_source.article_id
    FROM article_sources article_source
    JOIN claims claim ON claim.id = article_source.claim_id
    WHERE COALESCE(claim.canonical_claim_id, claim.id) = ANY(${db.array([...new Set(canonicalClaimIds)])})
  `;
  const articleIds = articles.map((article) => article.article_id as string);
  for (const articleId of articleIds) {
    await refreshArticleEvidenceState(db, articleId);
    await refreshArticleConfidence(db, articleId);
    await audit(db, "system", auditAction, "article", articleId, auditReason);
  }
  return articleIds;
}

export async function linkSourceItemProvenance(db: Db, input: {
  sourceItemId: string;
  relatedSourceItemId: string;
  relationship: ProvenanceRelationship;
  clusteringMethod?: ProvenanceClusteringMethod;
  reviewerId: string;
  notes?: string;
}): Promise<void> {
  const relationship = ProvenanceRelationshipSchema.parse(input.relationship);
  const clusteringMethod = ProvenanceClusteringMethodSchema.parse(input.clusteringMethod ?? "manual");
  if (!input.reviewerId.trim()) throw new Error("A provenance reviewer is required");
  if (input.sourceItemId === input.relatedSourceItemId) throw new Error("A source item cannot be related to itself");

  await inTransaction(db, async (transaction) => {
    const items = await transaction`
      SELECT id, game_id, lineage_id
      FROM source_items
      WHERE id = ANY(${transaction.array([input.sourceItemId, input.relatedSourceItemId])})
      FOR UPDATE
    `;
    if (items.length !== 2) throw new Error("Both source items must exist");
    const sourceItem = items.find((item) => item.id === input.sourceItemId)! as Record<string, unknown>;
    const relatedItem = items.find((item) => item.id === input.relatedSourceItemId)! as Record<string, unknown>;
    if (sourceItem.game_id !== relatedItem.game_id) throw new Error("Provenance relationships cannot cross collections");
    const sourceFamilyId = await provenanceFamilyForSourceItem(
      transaction,
      input.sourceItemId,
      sourceItem.game_id as string,
      sourceItem.lineage_id as string,
    );
    const relatedFamilyId = await provenanceFamilyForSourceItem(
      transaction,
      input.relatedSourceItemId,
      relatedItem.game_id as string,
      relatedItem.lineage_id as string,
    );
    const sharesFamily = ["copied_from", "quoted_from", "derived_from", "same_media", "same_source_family"].includes(relationship);
    const provenanceFamilyId = sharesFamily ? relatedFamilyId : sourceFamilyId;
    const notes = input.notes?.slice(0, 2_000) ?? "";
    await transaction`
      INSERT INTO provenance_relationships (id, source_item_id, related_source_item_id, relationship, clustering_method, reviewer_id, notes)
      VALUES (${id("provrel")}, ${input.sourceItemId}, ${input.relatedSourceItemId}, ${relationship}, ${clusteringMethod}, ${input.reviewerId}, ${notes})
      ON CONFLICT (source_item_id, related_source_item_id, relationship) DO UPDATE SET
        clustering_method = EXCLUDED.clustering_method,
        reviewer_id = EXCLUDED.reviewer_id,
        notes = EXCLUDED.notes
    `;
    await transaction`
      UPDATE source_item_provenance
      SET provenance_family_id = ${provenanceFamilyId}, relationship = ${relationship},
        derived_from_source_item_id = ${input.relatedSourceItemId}, clustering_method = ${clusteringMethod},
        reviewer_id = ${input.reviewerId}, notes = ${notes}, updated_at = now()
      WHERE source_item_id = ${input.sourceItemId}
    `;
    await transaction`
      UPDATE evidence
      SET provenance_family_id = ${provenanceFamilyId}
      WHERE source_item_id = ${input.sourceItemId}
    `;
    const affectedArticles = await transaction`
      SELECT DISTINCT article_source.article_id
      FROM article_sources article_source
      JOIN claims claim ON claim.id = article_source.claim_id
      LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
      JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
      JOIN evidence linked_evidence ON linked_evidence.claim_id = member.id
      WHERE linked_evidence.source_item_id = ${input.sourceItemId}
    `;
    for (const article of affectedArticles) await refreshArticleConfidence(transaction, article.article_id as string);
    await audit(
      transaction,
      input.reviewerId,
      `provenance.${relationship}`,
      "source_item",
      input.sourceItemId,
      notes || `Related to ${input.relatedSourceItemId}`,
    );
  });
}

function parseJob(row: Record<string, unknown>): IngestionJob {
  const json = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
  return {
    jobKey: row.job_key as string,
    jobType: row.job_type as string,
    status: row.status as string,
    payload: json<SourceIngestJobPayload>(row.payload),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    leaseToken: row.lease_token as string | null,
    leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at as string).toISOString() : null,
    lastError: row.last_error as string | null,
    result: row.result === null ? null : json(row.result),
  };
}

function parseIngestionWorkerHeartbeat(row: Record<string, unknown>): IngestionWorkerHeartbeat {
  return {
    workerId: row.worker_id as string,
    workerType: row.worker_type as "source_ingest",
    currentJobKey: row.current_job_key as string | null,
    lastError: row.last_error as string | null,
    lastSeenAt: new Date(row.last_seen_at as string).toISOString(),
  };
}

export async function heartbeatIngestionWorker(db: Db, input: {
  workerId: string;
  workerType: "source_ingest";
  currentJobKey?: string | null;
  // Omit this to retain an error until a successful job clears it with null.
  lastError?: string | null;
}): Promise<void> {
  const workerId = input.workerId.trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(workerId)) throw new Error("A valid ingestion worker id is required");
  const currentJobKey = input.currentJobKey ?? null;
  const retainLastError = input.lastError === undefined;
  const lastError = input.lastError?.slice(0, 2_000) ?? null;
  await db`
    INSERT INTO ingestion_worker_heartbeats (worker_id, worker_type, current_job_key, last_error, last_seen_at, updated_at)
    VALUES (${workerId}, ${input.workerType}, ${currentJobKey}, ${lastError}, now(), now())
    ON CONFLICT (worker_id) DO UPDATE SET
      worker_type = EXCLUDED.worker_type,
      current_job_key = EXCLUDED.current_job_key,
      last_error = CASE WHEN ${retainLastError} THEN ingestion_worker_heartbeats.last_error ELSE EXCLUDED.last_error END,
      last_seen_at = now(),
      updated_at = now()
  `;
}

export async function listIngestionWorkerHeartbeats(db: Db): Promise<IngestionWorkerHeartbeat[]> {
  const rows = await db`
    SELECT worker_id, worker_type, current_job_key, last_error, last_seen_at
    FROM ingestion_worker_heartbeats
    ORDER BY last_seen_at DESC, worker_id
  `;
  return rows.map((row) => parseIngestionWorkerHeartbeat(row as Record<string, unknown>));
}

export async function getIngestionQueueStatus(db: Db, staleAfterMs = 30_000): Promise<IngestionQueueStatus> {
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 3_600_000) {
    throw new Error("Ingestion worker stale threshold must be between 1 second and 1 hour");
  }
  const [jobs, workers] = await Promise.all([
    db`
      SELECT
        count(*) FILTER (WHERE status = 'queued')::int AS queued,
        count(*) FILTER (WHERE status = 'running')::int AS running,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE status = 'dead')::int AS dead,
        min(available_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
      FROM jobs
      WHERE job_type IN ('source_ingest', 'source_discover')
    `,
    db`
      SELECT
        count(*) FILTER (WHERE last_seen_at >= ${new Date(Date.now() - staleAfterMs)})::int AS active_workers,
        count(*) FILTER (WHERE last_seen_at < ${new Date(Date.now() - staleAfterMs)})::int AS stale_workers
      FROM ingestion_worker_heartbeats
      WHERE worker_type = 'source_ingest'
    `,
  ]);
  const job = jobs[0] as Record<string, unknown> | undefined;
  const worker = workers[0] as Record<string, unknown> | undefined;
  return {
    queued: Number(job?.queued ?? 0),
    running: Number(job?.running ?? 0),
    completed: Number(job?.completed ?? 0),
    dead: Number(job?.dead ?? 0),
    oldestQueuedAt: job?.oldest_queued_at ? new Date(job.oldest_queued_at as string).toISOString() : null,
    activeWorkers: Number(worker?.active_workers ?? 0),
    staleWorkers: Number(worker?.stale_workers ?? 0),
  };
}

export async function listRecentIngestionJobs(db: Db, limit = 25): Promise<IngestionJob[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Ingestion job list limit must be between 1 and 100");
  const rows = await db`
    SELECT *
    FROM jobs
    WHERE job_type IN ('source_ingest', 'source_discover')
    ORDER BY updated_at DESC, job_key
    LIMIT ${limit}
  `;
  return rows.map((row) => parseJob(row as Record<string, unknown>));
}

export async function enqueueSourceIngestJob(db: Db, input: SourceIngestJobPayload): Promise<SourceIngestEnqueueResult> {
  const collectionId = input.collectionId.trim();
  const sourceId = input.sourceId.trim();
  if (!collectionId || !sourceId) throw new Error("Source ingestion jobs require a collection and source");
  const url = canonicalizeUrl(PublicHttpUrlSchema.parse(input.url));
  const payload: SourceIngestJobPayload = { collectionId, sourceId, url, profileId: input.profileId?.trim() || undefined };
  const jobKey = id("source_ingest");
  const dedupeKey = `source_ingest:${collectionId}:${sourceId}:${hashText(url)}`;
  const inserted = await db`
    INSERT INTO jobs (job_key, job_type, status, payload, priority, max_attempts, available_at, updated_at, dedupe_key)
    VALUES (${jobKey}, 'source_ingest', 'queued', ${JSON.stringify(payload)}, 100, 5, now(), now(), ${dedupeKey})
    ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING
    RETURNING job_key, status
  `;
  if (inserted.length) return { jobKey, dedupeKey, duplicate: false, status: inserted[0].status as string };
  const existing = await db`
    SELECT job_key, status
    FROM jobs
    WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running')
    LIMIT 1
  `;
  if (!existing.length) throw new Error("Source ingestion job was not persisted");
  return { jobKey: existing[0].job_key as string, dedupeKey, duplicate: true, status: existing[0].status as string };
}

export async function enqueueSourceDiscoverJob(db: Db, input: SourceDiscoverJobPayload): Promise<SourceIngestEnqueueResult> {
  const collectionId = input.collectionId.trim();
  const sourceId = input.sourceId.trim();
  if (!collectionId || !sourceId) throw new Error("Source discovery jobs require a collection and source");
  const feedUrl = canonicalizeUrl(PublicHttpUrlSchema.parse(input.feedUrl));
  const payload: SourceDiscoverJobPayload = { collectionId, sourceId, feedUrl, profileId: input.profileId?.trim() || undefined };
  const jobKey = id("source_discover");
  const dedupeKey = `source_discover:${collectionId}:${sourceId}:${hashText(feedUrl)}`;
  const inserted = await db`
    INSERT INTO jobs (job_key, job_type, status, payload, priority, max_attempts, available_at, updated_at, dedupe_key)
    VALUES (${jobKey}, 'source_discover', 'queued', ${JSON.stringify(payload)}, 100, 5, now(), now(), ${dedupeKey})
    ON CONFLICT (dedupe_key) WHERE status IN ('queued', 'running') DO NOTHING
    RETURNING job_key, status
  `;
  if (inserted.length) return { jobKey, dedupeKey, duplicate: false, status: inserted[0].status as string };
  const existing = await db`
    SELECT job_key, status
    FROM jobs
    WHERE dedupe_key = ${dedupeKey} AND status IN ('queued', 'running')
    LIMIT 1
  `;
  if (!existing.length) throw new Error("Source discovery job was not persisted");
  return { jobKey: existing[0].job_key as string, dedupeKey, duplicate: true, status: existing[0].status as string };
}

export async function claimIngestionJob(
  db: Db,
  workerId: string,
  jobTypes: string[] = ["source_ingest"],
  leaseMs = 60_000,
): Promise<IngestionJob | null> {
  if (!workerId.trim() || !jobTypes.length || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error("Invalid ingestion job lease request");
  }
  return inTransaction(db, async (transaction) => {
    await transaction`
      UPDATE jobs
      SET status = 'dead', completed_at = now(), lease_token = NULL, lease_expires_at = NULL, updated_at = now(),
        last_error = COALESCE(last_error, 'Job lease expired after maximum attempts')
      WHERE status = 'running' AND lease_expires_at <= now() AND attempts >= max_attempts
    `;
    await transaction`
      UPDATE jobs
      SET status = 'queued', leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, available_at = now(), updated_at = now()
      WHERE status = 'running' AND lease_expires_at <= now() AND attempts < max_attempts
    `;
    const candidates = await transaction`
      SELECT *
      FROM jobs
      WHERE status = 'queued' AND available_at <= now() AND job_type = ANY(${transaction.array(jobTypes)})
      ORDER BY priority DESC, available_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!candidates.length) return null;
    const jobKey = candidates[0].job_key as string;
    const leaseToken = id("lease");
    const leased = await transaction`
      UPDATE jobs
      SET status = 'running', attempts = attempts + 1, leased_by = ${workerId}, lease_token = ${leaseToken},
        lease_expires_at = ${new Date(Date.now() + leaseMs)}, updated_at = now(), last_error = NULL
      WHERE job_key = ${jobKey}
      RETURNING *
    `;
    return parseJob(leased[0] as Record<string, unknown>);
  });
}

// Fences an ingestion transaction against lease loss. The job row is locked
// FOR UPDATE for the remainder of the transaction, so the reaper cannot
// requeue or reclaim it mid-transaction. A worker whose lease was reclaimed
// while stalled fails this check and its transaction rolls back.
export async function assertIngestionJobLeaseHeld(db: Db, jobKey: string, leaseToken: string): Promise<void> {
  if (!jobKey.trim() || !leaseToken.trim()) throw new Error("An ingestion job key and lease token are required");
  const held = await db`
    SELECT job_key
    FROM jobs
    WHERE job_key = ${jobKey} AND status = 'running' AND lease_token = ${leaseToken}
    FOR UPDATE
  `;
  if (!held.length) throw new IngestionLeaseLostError(jobKey);
}

export async function completeIngestionJob(db: Db, jobKey: string, leaseToken: string, result: unknown): Promise<void> {
  const completed = await db`
    UPDATE jobs
    SET status = 'completed', result = ${JSON.stringify(result)}, completed_at = now(),
      lease_token = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE job_key = ${jobKey} AND status = 'running' AND lease_token = ${leaseToken}
    RETURNING job_key
  `;
  if (!completed.length) throw new IngestionLeaseLostError(jobKey);
}

export async function failIngestionJob(db: Db, jobKey: string, leaseToken: string, error: unknown, retryable = true): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const jobs = await transaction`
      SELECT attempts, max_attempts
      FROM jobs
      WHERE job_key = ${jobKey} AND status = 'running' AND lease_token = ${leaseToken}
      FOR UPDATE
    `;
    if (!jobs.length) throw new IngestionLeaseLostError(jobKey);
    const attempts = Number(jobs[0].attempts);
    const maxAttempts = Number(jobs[0].max_attempts);
    const terminal = !retryable || attempts >= maxAttempts;
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, attempts - 1));
    const message = error instanceof Error ? error.message : String(error);
    await transaction`
      UPDATE jobs
      SET status = ${terminal ? "dead" : "queued"}, last_error = ${message.slice(0, 2_000)},
        available_at = ${new Date(Date.now() + delayMs)}, lease_token = NULL, lease_expires_at = NULL,
        completed_at = ${terminal ? new Date() : null}, updated_at = now()
      WHERE job_key = ${jobKey}
    `;
  });
}

export async function renewIngestionJobLease(db: Db, jobKey: string, leaseToken: string, durationMs: number): Promise<boolean> {
  if (!jobKey.trim() || !leaseToken.trim() || !Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
    throw new Error("Invalid ingestion job lease renewal request");
  }
  const renewed = await db`
    UPDATE jobs
    SET lease_expires_at = now() + make_interval(secs => ${durationMs / 1000}), updated_at = now()
    WHERE job_key = ${jobKey} AND status = 'running' AND lease_token = ${leaseToken}
    RETURNING job_key
  `;
  return renewed.length > 0;
}

export async function getIngestionJob(db: Db, jobKey: string): Promise<IngestionJob | null> {
  const jobs = await db`SELECT * FROM jobs WHERE job_key = ${jobKey} LIMIT 1`;
  return jobs.length ? parseJob(jobs[0] as Record<string, unknown>) : null;
}

export async function acquireSourceFetchSlot(db: Db, sourceId: string, requestsPerMinute: number): Promise<number> {
  if (!sourceId.trim() || !Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
    throw new Error("Source fetch pacing requires a positive request rate");
  }
  return inTransaction(db, async (transaction) => {
    await transaction`
      INSERT INTO source_fetch_pacing (source_id, next_allowed_at)
      VALUES (${sourceId}, now())
      ON CONFLICT (source_id) DO NOTHING
    `;
    const rows = await transaction`SELECT next_allowed_at FROM source_fetch_pacing WHERE source_id = ${sourceId} FOR UPDATE`;
    const nextAllowedAt = new Date(rows[0].next_allowed_at as string).getTime();
    const scheduledAt = Math.max(Date.now(), nextAllowedAt);
    await transaction`
      UPDATE source_fetch_pacing
      SET next_allowed_at = ${new Date(scheduledAt + 60_000 / requestsPerMinute)}, updated_at = now()
      WHERE source_id = ${sourceId}
    `;
    return Math.max(0, scheduledAt - Date.now());
  });
}

export async function createArticleDraft(db: Db, input: {
  collectionId: string; title: string; description: string; body: ArticleBody;
  newsworthiness: number; confidence: number;
  sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
}): Promise<string> {
  const articleId = id("art");
  const slug = `${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}-${articleId.slice(-8)}`;
  await db`
    INSERT INTO articles (id, game_id, slug, title, seo_title, description, body, newsworthiness, confidence, article_sources_complete)
    VALUES (${articleId}, ${input.collectionId}, ${slug}, ${input.title}, ${input.title}, ${input.description}, ${JSON.stringify(input.body)}, ${input.newsworthiness}, ${input.confidence}, false)
  `;
  await db`
    INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary)
    VALUES (${id("rev")}, ${articleId}, 1, ${JSON.stringify(input.body)}, 'Initial AI-assisted draft')
  `;
  for (const source of input.sourceRefs) {
    await db`
    INSERT INTO article_sources (id, article_id, source_id, claim_id, citation_label, public_citation_url)
    VALUES (${id("arts")}, ${articleId}, ${source.sourceId}, ${source.claimId}, ${source.citationLabel}, ${source.publicCitationUrl})
    `;
  }
  return articleId;
}

// Refreshes an existing article from a re-analyzed source revision. The
// article_sources references owned by that source item are replaced by the
// new claim references, a new article_revisions row records the change, and
// evidence state/confidence are re-derived (a published article demotes and
// its materialized public record is dropped until evidence is re-reviewed).
export async function updateExistingArticle(db: Db, input: {
  articleId: string;
  sourceItemId: string;
  title: string;
  description: string;
  body: ArticleBody;
  newsworthiness: number;
  confidence: number;
  sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
}): Promise<void> {
  await inTransaction(db, async (transaction) => {
    await lockArticle(transaction, input.articleId);
    const maxRevision = await transaction`
      SELECT COALESCE(max(revision_number), 0) AS revision_number
      FROM article_revisions
      WHERE article_id = ${input.articleId}
    `;
    const revisionNumber = Number((maxRevision[0] as Record<string, unknown> | undefined)?.revision_number ?? 0) + 1;
    await transaction`
      UPDATE articles
      SET title = ${input.title}, seo_title = ${input.title}, description = ${input.description},
        body = ${JSON.stringify(input.body)}, newsworthiness = ${input.newsworthiness},
        confidence = ${input.confidence}, updated_at = now()
      WHERE id = ${input.articleId}
    `;
    await transaction`
      INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary)
      VALUES (${id("rev")}, ${input.articleId}, ${revisionNumber}, ${JSON.stringify(input.body)}, 'Re-analyzed source revision')
    `;
    await transaction`
      DELETE FROM article_sources
      WHERE article_id = ${input.articleId}
        AND claim_id IN (SELECT id FROM claims WHERE source_item_id = ${input.sourceItemId})
    `;
    for (const source of input.sourceRefs) {
      await transaction`
        INSERT INTO article_sources (id, article_id, source_id, claim_id, citation_label, public_citation_url)
        VALUES (${id("arts")}, ${input.articleId}, ${source.sourceId}, ${source.claimId}, ${source.citationLabel}, ${source.publicCitationUrl})
      `;
    }
    await refreshArticleEvidenceState(transaction, input.articleId);
    await refreshArticleConfidence(transaction, input.articleId);
  });
}

function parseArticle(row: Record<string, unknown>): Article {
  const jsonValue = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
  return ArticleSchema.parse({
    id: row.id, collectionId: row.game_id, slug: row.slug, title: row.title, seoTitle: row.seo_title,
    description: row.description, body: ArticleBodySchema.parse(jsonValue(row.body)), status: row.status,
    newsworthiness: Number(row.newsworthiness), confidence: Number(row.confidence),
    sourceReviewCompleted: row.source_review_completed, editorReviewCompleted: row.editor_review_completed,
    articleSourcesComplete: row.article_sources_complete,
    sourceRefs: jsonValue(row.source_refs ?? []),
    coverMedia: row.cover_media ? ArticleCoverMediaSchema.parse(jsonValue(row.cover_media)) : null,
    approvedBy: row.approved_by,
    publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  });
}

const articleSelect = (db: Db) => db`
  SELECT a.*, COALESCE(jsonb_agg(DISTINCT jsonb_build_object('sourceId', ass.source_id, 'claimId', ass.claim_id, 'citationLabel', ass.citation_label, 'publicCitationUrl', ass.public_citation_url)) FILTER (WHERE ass.article_id IS NOT NULL), '[]') AS source_refs,
    cover.cover_media
  FROM articles a
    LEFT JOIN article_sources ass ON ass.article_id = a.id
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'id', ma.id,
        'caption', ma.caption,
        'altText', ma.alt_text,
        'collection', ma.collection,
        'tags', ma.tags,
        'spoilerTags', ma.spoiler_tags,
        'attribution', ma.attribution,
        'sourceUrl', ma.source_url,
        'publicUrl', ma.public_url,
        'selectionSource', am.selection_source,
        'reviewStatus', CASE
          WHEN am.review_status = 'approved' AND ma.review_status = 'approved' THEN 'approved'
          WHEN am.review_status = 'rejected' THEN 'rejected'
          ELSE 'pending'
        END
      ) AS cover_media
      FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
      WHERE am.article_id = a.id AND am.role = 'cover'
      LIMIT 1
    ) cover ON true
`;

export async function getArticle(db: Db, idOrSlug: string): Promise<Article | null> {
  const rows = await db`${articleSelect(db)} WHERE (a.id = ${idOrSlug} OR a.slug = ${idOrSlug}) GROUP BY a.id, cover.cover_media LIMIT 1`;
  return rows.length ? parseArticle(rows[0] as Record<string, unknown>) : null;
}

export async function listArticles(db: Db, collectionId: string): Promise<Article[]> {
  const rows = await db`${articleSelect(db)} WHERE a.game_id = ${collectionId} GROUP BY a.id, cover.cover_media ORDER BY a.created_at DESC`;
  return rows.map((row) => parseArticle(row as Record<string, unknown>));
}

// Public article reads serve the materialized sanitized surface
// (public_article_records), never raw article rows. The table is written at
// publish time from toSafeArticle() by the runtime role.
export async function getPublicArticle(db: Db, idOrSlug: string): Promise<SafeArticle | null> {
  const rows = await db`SELECT public_public_article_get(${idOrSlug}) AS article`;
  return (rows[0] as { article: SafeArticle | null } | undefined)?.article ?? null;
}

export async function listPublicArticles(db: Db, collectionId: string): Promise<SafeArticle[]> {
  const rows = await db`SELECT public_public_article_list(${collectionId}) AS articles`;
  return (rows[0] as { articles: SafeArticle[] } | undefined)?.articles ?? [];
}

export async function materializePublicArticle(db: Db, article: Article): Promise<void> {
  const safe = toSafeArticle(article);
  if (!safe) throw new Error("Cannot materialize a non-public article");
  const now = new Date().toISOString();
  await db`
    INSERT INTO public_article_records (
      article_id, collection_id, slug, title, seo_title, description, body, status, citations, cover_media, published_at, updated_at
    ) VALUES (
      ${safe.id}, ${safe.collectionId}, ${safe.slug}, ${safe.title}, ${safe.seoTitle}, ${safe.description},
      ${db.json(safe.body)}, ${safe.status}, ${db.json(safe.citations)}, ${safe.coverMedia ? db.json(safe.coverMedia) : null},
      ${safe.publishedAt ?? now}, ${safe.updatedAt ?? now}
    )
    ON CONFLICT (article_id) DO UPDATE SET
      collection_id = excluded.collection_id, slug = excluded.slug, title = excluded.title, seo_title = excluded.seo_title,
      description = excluded.description, body = excluded.body, status = excluded.status, citations = excluded.citations,
      cover_media = excluded.cover_media, published_at = excluded.published_at, updated_at = excluded.updated_at
  `;
}

// Keeps the materialized public surface consistent with the article row after
// any mutation that affects public output (publication, evidence demotion,
// cover changes, media approval or revocation). Call this transactionally
// from the same operation that changed the article or its media.
export async function refreshPublicArticleRecord(db: Db, articleId: string, article?: Article | null): Promise<void> {
  const current = article ?? await getArticle(db, articleId);
  if (!current || (current.status !== "published" && current.status !== "updated") || !toSafeArticle(current)) {
    await db`DELETE FROM public_article_records WHERE article_id = ${articleId}`;
    return;
  }
  await materializePublicArticle(db, current);
}

async function lockArticle(db: Db, articleId: string): Promise<Record<string, unknown>> {
  const articles = await db`SELECT id, status FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!articles.length) throw new Error("Article not found");
  await db`SELECT article_id FROM article_sources WHERE article_id = ${articleId} FOR UPDATE`;
  return articles[0] as Record<string, unknown>;
}

function timestamp(value: unknown): number {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

type EvidenceApprovalState = {
  approved: boolean;
  latestReviewAt: number;
  blockedBy: "rejected" | "disputed" | null;
};

async function evidenceApprovalState(
  db: Db,
  evidenceId: string,
  sourceItemRevisionId: string,
  policy: SourcePolicy,
): Promise<EvidenceApprovalState> {
  const reviews = await db`
    SELECT DISTINCT ON (reviewer_id) reviewer_id, decision, created_at
    FROM evidence_reviews
    WHERE evidence_id = ${evidenceId} AND source_item_revision_id = ${sourceItemRevisionId}
    ORDER BY reviewer_id, seq DESC
  `;
  const gate = evidenceReviewGate(
    reviews.map((review) => ({
      reviewerId: review.reviewer_id as string,
      decision: review.decision as EvidenceReviewDecision,
      createdAt: timestamp(review.created_at),
    })),
    policy.evidenceReview,
  );
  const latestReviewAt = reviews.reduce((latest, review) => Math.max(latest, timestamp(review.created_at)), 0);
  return { approved: gate.eligible, latestReviewAt, blockedBy: gate.blockedBy };
}

const sourceStrengthOrder: Record<SourceStrength, number> = {
  UNVERIFIED: 0,
  COMMUNITY: 1,
  TRUSTED_SECONDARY: 2,
  DIRECT_EVIDENCE: 3,
  PRIMARY: 4,
};

export async function calculateClaimConfidence(db: Db, claimId: string): Promise<number> {
  const claims = await db`SELECT game_id, qualifiers, canonical_claim_id FROM claims WHERE id = ${claimId} LIMIT 1`;
  if (!claims.length) throw new Error("Claim not found");
  const claim = claims[0] as Record<string, unknown>;
  // Comparability is defined by canonical identity, not by exact rows: every
  // member claim of the same canonical claim contributes evidence, so two
  // sources describing the same fact converge on one confidence.
  const identity = (claim.canonical_claim_id as string | null) ?? claimId;
  const evidenceRows = await db`
    SELECT e.id AS evidence_id, e.source_item_id, e.provenance_family_id, e.stance, e.evidence_type, e.excerpt, e.start_ms, e.end_ms, e.lineage_id,
      item.source_strength, source.policy, revision.id AS source_item_revision_id,
      provenance.relationship AS provenance_relationship
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
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id AND revision.is_current
    JOIN sources source ON source.id = item.source_id
    LEFT JOIN source_item_provenance provenance ON provenance.source_item_id = e.source_item_id
    WHERE comparable_claim.game_id = ${claim.game_id as string}
      AND COALESCE(comparable_claim.canonical_claim_id, comparable_claim.id) = ${identity}
  `;
  let strongest: SourceStrength = "UNVERIFIED";
  const approvedEvidence: Array<Evidence & { sourceStrength?: SourceStrength }> = [];
  for (const row of evidenceRows as Array<Record<string, unknown>>) {
    const policy = SourcePolicySchema.parse(typeof row.policy === "string" ? JSON.parse(row.policy) : row.policy);
    const review = await evidenceApprovalState(db, row.evidence_id as string, row.source_item_revision_id as string, policy);
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
  const qualifiers = typeof claim.qualifiers === "string" ? JSON.parse(claim.qualifiers) : claim.qualifiers as Record<string, unknown>;
  return calculateConfidence(strongest, approvedEvidence, Object.keys(qualifiers).length > 0 ? 0.9 : 0.5);
}

async function refreshArticleConfidence(db: Db, articleId: string): Promise<number> {
  const claims = await db`
    SELECT DISTINCT claim_id
    FROM article_sources
    WHERE article_id = ${articleId} AND claim_id IS NOT NULL
  `;
  if (!claims.length) return 0;
  const confidences: number[] = [];
  for (const claim of claims) confidences.push(await calculateClaimConfidence(db, claim.claim_id as string));
  const confidence = Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100) / 100;
  await db`UPDATE articles SET confidence = ${confidence} WHERE id = ${articleId}`;
  return confidence;
}

type ArticleEvidenceState = {
  sourceCount: number;
  evidenceCount: number;
  approvedCount: number;
  complete: boolean;
  latestChangeAt: number;
};

async function articleEvidenceState(db: Db, articleId: string): Promise<ArticleEvidenceState> {
  const rows = await db`
    SELECT
      ass.id AS article_source_id,
      ass.updated_at AS article_source_updated_at,
      e.id AS evidence_id,
      e.source_item_revision_id,
      e.created_at AS evidence_created_at,
      revision.is_current AS source_item_revision_current,
      revision.created_at AS source_item_revision_created_at,
      run.status = 'completed'
        AND run.id = (
          SELECT latest_run.id
          FROM analysis_runs latest_run
          WHERE latest_run.source_item_revision_id = revision.id AND latest_run.status = 'completed'
          ORDER BY latest_run.completed_at DESC, latest_run.id DESC
          LIMIT 1
        ) AS analysis_run_current,
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
    WHERE ass.article_id = ${articleId}
  `;
  const references = new Map<string, Set<string>>();
  const evidenceRows = new Map<string, Record<string, unknown>>();
  let latestChangeAt = 0;
  for (const row of rows as Array<Record<string, unknown>>) {
    const referenceId = row.article_source_id as string;
    if (!references.has(referenceId)) references.set(referenceId, new Set());
    latestChangeAt = Math.max(latestChangeAt, timestamp(row.article_source_updated_at));
    const evidenceId = row.evidence_id as string | null;
    if (!evidenceId) continue;
    references.get(referenceId)!.add(evidenceId);
    evidenceRows.set(evidenceId, row);
  }

  let approvedCount = 0;
  for (const [evidenceId, row] of evidenceRows) {
    const sourceItemRevisionId = row.source_item_revision_id as string | null;
    latestChangeAt = Math.max(
      latestChangeAt,
      timestamp(row.evidence_created_at),
      timestamp(row.source_item_revision_created_at),
    );
    if (!sourceItemRevisionId || row.source_item_revision_current !== true || row.analysis_run_current !== true || !row.source_policy) continue;
    const policy = SourcePolicySchema.parse(typeof row.source_policy === "string" ? JSON.parse(row.source_policy) : row.source_policy);
    const review = await evidenceApprovalState(db, evidenceId, sourceItemRevisionId, policy);
    latestChangeAt = Math.max(latestChangeAt, review.latestReviewAt);
    if (review.approved) approvedCount += 1;
  }

  const sourceCount = references.size;
  const evidenceCount = evidenceRows.size;
  const complete = sourceCount > 0
    && evidenceCount > 0
    && approvedCount === evidenceCount
    && [...references.values()].every((evidenceIds) => evidenceIds.size > 0);
  return {
    sourceCount,
    evidenceCount,
    approvedCount,
    complete,
    latestChangeAt,
  };
}

async function refreshArticleEvidenceState(db: Db, articleId: string): Promise<ArticleEvidenceState> {
  await lockArticle(db, articleId);
  const evidence = await articleEvidenceState(db, articleId);
  await db`
    UPDATE articles
    SET source_review_completed = ${evidence.complete},
      article_sources_complete = ${evidence.sourceCount > 0},
      editor_review_completed = false,
      approved_by = NULL,
      approved_at = NULL,
      status = CASE
        WHEN status = 'retracted' THEN status
        WHEN ${evidence.complete} THEN 'source_review'
        ELSE 'draft'
      END
    WHERE id = ${articleId}
  `;
  // A demoted article is no longer public-safe; drop its materialized record
  // (refreshPublicArticleRecord also covers any residual public state).
  await refreshPublicArticleRecord(db, articleId);
  return evidence;
}

async function assertPublicationRequirements(db: Db, articleId: string): Promise<void> {
  const evidence = await articleEvidenceState(db, articleId);
  if (!evidence.complete) {
    throw new Error("Publication approval requires current evidence review for every source reference");
  }
  const reviews = await db`
    SELECT max(created_at) AS reviewed_at
    FROM reviews
    WHERE target_type = 'article' AND target_id = ${articleId} AND decision = 'approved'
  `;
  const reviewedAt = timestamp((reviews[0] as Record<string, unknown> | undefined)?.reviewed_at);
  if (!reviewedAt || reviewedAt < evidence.latestChangeAt) {
    throw new Error("Publication approval requires a current editorial review");
  }
}

export async function reviewSourcePolicy(
  db: Db,
  sourceId: string,
  reviewerId: string,
  decision: SourcePolicyReviewDecision = "approved",
  notes = "",
): Promise<void> {
  decision = SourcePolicyReviewDecisionSchema.parse(decision);
  await inTransaction(db, async (transaction) => {
    const source = await transaction`SELECT id FROM sources WHERE id = ${sourceId} FOR UPDATE`;
    if (!source.length) throw new Error("Source not found");
    await transaction`
      INSERT INTO source_policy_reviews (id, source_id, reviewer_id, decision, notes)
      VALUES (${id("srcpol")}, ${sourceId}, ${reviewerId}, ${decision}, ${notes})
    `;
    await audit(transaction, reviewerId, `source_policy_review.${decision}`, "source", sourceId, notes);
  });
}

// Kept as a compatibility entrypoint; it records source access metadata only.
// Collection itself follows the registry enabled state and never requires this
// record, so an editorial review cannot become an ingestion gate.
export async function reviewSource(db: Db, sourceId: string, reviewerId: string, notes = ""): Promise<void> {
  await reviewSourcePolicy(db, sourceId, reviewerId, "approved", notes);
}

export async function reviewEvidence(
  db: Db,
  evidenceId: string,
  reviewerId: string,
  decision: EvidenceReviewDecision = "approved",
  notes = "",
): Promise<void> {
  decision = EvidenceReviewDecisionSchema.parse(decision);
  await inTransaction(db, async (transaction) => {
    const evidence = await transaction`
      SELECT e.id, e.source_item_revision_id, revision.is_current, item.submitted_by, source.policy,
        run.status AS analysis_run_status,
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
      WHERE e.id = ${evidenceId}
      FOR UPDATE OF e, revision, item
    `;
    if (!evidence.length) throw new Error("Evidence not found or cannot be reviewed without a source revision");
    const record = evidence[0] as Record<string, unknown>;
    if (record.is_current !== true || record.analysis_run_current !== true) {
      throw new Error("Evidence review requires the current source revision and analysis run");
    }
    const policy = SourcePolicySchema.parse(typeof record.policy === "string" ? JSON.parse(record.policy) : record.policy);
    if (decision === "approved" && policy.evidenceReview.preventSubmitterApproval && record.submitted_by === reviewerId) {
      throw new Error("Submitters cannot approve their own evidence");
    }
    await transaction`
      INSERT INTO evidence_reviews (id, evidence_id, source_item_revision_id, reviewer_id, decision, notes)
      VALUES (${id("evrev")}, ${evidenceId}, ${record.source_item_revision_id as string}, ${reviewerId}, ${decision}, ${notes})
    `;
    const articles = await transaction`
      SELECT DISTINCT article_source.article_id
      FROM article_sources article_source
      JOIN claims claim ON claim.id = article_source.claim_id
      LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
      JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
      JOIN evidence linked_evidence ON linked_evidence.claim_id = member.id
      WHERE linked_evidence.id = ${evidenceId}
    `;
    for (const article of articles) {
      const articleId = article.article_id as string;
      await refreshArticleEvidenceState(transaction, articleId);
      await refreshArticleConfidence(transaction, articleId);
    }
    await audit(transaction, reviewerId, `evidence_review.${decision}`, "evidence", evidenceId, notes);
  });
}

export async function refreshClaimState(db: Db, claimId: string): Promise<ClaimState> {
  const claim = await db`SELECT id, canonical_claim_id FROM claims WHERE id = ${claimId} LIMIT 1`;
  if (!claim.length) throw new Error("Claim not found");
  const identity = (claim[0].canonical_claim_id as string | null) ?? claimId;
  const rows = await db`
    SELECT e.stance, e.provenance_family_id, item.source_strength, revision.is_current AS current_rev
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
    WHERE COALESCE(member.canonical_claim_id, member.id) = ${identity}
  `;
  const currentRows = rows.filter((row) => row.current_rev === true);
  const supportingFamilies = new Set<string>();
  const contradictingFamilies = new Set<string>();
  let strongest: SourceStrength = "UNVERIFIED";
  for (const row of currentRows as Array<Record<string, unknown>>) {
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
  // Claim state is a property of the canonical claim: every member claim
  // shares the same derivation so articles can compare like for like.
  await db`
    UPDATE claims
    SET state = ${state}
    WHERE COALESCE(canonical_claim_id, id) = ${identity}
  `;
  return state;
}

// Refreshes every claim belonging to a source item, including claims that no
// longer appear in the newest extraction. Claims persist across source
// revisions, so a material change that removes a claim leaves its evidence
// stale and the claim becomes superseded. Legacy claim rows without a
// canonical link are resolved first.
export async function refreshClaimStatesForSourceItem(db: Db, sourceItemId: string): Promise<number> {
  const claims = await db`SELECT id FROM claims WHERE source_item_id = ${sourceItemId}`;
  await ensureCanonicalClaimsForSourceItem(db, sourceItemId);
  for (const claim of claims) await refreshClaimState(db, claim.id as string);
  return claims.length;
}

export async function invalidateEvidenceApprovalsForSourceItem(db: Db, sourceItemId: string): Promise<void> {
  const articles = await db`
    SELECT DISTINCT article_source.article_id
    FROM article_sources article_source
    JOIN claims claim ON claim.id = article_source.claim_id
    LEFT JOIN canonical_claims cc ON cc.id = claim.canonical_claim_id
    JOIN claims member ON COALESCE(member.canonical_claim_id, member.id) = COALESCE(cc.id, claim.id)
    WHERE member.source_item_id = ${sourceItemId}
  `;
  for (const article of articles) {
    const articleId = article.article_id as string;
    await refreshArticleEvidenceState(db, articleId);
    await refreshArticleConfidence(db, articleId);
    await audit(db, "system", "evidence_review.invalidated", "article", articleId, "Underlying source evidence changed");
  }
}

export async function listArticleEvidence(db: Db, articleId: string): Promise<ArticleEvidenceForReview[]> {
  const rows = await db`
    SELECT DISTINCT e.id, e.claim_id, e.source_item_id, e.source_item_revision_id, e.excerpt, e.evidence_type,
      revision.processing_version,
      COALESCE(revision.is_current, false)
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
    WHERE article_source.article_id = ${articleId}
    ORDER BY e.id
  `;
  return rows.map((row) => ({
    id: row.id as string,
    claimId: row.claim_id as string,
    sourceItemId: row.source_item_id as string,
    sourceItemRevisionId: row.source_item_revision_id as string | null,
    processingVersion: (row.processing_version as string | null) ?? null,
    excerpt: row.excerpt as string,
    evidenceType: row.evidence_type as string,
    current: row.current === true,
  }));
}

export async function reviewArticle(db: Db, articleId: string, reviewerId: string, notes = ""): Promise<void> {
  await inTransaction(db, async (transaction) => {
    await lockArticle(transaction, articleId);
    const evidence = await articleEvidenceState(transaction, articleId);
    if (!evidence.complete) {
      throw new Error("Editorial review requires every source reference to have current evidence approval");
    }
    await transaction`INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision, notes) VALUES (${id("revw")}, 'article', ${articleId}, ${reviewerId}, 'approved', ${notes})`;
    await transaction`
      UPDATE articles
      SET source_review_completed = true, editor_review_completed = true, article_sources_complete = true,
        status = CASE WHEN status IN ('draft', 'source_review') THEN 'editor_review' ELSE status END
      WHERE id = ${articleId}
    `;
    await audit(transaction, reviewerId, "article_review.approved", "article", articleId, notes);
  });
}

export async function approveArticle(db: Db, articleId: string, approver: string): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const article = await lockArticle(transaction, articleId);
    if (article.status !== "editor_review") throw new Error("Publication approval requires a current editorial review");
    await assertPublicationRequirements(transaction, articleId);
    await transaction`
      UPDATE articles
      SET source_review_completed = true, editor_review_completed = true, article_sources_complete = true,
        status = 'approved', approved_by = ${approver}, approved_at = now()
      WHERE id = ${articleId}
    `;
    await audit(transaction, approver, "article.publication_approved", "article", articleId, "Human publication approval");
  });
}

export async function markPublished(db: Db, articleId: string, operator: string): Promise<Article> {
  return inTransaction(db, async (transaction) => {
    const article = await lockArticle(transaction, articleId);
    if (article.status !== "approved") throw new Error("Only approved articles can be published");
    await assertPublicationRequirements(transaction, articleId);
    const cover = await transaction`
      SELECT am.review_status AS assignment_review_status, ma.review_status AS asset_review_status
      FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
      WHERE am.article_id = ${articleId} AND am.role = 'cover'
      FOR UPDATE
    `;
    if (cover.length && (cover[0].assignment_review_status !== "approved" || cover[0].asset_review_status !== "approved")) {
      throw new Error("Selected cover media must be approved before publication");
    }
    await transaction`UPDATE articles SET status = 'published', published_at = now(), updated_at = now() WHERE id = ${articleId}`;
    await audit(transaction, operator, "article.published", "article", articleId, "Published sanitized artifact");
    // Materialize the sanitized public surface in the same transaction; the
    // public role can only ever read this record, never the article row.
    const published = await getArticle(transaction, articleId);
    if (!published) throw new Error("Published article not found");
    await refreshPublicArticleRecord(transaction, articleId, published);
    return published;
  });
}

export async function purgeExpiredSourceContent(db: Db, options: { execute?: boolean } = {}): Promise<SourceContentPurgeResult> {
  return inTransaction(db, async (transaction) => {
    const candidates = await transaction`
      SELECT si.id
      FROM source_items si
      WHERE si.retention_until IS NOT NULL
        AND si.retention_until <= now()
        AND si.content_purged_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM articles a
          JOIN article_sources ass ON ass.article_id = a.id
          LEFT JOIN claims c ON c.id = ass.claim_id
          WHERE a.status IN ('draft', 'source_review', 'editor_review', 'approved', 'updated')
            AND (c.source_item_id = si.id OR (ass.claim_id IS NULL AND ass.source_id = si.source_id))
        )
      FOR UPDATE
    `;
    const ids = candidates.map((candidate) => candidate.id as string);
    if (!options.execute || !ids.length) {
      return { eligibleSourceItems: ids.length, purgedSourceItems: 0, purgedRevisions: 0, purgedEvidence: 0, dryRun: !options.execute };
    }
    const revisions = await transaction`UPDATE source_item_revisions SET excerpt = '', title = '', content = '', content_purged_at = now() WHERE source_item_id = ANY(${transaction.array(ids)}) AND (excerpt <> '' OR title IS NOT NULL OR content IS NOT NULL) RETURNING id`;
    const evidence = await transaction`UPDATE evidence SET excerpt = '' WHERE source_item_id = ANY(${transaction.array(ids)}) AND excerpt <> '' RETURNING id`;
    const sourceItems = await transaction`UPDATE source_items SET text_excerpt = '', content_purged_at = now() WHERE id = ANY(${transaction.array(ids)}) RETURNING id`;
    return {
      eligibleSourceItems: ids.length,
      purgedSourceItems: sourceItems.length,
      purgedRevisions: revisions.length,
      purgedEvidence: evidence.length,
      dryRun: false,
    };
  });
}

function validIdentityHash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

export async function createQuarantinedSubmission(db: Db, input: {
  submission: PublicSubmission;
  submitterSessionHash: string;
  submitterIpHash: string;
  submitterAccountId?: string | null;
  retentionDays?: number;
  limits?: PublicSubmissionRateLimits;
}): Promise<{ id: string; duplicate: boolean }> {
  const submission = PublicSubmissionSchema.parse(input.submission);
  if (!validIdentityHash(input.submitterSessionHash) || !validIdentityHash(input.submitterIpHash)) {
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
  // Rate limits are trusted database configuration inside
  // public_submission_submit; a compromised public client cannot supply
  // custom limits.
  if (JSON.stringify(limits) !== JSON.stringify(defaultPublicSubmissionRateLimits)) {
    throw new Error("Custom submission rate limits are not supported by the PostgreSQL backend");
  }
  const contentHash = publicSubmissionFingerprint(submission);

  return inTransaction(db, async (transaction) => {
    // A plain membership check keeps the public intake role free of UPDATE
    // privileges on games (FOR KEY SHARE would require them). Games are
    // never deleted in this system, so no lock is needed here.
    const collection = await transaction`SELECT id FROM games WHERE id = ${submission.collectionId}`;
    if (!collection.length) throw new Error("Collection not found");
    const minuteBucket = Math.floor(Date.now() / 60_000);
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`public-submission:global:${minuteBucket}`}, 0))`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`public-submission:ip:${input.submitterIpHash}:${minuteBucket}`}, 0))`;
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`public-submission:session:${input.submitterSessionHash}:${minuteBucket}`}, 0))`;
    if (accountId) await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`public-submission:account:${accountId}:${Math.floor(Date.now() / 86_400_000)}`}, 0))`;

    // The public role holds no INSERT on intake, moderation, or audit tables;
    // public_submission_submit forces the initial quarantined state and the
    // fixed system action/audit records inside the migration role's context.
    try {
      const result = await transaction`
        SELECT public_submission_submit(
          ${submission.collectionId}, ${accountId}, ${input.submitterSessionHash}, ${input.submitterIpHash},
          ${submission.title ?? null}, ${submission.report}, ${transaction.json(submission.urls)}, ${transaction.json(submission.mediaRefs)},
          ${contentHash}, ${retentionDays}
        ) AS result
      `;
      const submitted = result[0]?.result as { id: string; duplicate: boolean } | undefined;
      if (!submitted) throw new Error("Submission was not persisted");
      return { id: submitted.id, duplicate: submitted.duplicate };
    } catch (error) {
      if ((error as { code?: string })?.code === "SR001") throw new SubmissionRateLimitError();
      throw error;
    }
  });
}

function parseStoredJson<T>(value: unknown): T {
  return typeof value === "string" ? JSON.parse(value) as T : value as T;
}

function moderationSubmission(row: Record<string, unknown>): PublicSubmissionForModeration {
  return {
    id: row.id as string,
    collectionId: row.collection_id as string,
    state: PublicSubmissionStateSchema.parse(row.state),
    title: row.title as string | null,
    report: row.report as string,
    urls: PublicSubmissionSchema.shape.urls.parse(parseStoredJson(row.urls)),
    mediaRefs: PublicSubmissionSchema.shape.mediaRefs.parse(parseStoredJson(row.media_refs)),
    promotedSourceItemId: row.promoted_source_item_id as string | null,
    retentionUntil: new Date(row.retention_until as string).toISOString(),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

function moderationActor(actorId: string): string {
  const actor = actorId.trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(actor)) throw new Error("A valid moderation actor is required");
  return actor;
}

function moderationNotes(notes: string | undefined): string {
  const value = notes?.trim() ?? "";
  if (value.length > 2_000) throw new Error("Moderation notes exceed the 2,000 character limit");
  return value;
}

export async function listPublicSubmissionsForModeration(
  db: Db,
  collectionId: string,
  options: { state?: PublicSubmissionState; limit?: number } = {},
): Promise<PublicSubmissionForModeration[]> {
  if (!collectionId.trim()) throw new Error("A collection id is required");
  const state = options.state === undefined ? undefined : PublicSubmissionStateSchema.parse(options.state);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Submission list limit must be between 1 and 200");
  const rows = state === undefined
    ? await db`
      SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at
      FROM public_submissions
      WHERE collection_id = ${collectionId} AND content_purged_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `
    : await db`
      SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at
      FROM public_submissions
      WHERE collection_id = ${collectionId} AND state = ${state} AND content_purged_at IS NULL
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  return rows.map((row) => moderationSubmission(row as Record<string, unknown>));
}

export async function getPublicSubmissionForModeration(db: Db, submissionId: string): Promise<PublicSubmissionForModeration | null> {
  const rows = await db`
    SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at
    FROM public_submissions
    WHERE id = ${submissionId} AND content_purged_at IS NULL
    LIMIT 1
  `;
  return rows.length ? moderationSubmission(rows[0] as Record<string, unknown>) : null;
}

export async function listPublicSubmissionModerationActions(db: Db, submissionId: string): Promise<PublicSubmissionModerationAction[]> {
  const rows = await db`
    SELECT id, actor_id, action, notes, created_at
    FROM submission_moderation_actions
    WHERE submission_id = ${submissionId}
    ORDER BY created_at ASC
  `;
  return rows.map((row) => ({
    id: row.id as string,
    actorId: row.actor_id as string,
    action: row.action as string,
    notes: row.notes as string,
    createdAt: new Date(row.created_at as string).toISOString(),
  }));
}

export async function reviewPublicSubmission(db: Db, input: {
  submissionId: string;
  actorId: string;
  decision: PublicSubmissionReviewDecision;
  notes?: string;
}): Promise<{ id: string; state: PublicSubmissionReviewDecision }> {
  const actorId = moderationActor(input.actorId);
  const decision = PublicSubmissionReviewDecisionSchema.parse(input.decision);
  const notes = moderationNotes(input.notes);
  return inTransaction(db, async (transaction) => {
    const rows = await transaction`
      SELECT state, content_purged_at
      FROM public_submissions
      WHERE id = ${input.submissionId}
      FOR UPDATE
    `;
    if (!rows.length) throw new Error("Submission not found");
    const currentState = PublicSubmissionStateSchema.parse(rows[0].state);
    if (rows[0].content_purged_at || currentState === "expired" || currentState === "promoted") {
      throw new Error("Submission is no longer available for moderation");
    }
    const permitted = currentState === "quarantined" || currentState === "under_review";
    if (!permitted) throw new Error(`Submission cannot transition from ${currentState} to ${decision}`);
    await transaction`
      UPDATE public_submissions
      SET state = ${decision}, updated_at = now()
      WHERE id = ${input.submissionId}
    `;
    await transaction`
      INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes)
      VALUES (${id("subact")}, ${input.submissionId}, ${actorId}, ${`state:${decision}`}, ${notes})
    `;
    await audit(transaction, actorId, `submission.${decision}`, "public_submission", input.submissionId, notes);
    return { id: input.submissionId, state: decision };
  });
}

// This function must be called inside the transaction that creates the source
// item and marks the submission promoted, so a concurrent moderator cannot
// promote the same report twice.
export async function getPublicSubmissionForPromotion(db: Db, submissionId: string): Promise<PublicSubmissionForModeration> {
  const rows = await db`
    SELECT id, collection_id, state, title, report, urls, media_refs, promoted_source_item_id, retention_until, created_at, updated_at
    FROM public_submissions
    WHERE id = ${submissionId}
    FOR UPDATE
  `;
  if (!rows.length) throw new Error("Submission not found");
  const submission = moderationSubmission(rows[0] as Record<string, unknown>);
  if (submission.state !== "under_review" || !submission.report) {
    throw new Error("Submission must be under review and retained before promotion");
  }
  return submission;
}

export async function markPublicSubmissionPromoted(db: Db, input: {
  submissionId: string;
  sourceItemId: string;
  actorId: string;
  notes?: string;
}): Promise<void> {
  const actorId = moderationActor(input.actorId);
  const notes = moderationNotes(input.notes);
  const promoted = await db`
    UPDATE public_submissions
    SET state = 'promoted', promoted_source_item_id = ${input.sourceItemId}, updated_at = now()
    WHERE id = ${input.submissionId} AND state = 'under_review' AND content_purged_at IS NULL
    RETURNING id
  `;
  if (!promoted.length) throw new Error("Submission is no longer eligible for promotion");
  await db`
    INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes)
    VALUES (${id("subact")}, ${input.submissionId}, ${actorId}, 'promoted', ${notes})
  `;
  await audit(db, actorId, "submission.promoted", "public_submission", input.submissionId, notes);
}

export async function recordSubmissionModerationAction(
  db: Db,
  submissionId: string,
  actorId: string,
  action: string,
  notes = "",
): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const submission = await transaction`SELECT id FROM public_submissions WHERE id = ${submissionId} FOR UPDATE`;
    if (!submission.length) throw new Error("Submission not found");
    await transaction`
      INSERT INTO submission_moderation_actions (id, submission_id, actor_id, action, notes)
      VALUES (${id("subact")}, ${submissionId}, ${actorId}, ${action.slice(0, 100)}, ${notes.slice(0, 2_000)})
    `;
    await audit(transaction, actorId, `submission.${action.slice(0, 100)}`, "public_submission", submissionId, notes.slice(0, 2_000));
  });
}

export async function purgeExpiredPublicSubmissions(db: Db, options: { execute?: boolean } = {}): Promise<PublicSubmissionPurgeResult> {
  return inTransaction(db, async (transaction) => {
    const candidates = await transaction`
      SELECT id
      FROM public_submissions
      WHERE retention_until <= now() AND content_purged_at IS NULL
      FOR UPDATE
    `;
    const ids = candidates.map((candidate) => candidate.id as string);
    if (!options.execute || !ids.length) return { eligibleSubmissions: ids.length, purgedSubmissions: 0, dryRun: !options.execute };
    const purged = await transaction`
      UPDATE public_submissions
      SET title = NULL, report = '', urls = '[]'::jsonb, media_refs = '[]'::jsonb,
        content_purged_at = now(), updated_at = now(),
        state = CASE WHEN state IN ('quarantined', 'under_review', 'blocked') THEN 'expired' ELSE state END
      WHERE id = ANY(${transaction.array(ids)})
      RETURNING id
    `;
    return { eligibleSubmissions: ids.length, purgedSubmissions: purged.length, dryRun: false };
  });
}

export async function audit(db: Db, actor: string, action: string, targetType: string, targetId: string, reason: string): Promise<void> {
  await db`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, reason) VALUES (${id("audit")}, ${actor}, ${action}, ${targetType}, ${targetId}, ${reason})`;
}

export async function publicArticles(db: Db, collectionId: string): Promise<unknown[]> {
  return listPublicArticles(db, collectionId);
}

export async function closeDb(db: Db): Promise<void> {
  await db.end({ timeout: 2 });
}
