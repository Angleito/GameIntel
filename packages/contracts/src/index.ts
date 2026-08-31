import type {
  Article,
  ArticleBody,
  GameProfile,
  NormalizedSourceItem,
  PublicSubmission,
  PublicSubmissionReviewDecision,
  PublicSubmissionState,
  SafeArticle,
  SourcePolicy,
  SourceStrength,
  PublicationMode,
  ProvenanceClusteringMethod,
  ProvenanceRelationship,
  ClaimState,
} from "@gameintel/core";

// GameIntel capability contracts. GameIntel Core depends on these interfaces,
// never on PostgreSQL, Squid, Cloudflare, R2, or any other product. Adapters
// (PostgreSQL, in-memory, controlled fetch, filesystem, ...) implement them.
// Infrastructure-specific concerns belong inside adapters.

export const ADAPTER_API_VERSION = 1;

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  nowIso(): string;
}

export interface IdGenerator {
  generate(prefix: string): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
};

export const cryptoIdGenerator: IdGenerator = {
  generate: (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`,
};

// ---------------------------------------------------------------------------
// Domain-facing types shared by adapters
// ---------------------------------------------------------------------------

export type SourceInput = {
  id: string;
  type: string;
  canonicalUrl: string;
  publicCitationUrl: string | null;
  sourceStrength: SourceStrength;
  publicationMode: PublicationMode;
  policy: SourcePolicy;
  enabled?: boolean;
};

export type InsertedSourceItem = {
  id: string;
  // The revision that stores (or already stored) this content. A duplicate
  // re-fetch returns the current revision id so the pipeline can decide
  // whether that revision's analysis is up to date with the current
  // parser/extractor/confidence versions.
  revisionId: string;
  provenanceFamilyId: string;
  duplicate: boolean;
  materialChange: boolean;
};

export type InsertedClaim = {
  claimId: string;
  canonicalClaimId: string;
};

// The implementation versions that produced an analysis run. Only the
// analysis stages participate in run identity: normalization, claim
// extraction, and the confidence model. The parser version belongs to the
// immutable source-extraction stage (stored revision content is already
// parser output), so it never appears here; it is retained as audit
// metadata on the revision and the run. A completed run with identical
// versions is idempotent; any mismatch means the revision has not been
// interpreted by the current pipeline and should be reprocessed.
export type AnalysisVersions = {
  normalizationVersion: string;
  claimExtractorVersion: string;
  confidenceModelVersion: string;
};

export type AnalysisRunInfo = {
  id: string;
  sourceItemRevisionId: string;
  processingVersion: string | null;
  normalizationVersion: string | null;
  claimExtractorVersion: string | null;
  confidenceModelVersion: string | null;
  status: "completed" | "superseded";
  triggeredBy: string | null;
  triggerReason: string;
  createdAt: string;
  completedAt: string | null;
};

// The claim fields needed to regenerate an article draft from its currently
// referenced claims (subject/predicate/value, editorial metadata, and the
// evidence level/attribution already derived from source trust).
export type ArticleClaimForDraft = {
  id: string;
  sourceItemId: string;
  subject: string;
  predicate: string;
  value: string;
  evidenceLevel: import("@gameintel/core").EvidenceLevel;
  attributionType: import("@gameintel/core").AttributionType;
  statement: string | null;
  editorialAssessment: string | null;
  spoilerTags: string[];
};

// Immutable revision content plus the source policy context needed to
// reprocess it with the current pipeline without refetching.
export type RevisionForAnalysis = {
  id: string;
  sourceItemId: string;
  title: string;
  content: string;
  rawHash: string;
  processingVersion: string | null;
  contentPurged: boolean;
  sourceItem: {
    collectionId: string;
    externalId: string;
    url: string;
    sourceStrength: SourceStrength;
    publicationMode: PublicationMode;
    discoveredAt: string;
    publishedAt: string | null;
    inputKind: string;
    contentType: string | null;
    language: string | null;
    lineageId: string;
    submittedBy: string | null;
  };
  source: SourceInput;
};

export type SourceItemProvenanceInfo = {
  provenanceFamilyId: string;
  relationship: ProvenanceRelationship;
  clusteringMethod: ProvenanceClusteringMethod;
};

export type SourceIngestJobPayload = {
  collectionId: string;
  sourceId: string;
  url: string;
  profileId?: string;
};

// Discovery jobs are enqueued by the scheduler for discovery sources. The
// isolated ingestion worker fetches the feed, parses items, and enqueues each
// item as its own source_ingest job. The feed URL is never ingested as an
// article.
export type SourceDiscoverJobPayload = {
  collectionId: string;
  sourceId: string;
  feedUrl: string;
  profileId?: string;
};

export type IngestionJob = {
  jobKey: string;
  jobType: string;
  status: string;
  payload: SourceIngestJobPayload | SourceDiscoverJobPayload;
  attempts: number;
  maxAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  result: unknown;
};

export type IngestionWorkerHeartbeat = {
  workerId: string;
  workerType: "source_ingest";
  currentJobKey: string | null;
  lastError: string | null;
  lastSeenAt: string;
};

export type IngestionQueueStatus = {
  queued: number;
  running: number;
  completed: number;
  dead: number;
  oldestQueuedAt: string | null;
  activeWorkers: number;
  staleWorkers: number;
};

export type SourceIngestEnqueueResult = {
  jobKey: string;
  dedupeKey: string;
  duplicate: boolean;
  status: string;
};

export type SourceContentPurgeResult = {
  eligibleSourceItems: number;
  purgedSourceItems: number;
  purgedRevisions: number;
  purgedEvidence: number;
  dryRun: boolean;
};

export type PublicSubmissionRateLimits = {
  perIpPerMinute: number;
  perSessionPerMinute: number;
  perAccountPerDay: number;
  globalPerMinute: number;
};

export const defaultPublicSubmissionRateLimits: PublicSubmissionRateLimits = {
  perIpPerMinute: 5,
  perSessionPerMinute: 3,
  perAccountPerDay: 20,
  globalPerMinute: 300,
};

export type PublicSubmissionForModeration = {
  id: string;
  collectionId: string;
  state: PublicSubmissionState;
  title: string | null;
  report: string;
  urls: PublicSubmission["urls"];
  mediaRefs: PublicSubmission["mediaRefs"];
  promotedSourceItemId: string | null;
  retentionUntil: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicSubmissionModerationAction = {
  id: string;
  actorId: string;
  action: string;
  notes: string;
  createdAt: string;
};

export type PublicSubmissionPurgeResult = {
  eligibleSubmissions: number;
  purgedSubmissions: number;
  dryRun: boolean;
};

export type ArticleEvidenceForReview = {
  id: string;
  claimId: string;
  sourceItemId: string;
  sourceItemRevisionId: string | null;
  // Version of the parser/normalization/claim-extraction implementation that
  // produced the source revision this evidence is tied to.
  processingVersion: string | null;
  excerpt: string;
  evidenceType: string;
  current: boolean;
};

export type CoverMediaCandidate = {
  id: string;
  collection: string;
  caption: string;
  altText: string;
  tags: string[];
  spoilerTags: string[];
  attribution: string;
  sourceUrl: string;
  publicUrl: string;
};

export class IngestionLeaseLostError extends Error {
  constructor(jobKey: string) {
    super(`Ingestion job ${jobKey} lease is no longer held`);
    this.name = "IngestionLeaseLostError";
  }
}

export class SubmissionRateLimitError extends Error {
  constructor() {
    super("Submission rate limit exceeded");
  }
}

// ---------------------------------------------------------------------------
// Persistence capabilities
// ---------------------------------------------------------------------------

export interface SourceRepository {
  ensureGame(profile: GameProfile): Promise<void>;
  ensureSource(source: SourceInput): Promise<void>;
  insertSourceItem(
    item: NormalizedSourceItem,
    rawHash: string,
    lineageId: string,
    policy: SourcePolicy,
    submittedBy?: string | null,
  ): Promise<InsertedSourceItem>;
}

export interface ObservationRepository {
  createEvent(input: { collectionId: string; sourceItemId: string; newsworthiness: number; disposition: string; existingArticleId?: string | null }): Promise<string>;
  linkSourceItemProvenance(input: {
    sourceItemId: string;
    relatedSourceItemId: string;
    relationship: ProvenanceRelationship;
    clusteringMethod?: ProvenanceClusteringMethod;
    reviewerId: string;
    notes?: string;
  }): Promise<void>;
  getSourceItemProvenance(sourceItemId: string): Promise<SourceItemProvenanceInfo | null>;
}

export interface ClaimRepository {
  insertClaim(
    item: NormalizedSourceItem,
    sourceItemId: string,
    sourceItemRevisionId: string,
    analysisRunId: string,
    provenanceFamilyId: string,
    claim: NormalizedSourceItem["claims"][number],
    lineageId: string,
  ): Promise<InsertedClaim>;
  refreshClaimState(claimId: string): Promise<ClaimState>;
  refreshClaimStatesForSourceItem(sourceItemId: string): Promise<number>;
  calculateClaimConfidence(claimId: string): Promise<number>;
  getAnalysisRun(sourceItemRevisionId: string, versions: AnalysisVersions): Promise<AnalysisRunInfo | null>;
  createAnalysisRun(input: { sourceItemRevisionId: string; versions: AnalysisVersions; triggeredBy?: string | null; triggerReason: string }): Promise<AnalysisRunInfo>;
  listAnalysisRuns(sourceItemRevisionId: string): Promise<AnalysisRunInfo[]>;
  getRevisionForAnalysis(revisionId: string): Promise<RevisionForAnalysis | null>;
  resolveExistingArticleForCanonicalClaims(canonicalClaimIds: string[]): Promise<string | null>;
  refreshArticlesForCanonicalClaims(canonicalClaimIds: string[], auditAction: string, auditReason: string): Promise<string[]>;
  // Canonical claim identity of EVERY claim belonging to the source item,
  // including claims from superseded revisions. Refreshing through the
  // union of old and new canonical ids is what makes a material source
  // change invalidate articles that cite the source item's earlier claims.
  canonicalClaimIdsForSourceItem(sourceItemId: string): Promise<string[]>;
}

export interface EvidenceRepository {
  invalidateEvidenceApprovalsForSourceItem(sourceItemId: string): Promise<void>;
  listArticleEvidence(articleId: string): Promise<ArticleEvidenceForReview[]>;
}

export interface ReviewRepository {
  reviewSourcePolicy(sourceId: string, reviewerId: string, decision?: "approved" | "rejected" | "revoked", notes?: string): Promise<void>;
  reviewSource(sourceId: string, reviewerId: string, notes?: string): Promise<void>;
  reviewEvidence(evidenceId: string, reviewerId: string, decision?: "approved" | "rejected" | "disputed", notes?: string): Promise<void>;
  reviewArticle(articleId: string, reviewerId: string, notes?: string): Promise<void>;
  approveArticle(articleId: string, approver: string): Promise<void>;
}

export interface PublicationRepository {
  createArticleDraft(input: {
    collectionId: string;
    title: string;
    description: string;
    body: ArticleBody;
    newsworthiness: number;
    confidence: number;
    sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
  }): Promise<string>;
  // Refreshes an existing article from a re-analyzed source revision.
  // Knowledge update: replaces the article_sources references owned by that
  // source item, writes an article_revisions row, and re-derives evidence
  // state and confidence (a published article demotes to source_review/draft
  // and its materialized public record is dropped until evidence is
  // re-reviewed). When `body` is provided it is a draft regenerated from
  // ALL currently referenced claims — never from a single newly arrived
  // source — and is written in the same transaction; otherwise the article
  // content is left untouched for editorial rework.
  updateExistingArticle(input: {
    articleId: string;
    sourceItemId: string;
    sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
    body?: ArticleBody | null;
    changeSummary?: string;
  }): Promise<void>;
  // Claims currently referenced by the article, for draft regeneration.
  listClaimsForArticle(articleId: string): Promise<ArticleClaimForDraft[]>;
  getArticle(idOrSlug: string): Promise<Article | null>;
  listArticles(collectionId: string): Promise<Article[]>;
  // The public article surface: sanitized records (publicSafe + spoiler-safe
  // body sections, numbered citations, approved cover media only). For the
  // PostgreSQL adapter these are served from the materialized
  // public_article_records table via SECURITY DEFINER functions; the raw
  // article row, including editorial fields and internal sections, is never
  // readable by a public process.
  getPublicArticle(idOrSlug: string): Promise<SafeArticle | null>;
  listPublicArticles(collectionId: string): Promise<SafeArticle[]>;
  markPublished(articleId: string, operator: string): Promise<Article>;
  publicArticles(collectionId: string): Promise<unknown[]>;
  purgeExpiredSourceContent(options?: { execute?: boolean }): Promise<SourceContentPurgeResult>;
}

export interface SubmissionRepository {
  createQuarantinedSubmission(input: {
    submission: PublicSubmission;
    submitterSessionHash: string;
    submitterIpHash: string;
    submitterAccountId?: string | null;
    retentionDays?: number;
    limits?: PublicSubmissionRateLimits;
  }): Promise<{ id: string; duplicate: boolean }>;
  listPublicSubmissionsForModeration(collectionId: string, options?: { state?: PublicSubmissionState; limit?: number }): Promise<PublicSubmissionForModeration[]>;
  getPublicSubmissionForModeration(submissionId: string): Promise<PublicSubmissionForModeration | null>;
  listPublicSubmissionModerationActions(submissionId: string): Promise<PublicSubmissionModerationAction[]>;
  reviewPublicSubmission(input: {
    submissionId: string;
    actorId: string;
    decision: PublicSubmissionReviewDecision;
    notes?: string;
  }): Promise<{ id: string; state: PublicSubmissionReviewDecision }>;
  getPublicSubmissionForPromotion(submissionId: string): Promise<PublicSubmissionForModeration>;
  markPublicSubmissionPromoted(input: { submissionId: string; sourceItemId: string; actorId: string; notes?: string }): Promise<void>;
  recordSubmissionModerationAction(submissionId: string, actorId: string, action: string, notes?: string): Promise<void>;
  purgeExpiredPublicSubmissions(options?: { execute?: boolean }): Promise<PublicSubmissionPurgeResult>;
}

export interface AuditRepository {
  audit(actor: string, action: string, targetType: string, targetId: string, reason: string): Promise<void>;
}

export interface MediaRepository {
  importMediaCatalog(catalogPath: string): Promise<{ imported: number; collectionIds: string[] }>;
  listCoverCandidates(articleId: string): Promise<CoverMediaCandidate[]>;
  setCoverMedia(articleId: string, mediaId: string, selectionSource?: "automatic" | "editor"): Promise<void>;
  recommendArticleCover(input: { articleId: string; title: string; description: string; safeClaimText: string[] }): Promise<string | null>;
  approveMediaAsset(mediaId: string, reviewer: string): Promise<void>;
  approveMediaCollection(collectionId: string, reviewer: string): Promise<number>;
  approveCoverMedia(articleId: string, reviewer: string): Promise<void>;
  rejectCoverMedia(articleId: string, reviewer: string): Promise<void>;
  clearCoverMedia(articleId: string): Promise<void>;
}

// A transaction-scoped persistence handle. `transaction` runs the callback
// against the same atomic scope as every repository method; a lease fence is
// checked inside the transaction so a reclaimed execution can never write.
export interface GameIntelPersistence extends
  SourceRepository,
  ObservationRepository,
  ClaimRepository,
  EvidenceRepository,
  ReviewRepository,
  PublicationRepository,
  SubmissionRepository,
  AuditRepository,
  MediaRepository {
  transaction<T>(callback: (transaction: GameIntelPersistence) => Promise<T>): Promise<T>;
  assertIngestionJobLeaseHeld(jobKey: string, leaseToken: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Scheduling, queue, pacing
// ---------------------------------------------------------------------------

export interface JobQueue {
  enqueueSourceIngestJob(input: SourceIngestJobPayload): Promise<SourceIngestEnqueueResult>;
  enqueueSourceDiscoverJob(input: SourceDiscoverJobPayload): Promise<SourceIngestEnqueueResult>;
  claimIngestionJob(workerId: string, jobTypes?: string[], leaseMs?: number): Promise<IngestionJob | null>;
  completeIngestionJob(jobKey: string, leaseToken: string, result: unknown): Promise<void>;
  failIngestionJob(jobKey: string, leaseToken: string, error: unknown, retryable?: boolean): Promise<void>;
  renewIngestionJobLease(jobKey: string, leaseToken: string, durationMs: number): Promise<boolean>;
  getIngestionJob(jobKey: string): Promise<IngestionJob | null>;
  listRecentIngestionJobs(limit?: number): Promise<IngestionJob[]>;
  getIngestionQueueStatus(staleAfterMs?: number): Promise<IngestionQueueStatus>;
  heartbeatIngestionWorker(input: {
    workerId: string;
    workerType: "source_ingest";
    currentJobKey?: string | null;
    lastError?: string | null;
  }): Promise<void>;
  listIngestionWorkerHeartbeats(): Promise<IngestionWorkerHeartbeat[]>;
}

export interface SourcePacingStore {
  acquireFetchSlot(sourceId: string, requestsPerMinute: number): Promise<number>;
}
// ---------------------------------------------------------------------------
// Source health (TASK-004): persistent per-source health aggregation with an
// operator-controlled kill switch. Auto-disable is a pure function of the
// previous record and the incoming observation.
// ---------------------------------------------------------------------------

export type SourceHealthStatus = "ok" | "down";

export type SourceHealthRecord = {
  sourceId: string;
  status: SourceHealthStatus;
  checkedAt: string;
  message: string | null;
  consecutiveFailures: number;
  disabledAt: string | null;
  disabledReason: string | null;
};

export const SOURCE_HEALTH_DISABLE_AFTER_FAILURES = 3;

export function applySourceHealthUpdate(previous: SourceHealthRecord | null, input: {
  sourceId: string;
  status: SourceHealthStatus;
  checkedAt: string;
  message?: string | null;
}): SourceHealthRecord {
  const consecutiveFailures = input.status === "down" ? (previous?.consecutiveFailures ?? 0) + 1 : 0;
  const disabledAt = previous?.disabledAt ?? (consecutiveFailures >= SOURCE_HEALTH_DISABLE_AFTER_FAILURES ? input.checkedAt : null);
  return {
    sourceId: input.sourceId,
    status: input.status,
    checkedAt: input.checkedAt,
    message: input.message ?? null,
    consecutiveFailures,
    disabledAt,
    disabledReason: disabledAt && !previous?.disabledAt
      ? `automatically disabled after ${consecutiveFailures} consecutive failures`
      : previous?.disabledReason ?? null,
  };
}

export interface SourceHealthStore {
  recordSourceHealth(input: { sourceId: string; status: SourceHealthStatus; checkedAt: string; message?: string | null }): Promise<SourceHealthRecord>;
  getSourceHealth(sourceId: string): Promise<SourceHealthRecord | null>;
  listSourceHealth(): Promise<SourceHealthRecord[]>;
  setSourceDisabled(sourceId: string, disabled: boolean, reason: string, actor: string): Promise<SourceHealthRecord>;
}

export type SchedulableSource = {
  sourceId: string;
  collectionId: string;
  url: string;
  profileId?: string;
  pollIntervalSeconds: number;
  // Discovery sources enqueue a source_discover job for url (the feed) on
  // each due tick; the isolated ingestion worker performs the fetch.
  discoveryAdapter?: "rss" | null;
};

export interface SourceScheduler {
  dueSources(now?: number): Promise<SchedulableSource[]>;
  markScheduled(sourceId: string, scheduledAt: number): Promise<void>;
}

// Reference scheduler implementation: registry-driven polling cadence tracked
// in memory. The scheduler decides when a source is due; the pacing layer
// decides when a request is actually allowed.
export class RegistryPollingScheduler implements SourceScheduler {
  private readonly lastScheduledAt = new Map<string, number>();

  constructor(
    private readonly sources: SchedulableSource[],
    private readonly clock: Clock,
  ) {}

  async dueSources(now = this.clock.now()): Promise<SchedulableSource[]> {
    const due: SchedulableSource[] = [];
    for (const source of this.sources) {
      const lastScheduled = this.lastScheduledAt.get(source.sourceId) ?? 0;
      if (now - lastScheduled >= source.pollIntervalSeconds * 1_000) due.push(source);
    }
    return due;
  }

  async markScheduled(sourceId: string, scheduledAt: number): Promise<void> {
    this.lastScheduledAt.set(sourceId, scheduledAt);
  }
}

// Runtime factories use this to distinguish "scheduler not configured"
// (undefined -> null) from "scheduler configured with zero sources"
// ([] -> a live scheduler that stays idle). An explicit empty set still
// creates a live idle scheduler, avoiding a restart loop when no network
// sources are currently enabled.
export function schedulerForSources(sources: SchedulableSource[] | undefined, clock: Clock): SourceScheduler | null {
  return sources !== undefined ? new RegistryPollingScheduler(sources, clock) : null;
}

// ---------------------------------------------------------------------------
// Controlled fetch
// ---------------------------------------------------------------------------

export type RegisteredSource = {
  id: string;
  domains: string[];
  access: "rss" | "permitted_scrape" | "official_api" | "manual";
  rpm: number;
  userAgent?: string;
  enabled: boolean;
};

export type FetchPolicy = {
  source: RegisteredSource;
  sourcePolicy: SourcePolicy;
  proxyUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
};

export type FetchedResource = { url: string; contentType: string; status: number; text: string };

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface ControlledFetchTransport {
  fetch(url: string, policy: FetchPolicy): Promise<FetchedResource>;
}

// Fail-fast default for runtime assemblies that do not wire a real transport.
// Any process that actually fetches must receive a configured transport.
export class UnconfiguredFetchTransport implements ControlledFetchTransport {
  async fetch(): Promise<FetchedResource> {
    throw new Error("No fetch transport is configured for this runtime");
  }
}

// ---------------------------------------------------------------------------
// Object storage
// ---------------------------------------------------------------------------

export interface ObjectStore {
  put(key: string, value: Uint8Array | string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export function assertSafeObjectStoreKey(key: string): void {
  if (!key || key.includes("\0") || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
    throw new Error(`Unsafe object store key: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Identity and abuse protection (wired in a later phase)
// ---------------------------------------------------------------------------

export type OperatorIdentity = { actorId: string };

export interface OperatorIdentityProvider {
  authenticate(token: string): Promise<OperatorIdentity | null>;
  operatorActorId(): string;
}

export type SubmissionIdentity = { sessionHash: string; ipHash: string };

export interface AbuseProtection {
  hashSubmissionIdentity(input: { session: string; ip: string; accountId?: string | null }): Promise<SubmissionIdentity>;
}

// ---------------------------------------------------------------------------
// Runtime assembly
// ---------------------------------------------------------------------------

export interface GameIntelRuntime {
  adapterApiVersion: number;
  persistence: GameIntelPersistence;
  jobQueue: JobQueue;
  pacing: SourcePacingStore;
  sourceHealth: SourceHealthStore;
  fetchTransport: ControlledFetchTransport;
  scheduler: SourceScheduler | null;
  objectStore: ObjectStore | null;
  clock: Clock;
  ids: IdGenerator;
  close(): Promise<void>;
}
