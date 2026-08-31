import { z } from "zod";

export const PublicHttpUrlSchema = z.string().min(1).superRefine((value, context) => {
  if (value.trim() !== value || /[\u0000-\u001F\u007F]/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an HTTP(S) URL without credentials" });
    return;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || !url.hostname
      || url.username
      || url.password
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an HTTP(S) URL without credentials" });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected an HTTP(S) URL without credentials" });
  }
});
export type PublicHttpUrl = z.infer<typeof PublicHttpUrlSchema>;

export function isPublicHttpUrl(value: unknown): value is PublicHttpUrl {
  return PublicHttpUrlSchema.safeParse(value).success;
}

export const SourceStrengthSchema = z.enum([
  "PRIMARY",
  "DIRECT_EVIDENCE",
  "TRUSTED_SECONDARY",
  "COMMUNITY",
  "UNVERIFIED",
]);
export type SourceStrength = z.infer<typeof SourceStrengthSchema>;

export const PublicationModeSchema = z.enum(["normal", "discussion_only", "blocked"]);
export type PublicationMode = z.infer<typeof PublicationModeSchema>;

export const EvidenceReviewPolicySchema = z.object({
  minimumApprovals: z.number().int().min(1).max(5).default(1),
  preventSubmitterApproval: z.boolean().default(true),
}).default({ minimumApprovals: 1, preventSubmitterApproval: true });
export type EvidenceReviewPolicy = z.infer<typeof EvidenceReviewPolicySchema>;

export const SourcePolicySchema = z.object({
  accessMode: z.enum(["official_api", "rss", "permitted_scrape", "provider_api", "manual"]),
  requestsPerMinute: z.number().nonnegative(),
  retainRawTextDays: z.number().nonnegative(),
  mayStoreFullText: z.boolean(),
  attributionRequired: z.boolean(),
  termsReviewedAt: z.string().nullable(),
  evidenceReview: EvidenceReviewPolicySchema,
});
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;

export const InputKindSchema = z.enum(["url", "rss", "pasted_text", "local_file", "manual_fixture"]);
export type InputKind = z.infer<typeof InputKindSchema>;

// Processing versions record which implementation produced a source revision
// and which model computes claim confidence. Bump them when the corresponding
// behavior changes so stored revisions and review surfaces can answer "why
// does GameIntel currently believe this?" and "would reprocessing with the
// current pipeline produce a different result?".
export const NORMALIZATION_VERSION = "1";
export const CONFIDENCE_MODEL_VERSION = "1";
export const CLAIM_EXTRACTOR_VERSION = "1";

export const EvidenceLevelSchema = z.enum(["suspected", "corroborated", "confirmed", "disputed"]);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;

export const ClaimStateSchema = z.enum([
  "unverified",
  "supported",
  "contested",
  "confirmed",
  "superseded",
  "retracted",
]);
export type ClaimState = z.infer<typeof ClaimStateSchema>;

export type ClaimStateInput = {
  supportingFamilies: number;
  contradictingFamilies: number;
  strongestStrength: SourceStrength;
  // Confirmation requires a current evidence review that passes its source policy.
  strongestApprovedStrength: SourceStrength;
  hasCurrentEvidence: boolean;
  hasHistoricalEvidence?: boolean;
  retracted?: boolean;
};

// Claim states describe what GameIntel currently believes, not permanent
// truth. Evidence tied to superseded source revisions moves the claim to
// superseded; contradictions make it contested; an explicit retraction wins.
// Primary and direct evidence become confirmed only after current approval.
export function deriveClaimState(input: ClaimStateInput): ClaimState {
  if (input.retracted) return "retracted";
  if (!input.hasCurrentEvidence) return input.hasHistoricalEvidence ? "superseded" : "unverified";
  if (input.contradictingFamilies > 0) return "contested";
  if (input.supportingFamilies === 0) return "unverified";
  if (input.strongestApprovedStrength === "PRIMARY" || input.strongestApprovedStrength === "DIRECT_EVIDENCE") return "confirmed";
  return "supported";
}

export const AttributionTypeSchema = z.enum([
  "official",
  "direct_evidence",
  "trusted_secondary",
  "community",
  "unverified",
  "reviewed_leak_reporting",
]);
export type AttributionType = z.infer<typeof AttributionTypeSchema>;

// Qualifier vocabulary (TASK-002). Keys stay open snake_case identifiers —
// profiles supply their own ontology — but values are normalized so
// semantically identical claims converge on one canonical identity regardless
// of how reporters typed them.
export const QualifierKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "Expected a snake_case semantic qualifier key");
export const QualifiersSchema = z.record(QualifierKeySchema, z.string().max(256));
export type Qualifiers = z.infer<typeof QualifiersSchema>;

