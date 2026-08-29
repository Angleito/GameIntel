import {
  ADAPTER_API_VERSION,
  cryptoIdGenerator,
  schedulerForSources,
  systemClock,
  UnconfiguredFetchTransport,
  type GameIntelPersistence,
  type GameIntelRuntime,
  type JobQueue,
  type ObjectStore,
  type SchedulableSource,
  type SourcePacingStore,
} from "@gameintel/contracts";
import {
  acquireSourceFetchSlot,
  approveArticle,
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  assertIngestionJobLeaseHeld,
  audit,
  calculateClaimConfidence,
  claimIngestionJob,
  clearCoverMedia,
  closeDb,
  completeIngestionJob,
  createArticleDraft,
  createDb,
  createEvent,
  createQuarantinedSubmission,
  enqueueSourceIngestJob,
  ensureGame,
  ensureSource,
  failIngestionJob,
  getArticle,
  getIngestionJob,
  getIngestionQueueStatus,
  getPublicSubmissionForModeration,
  getPublicSubmissionForPromotion,
  heartbeatIngestionWorker,
  importMediaCatalog,
  insertClaim,
  insertSourceItem,
  invalidateEvidenceApprovalsForSourceItem,
  inTransaction,
  linkSourceItemProvenance,
  listArticleEvidence,
  listArticles,
  listCoverCandidates,
  listIngestionWorkerHeartbeats,
  listPublicSubmissionModerationActions,
  listPublicSubmissionsForModeration,
  listRecentIngestionJobs,
  markPublished,
  markPublicSubmissionPromoted,
  publicArticles,
  purgeExpiredPublicSubmissions,
  purgeExpiredSourceContent,
  recommendArticleCover,
  recordSubmissionModerationAction,
  refreshClaimState,
  refreshClaimStatesForSourceItem,
  rejectCoverMedia,
  renewIngestionJobLease,
  reviewArticle,
  reviewEvidence,
  reviewPublicSubmission,
  reviewSource,
  reviewSourcePolicy,
  setCoverMedia,
  type Db,
} from "./index.ts";

// PostgreSQL reference persistence adapter. PostgreSQL-specific concerns
// (advisory locks, SKIP LOCKED, partial indexes, savepoints) stay inside this
// adapter and never define GameIntel Core.

export class PostgresPersistence implements GameIntelPersistence {
  constructor(private readonly handle: Db) {}

  ensureGame = (profile: Parameters<typeof ensureGame>[1]) => ensureGame(this.handle, profile);
  ensureSource = (source: Parameters<typeof ensureSource>[1]) => ensureSource(this.handle, source);
  insertSourceItem = (
    item: Parameters<typeof insertSourceItem>[1],
    rawHash: string,
    lineageId: string,
    policy: Parameters<typeof insertSourceItem>[4],
    submittedBy?: string | null,
  ) => insertSourceItem(this.handle, item, rawHash, lineageId, policy, submittedBy);

  createEvent = (input: Parameters<typeof createEvent>[1]) => createEvent(this.handle, input);
  linkSourceItemProvenance = (input: Parameters<typeof linkSourceItemProvenance>[1]) => linkSourceItemProvenance(this.handle, input);
  getSourceItemProvenance = async (sourceItemId: string) => {
    const rows = await this.handle`
      SELECT provenance_family_id, relationship, clustering_method
      FROM source_item_provenance
      WHERE source_item_id = ${sourceItemId}
      LIMIT 1
    `;
    if (!rows.length) return null;
    const row = rows[0] as { provenance_family_id: string; relationship: import("@gameintel/core").ProvenanceRelationship; clustering_method: import("@gameintel/core").ProvenanceClusteringMethod };
    return {
      provenanceFamilyId: row.provenance_family_id,
      relationship: row.relationship,
      clusteringMethod: row.clustering_method,
    };
  };

