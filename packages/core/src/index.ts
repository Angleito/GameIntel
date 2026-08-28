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

export const SourcePolicySchema = z.object({
  accessMode: z.enum(["official_api", "rss", "permitted_scrape", "provider_api", "manual"]),
  requestsPerMinute: z.number().nonnegative(),
  retainRawTextDays: z.number().nonnegative(),
  mayStoreFullText: z.boolean(),
  attributionRequired: z.boolean(),
  termsReviewedAt: z.string().nullable(),
});
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;

export const InputKindSchema = z.enum(["url", "rss", "pasted_text", "local_file", "manual_fixture"]);
export type InputKind = z.infer<typeof InputKindSchema>;

export const EvidenceLevelSchema = z.enum(["suspected", "corroborated", "confirmed", "disputed"]);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;

export const AttributionTypeSchema = z.enum(["official", "trusted_secondary", "community", "reviewed_leak_reporting"]);
export type AttributionType = z.infer<typeof AttributionTypeSchema>;

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

export const ClaimSchema = z.object({
  id: z.string(),
  collectionId: z.string(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  qualifiers: z.record(z.string()),
  spoilerTags: z.array(z.string()),
  exploitClass: z.string().nullable(),
  evidenceLevel: EvidenceLevelSchema.default("suspected"),
  attributionType: AttributionTypeSchema.default("trusted_secondary"),
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
  claims: z.array(z.object({
    subject: z.string(),
    predicate: z.string(),
    value: z.string(),
    qualifiers: z.record(z.string()).default({}),
    spoilerTags: z.array(z.string()).default([]),
     exploitClass: z.string().nullable().default(null),
     evidenceLevel: EvidenceLevelSchema.default("suspected"),
     attributionType: AttributionTypeSchema.default("trusted_secondary"),
     statement: z.string().nullable().default(null),
     editorialAssessment: z.string().nullable().default(null),
     evidenceType: EvidenceSchema.shape.evidenceType,
    excerpt: z.string().max(1000),
    startMs: z.number().nonnegative().nullable().default(null),
    endMs: z.number().nonnegative().nullable().default(null),
  })).default([]),
});
export type NormalizedSourceItem = z.infer<typeof NormalizedSourceItemSchema>;

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
  attributionType: "trusted_secondary",
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
  const lineages = new Set<string>();
  let independent = 0;
  let contradiction = 0;
  for (const item of evidence) {
    if (item.stance === "contradicts") {
      contradiction -= item.evidenceType === "independent_reproduction" ? 0.15 : 0.25;
      continue;
    }
    if (!lineages.has(item.lineageId)) {
      lineages.add(item.lineageId);
      independent += evidenceWeight[item.evidenceType];
    }
  }
  const logit = -1.4 + strengthPrior[strength] + independent + contradiction + 0.35 * conditionQuality;
  const confidence = 1 / (1 + Math.exp(-logit));
  return Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
}

export function hashText(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
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
  body: ArticleBody;
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
  const safeBody = {
    ...body,
    sections: body.sections.map((section) => ({
      ...section,
      paragraphs: section.paragraphs.map((fact) => ({
        ...fact,
        citations: [...new Set((fact.claimIds.length ? fact.claimIds : article.sourceRefs.length === 1 ? [article.sourceRefs[0].claimId ?? article.sourceRefs[0].sourceId] : [])
          .map((claimId) => citationNumbers.get(claimId)).filter((number): number is number => number !== undefined))],
      })),
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