export const SEMANTIC_QUALIFIER_KEYS = [
  "platform", "mode", "build", "region", "time_of_day", "weather", "mission", "progression", "wanted_level", "inventory",
] as const;
export type SemanticQualifierKey = (typeof SEMANTIC_QUALIFIER_KEYS)[number];

const QUALIFIER_VALUE_NORMALIZERS: Record<SemanticQualifierKey, (value: string) => string> = {
  platform: (v) => v.trim().replaceAll(/\s+/g, " "),
  mode: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
  build: (v) => v.trim().replaceAll(/\s+/g, " "),
  region: (v) => v.trim().toUpperCase().replaceAll(/\s+/g, "_"),
  time_of_day: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
  weather: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
  mission: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
  progression: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
  wanted_level: (v) => {
    const trimmed = v.trim();
    return /^\d+$/.test(trimmed) ? String(Number(trimmed)) : trimmed;
  },
  inventory: (v) => v.trim().toLowerCase().replaceAll(/\s+/g, "_"),
};

export function normalizeQualifiers(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim().replaceAll(/\s+/g, " ");
    const normalize = (QUALIFIER_VALUE_NORMALIZERS as Record<string, (v: string) => string>)[key];
    out[key] = normalize ? normalize(value) : value;
  }
  return out;
}

// Structured applicability model (TASK-002): the build/version view of a
// claim plus the profile's registered builds. Build versions compare
// segment-wise ("1.10.0" > "1.4.0") so a claim can be flagged superseded
// once an active build moves past it.
export const ClaimApplicabilitySchema = z.object({
  platform: z.string().nullable().default(null),
  build: z.string().nullable().default(null),
  mode: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  progressionContext: z.string().nullable().default(null),
}).strict();
export type ClaimApplicability = z.infer<typeof ClaimApplicabilitySchema>;

export function applicabilityFromQualifiers(qualifiers: Record<string, string>): ClaimApplicability {
  const q = normalizeQualifiers(qualifiers);
  return {
    platform: q.platform ?? null,
    build: q.build ?? null,
    mode: q.mode ?? null,
    region: q.region ?? null,
    progressionContext: q.progression ?? q.mission ?? null,
  };
}

export const GameBuildSchema = z.object({
  id: z.string().min(1),
  platform: z.string().nullable().default(null),
  mode: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  // Numeric dot-separated constraint: deliberate, keeps compareBuildVersions'
  // segment-wise parse safe and predictable. NOT the permanent generic version
  // model — profiles may later adopt prerelease SemVer or non-numeric
  // identifiers by replacing the comparator, not by relaxing this regex.
  version: z.string().min(1).regex(/^\d+(?:\.\d+)*$/, "Expected a numeric dot-separated build version"),
  releasedAt: z.string().datetime().nullable().default(null),
  active: z.boolean().default(true),
});
export type GameBuild = z.infer<typeof GameBuildSchema>;