  insertClaim = (
    item: Parameters<typeof insertClaim>[1],
    sourceItemId: string,
    sourceItemRevisionId: string,
    provenanceFamilyId: string,
    claim: Parameters<typeof insertClaim>[5],
    lineageId: string,
  ) => insertClaim(this.handle, item, sourceItemId, sourceItemRevisionId, provenanceFamilyId, claim, lineageId);
  refreshClaimState = (claimId: string) => refreshClaimState(this.handle, claimId);
  refreshClaimStatesForSourceItem = (sourceItemId: string) => refreshClaimStatesForSourceItem(this.handle, sourceItemId);
  calculateClaimConfidence = (claimId: string) => calculateClaimConfidence(this.handle, claimId);

  invalidateEvidenceApprovalsForSourceItem = (sourceItemId: string) => invalidateEvidenceApprovalsForSourceItem(this.handle, sourceItemId);
  listArticleEvidence = (articleId: string) => listArticleEvidence(this.handle, articleId);

  reviewSourcePolicy = (
    sourceId: string,
    reviewerId: string,
    decision?: Parameters<typeof reviewSourcePolicy>[3],
    notes?: string,
  ) => reviewSourcePolicy(this.handle, sourceId, reviewerId, decision, notes);
  reviewSource = (sourceId: string, reviewerId: string, notes?: string) => reviewSource(this.handle, sourceId, reviewerId, notes);
  reviewEvidence = (
    evidenceId: string,
    reviewerId: string,
    decision?: Parameters<typeof reviewEvidence>[3],
    notes?: string,
  ) => reviewEvidence(this.handle, evidenceId, reviewerId, decision, notes);
  reviewArticle = (articleId: string, reviewerId: string, notes?: string) => reviewArticle(this.handle, articleId, reviewerId, notes);
  approveArticle = (articleId: string, approver: string) => approveArticle(this.handle, articleId, approver);

  createArticleDraft = (input: Parameters<typeof createArticleDraft>[1]) => createArticleDraft(this.handle, input);
  getArticle = (idOrSlug: string, publishedOnly?: boolean) => getArticle(this.handle, idOrSlug, publishedOnly);
  listArticles = (collectionId: string, publishedOnly?: boolean) => listArticles(this.handle, collectionId, publishedOnly);
  markPublished = (articleId: string, operator: string) => markPublished(this.handle, articleId, operator);
  publicArticles = (collectionId: string) => publicArticles(this.handle, collectionId);
  purgeExpiredSourceContent = (options?: { execute?: boolean }) => purgeExpiredSourceContent(this.handle, options);

  createQuarantinedSubmission = (input: Parameters<typeof createQuarantinedSubmission>[1]) => createQuarantinedSubmission(this.handle, input);
  listPublicSubmissionsForModeration = (
    collectionId: string,
    options?: Parameters<typeof listPublicSubmissionsForModeration>[2],
  ) => listPublicSubmissionsForModeration(this.handle, collectionId, options);
  getPublicSubmissionForModeration = (submissionId: string) => getPublicSubmissionForModeration(this.handle, submissionId);
  listPublicSubmissionModerationActions = (submissionId: string) => listPublicSubmissionModerationActions(this.handle, submissionId);
  reviewPublicSubmission = (input: Parameters<typeof reviewPublicSubmission>[1]) => reviewPublicSubmission(this.handle, input);
  getPublicSubmissionForPromotion = (submissionId: string) => getPublicSubmissionForPromotion(this.handle, submissionId);
  markPublicSubmissionPromoted = (input: Parameters<typeof markPublicSubmissionPromoted>[1]) => markPublicSubmissionPromoted(this.handle, input);
  recordSubmissionModerationAction = (submissionId: string, actorId: string, action: string, notes?: string) =>
    recordSubmissionModerationAction(this.handle, submissionId, actorId, action, notes);
  purgeExpiredPublicSubmissions = (options?: { execute?: boolean }) => purgeExpiredPublicSubmissions(this.handle, options);

  audit = (actor: string, action: string, targetType: string, targetId: string, reason: string) =>
    audit(this.handle, actor, action, targetType, targetId, reason);

