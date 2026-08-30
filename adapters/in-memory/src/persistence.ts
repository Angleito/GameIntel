import { readFile } from "node:fs/promises";
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
  effectivePublicationMode,
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
import {
  articleRecordToArticle,
  memoryCatalogEntry,
  type AnalysisRunRecord,
  type ArticleMediaRecord,
  type ArticleRecord,
  type ArticleSourceRecord,
  type CanonicalClaimRecord,
  type ClaimRecord,
  type EvidenceRecord,
  type MemoryStore,
  type RevisionRecord,
  type SourceItemRecord,
  type SourceItemProvenanceRecord,
} from "./store.ts";
import type { MemoryLeaseRegistry } from "./job-queue.ts";

const sourceStrengthOrder: Record<SourceStrength, number> = {
  UNVERIFIED: 0,
  COMMUNITY: 1,
  TRUSTED_SECONDARY: 2,
  DIRECT_EVIDENCE: 3,
  PRIMARY: 4,
};

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parsePolicy(policy: SourcePolicy): SourcePolicy {
  return SourcePolicySchema.parse(policy);
}

// In-memory reference persistence. Transaction semantics are snapshot-based:
// the callback runs against a cloned store and the clone replaces the parent
// store only on success, so a thrown error rolls everything back.
export class InMemoryPersistence implements GameIntelPersistence {
  store: MemoryStore;

  constructor(
    store: MemoryStore,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly leases: MemoryLeaseRegistry | null = null,
  ) {
    this.store = store;
  }

  async transaction<T>(callback: (transaction: GameIntelPersistence) => Promise<T>): Promise<T> {
    const working = new InMemoryPersistence(structuredClone(this.store), this.ids, this.clock, this.leases);
    const result = await callback(working);
    this.store = working.store;
    return result;
  }

  // -------------------------------------------------------------------------
  // SourceRepository
  // -------------------------------------------------------------------------

  async ensureGame(profile: GameProfile): Promise<void> {
    this.store.games.set(profile.id, { ...profile, aliases: [...profile.aliases] });
  }

  async ensureSource(source: SourceInput): Promise<void> {
    this.store.sources.set(source.id, { ...source, policy: parsePolicy(source.policy) });
  }

  private provenanceFamilyForSourceItem(sourceItemId: string, collectionId: string, lineageId: string): string {
    const existing = [...this.store.sourceItemProvenance.values()].find((entry) => entry.sourceItemId === sourceItemId);
    if (existing) return existing.provenanceFamilyId;
    const familyKey = `lineage:${lineageId}`;
    let family = [...this.store.provenanceFamilies.values()].find((candidate) => candidate.collectionId === collectionId && candidate.familyKey === familyKey);
    if (!family) {
      family = {
        id: this.ids.generate("pf"),
        collectionId,
        familyKey,
        rootSourceItemId: sourceItemId,
      };
      this.store.provenanceFamilies.set(family.id, family);
    }
    this.store.sourceItemProvenance.set(sourceItemId, {
      sourceItemId,
      provenanceFamilyId: family.id,
      relationship: "original",
      derivedFromSourceItemId: null,
      clusteringMethod: "lineage",
      reviewerId: null,
      notes: "",
      updatedAt: this.clock.nowIso(),
    });
    return family.id;
  }

  async getSourceItemProvenance(sourceItemId: string): Promise<import("@gameintel/contracts").SourceItemProvenanceInfo | null> {
    const provenance = this.store.sourceItemProvenance.get(sourceItemId);
    if (!provenance) return null;
    return {
      provenanceFamilyId: provenance.provenanceFamilyId,
      relationship: provenance.relationship,
      clusteringMethod: provenance.clusteringMethod,
    };
  }

