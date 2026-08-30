import type {
  Article,
  ArticleBody,
  ArticleStatus,
  AttributionType,
  CatalogMedia,
  ClaimState,
  EvidenceLevel,
  GameProfile,
  MediaReviewStatus,
  NormalizedSourceItem,
  ProvenanceClusteringMethod,
  ProvenanceRelationship,
  PublicSubmission,
  PublicSubmissionState,
  SourceStrength,
  PublicationMode,
} from "@gameintel/core";
import type { SourceDiscoverJobPayload, SourceIngestJobPayload, SourceInput } from "@gameintel/contracts";

// In-memory adapter state. Records mirror the reference PostgreSQL schema.
// The store is snapshot-cloned by `transaction` so rollback is a discard.

export type SourceItemRecord = {
  id: string;
  sourceId: string;
  gameId: string;
  externalId: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  textExcerpt: string;
  rawHash: string;
  lineageId: string;
  sourceStrength: SourceStrength;
  publicationMode: PublicationMode;
  discoveredAt: string;
  publishedAt: string | null;
  inputKind: string;
  contentType: string | null;
  language: string | null;
  retentionUntil: number;
  provenanceStatus: string;
  contentPurgedAt: number | null;
  submittedBy: string | null;
  createdAt: string;
};

export type RevisionRecord = {
  id: string;
  sourceItemId: string;
  rawHash: string;
  excerpt: string;
  contentType: string | null;
  httpStatus: number | null;
  isCurrent: boolean;
  processingVersion: string | null;
  title: string;
  content: string;
  contentPurgedAt: number | null;
  createdAt: string;
};

export type CanonicalClaimRecord = {
  id: string;
  gameId: string;
  subject: string;
  predicate: string;
  value: string;
  qualifiers: Record<string, string>;
  canonicalKey: string;
  createdAt: string;
};

export type AnalysisRunRecord = {
  id: string;
  sourceItemRevisionId: string;
  processingVersion: string | null;
  claimExtractorVersion: string | null;
  confidenceModelVersion: string | null;
  status: "completed" | "superseded";
  triggeredBy: string | null;
  triggerReason: string;
  createdAt: string;
  completedAt: string | null;
};

export type ProvenanceFamilyRecord = {
  id: string;
  collectionId: string;
  familyKey: string;
  rootSourceItemId: string;
};

export type SourceItemProvenanceRecord = {
  sourceItemId: string;
  provenanceFamilyId: string;
  relationship: ProvenanceRelationship;
  derivedFromSourceItemId: string | null;
  clusteringMethod: ProvenanceClusteringMethod;
  reviewerId: string | null;
  notes: string;
  updatedAt: string;
};

export type ProvenanceRelationshipRecord = {
  id: string;
  sourceItemId: string;
  relatedSourceItemId: string;
  relationship: ProvenanceRelationship;
  clusteringMethod: ProvenanceClusteringMethod;
  reviewerId: string;
  notes: string;
  createdAt: string;
};

export type EventRecord = {
  id: string;
  gameId: string;
  sourceItemId: string;
  newsworthiness: number;
  disposition: string;
  existingArticleId: string | null;
  createdAt: string;
};

export type ClaimRecord = {
  id: string;
  gameId: string;
  sourceItemId: string;
  subject: string;
  predicate: string;
  value: string;
  qualifiers: Record<string, string>;
  spoilerTags: string[];
  exploitClass: string | null;
  evidenceLevel: EvidenceLevel;
  attributionType: AttributionType;
  statement: string | null;
  editorialAssessment: string | null;
  state: ClaimState;
  canonicalClaimId: string | null;
  createdAt: string;
};

export type EvidenceRecord = {
  id: string;
  claimId: string;
  sourceItemId: string;
  sourceItemRevisionId: string;
  analysisRunId: string;
  provenanceFamilyId: string;
  stance: "supports" | "contradicts" | "context";
  evidenceType: NormalizedSourceItem["claims"][number]["evidenceType"];
  excerpt: string;
  startMs: number | null;
  endMs: number | null;
  lineageId: string;
  createdAt: string;
};

export type EvidenceReviewRecord = {
  id: string;
  evidenceId: string;
  sourceItemRevisionId: string;
  reviewerId: string;
  decision: "approved" | "rejected" | "disputed";
  notes: string;
  seq: number;
  createdAt: string;
};

export type SourcePolicyReviewRecord = {
  id: string;
  sourceId: string;
  reviewerId: string;
  decision: "approved" | "rejected" | "revoked";
  notes: string;
  createdAt: string;
};