export function compareBuildVersions(left: string, right: string): number {
  const segments = (value: string) => value.split(".").map((part) => {
    const number = Number.parseInt(part, 10);
    return Number.isNaN(number) ? 0 : number;
  });
  const a = segments(left);
  const b = segments(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function claimBuildStatus(claimBuild: string | null, currentBuild: string | null): "current" | "superseded" | "unknown" {
  if (!claimBuild) return "unknown";
  if (!currentBuild) return "current";
  return compareBuildVersions(claimBuild, currentBuild) < 0 ? "superseded" : "current";
}

export const CollectionProfileSchema = z.object({
  id: z.string().min(1),
  canonicalName: z.string().min(1),
  aliases: z.array(z.string()),
  version: z.string(),
  capabilities: z.record(z.boolean()).default({}),
  categories: z.array(z.string()).default([]),
  spoilerSafeCategories: z.array(z.string()).default([]),
  defaultExploitMode: z.string().optional(),
  platforms: z.array(z.string()).default([]),
  sourceQueries: z.array(z.string()).default([]),
  builds: z.array(GameBuildSchema).default([]),
});
export type CollectionProfile = z.infer<typeof CollectionProfileSchema>;

// GameIntel's first profile is game-shaped, but the core contract is reusable
// for any collection that turns source material into structured records.
export const GameProfileSchema = CollectionProfileSchema;
export type GameProfile = CollectionProfile;

export const SourceSchema = z.object({
  id: z.string(),
  type: z.string(),
  canonicalUrl: PublicHttpUrlSchema,
  publicCitationUrl: PublicHttpUrlSchema.nullable(),
  sourceStrength: SourceStrengthSchema,
  publicationMode: PublicationModeSchema,
  policy: SourcePolicySchema,
  enabled: z.boolean(),
});
export type Source = z.infer<typeof SourceSchema>;

export const EvidenceSchema = z.object({
  sourceItemId: z.string(),
  provenanceFamilyId: z.string().optional(),
  stance: z.enum(["supports", "contradicts", "context"]),
  evidenceType: z.enum([
    "official_document",
    "independent_reproduction",
    "video_result",
    "screenshot_log",
    "trusted_reporting",
    "community_report",
    "copied_report",
  ]),
  excerpt: z.string().max(1000),
  startMs: z.number().nonnegative().nullable(),
  endMs: z.number().nonnegative().nullable(),
  lineageId: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const SourceTrustClassificationSchema = z.object({
  attributionType: AttributionTypeSchema,
  evidenceType: EvidenceSchema.shape.evidenceType,
  initialPublicationMode: PublicationModeSchema,
});
export type SourceTrustClassification = z.infer<typeof SourceTrustClassificationSchema>;

export const EvidenceReviewDecisionSchema = z.enum(["approved", "rejected", "disputed"]);
export type EvidenceReviewDecision = z.infer<typeof EvidenceReviewDecisionSchema>;

export type EvidenceReviewVote = {
  reviewerId: string;
  decision: EvidenceReviewDecision;
  createdAt: number;
};

export type EvidenceReviewGate = {
  eligible: boolean;
  approvedCount: number;
  blockedBy: "rejected" | "disputed" | null;
};

// Conservative publication gate: the latest decision per reviewer wins. Any
// currently rejected or disputed evidence is blocked from influencing
// publication regardless of how many other reviewers approved it. A later
// decision by the objecting reviewer can resolve the objection.
export function evidenceReviewGate(
  votes: EvidenceReviewVote[],
  policy: Pick<EvidenceReviewPolicy, "minimumApprovals">,
): EvidenceReviewGate {
  const latest = new Map<string, { decision: EvidenceReviewDecision; createdAt: number }>();
  for (const vote of votes) {
    const current = latest.get(vote.reviewerId);
    if (current === undefined || vote.createdAt >= current.createdAt) latest.set(vote.reviewerId, { decision: vote.decision, createdAt: vote.createdAt });
  }
  const decisions = [...latest.values()].map((review) => review.decision);
  const approvedCount = decisions.filter((decision) => decision === "approved").length;
  if (decisions.includes("rejected")) return { eligible: false, approvedCount, blockedBy: "rejected" };
  if (decisions.includes("disputed")) return { eligible: false, approvedCount, blockedBy: "disputed" };
  return { eligible: approvedCount >= policy.minimumApprovals, approvedCount, blockedBy: null };
}

export const SourcePolicyReviewDecisionSchema = z.enum(["approved", "rejected", "revoked"]);
export type SourcePolicyReviewDecision = z.infer<typeof SourcePolicyReviewDecisionSchema>;

export const ProvenanceRelationshipSchema = z.enum([
  "original",
  "copied_from",
  "quoted_from",
  "derived_from",
  "independent_reproduction",
  "contradiction",
  "same_media",
  "same_source_family",
]);
export type ProvenanceRelationship = z.infer<typeof ProvenanceRelationshipSchema>;

export const ProvenanceClusteringMethodSchema = z.enum(["automatic_exact", "manual", "declared", "lineage"]);
export type ProvenanceClusteringMethod = z.infer<typeof ProvenanceClusteringMethodSchema>;

const sourceTrustClassifications: Record<SourceStrength, SourceTrustClassification> = {
  PRIMARY: {
    attributionType: "official",
    evidenceType: "official_document",
    initialPublicationMode: "normal",
  },
  DIRECT_EVIDENCE: {
    attributionType: "direct_evidence",
    evidenceType: "independent_reproduction",
    initialPublicationMode: "normal",
  },
  TRUSTED_SECONDARY: {
    attributionType: "trusted_secondary",
    evidenceType: "trusted_reporting",
    initialPublicationMode: "normal",
  },
  COMMUNITY: {
    attributionType: "community",
    evidenceType: "community_report",
    initialPublicationMode: "discussion_only",
  },
  UNVERIFIED: {
    attributionType: "unverified",
    evidenceType: "community_report",
    initialPublicationMode: "discussion_only",
  },
};

// Trust metadata is derived from the source policy, never from a submitted claim.
export function trustClassificationFor(sourceStrength: SourceStrength): SourceTrustClassification {
  return sourceTrustClassifications[sourceStrength];
}

export function effectivePublicationMode(sourceStrength: SourceStrength, configuredMode: PublicationMode): PublicationMode {
  const classification = trustClassificationFor(sourceStrength);
  return classification.initialPublicationMode === "discussion_only" ? "discussion_only" : configuredMode;
}

export const ClaimSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  qualifiers: QualifiersSchema,
  spoilerTags: z.array(z.string()),
  exploitClass: z.string().nullable(),
  evidenceLevel: EvidenceLevelSchema.default("suspected"),
  attributionType: AttributionTypeSchema.default("unverified"),
  statement: z.string().nullable().default(null),
  editorialAssessment: z.string().nullable().default(null),
  evidence: z.array(EvidenceSchema).min(1),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const NormalizedSourceItemSchema = z.object({
  sourceId: z.string(),
  collectionId: z.string(),
  externalId: z.string(),
  url: z.string().refine((value) => value.startsWith("urn:") || isPublicHttpUrl(value), "Expected an HTTP(S) URL or URN"),
  title: z.string().min(1),
  text: z.string().default(""),
  sourceStrength: SourceStrengthSchema,
  publicationMode: PublicationModeSchema,
  discoveredAt: z.string().datetime().or(z.string()),
  publishedAt: z.string().datetime().or(z.string()).nullable(),
  lineageId: z.string().nullable(),
  inputKind: InputKindSchema.default("manual_fixture"),
  contentType: z.string().nullable().default(null),
  language: z.string().nullable().default(null),
  // Version of the parser/normalization/claim-extraction implementation that
  // produced this item. Stored per source revision so evidence can be traced
  // to the exact processing code that created it.
  processingVersion: z.string().min(1).default(NORMALIZATION_VERSION),
  claims: z.array(z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    qualifiers: QualifiersSchema.default({}),
    spoilerTags: z.array(z.string()).default([]),
     exploitClass: z.string().nullable().default(null),
     evidenceLevel: EvidenceLevelSchema.default("suspected"),
      attributionType: AttributionTypeSchema.default("unverified"),
      statement: z.string().nullable().default(null),
      editorialAssessment: z.string().nullable().default(null),
      stance: EvidenceSchema.shape.stance.default("supports"),
      evidenceType: EvidenceSchema.shape.evidenceType,
    excerpt: z.string().max(1000),
    startMs: z.number().nonnegative().nullable().default(null),
    endMs: z.number().nonnegative().nullable().default(null),
  })).default([]).transform((claims) => claims.map((claim) => ({ ...claim, qualifiers: normalizeQualifiers(claim.qualifiers) }))),
});
export type NormalizedSourceItem = z.infer<typeof NormalizedSourceItemSchema>;

// This is intentionally separate from NormalizedSourceItemSchema. Public
// reporters describe what they observed; only trusted server workflows attach
// source strength, claim confidence, attribution, or publication metadata.
export const PublicSubmissionSchema = z.object({
  collectionId: z.string().regex(/^[a-z0-9-]{1,64}$/, "Expected a collection id"),
  title: z.string().trim().min(1).max(280).optional(),
  report: z.string().trim().min(1).max(10_000),
  urls: z.array(PublicHttpUrlSchema).max(3).default([]),
  mediaRefs: z.array(z.object({
    uploadId: z.string().regex(/^upload_[a-zA-Z0-9_-]{16,128}$/, "Expected a staged upload reference"),
  }).strict()).max(3).default([]),
}).strict();
export type PublicSubmission = z.infer<typeof PublicSubmissionSchema>;

export const PublicSubmissionStateSchema = z.enum([
  "quarantined",
  "under_review",
  "rejected",
  "promoted",
  "blocked",
  "expired",
]);
export type PublicSubmissionState = z.infer<typeof PublicSubmissionStateSchema>;

// Promotion is intentionally absent. It has its own operator-only workflow
// that can enforce a reviewed submission and a non-publishable source policy.
export const PublicSubmissionReviewDecisionSchema = z.enum(["under_review", "rejected", "blocked"]);
export type PublicSubmissionReviewDecision = z.infer<typeof PublicSubmissionReviewDecisionSchema>;

// Discovery model (TASK-003): the structured record of a discovered fact, its
// capture conditions, and its reproducibility. Schema and deterministic
// derivation only — persistence wiring is a later milestone.
export const DiscoveryStatusSchema = z.enum([
  "unverified", "reported", "corroborated", "verified", "needs_retest", "disputed", "patched", "rejected",
]);
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;

export const EvidenceSummarySchema = z.object({
  supportingLineages: z.number().int().nonnegative(),
  contradictingLineages: z.number().int().nonnegative(),
  strongestEvidenceType: EvidenceSchema.shape.evidenceType.nullable(),
}).strict();
export type EvidenceSummary = z.infer<typeof EvidenceSummarySchema>;

export const ConditionsSchema = z.object({
  timeOfDay: z.string().nullable().default(null),
  weather: z.string().nullable().default(null),
  mission: z.string().nullable().default(null),
  wantedLevel: z.number().int().nonnegative().nullable().default(null),
  inventory: z.array(z.string()).default([]),
  mode: z.string().nullable().default(null),
}).strict();
export type Conditions = z.infer<typeof ConditionsSchema>;

export const ReproductionSchema = z.object({
  id: z.string().min(1),
  discoveryId: z.string().min(1),
  actorId: z.string().min(1),
  outcome: z.enum(["reproduced", "failed_to_reproduce"]),
  platform: z.string().nullable().default(null),
  gameBuild: z.string().nullable().default(null),
  stepsHash: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 steps hash"),
  notes: z.string().nullable().default(null),
  proofAttachmentId: z.string().nullable().default(null),
}).strict();
export type Reproduction = z.infer<typeof ReproductionSchema>;

export const GameBuildRefSchema = z.object({
  buildId: z.string().min(1),
  version: z.string().min(1).regex(/^\d+(?:\.\d+)*$/, "Expected a numeric dot-separated build version"),
  platform: z.string().nullable().default(null),
  mode: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
});
export type GameBuildRef = z.infer<typeof GameBuildRefSchema>;

export const DiscoverySchema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  gameProfileVersion: z.string().min(1),
  canonicalTitle: z.string().min(1),
  titleSafe: z.string().min(1),
  categoryId: z.string().min(1),
  summary: z.string(),
  status: DiscoveryStatusSchema,
  confidence: z.number().min(0).max(1),
  newsworthiness: z.number().min(0).max(100),
  platforms: z.array(z.string()).default([]),
  // Build references validated for this discovery. Single-context invariant,
  // enforced here: all entries MUST share one applicability context
  // (platform/mode/region). applyActiveBuildChange compares the list as one
  // context, so a producer merging contexts could let a newer build on
  // another platform mask a stale observation here. Producers must never
  // merge contexts.
  gameBuilds: z.array(GameBuildRefSchema).default([]).superRefine((refs, context) => {
    if (refs.length < 2) return;
    // A ref that leaves a field null does not pin it; only conflicting
    // non-null declarations across refs violate the single-context invariant
    // (e.g. a pc build and a ps5 build in one list).
    const fields: Array<"platform" | "mode" | "region"> = ["platform", "mode", "region"];
    const conflict = fields.some((field) => {
      const pinned = refs.filter((ref) => ref[field] !== null);
      return pinned.some((ref) => ref[field] !== pinned[0][field]);
    });
    if (conflict) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "All gameBuilds must share one applicability context (platform/mode/region)" });
    }
  }),
  progressionContext: z.string().nullable().default(null),
  conditions: ConditionsSchema,
  spoilerTags: z.array(z.string()).default([]),
  firstSeenAt: z.string().datetime(),
  verifiedAt: z.string().datetime().nullable().default(null),
  lastValidatedAt: z.string().datetime().nullable().default(null),
  claimIds: z.array(z.string()).default([]),
  evidenceSummary: EvidenceSummarySchema,
  reproductions: z.array(ReproductionSchema).default([]),
}).strict();
export type Discovery = z.infer<typeof DiscoverySchema>;