  async insertSourceItem(
    item: NormalizedSourceItem,
    rawHash: string,
    lineageId: string,
    policy: SourcePolicy,
    submittedBy: string | null = null,
  ): Promise<InsertedSourceItem> {
    const now = this.clock.nowIso();
    const excerpt = policy.retainRawTextDays === 0 ? "" : item.text.slice(0, policy.mayStoreFullText ? 4_000 : 1_000);
    const retentionUntil = this.clock.now() + policy.retainRawTextDays * 86_400_000;

    const currentRevisionId = (sourceItemId: string): string => {
      const current = [...this.store.revisions.values()]
        .filter((revision) => revision.sourceItemId === sourceItemId && revision.isCurrent)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (current) return current.id;
      const first = [...this.store.revisions.values()]
        .filter((revision) => revision.sourceItemId === sourceItemId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
      if (!first) throw new Error(`Source item ${sourceItemId} has no source revisions`);
      return first.id;
    };

    const existingByExternal = [...this.store.sourceItems.values()]
      .find((candidate) => candidate.sourceId === item.sourceId && candidate.externalId === item.externalId);
    if (existingByExternal && existingByExternal.rawHash === rawHash) {
      return {
        id: existingByExternal.id,
        revisionId: currentRevisionId(existingByExternal.id),
        provenanceFamilyId: this.provenanceFamilyForSourceItem(existingByExternal.id, item.collectionId, lineageId),
        duplicate: true,
        materialChange: false,
      };
    }
    const existingByHash = [...this.store.sourceItems.values()]
      .find((candidate) => candidate.sourceId === item.sourceId && candidate.rawHash === rawHash);
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
      for (const revision of this.store.revisions.values()) {
        if (revision.sourceItemId === itemId && revision.isCurrent) revision.isCurrent = false;
      }
      const updated: SourceItemRecord = {
        ...existingByExternal,
        gameId: item.collectionId,
        url: item.url,
        canonicalUrl: item.url.startsWith("urn:") ? null : item.url,
        title: item.title,
        textExcerpt: excerpt,
        rawHash,
        lineageId,
        sourceStrength: item.sourceStrength,
        publicationMode: item.publicationMode,
        discoveredAt: item.discoveredAt,
        publishedAt: item.publishedAt,
        inputKind: item.inputKind,
        contentType: item.contentType,
        language: item.language,
        retentionUntil,
        provenanceStatus: "normalized",
        contentPurgedAt: null,
        submittedBy,
      };
      this.store.sourceItems.set(itemId, updated);
      this.store.revisions.set(revisionId, {
        id: revisionId,
        sourceItemId: itemId,
        rawHash,
        excerpt,
        contentType: item.contentType,
        httpStatus: item.inputKind === "url" || item.inputKind === "rss" ? 200 : null,
        isCurrent: true,
        processingVersion: item.processingVersion ?? null,
        title: item.title,
        content: excerpt,
        contentPurgedAt: null,
        createdAt: now,
      });
      return {
        id: itemId,
        revisionId,
        provenanceFamilyId: this.provenanceFamilyForSourceItem(itemId, item.collectionId, lineageId),
        duplicate: false,
        materialChange: true,
      };
    }

    const itemId = this.ids.generate("src");
    this.store.sourceItems.set(itemId, {
      id: itemId,
      sourceId: item.sourceId,
      gameId: item.collectionId,
      externalId: item.externalId,
      url: item.url,
      canonicalUrl: item.url.startsWith("urn:") ? null : item.url,
      title: item.title,
      textExcerpt: excerpt,
      rawHash,
      lineageId,
      sourceStrength: item.sourceStrength,
      publicationMode: item.publicationMode,
      discoveredAt: item.discoveredAt,
      publishedAt: item.publishedAt,
      inputKind: item.inputKind,
      contentType: item.contentType,
      language: item.language,
      retentionUntil,
      provenanceStatus: "normalized",
      contentPurgedAt: null,
      submittedBy,
      createdAt: now,
    });
    this.store.revisions.set(revisionId, {
      id: revisionId,
      sourceItemId: itemId,
      rawHash,
      excerpt,
      contentType: item.contentType,
      httpStatus: item.inputKind === "url" || item.inputKind === "rss" ? 200 : null,
      isCurrent: true,
      processingVersion: item.processingVersion ?? null,
      title: item.title,
      content: excerpt,
      contentPurgedAt: null,
      createdAt: now,
    });
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
    this.store.events.set(eventId, {
      id: eventId,
      gameId: input.collectionId,
      sourceItemId: input.sourceItemId,
      newsworthiness: input.newsworthiness,
      disposition: input.disposition,
      existingArticleId: input.existingArticleId ?? null,
      createdAt: this.clock.nowIso(),
    });
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
    const sourceItem = this.store.sourceItems.get(input.sourceItemId);
    const relatedItem = this.store.sourceItems.get(input.relatedSourceItemId);
    if (!sourceItem || !relatedItem) throw new Error("Both source items must exist");
    if (sourceItem.gameId !== relatedItem.gameId) throw new Error("Provenance relationships cannot cross collections");
    const sourceFamilyId = this.provenanceFamilyForSourceItem(input.sourceItemId, sourceItem.gameId, sourceItem.lineageId);
    const relatedFamilyId = this.provenanceFamilyForSourceItem(input.relatedSourceItemId, relatedItem.gameId, relatedItem.lineageId);
    const sharesFamily = ["copied_from", "quoted_from", "derived_from", "same_media", "same_source_family"].includes(input.relationship);
    const provenanceFamilyId = sharesFamily ? relatedFamilyId : sourceFamilyId;
    const notes = input.notes?.slice(0, 2_000) ?? "";
    const relationshipId = this.ids.generate("provrel");
    this.store.provenanceRelationships.set(relationshipId, {
      id: relationshipId,
      sourceItemId: input.sourceItemId,
      relatedSourceItemId: input.relatedSourceItemId,
      relationship: input.relationship,
      clusteringMethod: input.clusteringMethod ?? "manual",
      reviewerId: input.reviewerId,
      notes,
      createdAt: this.clock.nowIso(),
    });
    const provenance = this.store.sourceItemProvenance.get(input.sourceItemId);
    if (provenance) {
      this.store.sourceItemProvenance.set(input.sourceItemId, {
        ...provenance,
        provenanceFamilyId,
        relationship: input.relationship,
        derivedFromSourceItemId: input.relatedSourceItemId,
        clusteringMethod: input.clusteringMethod ?? "manual",
        reviewerId: input.reviewerId,
        notes,
        updatedAt: this.clock.nowIso(),
      });
    }
    for (const evidence of this.store.evidence.values()) {
      if (evidence.sourceItemId === input.sourceItemId) evidence.provenanceFamilyId = provenanceFamilyId;
    }
    const affectedArticles = new Set<string>();
    for (const articleSource of this.store.articleSources.values()) {
      const claim = articleSource.claimId ? this.store.claims.get(articleSource.claimId) : undefined;
      if (!claim) continue;
      const memberIds = [...this.store.claims.values()]
        .filter((candidate) => (candidate.canonicalClaimId ?? candidate.id) === (claim.canonicalClaimId ?? claim.id))
        .map((candidate) => candidate.id);
      const hasEvidence = [...this.store.evidence.values()]
        .some((record) => record.sourceItemId === input.sourceItemId && memberIds.includes(record.claimId));
      if (hasEvidence) affectedArticles.add(articleSource.articleId);
    }
    for (const articleId of affectedArticles) {
      await this.refreshArticleConfidence(articleId);
    }
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
    let claimRecord = [...this.store.claims.values()]
      .find((candidate) => candidate.sourceItemId === sourceItemId && candidate.claimKey === claimKey);
    let canonicalClaimId: string;
    if (claimRecord) {
      canonicalClaimId = claimRecord.canonicalClaimId ?? this.resolveCanonicalClaimForRow(claimRecord.id, item.collectionId, claim.subject, claim.predicate, claim.value, claimRecord.qualifiers);
    } else {
      const claimId = this.ids.generate("clm");
      claimRecord = {
        id: claimId,
        gameId: item.collectionId,
        sourceItemId,
        subject: claim.subject,
        predicate: claim.predicate,
        value: claim.value,
        qualifiers: { ...claim.qualifiers },
        claimKey,
        spoilerTags: [...claim.spoilerTags],
        exploitClass: claim.exploitClass,
        evidenceLevel: claim.evidenceLevel,
        attributionType: claim.attributionType,
        statement: claim.statement,
        editorialAssessment: claim.editorialAssessment,
        state: "unverified",
        canonicalClaimId: null,
        createdAt: this.clock.nowIso(),
      };
      this.store.claims.set(claimId, claimRecord);
      canonicalClaimId = this.resolveCanonicalClaimForRow(claimId, item.collectionId, claim.subject, claim.predicate, claim.value, claim.qualifiers);
    }
    const existingEvidence = [...this.store.evidence.values()]
      .find((candidate) => candidate.claimId === claimRecord!.id && candidate.analysisRunId === analysisRunId);
    if (!existingEvidence) {
      const evidenceId = this.ids.generate("evd");
      this.store.evidence.set(evidenceId, {
        id: evidenceId,
        claimId: claimRecord!.id,
        sourceItemId,
        sourceItemRevisionId,
        analysisRunId,
        provenanceFamilyId,
        stance: claim.stance,
        evidenceType: claim.evidenceType,
        excerpt: claim.excerpt,
        startMs: claim.startMs,
        endMs: claim.endMs,
        lineageId,
        createdAt: this.clock.nowIso(),
      });
    }
    return { claimId: claimRecord!.id, canonicalClaimId };
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
    let canonical = [...this.store.canonicalClaims.values()]
      .find((candidate) => candidate.gameId === collectionId && candidate.canonicalKey === key);
    if (!canonical) {
      canonical = {
        id: this.ids.generate("cc"),
        gameId: collectionId,
        subject,
        predicate,
        value,
        qualifiers: { ...qualifiers },
        canonicalKey: key,
        createdAt: this.clock.nowIso(),
      };
      this.store.canonicalClaims.set(canonical.id, canonical);
    }
    const claim = this.store.claims.get(claimId);
    if (claim) {
      claim.canonicalClaimId = canonical.id;
      claim.claimKey = key;
    }
    return canonical.id;
  }

  private ensureCanonicalClaimsForSourceItem(sourceItemId: string): number {
    const unresolved = [...this.store.claims.values()].filter((claim) => claim.sourceItemId === sourceItemId && claim.canonicalClaimId === null);
    for (const claim of unresolved) {
      this.resolveCanonicalClaimForRow(claim.id, claim.gameId, claim.subject, claim.predicate, claim.value, claim.qualifiers);
    }
    return unresolved.length;
  }