  importMediaCatalog = (catalogPath: string) => importMediaCatalog(this.handle, catalogPath);
  listCoverCandidates = (articleId: string) => listCoverCandidates(this.handle, articleId);
  setCoverMedia = (articleId: string, mediaId: string, selectionSource?: "automatic" | "editor") =>
    setCoverMedia(this.handle, articleId, mediaId, selectionSource);
  recommendArticleCover = (input: Parameters<typeof recommendArticleCover>[1]) => recommendArticleCover(this.handle, input);
  approveMediaAsset = (mediaId: string, reviewer: string) => approveMediaAsset(this.handle, mediaId, reviewer);
  approveMediaCollection = (collectionId: string, reviewer: string) => approveMediaCollection(this.handle, collectionId, reviewer);
  approveCoverMedia = (articleId: string, reviewer: string) => approveCoverMedia(this.handle, articleId, reviewer);
  rejectCoverMedia = (articleId: string, reviewer: string) => rejectCoverMedia(this.handle, articleId, reviewer);
  clearCoverMedia = (articleId: string) => clearCoverMedia(this.handle, articleId);

  transaction = async <T>(callback: (transaction: GameIntelPersistence) => Promise<T>): Promise<T> => {
    return inTransaction(this.handle, async (transaction) => {
      return callback(new PostgresPersistence(transaction));
    });
  };

  assertIngestionJobLeaseHeld = (jobKey: string, leaseToken: string) => assertIngestionJobLeaseHeld(this.handle, jobKey, leaseToken);
}

export class PostgresJobQueue implements JobQueue {
  constructor(private readonly handle: Db) {}

  enqueueSourceIngestJob = (input: Parameters<typeof enqueueSourceIngestJob>[1]) => enqueueSourceIngestJob(this.handle, input);
  claimIngestionJob = (workerId: string, jobTypes?: string[], leaseMs?: number) => claimIngestionJob(this.handle, workerId, jobTypes, leaseMs);
  completeIngestionJob = (jobKey: string, leaseToken: string, result: unknown) => completeIngestionJob(this.handle, jobKey, leaseToken, result);
  failIngestionJob = (jobKey: string, leaseToken: string, error: unknown, retryable?: boolean) =>
    failIngestionJob(this.handle, jobKey, leaseToken, error, retryable);
  renewIngestionJobLease = (jobKey: string, leaseToken: string, durationMs: number) => renewIngestionJobLease(this.handle, jobKey, leaseToken, durationMs);
  getIngestionJob = (jobKey: string) => getIngestionJob(this.handle, jobKey);
  listRecentIngestionJobs = (limit?: number) => listRecentIngestionJobs(this.handle, limit);
  getIngestionQueueStatus = (staleAfterMs?: number) => getIngestionQueueStatus(this.handle, staleAfterMs);
  heartbeatIngestionWorker = (input: Parameters<typeof heartbeatIngestionWorker>[1]) => heartbeatIngestionWorker(this.handle, input);
  listIngestionWorkerHeartbeats = () => listIngestionWorkerHeartbeats(this.handle);
}

export class PostgresPacingStore implements SourcePacingStore {
  constructor(private readonly handle: Db) {}

  acquireFetchSlot = (sourceId: string, requestsPerMinute: number) => acquireSourceFetchSlot(this.handle, sourceId, requestsPerMinute);
}

export type PostgresRuntime = GameIntelRuntime;

export function createPostgresRuntime(options: {
  url?: string;
  fetchTransport?: GameIntelRuntime["fetchTransport"];
  objectStore?: ObjectStore | null;
  schedulerSources?: SchedulableSource[];
} = {}): PostgresRuntime {
  const handle = createDb(options.url);
  const clock = systemClock;
  const scheduler = schedulerForSources(options.schedulerSources, clock);
  return {
    adapterApiVersion: ADAPTER_API_VERSION,
    persistence: new PostgresPersistence(handle),
    jobQueue: new PostgresJobQueue(handle),
    pacing: new PostgresPacingStore(handle),
    fetchTransport: options.fetchTransport ?? new UnconfiguredFetchTransport(),
    scheduler,
    objectStore: options.objectStore ?? null,
    clock,
    ids: cryptoIdGenerator,
    close: () => closeDb(handle),
  };
}

export type { Db };