const evidenceWeights: Record<Evidence["evidenceType"], number> = {
  official_document: 0.35,
  independent_reproduction: 0.25,
  video_result: 0.2,
  trusted_reporting: 0.18,
  screenshot_log: 0.08,
  community_report: 0.04,
  copied_report: 0.01,
};

export function evidenceSummaryFor(claims: Claim[]): EvidenceSummary {
  const supporting = new Set<string>();
  const contradicting = new Set<string>();
  let strongest: Evidence["evidenceType"] | null = null;
  for (const claim of claims) {
    for (const evidence of claim.evidence) {
      const family = evidence.provenanceFamilyId ?? evidence.lineageId;
      if (evidence.stance === "contradicts") {
        contradicting.add(family);
        continue;
      }
      supporting.add(family);
      if (!strongest || evidenceWeights[evidence.evidenceType] > evidenceWeights[strongest]) strongest = evidence.evidenceType;
    }
  }
  return {
    supportingLineages: supporting.size,
    contradictingLineages: contradicting.size,
    strongestEvidenceType: strongest,
  };
}

export function assembleDiscovery(input: {
  id: string;
  collectionId: string;
  gameProfileVersion: string;
  canonicalTitle: string;
  titleSafe?: string;
  categoryId: string;
  summary: string;
  status: DiscoveryStatus;
  confidence: number;
  newsworthiness: number;
  platforms?: string[];
  gameBuilds?: GameBuildRef[];
  progressionContext?: string | null;
  conditions: Conditions;
  spoilerTags?: string[];
  firstSeenAt: string;
  verifiedAt?: string | null;
  lastValidatedAt?: string | null;
  claims: Claim[];
  reproductions?: Reproduction[];
}): Discovery {
  return DiscoverySchema.parse({
    id: input.id,
    collectionId: input.collectionId,
    gameProfileVersion: input.gameProfileVersion,
    canonicalTitle: input.canonicalTitle,
    titleSafe: input.titleSafe ?? input.canonicalTitle,
    categoryId: input.categoryId,
    summary: input.summary,
    status: input.status,
    confidence: input.confidence,
    newsworthiness: input.newsworthiness,
    platforms: input.platforms ?? [],
    gameBuilds: input.gameBuilds ?? [],
    progressionContext: input.progressionContext ?? null,
    conditions: input.conditions,
    spoilerTags: input.spoilerTags ?? [],
    firstSeenAt: input.firstSeenAt,
    verifiedAt: input.verifiedAt ?? null,
    lastValidatedAt: input.lastValidatedAt ?? null,
    claimIds: input.claims.map((claim) => claim.id),
    evidenceSummary: evidenceSummaryFor(input.claims),
    reproductions: input.reproductions ?? [],
  });
}