export type ArticleRecord = {
  id: string;
  gameId: string;
  slug: string;
  title: string;
  seoTitle: string;
  description: string;
  body: ArticleBody;
  status: ArticleStatus;
  newsworthiness: number;
  confidence: number;
  sourceReviewCompleted: boolean;
  editorReviewCompleted: boolean;
  articleSourcesComplete: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ArticleRevisionRecord = {
  id: string;
  articleId: string;
  revisionNumber: number;
  body: ArticleBody;
  changeSummary: string;
  createdAt: string;
};

export type ArticleSourceRecord = {
  id: string;
  articleId: string;
  sourceId: string;
  claimId: string | null;
  citationLabel: string;
  publicCitationUrl: string;
  updatedAt: string;
};

export type ReviewRecord = {
  id: string;
  targetType: string;
  targetId: string;
  reviewerId: string;
  decision: string;
  notes: string;
  createdAt: string;
};

export type MediaAssetRecord = {
  id: string;
  gameId: string;
  collection: string;
  caption: string;
  altText: string;
  tags: string[];
  spoilerTags: string[];
  attribution: string;
  sourceUrl: string;
  sourcePageUrl: string;
  originalKey: string;
  displayKey: string;
  publicUrl: string;
  contentType: string;
  width: number;
  height: number;
  checksum: string;
  reviewStatus: MediaReviewStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  updatedAt: string;
};

export type ArticleMediaRecord = {
  articleId: string;
  mediaId: string;
  role: string;
  selectionSource: "automatic" | "editor";
  reviewStatus: MediaReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type PublicSubmissionRecord = {
  id: string;
  collectionId: string;
  submitterAccountId: string | null;
  submitterSessionHash: string;
  submitterIpHash: string;
  title: string | null;
  report: string;
  urls: PublicSubmission["urls"];
  mediaRefs: PublicSubmission["mediaRefs"];
  contentHash: string;
  retentionUntil: number;
  state: PublicSubmissionState;
  promotedSourceItemId: string | null;
  contentPurgedAt: number | null;
  createdAt: string;
  updatedAt: string;
};

export type SubmissionActionRecord = {
  id: string;
  submissionId: string;
  actorId: string;
  action: string;
  notes: string;
  createdAt: string;
};

export type AuditRecord = {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  createdAt: string;
};

export type JobRecord = {
  jobKey: string;
  jobType: string;
  status: "queued" | "running" | "completed" | "dead";
  payload: SourceIngestJobPayload | SourceDiscoverJobPayload;
  dedupeKey: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  leasedBy: string | null;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
  lastError: string | null;
  result: unknown;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type WorkerHeartbeatRecord = {
  workerId: string;
  workerType: "source_ingest";
  currentJobKey: string | null;
  lastError: string | null;
  lastSeenAt: number;
  updatedAt: number;
};

export type MemoryStore = {
  games: Map<string, GameProfile>;
  sources: Map<string, SourceInput>;
  sourceItems: Map<string, SourceItemRecord>;
  revisions: Map<string, RevisionRecord>;
  canonicalClaims: Map<string, CanonicalClaimRecord>;
  analysisRuns: Map<string, AnalysisRunRecord>;
  provenanceFamilies: Map<string, ProvenanceFamilyRecord>;
  sourceItemProvenance: Map<string, SourceItemProvenanceRecord>;
  provenanceRelationships: Map<string, ProvenanceRelationshipRecord>;
  events: Map<string, EventRecord>;
  claims: Map<string, ClaimRecord>;
  evidence: Map<string, EvidenceRecord>;
  evidenceReviews: EvidenceReviewRecord[];
  sourcePolicyReviews: SourcePolicyReviewRecord[];
  articles: Map<string, ArticleRecord>;
  articleRevisions: Map<string, ArticleRevisionRecord>;
  articleSources: Map<string, ArticleSourceRecord>;
  reviews: ReviewRecord[];
  mediaAssets: Map<string, MediaAssetRecord>;
  articleMedia: Map<string, ArticleMediaRecord>;
  publicSubmissions: Map<string, PublicSubmissionRecord>;
  submissionActions: SubmissionActionRecord[];
  auditLog: AuditRecord[];
  jobs: Map<string, JobRecord>;
  pacing: Map<string, number>;
  workerHeartbeats: Map<string, WorkerHeartbeatRecord>;
};

export function createMemoryStore(): MemoryStore {
  return {
    games: new Map(),
    sources: new Map(),
    sourceItems: new Map(),
    revisions: new Map(),
    canonicalClaims: new Map(),
    analysisRuns: new Map(),
    provenanceFamilies: new Map(),
    sourceItemProvenance: new Map(),
    provenanceRelationships: new Map(),
    events: new Map(),
    claims: new Map(),
    evidence: new Map(),
    evidenceReviews: [],
    sourcePolicyReviews: [],
    articles: new Map(),
    articleRevisions: new Map(),
    articleSources: new Map(),
    reviews: [],
    mediaAssets: new Map(),
    articleMedia: new Map(),
    publicSubmissions: new Map(),
    submissionActions: [],
    auditLog: [],
    jobs: new Map(),
    pacing: new Map(),
    workerHeartbeats: new Map(),
  };
}

export function memoryCatalogEntry(entry: CatalogMedia): MediaAssetRecord {
  return {
    id: entry.id,
    gameId: entry.collectionId,
    collection: entry.collection,
    caption: entry.caption,
    altText: entry.altText,
    tags: [...entry.tags],
    spoilerTags: [...entry.spoilerTags],
    attribution: entry.attribution,
    sourceUrl: entry.sourceUrl,
    sourcePageUrl: entry.sourcePageUrl,
    originalKey: entry.originalKey,
    displayKey: entry.displayKey,
    publicUrl: entry.publicUrl,
    contentType: entry.contentType,
    width: entry.width,
    height: entry.height,
    checksum: entry.checksum,
    reviewStatus: "pending",
    approvedBy: null,
    approvedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function articleRecordToArticle(record: ArticleRecord): Article {
  return {
    id: record.id,
    collectionId: record.gameId,
    slug: record.slug,
    title: record.title,
    seoTitle: record.seoTitle,
    description: record.description,
    body: record.body,
    status: record.status,
    newsworthiness: record.newsworthiness,
    confidence: record.confidence,
    sourceReviewCompleted: record.sourceReviewCompleted,
    editorReviewCompleted: record.editorReviewCompleted,
    articleSourcesComplete: record.articleSourcesComplete,
    coverMedia: null,
    sourceRefs: [],
    approvedBy: record.approvedBy,
    publishedAt: record.publishedAt,
    updatedAt: record.updatedAt,
  };
}