  private latestAnalysisRunForRevision(sourceItemRevisionId: string): AnalysisRunRecord | null {
    return [...this.store.analysisRuns.values()]
      .filter((run) => run.sourceItemRevisionId === sourceItemRevisionId && run.status === "completed")
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? "") || right.id.localeCompare(left.id))[0] ?? null;
  }

  private parseAnalysisRun(record: AnalysisRunRecord): AnalysisRunInfo {
    return {
      id: record.id,
      sourceItemRevisionId: record.sourceItemRevisionId,
      processingVersion: record.processingVersion,
      normalizationVersion: record.normalizationVersion,
      claimExtractorVersion: record.claimExtractorVersion,
      confidenceModelVersion: record.confidenceModelVersion,
      status: record.status,
      triggeredBy: record.triggeredBy,
      triggerReason: record.triggerReason,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
    };
  }

  async getAnalysisRun(sourceItemRevisionId: string, versions: AnalysisVersions): Promise<AnalysisRunInfo | null> {
    const run = [...this.store.analysisRuns.values()]
      .find((candidate) => candidate.sourceItemRevisionId === sourceItemRevisionId
        && candidate.status === "completed"
        && candidate.normalizationVersion === versions.normalizationVersion
        && candidate.claimExtractorVersion === versions.claimExtractorVersion
        && candidate.confidenceModelVersion === versions.confidenceModelVersion);
    return run ? this.parseAnalysisRun(run) : null;
  }

  async createAnalysisRun(input: { sourceItemRevisionId: string; versions: AnalysisVersions; triggeredBy?: string | null; triggerReason: string }): Promise<AnalysisRunInfo> {
    const existing = await this.getAnalysisRun(input.sourceItemRevisionId, input.versions);
    if (existing) return existing;
    for (const run of this.store.analysisRuns.values()) {
      if (run.sourceItemRevisionId === input.sourceItemRevisionId && run.status === "completed") run.status = "superseded";
    }
    const now = this.clock.nowIso();
    const run: AnalysisRunRecord = {
      id: this.ids.generate("arun"),
      sourceItemRevisionId: input.sourceItemRevisionId,
      processingVersion: this.store.revisions.get(input.sourceItemRevisionId)?.processingVersion ?? null,
      normalizationVersion: input.versions.normalizationVersion,
      claimExtractorVersion: input.versions.claimExtractorVersion,
      confidenceModelVersion: input.versions.confidenceModelVersion,
      status: "completed",
      triggeredBy: input.triggeredBy ?? null,
      triggerReason: input.triggerReason,
      createdAt: now,
      completedAt: now,
    };
    this.store.analysisRuns.set(run.id, run);
    return this.parseAnalysisRun(run);
  }

  async listAnalysisRuns(sourceItemRevisionId: string): Promise<AnalysisRunInfo[]> {
    return [...this.store.analysisRuns.values()]
      .filter((run) => run.sourceItemRevisionId === sourceItemRevisionId)
      .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? "") || right.id.localeCompare(left.id))
      .map((run) => this.parseAnalysisRun(run));
  }

  async getRevisionForAnalysis(revisionId: string): Promise<RevisionForAnalysis | null> {
    const revision = this.store.revisions.get(revisionId);
    if (!revision) return null;
    const item = this.store.sourceItems.get(revision.sourceItemId);
    if (!item) return null;
    const source = this.store.sources.get(item.sourceId);
    if (!source) return null;
    return {
      id: revision.id,
      sourceItemId: revision.sourceItemId,
      title: revision.title,
      content: revision.content,
      rawHash: revision.rawHash,
      processingVersion: revision.processingVersion,
      contentPurged: revision.contentPurgedAt !== null || revision.content === "",
      sourceItem: {
        collectionId: item.gameId,
        externalId: item.externalId,
        url: item.url,
        sourceStrength: item.sourceStrength,
        publicationMode: item.publicationMode,
        discoveredAt: item.discoveredAt,
        publishedAt: item.publishedAt,
        inputKind: item.inputKind,
        contentType: item.contentType,
        language: item.language,
        lineageId: item.lineageId,
        submittedBy: item.submittedBy,
      },
      source,
    };
  }

  async resolveExistingArticleForCanonicalClaims(canonicalClaimIds: string[]): Promise<string | null> {
    const unique = new Set(canonicalClaimIds);
    if (!unique.size) return null;
    const articles = [...this.store.articles.values()]
      .filter((article) => article.status !== "retracted")
      .map((article) => {
        for (const articleSource of this.store.articleSources.values()) {
          if (articleSource.articleId !== article.id || articleSource.claimId === null) continue;
          const claim = this.store.claims.get(articleSource.claimId);
          if (claim && unique.has(claim.canonicalClaimId ?? claim.id)) return article;
        }
        return null;
      })
      .filter((article): article is ArticleRecord => article !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return articles[0]?.id ?? null;
  }

  async refreshArticlesForCanonicalClaims(canonicalClaimIds: string[], auditAction: string, auditReason: string): Promise<string[]> {
    const unique = new Set(canonicalClaimIds);
    const articleIds = new Set<string>();
    for (const articleSource of this.store.articleSources.values()) {
      if (articleSource.claimId === null) continue;
      const claim = this.store.claims.get(articleSource.claimId);
      if (claim && unique.has(claim.canonicalClaimId ?? claim.id)) articleIds.add(articleSource.articleId);
    }
    for (const articleId of articleIds) {
      await this.refreshArticleEvidenceState(articleId);
      await this.refreshArticleConfidence(articleId);
      await this.audit("system", auditAction, "article", articleId, auditReason);
    }
    return [...articleIds];
  }

  async canonicalClaimIdsForSourceItem(sourceItemId: string): Promise<string[]> {
    return [...new Set([...this.store.claims.values()]
      .filter((claim) => claim.sourceItemId === sourceItemId)
      .map((claim) => claim.canonicalClaimId ?? claim.id))];
  }

  private evidenceApprovalState(evidenceId: string, sourceItemRevisionId: string, policy: SourcePolicy): { approved: boolean; latestReviewAt: number; blockedBy: "rejected" | "disputed" | null } {
    const reviews = this.store.evidenceReviews
      .filter((review) => review.evidenceId === evidenceId && review.sourceItemRevisionId === sourceItemRevisionId)
      .sort((left, right) => left.seq - right.seq);
    const latestByReviewer = new Map<string, (typeof reviews)[number]>();
    for (const review of reviews) latestByReviewer.set(review.reviewerId, review);
    const gate = evidenceReviewGate(
      [...latestByReviewer.values()].map((review) => ({ reviewerId: review.reviewerId, decision: review.decision, createdAt: timestamp(review.createdAt) })),
      policy.evidenceReview,
    );
    const latestReviewAt = reviews.reduce((latest, review) => Math.max(latest, timestamp(review.createdAt)), 0);
    return { approved: gate.eligible, latestReviewAt, blockedBy: gate.blockedBy };
  }

  async calculateClaimConfidence(claimId: string): Promise<number> {
    const claim = this.store.claims.get(claimId);
    if (!claim) throw new Error("Claim not found");
    const identity = claim.canonicalClaimId ?? claim.id;
    let strongest: SourceStrength = "UNVERIFIED";
    const approvedEvidence: Array<Evidence & { sourceStrength?: SourceStrength }> = [];
    for (const record of this.store.evidence.values()) {
      const recordClaim = this.store.claims.get(record.claimId);
      if (!recordClaim || (recordClaim.canonicalClaimId ?? recordClaim.id) !== identity) continue;
      const run = this.store.analysisRuns.get(record.analysisRunId);
      const latestRun = this.latestAnalysisRunForRevision(record.sourceItemRevisionId);
      if (!run || run.status !== "completed" || latestRun?.id !== run.id) continue;
      const item = this.store.sourceItems.get(record.sourceItemId);
      const revision = this.store.revisions.get(record.sourceItemRevisionId);
      if (!item || !revision || !revision.isCurrent) continue;
      const source = this.store.sources.get(item.sourceId);
      if (!source) continue;
      const policy = parsePolicy(source.policy);
      const review = this.evidenceApprovalState(record.id, record.sourceItemRevisionId, policy);
      if (!review.approved) continue;
      const sourceStrength = SourceStrengthSchema.parse(item.sourceStrength);
      if (sourceStrengthOrder[sourceStrength] > sourceStrengthOrder[strongest]) strongest = sourceStrength;
      approvedEvidence.push({
        sourceItemId: item.id,
        provenanceFamilyId: record.provenanceFamilyId,
        stance: this.store.sourceItemProvenance.get(item.id)?.relationship === "contradiction" ? "contradicts" : record.stance,
        evidenceType: record.evidenceType,
        excerpt: record.excerpt,
        startMs: record.startMs,
        endMs: record.endMs,
        lineageId: record.lineageId,
        sourceStrength,
      });
    }
    return calculateConfidence(strongest, approvedEvidence, Object.keys(claim.qualifiers).length > 0 ? 0.9 : 0.5);
  }

  private async refreshArticleConfidence(articleId: string): Promise<number> {
    const claimIds = [...this.store.articleSources.values()]
      .filter((articleSource) => articleSource.articleId === articleId && articleSource.claimId !== null)
      .map((articleSource) => articleSource.claimId as string);
    const unique = [...new Set(claimIds)];
    if (!unique.length) return 0;
    const confidences: number[] = [];
    for (const claimId of unique) confidences.push(await this.calculateClaimConfidence(claimId));
    const confidence = Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100) / 100;
    const article = this.store.articles.get(articleId);
    if (article) article.confidence = confidence;
    return confidence;
  }

  async refreshClaimState(claimId: string): Promise<ClaimState> {
    const claim = this.store.claims.get(claimId);
    if (!claim) throw new Error("Claim not found");
    const identity = claim.canonicalClaimId ?? claim.id;
    const memberIds = new Set([...this.store.claims.values()]
      .filter((candidate) => (candidate.canonicalClaimId ?? candidate.id) === identity)
      .map((candidate) => candidate.id));
    const rows = [...this.store.evidence.values()].filter((record) => memberIds.has(record.claimId));
    const currentRows = rows.filter((record) => {
      const revision = this.store.revisions.get(record.sourceItemRevisionId);
      const run = this.store.analysisRuns.get(record.analysisRunId);
      const latestRun = this.latestAnalysisRunForRevision(record.sourceItemRevisionId);
      return revision?.isCurrent === true && run?.status === "completed" && latestRun?.id === run.id;
    });
    const supportingFamilies = new Set<string>();
    const contradictingFamilies = new Set<string>();
    let strongest: SourceStrength = "UNVERIFIED";
    for (const row of currentRows) {
      const item = this.store.sourceItems.get(row.sourceItemId);
      if (!item) continue;
      const strength = SourceStrengthSchema.parse(item.sourceStrength);
      if (sourceStrengthOrder[strength] > sourceStrengthOrder[strongest]) strongest = strength;
      if (!row.provenanceFamilyId) continue;
      if (row.stance === "contradicts") contradictingFamilies.add(row.provenanceFamilyId);
      else supportingFamilies.add(row.provenanceFamilyId);
    }
    const state = deriveClaimState({
      supportingFamilies: supportingFamilies.size,
      contradictingFamilies: contradictingFamilies.size,
      strongestStrength: strongest,
      hasCurrentEvidence: currentRows.length > 0,
      hasHistoricalEvidence: rows.length > 0,
    });
    for (const memberId of memberIds) {
      const member = this.store.claims.get(memberId);
      if (member) member.state = state;
    }
    return state;
  }

  async refreshClaimStatesForSourceItem(sourceItemId: string): Promise<number> {
    this.ensureCanonicalClaimsForSourceItem(sourceItemId);
    const claims = [...this.store.claims.values()].filter((claim) => claim.sourceItemId === sourceItemId);
    for (const claim of claims) await this.refreshClaimState(claim.id);
    return claims.length;
  }

  // -------------------------------------------------------------------------
  // EvidenceRepository
  // -------------------------------------------------------------------------

  async invalidateEvidenceApprovalsForSourceItem(sourceItemId: string): Promise<void> {
    const affectedArticles = new Set<string>();
    for (const articleSource of this.store.articleSources.values()) {
      const claim = articleSource.claimId ? this.store.claims.get(articleSource.claimId) : undefined;
      if (!claim) continue;
      const memberIds = [...this.store.claims.values()]
        .filter((candidate) => (candidate.canonicalClaimId ?? candidate.id) === (claim.canonicalClaimId ?? claim.id))
        .map((candidate) => candidate.id);
      const memberClaims = memberIds.map((id) => this.store.claims.get(id)).filter((candidate): candidate is ClaimRecord => candidate !== undefined);
      if (memberClaims.some((candidate) => candidate.sourceItemId === sourceItemId)) affectedArticles.add(articleSource.articleId);
    }
    for (const articleId of affectedArticles) {
      await this.refreshArticleEvidenceState(articleId);
      await this.refreshArticleConfidence(articleId);
      await this.audit("system", "evidence_review.invalidated", "article", articleId, "Underlying source evidence changed");
    }
  }

  async listArticleEvidence(articleId: string): Promise<ArticleEvidenceForReview[]> {
    const memberClaimIds = new Set<string>();
    for (const articleSource of this.store.articleSources.values()) {
      if (articleSource.articleId !== articleId || articleSource.claimId === null) continue;
      const claim = this.store.claims.get(articleSource.claimId);
      if (!claim) continue;
      for (const candidate of this.store.claims.values()) {
        if ((candidate.canonicalClaimId ?? candidate.id) === (claim.canonicalClaimId ?? claim.id)) memberClaimIds.add(candidate.id);
      }
    }
    const rows: ArticleEvidenceForReview[] = [];
    for (const record of this.store.evidence.values()) {
      if (!memberClaimIds.has(record.claimId)) continue;
      const revision = this.store.revisions.get(record.sourceItemRevisionId);
      const run = this.store.analysisRuns.get(record.analysisRunId);
      const latestRun = this.latestAnalysisRunForRevision(record.sourceItemRevisionId);
      rows.push({
        id: record.id,
        claimId: record.claimId,
        sourceItemId: record.sourceItemId,
        sourceItemRevisionId: record.sourceItemRevisionId,
        processingVersion: revision?.processingVersion ?? null,
        excerpt: record.excerpt,
        evidenceType: record.evidenceType,
        current: revision?.isCurrent === true && run?.status === "completed" && latestRun?.id === run.id,
      });
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id));
  }

  // -------------------------------------------------------------------------
  // ReviewRepository
  // -------------------------------------------------------------------------

  async reviewSourcePolicy(sourceId: string, reviewerId: string, decision: "approved" | "rejected" | "revoked" = "approved", notes = ""): Promise<void> {
    if (!this.store.sources.has(sourceId)) throw new Error("Source not found");
    this.store.sourcePolicyReviews.push({
      id: this.ids.generate("srcpol"),
      sourceId,
      reviewerId,
      decision,
      notes,
      createdAt: this.clock.nowIso(),
    });
    await this.audit(reviewerId, `source_policy_review.${decision}`, "source", sourceId, notes);
  }

  async reviewSource(sourceId: string, reviewerId: string, notes = ""): Promise<void> {
    await this.reviewSourcePolicy(sourceId, reviewerId, "approved", notes);
  }

  async reviewEvidence(evidenceId: string, reviewerId: string, decision: "approved" | "rejected" | "disputed" = "approved", notes = ""): Promise<void> {
    const record = this.store.evidence.get(evidenceId);
    if (!record) throw new Error("Evidence not found or cannot be reviewed without a source revision");
    const revision = this.store.revisions.get(record.sourceItemRevisionId);
    const item = this.store.sourceItems.get(record.sourceItemId);
    const source = item ? this.store.sources.get(item.sourceId) : undefined;
    const run = this.store.analysisRuns.get(record.analysisRunId);
    const latestRun = this.latestAnalysisRunForRevision(record.sourceItemRevisionId);
    if (!revision || !item || !source || !run || run.status !== "completed" || latestRun?.id !== run.id) {
      throw new Error("Evidence not found or cannot be reviewed without a source revision");
    }
    if (!revision.isCurrent) throw new Error("Evidence review requires the current source revision and analysis run");
    const policy = parsePolicy(source.policy);
    if (decision === "approved" && policy.evidenceReview.preventSubmitterApproval && item.submittedBy === reviewerId) {
      throw new Error("Submitters cannot approve their own evidence");
    }
    const seq = this.store.evidenceReviews.reduce((max, review) => Math.max(max, review.seq), 0) + 1;
    this.store.evidenceReviews.push({
      id: this.ids.generate("evrev"),
      evidenceId,
      sourceItemRevisionId: record.sourceItemRevisionId,
      reviewerId,
      decision,
      notes,
      seq,
      createdAt: this.clock.nowIso(),
    });
    const affectedArticles = new Set<string>();
    const claim = this.store.claims.get(record.claimId);
    if (claim) {
      const identity = claim.canonicalClaimId ?? claim.id;
      for (const articleSource of this.store.articleSources.values()) {
        const referenced = articleSource.claimId ? this.store.claims.get(articleSource.claimId) : undefined;
        if (referenced && (referenced.canonicalClaimId ?? referenced.id) === identity) affectedArticles.add(articleSource.articleId);
      }
    }
    for (const articleId of affectedArticles) {
      await this.refreshArticleEvidenceState(articleId);
      await this.refreshArticleConfidence(articleId);
    }
    await this.audit(reviewerId, `evidence_review.${decision}`, "evidence", evidenceId, notes);
  }

  // -------------------------------------------------------------------------
  // Publication internals
  // -------------------------------------------------------------------------

  private articleEvidenceState(articleId: string): { sourceCount: number; evidenceCount: number; approvedCount: number; complete: boolean; latestChangeAt: number } {
    const references = new Map<string, Set<string>>();
    const evidenceRows = new Map<string, { record: EvidenceRecord; direct: boolean }>();
    let latestChangeAt = 0;
    for (const articleSource of this.store.articleSources.values()) {
      if (articleSource.articleId !== articleId) continue;
      const referenceId = articleSource.id;
      if (!references.has(referenceId)) references.set(referenceId, new Set());
      latestChangeAt = Math.max(latestChangeAt, timestamp(articleSource.updatedAt));
      const claim = articleSource.claimId ? this.store.claims.get(articleSource.claimId) : undefined;
      if (!claim) continue;
      const identity = claim.canonicalClaimId ?? claim.id;
      const memberIds = new Set([...this.store.claims.values()]
        .filter((candidate) => (candidate.canonicalClaimId ?? candidate.id) === identity)
        .map((candidate) => candidate.id));
      for (const record of this.store.evidence.values()) {
        if (!memberIds.has(record.claimId)) continue;
        const direct = record.claimId === claim.id;
        if (direct) references.get(referenceId)!.add(record.id);
        evidenceRows.set(record.id, { record, direct });
      }
    }
    let approvedCount = 0;
    let directEvidenceCount = 0;
    let blockedBy: "rejected" | "disputed" | null = null;
    for (const evidence of evidenceRows.values()) {
      const { record, direct } = evidence;
      const revision = this.store.revisions.get(record.sourceItemRevisionId);
      const item = this.store.sourceItems.get(record.sourceItemId);
      const source = item ? this.store.sources.get(item.sourceId) : undefined;
      const run = this.store.analysisRuns.get(record.analysisRunId);
      const latestRun = this.latestAnalysisRunForRevision(record.sourceItemRevisionId);
      latestChangeAt = Math.max(latestChangeAt, timestamp(record.createdAt), revision ? timestamp(revision.createdAt) : 0);
      if (!revision || !revision.isCurrent || !item || !source || !run || run.status !== "completed" || latestRun?.id !== run.id) continue;
      const review = this.evidenceApprovalState(record.id, record.sourceItemRevisionId, parsePolicy(source.policy));
      latestChangeAt = Math.max(latestChangeAt, review.latestReviewAt);
      if (review.blockedBy === "rejected" || (review.blockedBy === "disputed" && blockedBy !== "rejected")) blockedBy = review.blockedBy;
      if (direct) {
        directEvidenceCount += 1;
        if (review.approved) approvedCount += 1;
      }
    }
    const sourceCount = references.size;
    const evidenceCount = directEvidenceCount;
    const complete = blockedBy === null && sourceCount > 0
      && evidenceCount > 0
      && approvedCount === evidenceCount
      && [...references.values()].every((evidenceIds) => evidenceIds.size > 0);
    return { sourceCount, evidenceCount, approvedCount, complete, latestChangeAt };
  }

  private async refreshArticleEvidenceState(articleId: string): Promise<void> {
    const article = this.store.articles.get(articleId);
    if (!article) throw new Error("Article not found");
    const evidence = this.articleEvidenceState(articleId);
    article.sourceReviewCompleted = evidence.complete;
    article.articleSourcesComplete = evidence.sourceCount > 0;
    if (!evidence.complete) {
      article.editorReviewCompleted = false;
      article.approvedBy = null;
      article.approvedAt = null;
      article.status = article.status === "retracted" ? article.status : "draft";
    } else if (article.status !== "retracted" && article.status !== "published" && article.status !== "updated") {
      article.status = "source_review";
    }
  }

  private async assertPublicationRequirements(articleId: string): Promise<void> {
    const evidence = this.articleEvidenceState(articleId);
    if (!evidence.complete) {
      throw new Error("Publication approval requires current evidence review for every source reference");
    }
    const reviewedAt = this.store.reviews
      .filter((review) => review.targetType === "article" && review.targetId === articleId && review.decision === "approved")
      .reduce((latest, review) => Math.max(latest, timestamp(review.createdAt)), 0);
    if (!reviewedAt || reviewedAt < evidence.latestChangeAt) {
      throw new Error("Publication approval requires a current editorial review");
    }
  }

  async reviewArticle(articleId: string, reviewerId: string, notes = ""): Promise<void> {
    const article = this.store.articles.get(articleId);
    if (!article) throw new Error("Article not found");
    const evidence = this.articleEvidenceState(articleId);
    if (!evidence.complete) {
      throw new Error("Editorial review requires every source reference to have current evidence approval");
    }
    this.store.reviews.push({
      id: this.ids.generate("revw"),
      targetType: "article",
      targetId: articleId,
      reviewerId,
      decision: "approved",
      notes,
      createdAt: this.clock.nowIso(),
    });
    article.sourceReviewCompleted = true;
    article.editorReviewCompleted = true;
    article.articleSourcesComplete = true;
    article.status = article.status === "draft" || article.status === "source_review" ? "editor_review" : article.status;
    await this.audit(reviewerId, "article_review.approved", "article", articleId, notes);
  }

  async approveArticle(articleId: string, approver: string): Promise<void> {
    const article = this.store.articles.get(articleId);
    if (!article) throw new Error("Article not found");
    if (article.status !== "editor_review") throw new Error("Publication approval requires a current editorial review");
    await this.assertPublicationRequirements(articleId);
    article.sourceReviewCompleted = true;
    article.editorReviewCompleted = true;
    article.articleSourcesComplete = true;
    article.status = "approved";
    article.approvedBy = approver;
    article.approvedAt = this.clock.nowIso();
    await this.audit(approver, "article.publication_approved", "article", articleId, "Human publication approval");
  }

  async markPublished(articleId: string, operator: string): Promise<Article> {
    const article = this.store.articles.get(articleId);
    if (!article) throw new Error("Article not found");
    if (article.status !== "approved") throw new Error("Only approved articles can be published");
    await this.assertPublicationRequirements(articleId);
    const cover = this.coverMediaAssignment(articleId);
    if (cover && (cover.assignment.reviewStatus !== "approved" || cover.asset.reviewStatus !== "approved")) {
      throw new Error("Selected cover media must be approved before publication");
    }
    article.status = "published";
    article.publishedAt = this.clock.nowIso();
    article.updatedAt = this.clock.nowIso();
    await this.audit(operator, "article.published", "article", articleId, "Published sanitized artifact");
    const published = await this.getArticle(articleId);
    if (!published) throw new Error("Published article is not readable");
    return published;
  }

  private coverMediaAssignment(articleId: string): { assignment: ArticleMediaRecord; asset: import("./store.ts").MediaAssetRecord } | null {
    const assignment = [...this.store.articleMedia.values()].find((record) => record.articleId === articleId && record.role === "cover");
    if (!assignment) return null;
    const asset = this.store.mediaAssets.get(assignment.mediaId);
    if (!asset) return null;
    return { assignment, asset };
  }

  private assembleArticle(record: ArticleRecord): Article {
    const article = articleRecordToArticle(record);
    article.sourceRefs = [...this.store.articleSources.values()]
      .filter((articleSource) => articleSource.articleId === record.id)
      .map((articleSource) => ({
        sourceId: articleSource.sourceId,
        claimId: articleSource.claimId,
        citationLabel: articleSource.citationLabel,
        publicCitationUrl: articleSource.publicCitationUrl,
      }));
    const cover = this.coverMediaAssignment(record.id);
    if (cover) {
      article.coverMedia = ArticleCoverMediaSchema.parse({
        id: cover.asset.id,
        caption: cover.asset.caption,
        altText: cover.asset.altText,
        collection: cover.asset.collection,
        tags: cover.asset.tags,
        spoilerTags: cover.asset.spoilerTags,
        attribution: cover.asset.attribution,
        sourceUrl: cover.asset.sourceUrl,
        publicUrl: cover.asset.publicUrl,
        selectionSource: cover.assignment.selectionSource,
        reviewStatus: cover.assignment.reviewStatus === "approved" && cover.asset.reviewStatus === "approved" ? "approved"
          : cover.assignment.reviewStatus === "rejected" ? "rejected" : "pending",
      });
    }
    return ArticleSchema.parse(article);
  }

  async getArticle(idOrSlug: string): Promise<Article | null> {
    const record = [...this.store.articles.values()]
      .find((candidate) => candidate.id === idOrSlug || candidate.slug === idOrSlug);
    if (!record) return null;
    return this.assembleArticle(record);
  }

  async listArticles(collectionId: string): Promise<Article[]> {
    const records = [...this.store.articles.values()]
      .filter((record) => record.gameId === collectionId)
      .sort((left, right) => (right.publishedAt ?? right.createdAt).localeCompare(left.publishedAt ?? left.createdAt));
    return records.map((record) => this.assembleArticle(record));
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
    return (await this.listArticles(collectionId))
      .filter((article) => article.status === "published" || article.status === "updated")
      .map((article) => toSafeArticle(article))
      .filter((safe): safe is SafeArticle => safe !== null);
  }

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
    const now = this.clock.nowIso();
    this.store.articles.set(articleId, {
      id: articleId,
      gameId: input.collectionId,
      slug,
      title: input.title,
      seoTitle: input.title,
      description: input.description,
      body: input.body,
      status: "draft",
      newsworthiness: input.newsworthiness,
      confidence: input.confidence,
      sourceReviewCompleted: false,
      editorReviewCompleted: false,
      articleSourcesComplete: false,
      approvedBy: null,
      approvedAt: null,
      publishedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.store.articleRevisions.set(this.ids.generate("rev"), {
      id: this.ids.generate("rev"),
      articleId,
      revisionNumber: 1,
      body: input.body,
      changeSummary: "Initial AI-assisted draft",
      createdAt: now,
    });
    for (const source of input.sourceRefs) {
      const articleSourceId = this.ids.generate("arts");
      this.store.articleSources.set(articleSourceId, {
        id: articleSourceId,
        articleId,
        sourceId: source.sourceId,
        claimId: source.claimId,
        citationLabel: source.citationLabel,
        publicCitationUrl: source.publicCitationUrl,
        updatedAt: now,
      });
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
    const article = this.store.articles.get(input.articleId);
    if (!article) throw new Error("Article not found");
    const maxRevision = [...this.store.articleRevisions.values()]
      .filter((revision) => revision.articleId === input.articleId)
      .reduce((max, revision) => Math.max(max, revision.revisionNumber), 0);
    const now = this.clock.nowIso();
    if (input.body) article.body = input.body;
    article.updatedAt = now;
    this.store.articleRevisions.set(this.ids.generate("rev"), {
      id: this.ids.generate("rev"),
      articleId: input.articleId,
      revisionNumber: maxRevision + 1,
      body: input.body ?? article.body,
      changeSummary: input.changeSummary ?? "Re-analyzed source revision",
      createdAt: now,
    });
    const ownedClaimIds = new Set([...this.store.claims.values()]
      .filter((claim) => claim.sourceItemId === input.sourceItemId)
      .map((claim) => claim.id));
    for (const articleSource of this.store.articleSources.values()) {
      if (articleSource.articleId === input.articleId && articleSource.claimId !== null && ownedClaimIds.has(articleSource.claimId)) {
        this.store.articleSources.delete(articleSource.id);
      }
    }
    for (const source of input.sourceRefs) {
      const articleSourceId = this.ids.generate("arts");
      this.store.articleSources.set(articleSourceId, {
        id: articleSourceId,
        articleId: input.articleId,
        sourceId: source.sourceId,
        claimId: source.claimId,
        citationLabel: source.citationLabel,
        publicCitationUrl: source.publicCitationUrl,
        updatedAt: now,
      });
    }
    await this.refreshArticleEvidenceState(input.articleId);
    await this.refreshArticleConfidence(input.articleId);
  }

  async listClaimsForArticle(articleId: string): Promise<import("@gameintel/contracts").ArticleClaimForDraft[]> {
    const claimIds = new Set([...this.store.articleSources.values()]
      .filter((source) => source.articleId === articleId && source.claimId !== null)
      .map((source) => source.claimId!));
    return [...this.store.claims.values()]
      .filter((claim) => claimIds.has(claim.id))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((claim) => ({
        id: claim.id,
        sourceItemId: claim.sourceItemId,
        subject: claim.subject,
        predicate: claim.predicate,
        value: claim.value,
        evidenceLevel: claim.evidenceLevel,
        attributionType: claim.attributionType,
        statement: claim.statement,
        editorialAssessment: claim.editorialAssessment,
        spoilerTags: [...claim.spoilerTags],
      }));
  }

  async publicArticles(collectionId: string): Promise<unknown[]> {
    return this.listPublicArticles(collectionId);
  }

  async purgeExpiredSourceContent(options: { execute?: boolean } = {}): Promise<SourceContentPurgeResult> {
    const now = this.clock.now();
    const activeArticleIds = new Set([...this.store.articles.values()]
      .filter((article) => ["draft", "source_review", "editor_review", "approved", "updated"].includes(article.status))
      .map((article) => article.id));
    const candidates = [...this.store.sourceItems.values()]
      .filter((item) => item.retentionUntil !== null && item.retentionUntil <= now && item.contentPurgedAt === null)
      .filter((item) => {
        for (const articleSource of this.store.articleSources.values()) {
          if (!activeArticleIds.has(articleSource.articleId)) continue;
          const claim = articleSource.claimId ? this.store.claims.get(articleSource.claimId) : undefined;
          if (claim?.sourceItemId === item.id || (articleSource.claimId === null && articleSource.sourceId === item.sourceId)) return false;
        }
        return true;
      });
    const ids = new Set(candidates.map((candidate) => candidate.id));
    if (!options.execute || !ids.size) {
      return { eligibleSourceItems: ids.size, purgedSourceItems: 0, purgedRevisions: 0, purgedEvidence: 0, dryRun: !options.execute };
    }
    let purgedRevisions = 0;
    let purgedEvidence = 0;
    for (const revision of this.store.revisions.values()) {
      if (ids.has(revision.sourceItemId) && (revision.excerpt !== "" || revision.title !== "" || revision.content !== "")) {
        revision.excerpt = "";
        revision.title = "";
        revision.content = "";
        revision.contentPurgedAt = now;
        purgedRevisions += 1;
      }
    }
    for (const evidence of this.store.evidence.values()) {
      if (ids.has(evidence.sourceItemId) && evidence.excerpt !== "") {
        evidence.excerpt = "";
        purgedEvidence += 1;
      }
    }
    for (const item of this.store.sourceItems.values()) {
      if (ids.has(item.id)) {
        item.textExcerpt = "";
        item.contentPurgedAt = now;
      }
    }
    return { eligibleSourceItems: ids.size, purgedSourceItems: ids.size, purgedRevisions, purgedEvidence, dryRun: false };
  }

  // -------------------------------------------------------------------------
  // SubmissionRepository
  // -------------------------------------------------------------------------

  async createQuarantinedSubmission(input: {
    submission: PublicSubmission;
    submitterSessionHash: string;
    submitterIpHash: string;
    submitterAccountId?: string | null;
    retentionDays?: number;
    limits?: import("@gameintel/contracts").PublicSubmissionRateLimits;
  }): Promise<{ id: string; duplicate: boolean }> {
    if (!/^[a-f0-9]{64}$/i.test(input.submitterSessionHash) || !/^[a-f0-9]{64}$/i.test(input.submitterIpHash)) {
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
    if (!this.store.games.has(input.submission.collectionId)) throw new Error("Collection not found");
    const contentHash = publicSubmissionFingerprint(input.submission);
    const now = this.clock.now();
    const duplicate = [...this.store.publicSubmissions.values()]
      .find((submission) => submission.collectionId === input.submission.collectionId
        && submission.submitterSessionHash === input.submitterSessionHash
        && submission.contentHash === contentHash
        && now - timestamp(submission.createdAt) < 86_400_000);
    if (duplicate) return { id: duplicate.id, duplicate: true };

    const submissionCount = (condition: "ip" | "session" | "account" | "global", identity?: string): number => {
      const all = [...this.store.publicSubmissions.values()];
      if (condition === "ip") return all.filter((submission) => submission.submitterIpHash === identity && now - timestamp(submission.createdAt) < 60_000).length;
      if (condition === "session") return all.filter((submission) => submission.submitterSessionHash === identity && now - timestamp(submission.createdAt) < 60_000).length;
      if (condition === "account") return all.filter((submission) => submission.submitterAccountId === identity && now - timestamp(submission.createdAt) < 86_400_000).length;
      return all.filter((submission) => now - timestamp(submission.createdAt) < 60_000).length;
    };
    if (submissionCount("global") >= limits.globalPerMinute
      || submissionCount("ip", input.submitterIpHash) >= limits.perIpPerMinute
      || submissionCount("session", input.submitterSessionHash) >= limits.perSessionPerMinute
      || (accountId !== null && submissionCount("account", accountId) >= limits.perAccountPerDay)) {
      throw new SubmissionRateLimitError();
    }

    const submissionId = this.ids.generate("sub");
    const nowIso = this.clock.nowIso();
    this.store.publicSubmissions.set(submissionId, {
      id: submissionId,
      collectionId: input.submission.collectionId,
      submitterAccountId: accountId,
      submitterSessionHash: input.submitterSessionHash,
      submitterIpHash: input.submitterIpHash,
      title: input.submission.title ?? null,
      report: input.submission.report,
      urls: [...input.submission.urls],
      mediaRefs: input.submission.mediaRefs.map((media) => ({ ...media })),
      contentHash,
      retentionUntil: now + retentionDays * 86_400_000,
      state: "quarantined",
      promotedSourceItemId: null,
      contentPurgedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    this.store.submissionActions.push({
      id: this.ids.generate("subact"),
      submissionId,
      actorId: "system",
      action: "submitted",
      notes: "Submission entered quarantine",
      createdAt: nowIso,
    });
    await this.audit("system", "submission.quarantined", "public_submission", submissionId, "Unverified public submission");
    return { id: submissionId, duplicate: false };
  }

  private moderationSubmission(submission: import("./store.ts").PublicSubmissionRecord): PublicSubmissionForModeration {
    return {
      id: submission.id,
      collectionId: submission.collectionId,
      state: submission.state,
      title: submission.title,
      report: submission.report,
      urls: [...submission.urls],
      mediaRefs: submission.mediaRefs.map((media) => ({ ...media })),
      promotedSourceItemId: submission.promotedSourceItemId,
      retentionUntil: new Date(submission.retentionUntil).toISOString(),
      createdAt: submission.createdAt,
      updatedAt: submission.updatedAt,
    };
  }

  // Diagnostic surface for conformance tests: forces retention expiry.
  expireSubmissionRetentionForTest(submissionId: string): void {
    const submission = this.store.publicSubmissions.get(submissionId);
    if (submission) submission.retentionUntil = this.clock.now() - 1_000;
  }

  async listPublicSubmissionsForModeration(
    collectionId: string,
    options: { state?: import("@gameintel/core").PublicSubmissionState; limit?: number } = {},
  ): Promise<PublicSubmissionForModeration[]> {
    if (!collectionId.trim()) throw new Error("A collection id is required");
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Submission list limit must be between 1 and 200");
    const rows = [...this.store.publicSubmissions.values()]
      .filter((submission) => submission.collectionId === collectionId && submission.contentPurgedAt === null)
      .filter((submission) => options.state === undefined || submission.state === options.state)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
    return rows.map((submission) => this.moderationSubmission(submission));
  }

  async getPublicSubmissionForModeration(submissionId: string): Promise<PublicSubmissionForModeration | null> {
    const submission = this.store.publicSubmissions.get(submissionId);
    if (!submission || submission.contentPurgedAt !== null) return null;
    return this.moderationSubmission(submission);
  }

  async listPublicSubmissionModerationActions(submissionId: string): Promise<PublicSubmissionModerationAction[]> {
    return this.store.submissionActions
      .filter((action) => action.submissionId === submissionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((action) => ({
        id: action.id,
        actorId: action.actorId,
        action: action.action,
        notes: action.notes,
        createdAt: action.createdAt,
      }));
  }

  async reviewPublicSubmission(input: {
    submissionId: string;
    actorId: string;
    decision: import("@gameintel/core").PublicSubmissionReviewDecision;
    notes?: string;
  }): Promise<{ id: string; state: import("@gameintel/core").PublicSubmissionReviewDecision }> {
    const actorId = input.actorId.trim();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(actorId)) throw new Error("A valid moderation actor is required");
    const notes = input.notes?.trim() ?? "";
    if (notes.length > 2_000) throw new Error("Moderation notes exceed the 2,000 character limit");
    const submission = this.store.publicSubmissions.get(input.submissionId);
    if (!submission) throw new Error("Submission not found");
    if (submission.contentPurgedAt !== null || submission.state === "expired" || submission.state === "promoted") {
      throw new Error("Submission is no longer available for moderation");
    }
    const permitted = submission.state === "quarantined" || submission.state === "under_review";
    if (!permitted) throw new Error(`Submission cannot transition from ${submission.state} to ${input.decision}`);
    submission.state = input.decision;
    submission.updatedAt = this.clock.nowIso();
    this.store.submissionActions.push({
      id: this.ids.generate("subact"),
      submissionId: submission.id,
      actorId,
      action: `state:${input.decision}`,
      notes,
      createdAt: this.clock.nowIso(),
    });
    await this.audit(actorId, `submission.${input.decision}`, "public_submission", submission.id, notes);
    return { id: submission.id, state: input.decision };
  }

  async getPublicSubmissionForPromotion(submissionId: string): Promise<PublicSubmissionForModeration> {
    const submission = this.store.publicSubmissions.get(submissionId);
    if (!submission) throw new Error("Submission not found");
    const moderated = this.moderationSubmission(submission);
    if (moderated.state !== "under_review" || !moderated.report) {
      throw new Error("Submission must be under review and retained before promotion");
    }
    return moderated;
  }

  async markPublicSubmissionPromoted(input: { submissionId: string; sourceItemId: string; actorId: string; notes?: string }): Promise<void> {
    const actorId = input.actorId.trim();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(actorId)) throw new Error("A valid moderation actor is required");
    const notes = input.notes?.trim() ?? "";
    if (notes.length > 2_000) throw new Error("Moderation notes exceed the 2,000 character limit");
    const submission = this.store.publicSubmissions.get(input.submissionId);
    if (!submission || submission.state !== "under_review" || submission.contentPurgedAt !== null) {
      throw new Error("Submission is no longer eligible for promotion");
    }
    submission.state = "promoted";
    submission.promotedSourceItemId = input.sourceItemId;
    submission.updatedAt = this.clock.nowIso();
    this.store.submissionActions.push({
      id: this.ids.generate("subact"),
      submissionId: submission.id,
      actorId,
      action: "promoted",
      notes,
      createdAt: this.clock.nowIso(),
    });
    await this.audit(actorId, "submission.promoted", "public_submission", submission.id, notes);
  }

  async recordSubmissionModerationAction(submissionId: string, actorId: string, action: string, notes = ""): Promise<void> {
    if (!this.store.publicSubmissions.has(submissionId)) throw new Error("Submission not found");
    this.store.submissionActions.push({
      id: this.ids.generate("subact"),
      submissionId,
      actorId,
      action: action.slice(0, 100),
      notes: notes.slice(0, 2_000),
      createdAt: this.clock.nowIso(),
    });
    await this.audit(actorId, `submission.${action.slice(0, 100)}`, "public_submission", submissionId, notes.slice(0, 2_000));
  }

  async purgeExpiredPublicSubmissions(options: { execute?: boolean } = {}): Promise<PublicSubmissionPurgeResult> {
    const now = this.clock.now();
    const candidates = [...this.store.publicSubmissions.values()]
      .filter((submission) => submission.retentionUntil <= now && submission.contentPurgedAt === null);
    if (!options.execute || !candidates.length) {
      return { eligibleSubmissions: candidates.length, purgedSubmissions: 0, dryRun: !options.execute };
    }
    for (const submission of candidates) {
      submission.title = null;
      submission.report = "";
      submission.urls = [];
      submission.mediaRefs = [];
      submission.contentPurgedAt = now;
      submission.updatedAt = this.clock.nowIso();
      if (["quarantined", "under_review", "blocked"].includes(submission.state)) submission.state = "expired";
    }
    return { eligibleSubmissions: candidates.length, purgedSubmissions: candidates.length, dryRun: false };
  }

  // -------------------------------------------------------------------------
  // AuditRepository
  // -------------------------------------------------------------------------

  async audit(actor: string, action: string, targetType: string, targetId: string, reason: string): Promise<void> {
    this.store.auditLog.push({
      id: this.ids.generate("audit"),
      actorId: actor,
      action,
      targetType,
      targetId,
      reason,
      createdAt: this.clock.nowIso(),
    });
  }

  // -------------------------------------------------------------------------
  // MediaRepository
  // -------------------------------------------------------------------------

  async importMediaCatalog(catalogPath: string): Promise<{ imported: number; collectionIds: string[] }> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(catalogPath, "utf8"));
    } catch (error) {
      throw new Error(`Could not read media catalog '${catalogPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
    const catalog = MediaCatalogSchema.safeParse(parsed);
    if (!catalog.success) throw new Error(`Invalid media catalog: ${catalog.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    assertUniqueMedia(catalog.data.media);
    const now = this.clock.nowIso();
    for (const entry of catalog.data.media) {
      const existing = this.store.mediaAssets.get(entry.id);
      if (existing) {
        const replacement = memoryCatalogEntry(entry);
        replacement.updatedAt = now;
        this.store.mediaAssets.set(entry.id, replacement);
      } else {
        this.store.mediaAssets.set(entry.id, memoryCatalogEntry(entry));
      }
    }
    return { imported: catalog.data.media.length, collectionIds: [...new Set(catalog.data.media.map((entry) => entry.collectionId))].sort() };
  }

  async listCoverCandidates(articleId: string): Promise<CoverMediaCandidate[]> {
    const article = this.store.articles.get(articleId);
    if (!article) return [];
    const candidates = [...this.store.mediaAssets.values()]
      .filter((asset) => asset.gameId === article.gameId && asset.reviewStatus === "approved" && asset.spoilerTags.length === 0)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((asset) => ({
        id: asset.id,
        collection: asset.collection,
        caption: asset.caption,
        altText: asset.altText,
        tags: [...asset.tags],
        spoilerTags: [...asset.spoilerTags],
        attribution: asset.attribution,
        sourceUrl: asset.sourceUrl,
        publicUrl: asset.publicUrl,
      }));
    return candidates;
  }

  async setCoverMedia(articleId: string, mediaId: string, selectionSource: "automatic" | "editor" = "editor"): Promise<void> {
    const article = this.store.articles.get(articleId);
    const asset = this.store.mediaAssets.get(mediaId);
    if (!article || !asset) throw new Error("Article or media asset not found");
    if (article.gameId !== asset.gameId) throw new Error("Cover media must belong to the article collection");
    if (asset.spoilerTags.length) throw new Error("Spoiler-tagged media cannot be a cover");
    const existing = [...this.store.articleMedia.values()].find((record) => record.articleId === articleId && record.role === "cover");
    const now = this.clock.nowIso();
    if (existing) {
      existing.mediaId = mediaId;
      existing.selectionSource = selectionSource;
      existing.reviewStatus = "pending";
      existing.reviewedBy = null;
      existing.reviewedAt = null;
      existing.createdAt = now;
    } else {
      this.store.articleMedia.set(this.ids.generate("artmed"), {
        articleId,
        mediaId,
        role: "cover",
        selectionSource,
        reviewStatus: "pending",
        reviewedBy: null,
        reviewedAt: null,
        createdAt: now,
      });
    }
  }

  async recommendArticleCover(input: { articleId: string; title: string; description: string; safeClaimText: string[] }): Promise<string | null> {
    const candidates = await this.listCoverCandidates(input.articleId);
    if (!candidates.length) return null;
    const articleText = [input.title, input.description, ...input.safeClaimText].join(" ").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
    const selected = candidates
      .map((candidate) => ({ candidate, score: mediaCoverScore(candidate, articleText) }))
      .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0].candidate;
    await this.setCoverMedia(input.articleId, selected.id, "automatic");
    return selected.id;
  }

  async approveMediaAsset(mediaId: string, reviewer: string): Promise<void> {
    const asset = this.store.mediaAssets.get(mediaId);
    if (!asset) throw new Error("Media asset not found");
    asset.reviewStatus = "approved";
    asset.approvedBy = reviewer;
    asset.approvedAt = this.clock.nowIso();
    asset.updatedAt = this.clock.nowIso();
  }

  async approveMediaCollection(collectionId: string, reviewer: string): Promise<number> {
    let count = 0;
    for (const asset of this.store.mediaAssets.values()) {
      if (asset.gameId === collectionId && asset.reviewStatus === "pending" && asset.spoilerTags.length === 0) {
        asset.reviewStatus = "approved";
        asset.approvedBy = reviewer;
        asset.approvedAt = this.clock.nowIso();
        asset.updatedAt = this.clock.nowIso();
        count += 1;
      }
    }
    return count;
  }

  async approveCoverMedia(articleId: string, reviewer: string): Promise<void> {
    const cover = this.coverMediaAssignment(articleId);
    if (!cover) throw new Error("Article has no selected cover media");
    if (cover.asset.reviewStatus !== "approved") throw new Error("Cover media asset must be approved before its assignment");
    cover.assignment.reviewStatus = "approved";
    cover.assignment.reviewedBy = reviewer;
    cover.assignment.reviewedAt = this.clock.nowIso();
  }

  async rejectCoverMedia(articleId: string, reviewer: string): Promise<void> {
    const cover = this.coverMediaAssignment(articleId);
    if (!cover) throw new Error("Article has no selected cover media");
    cover.assignment.reviewStatus = "rejected";
    cover.assignment.reviewedBy = reviewer;
    cover.assignment.reviewedAt = this.clock.nowIso();
  }

  async clearCoverMedia(articleId: string): Promise<void> {
    for (const [id, record] of this.store.articleMedia) {
      if (record.articleId === articleId && record.role === "cover") this.store.articleMedia.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Lease fencing
  // -------------------------------------------------------------------------

  async assertIngestionJobLeaseHeld(jobKey: string, leaseToken: string): Promise<void> {
    if (this.leases !== null && !this.leases.held(jobKey, leaseToken)) throw new IngestionLeaseLostError(jobKey);
  }
}