export function applyActiveBuildChange(discovery: Discovery, currentBuild: string | null): Discovery {
  if (!currentBuild || discovery.gameBuilds.length === 0) return discovery;
  // Demote only when the newest recorded build is superseded: a discovery
  // that already covers the current build is still valid.
  // Precondition: all gameBuilds share one applicability context — enforced
  // by the DiscoverySchema single-context refine (GameBuildRefSchema).
  const newestBuild = discovery.gameBuilds.reduce((newest, build) => (compareBuildVersions(build.version, newest.version) > 0 ? build : newest));
  const superseded = compareBuildVersions(newestBuild.version, currentBuild) < 0;
  if (superseded && discovery.status === "verified") return { ...discovery, status: "needs_retest" };
  return discovery;
}

export const ArticleFactSchema = z.object({
  text: z.string(),
  evidenceLevel: EvidenceLevelSchema,
  attributionType: AttributionTypeSchema,
  claimIds: z.array(z.string()).default([]),
  editorialAssessment: z.string().nullable().default(null),
});

const ArticleFactInputSchema = z.preprocess((value) => typeof value === "string" ? {
  text: value,
  evidenceLevel: "suspected",
   attributionType: "unverified",
  claimIds: [],
  editorialAssessment: null,
} : value, ArticleFactSchema);

export const ArticleSectionSchema = z.object({
  heading: z.string(),
  paragraphs: z.array(ArticleFactInputSchema),
  publicSafe: z.boolean().default(true),
  spoilerTags: z.array(z.string()).default([]),
});
export const ArticleBodySchema = z.object({
  summary: z.string(),
  sections: z.array(ArticleSectionSchema),
  unknowns: z.array(z.string()),
});
export type ArticleBody = z.infer<typeof ArticleBodySchema>;

export const ArticleStatusSchema = z.enum([
  "draft",
  "source_review",
  "editor_review",
  "approved",
  "published",
  "updated",
  "retracted",
]);
export type ArticleStatus = z.infer<typeof ArticleStatusSchema>;

export const MediaReviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type MediaReviewStatus = z.infer<typeof MediaReviewStatusSchema>;

export const MediaCatalogEntrySchema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  collection: z.string().min(1),
  caption: z.string().min(1),
  altText: z.string().min(1),
  tags: z.array(z.string().min(1)),
  spoilerTags: z.array(z.string().min(1)),
  attribution: z.string().min(1),
  sourceUrl: PublicHttpUrlSchema,
  sourcePageUrl: PublicHttpUrlSchema,
  originalKey: z.string().min(1),
  displayKey: z.string().min(1),
  publicUrl: PublicHttpUrlSchema,
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/i, "Expected an image content type"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 checksum"),
});
export type CatalogMedia = z.infer<typeof MediaCatalogEntrySchema>;

export const MediaCatalogSchema = z.object({ media: z.array(MediaCatalogEntrySchema) }).passthrough();

export function assertUniqueMedia(media: CatalogMedia[]): void {
  for (const key of ["id", "checksum", "displayKey"] as const) {
    const values = new Set<string>();
    for (const item of media) {
      if (values.has(item[key])) throw new Error(`Invalid media catalog: duplicate ${key} '${item[key]}'`);
      values.add(item[key]);
    }
  }
}

function normalizedText(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

// Deterministic cover-candidate scoring used by both reference adapters.
export function mediaCoverScore(candidate: Pick<CatalogMedia, "caption" | "collection" | "tags">, articleText: string): number {
  const phrases = [candidate.caption, candidate.collection];
  let score = 0;
  for (const tag of candidate.tags) {
    const phrase = normalizedText(tag);
    if (containsPhrase(articleText, phrase)) score += 10_000 + phrase.split(" ").length;
  }
  for (const phraseValue of phrases) {
    const phrase = normalizedText(phraseValue);
    if (phrase.split(" ").length > 1 && containsPhrase(articleText, phrase)) score += 100 + phrase.split(" ").length;
  }
  return score;
}

export const ArticleCoverMediaSchema = z.object({
  id: z.string(),
  caption: z.string(),
  altText: z.string(),
  collection: z.string(),
  tags: z.array(z.string()),
  spoilerTags: z.array(z.string()),
  attribution: z.string(),
  sourceUrl: PublicHttpUrlSchema,
  publicUrl: PublicHttpUrlSchema,
  selectionSource: z.enum(["automatic", "editor"]),
  reviewStatus: MediaReviewStatusSchema,
});
export type ArticleCoverMedia = z.infer<typeof ArticleCoverMediaSchema>;

export const ArticleSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  slug: z.string(),
  title: z.string(),
  seoTitle: z.string(),
  description: z.string(),
  body: ArticleBodySchema,
  status: ArticleStatusSchema,
  newsworthiness: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  sourceReviewCompleted: z.boolean(),
  editorReviewCompleted: z.boolean(),
  articleSourcesComplete: z.boolean(),
  coverMedia: ArticleCoverMediaSchema.nullable().default(null),
  sourceRefs: z.array(z.object({
    sourceId: z.string(),
    claimId: z.string().nullable(),
    citationLabel: z.string(),
    publicCitationUrl: PublicHttpUrlSchema,
  })),
  approvedBy: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type Article = z.infer<typeof ArticleSchema>;

export type EventDisposition = "ignore" | "update_existing" | "research_new_article";

export type ScoreInput = {
  sourceAuthority: number;
  novelty: number;
  readerUsefulness: number;
  collectionRelevance: number;
  newInformation: number;
  confirmationStrength: number;
  communityInterest: number;
  searchInterest: number;
};

export function scoreNewsworthiness(input: ScoreInput): number {
  const score = input.sourceAuthority * 0.18
    + input.novelty * 0.18
    + input.readerUsefulness * 0.16
    + input.collectionRelevance * 0.14
    + input.newInformation * 0.14
    + input.confirmationStrength * 0.10
    + input.communityInterest * 0.05
    + input.searchInterest * 0.05;
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

export function dispositionFor(score: number, existingArticleId: string | null): EventDisposition {
  if (score < 0.3) return "ignore";
  if (score <= 0.6 || existingArticleId) return "update_existing";
  return "research_new_article";
}

const strengthPrior: Record<SourceStrength, number> = {
  PRIMARY: 0.3,
  DIRECT_EVIDENCE: 0.24,
  TRUSTED_SECONDARY: 0.16,
  COMMUNITY: 0.08,
  UNVERIFIED: 0,
};
const evidenceWeight: Record<Evidence["evidenceType"], number> = {
  official_document: 0.35,
  independent_reproduction: 0.25,
  video_result: 0.2,
  screenshot_log: 0.08,
  trusted_reporting: 0.18,
  community_report: 0.04,
  copied_report: 0.01,
};

export function calculateConfidence(
  strength: SourceStrength,
  evidence: Array<Evidence & { sourceStrength?: SourceStrength }>,
  conditionQuality = 0.5,
): number {
  const families = new Map<string, { support: number; contradiction: number }>();
  for (const item of evidence) {
    const familyId = item.provenanceFamilyId ?? item.lineageId;
    const family = families.get(familyId) ?? { support: 0, contradiction: 0 };
    if (item.stance === "contradicts") {
      family.contradiction = Math.max(
        family.contradiction,
        item.evidenceType === "independent_reproduction" ? 0.15 : 0.25,
      );
    } else {
      family.support = Math.max(family.support, evidenceWeight[item.evidenceType]);
    }
    families.set(familyId, family);
  }
  let independent = 0;
  let contradiction = 0;
  for (const family of families.values()) {
    independent += family.support;
    contradiction -= family.contradiction;
  }
  const logit = -1.4 + strengthPrior[strength] + independent + contradiction + 0.35 * conditionQuality;
  const confidence = 1 / (1 + Math.exp(-logit));
  return Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
}

export function hashText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

// Canonical claim identity (plan section 1). Two source items describing the
// same real-world fact converge on one canonical claim when their normalized
// subject/predicate/value and semantic qualifiers agree. Normalization is
// intentionally conservative (case, whitespace, trailing punctuation) to
// avoid over-merging; transport details such as URL/RSS/community belong to
// the source item and provenance, never to the semantic identity.
export function canonicalizeClaimText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ").replaceAll(/[.!?]+$/g, "").trim();
}

export function canonicalClaimKey(input: { subject: string; predicate: string; value: string; qualifiers?: Record<string, string> }): string {
  const qualifiers = normalizeQualifiers(input.qualifiers ?? {});
  const qualifierEntries = Object.entries(qualifiers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${canonicalizeClaimText(value)}`);
  return hashText([
    canonicalizeClaimText(input.subject),
    canonicalizeClaimText(input.predicate),
    canonicalizeClaimText(input.value),
    ...qualifierEntries,
  ].join("|"));
}

export function publicSubmissionFingerprint(submission: PublicSubmission): string {
  return hashText(JSON.stringify({
    collectionId: submission.collectionId,
    title: submission.title ?? null,
    report: submission.report,
    urls: [...submission.urls].sort(),
    mediaRefs: submission.mediaRefs.map((media) => media.uploadId).sort(),
  }));
}

export function canonicalizeUrl(value: string): string {
  if (value.startsWith("urn:")) return value;
  const url = new URL(PublicHttpUrlSchema.parse(value));
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || ["ref", "source", "fbclid"].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.hash = "";
  return url.toString();
}

export function lineageFor(item: Pick<NormalizedSourceItem, "lineageId" | "url" | "text">): string {
  return item.lineageId ?? hashText(`${canonicalizeUrl(item.url)}:${hashText(item.text)}`);
}

export function canPublish(article: Pick<Article, "sourceReviewCompleted" | "editorReviewCompleted" | "articleSourcesComplete" | "approvedBy">): boolean {
  return article.sourceReviewCompleted && article.editorReviewCompleted && article.articleSourcesComplete && article.approvedBy !== null;
}

export type SafeArticle = {
  id: string;
  collectionId: string;
  slug: string;
  title: string;
  seoTitle: string;
  description: string;
  body: {
    summary: string;
    unknowns: string[];
    sections: Array<{
      heading: string;
      publicSafe: true;
      spoilerTags: [];
      paragraphs: Array<{
        text: string;
        evidenceLevel: EvidenceLevel;
        attributionType: AttributionType;
        editorialAssessment: string | null;
        citations: number[];
      }>;
    }>;
  };
  status: ArticleStatus;
  publishedAt: string | null;
  updatedAt: string | null;
  citations: Array<{ number: number; label: string; url: string }>;
  coverMedia: Pick<ArticleCoverMedia, "id" | "caption" | "altText" | "collection" | "attribution" | "sourceUrl" | "publicUrl"> | null;
};

function safeText(value: string): string {
  return value
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll(/https?:\/\/[^\s)]+/gi, "[link withheld]")
    .trim();
}

export function toSafeArticle(article: Article): SafeArticle | null {
  const parsedArticle = ArticleSchema.safeParse(article);
  if (!parsedArticle.success) return null;
  article = parsedArticle.data;
  if (!canPublish(article) || article.status === "retracted") return null;
  const citationNumbers = new Map<string, number>();
  const citations: Array<{ number: number; label: string; url: string }> = [];
  for (const source of article.sourceRefs) {
    const label = safeText(source.citationLabel);
    const citationKey = `${label}:${source.publicCitationUrl}`;
    const number = citations.find((citation) => `${citation.label}:${citation.url}` === citationKey)?.number ?? citations.length + 1;
    if (!citations.some((citation) => citation.number === number)) citations.push({ number, label, url: source.publicCitationUrl });
    citationNumbers.set(source.claimId ?? source.sourceId, number);
  }
  const body = ArticleBodySchema.parse({
    summary: safeText(article.body.summary),
    unknowns: article.body.unknowns.map(safeText),
    sections: article.body.sections.filter((section) => section.publicSafe && section.spoilerTags.length === 0).map((section) => ({
      ...section,
      heading: safeText(section.heading),
      paragraphs: section.paragraphs.map((fact) => ({
        ...fact,
        text: safeText(fact.text),
        editorialAssessment: fact.editorialAssessment ? safeText(fact.editorialAssessment) : null,
        claimIds: fact.claimIds,
      })),
    })),
  });
  const safeBody: SafeArticle["body"] = {
    ...body,
    sections: body.sections.map((section) => ({
      heading: section.heading,
      publicSafe: true,
      spoilerTags: [],
      paragraphs: section.paragraphs.map((fact) => {
          const { claimIds, ...safeFact } = fact;
          return {
            ...safeFact,
            citations: [...new Set((claimIds.length ? claimIds : article.sourceRefs.length === 1 ? [article.sourceRefs[0].claimId ?? article.sourceRefs[0].sourceId] : [])
              .map((claimId) => citationNumbers.get(claimId)).filter((number): number is number => number !== undefined))],
          };
        }),
    })),
  };
  return {
    id: article.id,
     collectionId: article.collectionId,
    slug: article.slug,
    title: safeText(article.title),
    seoTitle: safeText(article.seoTitle),
    description: safeText(article.description),
    body: safeBody,
    status: article.status,
    publishedAt: article.publishedAt,
    updatedAt: article.updatedAt,
    citations,
    coverMedia: article.coverMedia?.reviewStatus === "approved" ? {
      id: article.coverMedia.id,
      caption: safeText(article.coverMedia.caption),
      altText: safeText(article.coverMedia.altText),
      collection: safeText(article.coverMedia.collection),
      attribution: safeText(article.coverMedia.attribution),
      sourceUrl: article.coverMedia.sourceUrl,
      publicUrl: article.coverMedia.publicUrl,
    } : null,
  };
}
