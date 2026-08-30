import {
  CONFIDENCE_MODEL_VERSION,
  NORMALIZATION_VERSION,
  effectivePublicationMode,
  PublicationModeSchema,
  SourcePolicySchema,
  SourceStrengthSchema,
  trustClassificationFor,
  type AttributionType,
  type EvidenceLevel,
  type InputKind,
  type NormalizedSourceItem,
  type SourcePolicy,
} from "@gameintel/core";
import type {
  AnalysisVersions,
  GameIntelPersistence,
  SourceInput,
} from "@gameintel/contracts";
import { CLAIM_EXTRACTOR_VERSION, extractClaims, prepareIngestion } from "@gameintel/pipeline";
import { OpenCodeRuntime, type ArticleDraft } from "@gameintel/ai-runtime";
import type { Fixture } from "@gameintel/source-sdk";

const authority: Record<NormalizedSourceItem["sourceStrength"], number> = {
  PRIMARY: 1,
  DIRECT_EVIDENCE: 0.85,
  TRUSTED_SECONDARY: 0.7,
  COMMUNITY: 0.45,
  UNVERIFIED: 0.2,
};

function boundedDescription(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const candidate = value.slice(0, maxLength - 3).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  return `${(boundary > 0 ? candidate.slice(0, boundary) : candidate)}...`;
}

function claimAssertion(claim: NormalizedSourceItem["claims"][number]): string {
  return `${claim.subject} ${claim.predicate.replaceAll("_", " ")} ${claim.value}.`;
}

function claimStatement(claim: NormalizedSourceItem["claims"][number]): string {
  if (claim.statement) return claim.statement;
  const assertion = claimAssertion(claim);
  if (claim.evidenceLevel === "suspected" && claim.attributionType === "community") return `Many reports claim that ${assertion}`;
  if (claim.attributionType === "community") return `According to GameIntel.gg's community reporting, ${assertion}`;
  if (claim.attributionType === "reviewed_leak_reporting") return `According to hacked game leaks editorial team as reviewed, ${assertion}`;
  if (claim.evidenceLevel === "confirmed") return `It is confirmed that ${assertion}`;
  return assertion;
}

function defaultAssessment(level: EvidenceLevel): string | null {
  if (level === "suspected") return "GameIntel.gg has not found sufficient evidence to support this claim.";
  if (level === "disputed") return "GameIntel.gg found conflicting evidence and has not resolved this claim.";
  return null;
}

function citationLabel(type: AttributionType, sourceType: string): string {
  if (type === "community") return "GameIntel.gg community reporting";
  if (type === "reviewed_leak_reporting") return "GameIntel.gg reviewed leak reporting";
  if (type === "official" || sourceType === "official") return "Official source";
  return "Source report";
}

// Analysis re-derives claims from the same retained content the adapters
// store per revision, so a rerun of an immutable revision reproduces the
// original extraction exactly. This must mirror the adapter retention rule.
function retainedText(text: string, policy: SourcePolicy): string {
  if (policy.retainRawTextDays === 0) return "";
  return text.slice(0, policy.mayStoreFullText ? 4_000 : 1_000);
}

type DraftContent = {
  title: string;
  description: string;
  body: import("@gameintel/core").ArticleBody;
  sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
};

function buildDraftContent(
  item: NormalizedSourceItem,
  source: SourceInput,
  claimIds: string[],
  aiDraft: ArticleDraft | null,
): DraftContent {
  const safeClaims = item.claims.map((claim, index) => ({ claim, claimId: claimIds[index] })).filter(({ claim }) => claim.spoilerTags.length === 0);
  const sourceRefs = claimIds.length
    ? claimIds.map((claimId, index) => ({
      sourceId: source.id,
      claimId,
      citationLabel: citationLabel(item.claims[index].attributionType, source.type),
      publicCitationUrl: source.publicCitationUrl!,
    }))
    : [{ sourceId: source.id, claimId: null, citationLabel: citationLabel("trusted_secondary", source.type), publicCitationUrl: source.publicCitationUrl! }];
  return {
    title: aiDraft?.title ?? item.title,
    description: aiDraft?.description ?? boundedDescription(item.text, 155),
    body: {
      summary: aiDraft?.summary ?? item.text.slice(0, 280),
      sections: [
        {
          heading: "Evidence",
          paragraphs: safeClaims.length ? safeClaims.map(({ claim, claimId }) => ({
            text: claimStatement(claim),
            evidenceLevel: claim.evidenceLevel,
            attributionType: claim.attributionType,
            claimIds: claimId ? [claimId] : [],
            editorialAssessment: claim.editorialAssessment ?? defaultAssessment(claim.evidenceLevel),
          })) : [{
            text: item.text,
            evidenceLevel: "suspected" as const,
            attributionType: "trusted_secondary" as const,
            claimIds: [],
            editorialAssessment: defaultAssessment("suspected"),
          }],
          publicSafe: safeClaims.length > 0,
          spoilerTags: [],
        },
        {
          heading: "What remains unknown",
          paragraphs: (aiDraft?.unknowns ?? ["Further independent evidence and conditions are still being reviewed."]).map((text) => ({
            text,
            evidenceLevel: "suspected" as const,
            attributionType: "trusted_secondary" as const,
            claimIds: [],
            editorialAssessment: null,
          })),
          publicSafe: true,
          spoilerTags: [],
        },
      ],
      unknowns: ["The full set of platform and build conditions has not been independently reproduced."],
    },
    sourceRefs,
  };
}

function buildBodyFromClaims(claims: Array<{
  id: string;
  subject: string;
  predicate: string;
  value: string;
  evidenceLevel: EvidenceLevel;
  attributionType: AttributionType;
  statement: string | null;
  editorialAssessment: string | null;
  spoilerTags: string[];
}>): import("@gameintel/core").ArticleBody {
  const safeClaims = claims.filter((claim) => claim.spoilerTags.length === 0);
  return {
    summary: safeClaims.map((claim) => claim.statement ?? `${claim.subject} ${claim.predicate.replaceAll("_", " ")} ${claim.value}.`).join(" ").slice(0, 280),
    sections: [{
      heading: "Evidence",
      paragraphs: safeClaims.map((claim) => ({
        text: claim.statement ?? `${claim.subject} ${claim.predicate.replaceAll("_", " ")} ${claim.value}.`,
        evidenceLevel: claim.evidenceLevel,
        attributionType: claim.attributionType,
        claimIds: [claim.id],
        editorialAssessment: claim.editorialAssessment ?? defaultAssessment(claim.evidenceLevel),
      })),
      publicSafe: safeClaims.length > 0,
      spoilerTags: [],
    }],
    unknowns: ["The full set of platform and build conditions has not been independently reproduced."],
  };
}

export type LeaseFence = { jobKey: string; leaseToken: string };

// Canonical claim resolution: the newest non-retracted article referencing
// any member claim of the given canonical claims.
async function resolveArticleForClaims(transaction: GameIntelPersistence, canonicalClaimIds: string[]): Promise<string | null> {
  return transaction.resolveExistingArticleForCanonicalClaims(canonicalClaimIds);
}

export async function processNormalizedItem(persistence: GameIntelPersistence, item: NormalizedSourceItem, source: SourceInput, options: { submittedBy?: string | null; leaseFence?: LeaseFence | null } = {}): Promise<{ sourceItemId: string; eventId: string; articleId: string | null; disposition: string; duplicate: boolean; warnings: string[] }> {
  if (!source.enabled) throw new Error(`Source ${source.id} is disabled by source policy`);
  if (item.sourceId !== source.id) throw new Error("Source item does not match its source policy");
  const sourceStrength = SourceStrengthSchema.parse(source.sourceStrength);
  if (item.sourceStrength !== sourceStrength) throw new Error("Source item trust metadata must match its source policy");
  const policy = SourcePolicySchema.parse(source.policy);
  const publicationMode = effectivePublicationMode(sourceStrength, PublicationModeSchema.parse(source.publicationMode));
  const trust = trustClassificationFor(sourceStrength);
  source = { ...source, sourceStrength, publicationMode, policy };
  item = {
    ...item,
    // Every stored revision records which pipeline implementation produced
    // it. Paths that compose a parser version (URL ingestion) stamp a richer
    // "<parser>.<normalization>" value; everything else defaults to the
    // current normalization version.
    processingVersion: item.processingVersion ?? NORMALIZATION_VERSION,
    sourceStrength,
    publicationMode,
    claims: item.claims.map((claim) => ({
      ...claim,
      attributionType: trust.attributionType,
      evidenceType: trust.evidenceType,
    })),
  };

  return persistence.transaction(async (transaction) => {
  if (options.leaseFence) await transaction.assertIngestionJobLeaseHeld(options.leaseFence.jobKey, options.leaseFence.leaseToken);
  await transaction.ensureSource(source);
  const prepared = prepareIngestion(item, {
    sourceAuthority: authority[item.sourceStrength],
    novelty: 0.9,
    readerUsefulness: item.claims.length ? 0.9 : item.text.length > 80 ? 0.8 : 0.3,
    collectionRelevance: item.collectionId ? 1 : 0,
    newInformation: item.claims.length ? 0.85 : item.text.length > 80 ? 0.65 : 0.2,
    confirmationStrength: item.sourceStrength === "UNVERIFIED" ? 0.1 : 0.5,
    communityInterest: 0.4,
    searchInterest: 0.3,
  });
   item = prepared.item;
   const { lineageId } = prepared;
    const inserted = await transaction.insertSourceItem(item, prepared.rawHash, lineageId, policy, options.submittedBy ?? null);
    const currentRevisionId = inserted.revisionId;

    // An analysis run interprets the immutable revision with the current
    // normalization/extractor/confidence versions. Unchanged content
    // that was already interpreted by these exact versions is a duplicate;
    // unchanged content with a version mismatch is reprocessed in place.
    const versions: AnalysisVersions = {
      normalizationVersion: NORMALIZATION_VERSION,
      claimExtractorVersion: CLAIM_EXTRACTOR_VERSION,
      confidenceModelVersion: CONFIDENCE_MODEL_VERSION,
    };
    const existingRun = await transaction.getAnalysisRun(currentRevisionId, versions);
    if (inserted.duplicate && existingRun) {
      return { sourceItemId: inserted.id, eventId: "duplicate", articleId: null, disposition: "duplicate", duplicate: true, warnings: ["Source content was already ingested and analyzed"] };
    }

    const claimIds: string[] = [];
    const canonicalClaimIds: string[] = [];
    if (!existingRun) {
      const run = await transaction.createAnalysisRun({
        sourceItemRevisionId: currentRevisionId,
        versions,
        triggeredBy: options.submittedBy ?? null,
        triggerReason: inserted.materialChange ? "material-change" : "initial-analysis",
      });
      // Extraction runs over the retained content so a later rerun of this
      // revision reproduces the exact same claims.
      const analysisItem = { ...item, text: retainedText(item.text, policy) };
      const extracted = extractClaims(analysisItem, item.sourceStrength);
      for (const claim of extracted) {
        const insertedClaim = await transaction.insertClaim(analysisItem, inserted.id, currentRevisionId, run.id, inserted.provenanceFamilyId, claim, lineageId);
        claimIds.push(insertedClaim.claimId);
        canonicalClaimIds.push(insertedClaim.canonicalClaimId);
      }
      item = { ...item, claims: extracted };
    }
    await transaction.refreshClaimStatesForSourceItem(inserted.id);

    // Historical claims invalidate affected articles, but they cannot select
    // one for continuity. A source URL can be repurposed from X to unrelated
    // Y; only claims produced by this revision can update an X/Y article.
    // The historical union still matters for X -> no claims and X -> Y
    // invalidation.
    const sourceCanonicalClaimIds = await transaction.canonicalClaimIdsForSourceItem(inserted.id);
    const affectedCanonicalClaimIds = [...new Set([...canonicalClaimIds, ...sourceCanonicalClaimIds])];
    const existingArticleId = await resolveArticleForClaims(transaction, canonicalClaimIds);
    const score = prepared.newsworthiness;
    const disposition = existingArticleId ? "update_existing" : prepared.disposition;
    const mayRefreshPublication = source.publicationMode === "normal";

    // Before a normal-source revision can update/create a publication, demote
    // every article whose current evidence references an old or new member.
    // Discussion-only intake remains knowledge-only under the operator role.
    const refreshedForMaterialChange = inserted.materialChange && mayRefreshPublication;
    if (refreshedForMaterialChange) {
      await transaction.refreshArticlesForCanonicalClaims(affectedCanonicalClaimIds, "analysis_run.completed", "Source materially changed; articles referencing old or new canonical claims were refreshed");
    }

    // Unchanged content whose analysis run is stale: the revision was just
    // reprocessed with the current pipeline, but no event is recorded for a
    // re-interpretation of the same content. Articles referencing the
    // affected canonical claims are refreshed so the newly interpreted
    // evidence (which needs fresh review) and any changed claim set
    // propagate to publication state.
    if (inserted.duplicate) {
      if (mayRefreshPublication) {
        await transaction.refreshArticlesForCanonicalClaims(affectedCanonicalClaimIds, "analysis_run.completed", "Source unchanged; analysis rerun with current pipeline versions");
      }
      return { sourceItemId: inserted.id, eventId: "duplicate", articleId: null, disposition: "duplicate", duplicate: true, warnings: ["Source content unchanged; analysis rerun with current pipeline versions"] };
    }

    const eventId = await transaction.createEvent({ collectionId: item.collectionId, sourceItemId: inserted.id, newsworthiness: score, disposition, existingArticleId });

    if (disposition === "update_existing" && existingArticleId && source.publicationMode === "normal" && source.publicCitationUrl && claimIds.length > 0) {
      const content = buildDraftContent(item, source, claimIds, null);
      const existingClaims = await transaction.listClaimsForArticle(existingArticleId);
      const bodyClaims = [
        ...existingClaims.filter((claim) => claim.sourceItemId !== inserted.id),
        ...item.claims.map((claim, index) => ({ ...claim, id: claimIds[index] })),
      ];
      await transaction.updateExistingArticle({
        articleId: existingArticleId,
        sourceItemId: inserted.id,
        sourceRefs: content.sourceRefs,
        body: buildBodyFromClaims(bodyClaims),
        changeSummary: "Re-analyzed source revision",
      });
      return { sourceItemId: inserted.id, eventId, articleId: existingArticleId, disposition, duplicate: false, warnings: [] };
    }

    if (disposition !== "research_new_article" || !source.publicCitationUrl || source.publicationMode !== "normal" || claimIds.length === 0) {
      if (mayRefreshPublication && !refreshedForMaterialChange) {
        await transaction.refreshArticlesForCanonicalClaims(affectedCanonicalClaimIds, "analysis_run.completed", "Source evidence changed; articles referencing its canonical claims were refreshed");
      }
      const warning = claimIds.length === 0
        ? "No claims were extracted from the source item"
        : "Source policy or public citation does not permit article output";
      return { sourceItemId: inserted.id, eventId, articleId: null, disposition, duplicate: false, warnings: [warning] };
    }

    const claimConfidences: number[] = [];
    for (const claimId of claimIds) claimConfidences.push(await transaction.calculateClaimConfidence(claimId));
    const confidence = claimConfidences.length
      ? Math.round((claimConfidences.reduce((sum, value) => sum + value, 0) / claimConfidences.length) * 100) / 100
      : 0;
   const safeClaims = item.claims.map((claim, index) => ({ claim, claimId: claimIds[index] })).filter(({ claim }) => claim.spoilerTags.length === 0);
   let aiDraft: ArticleDraft | null = null;
   if (process.env.OPENCODE_ENABLED === "true") {
     aiDraft = await new OpenCodeRuntime().draft({
       jobId: eventId,
       collectionId: item.collectionId,
       sourceItems: [{ id: inserted.id, title: item.title, excerpt: item.text.slice(0, 4_000), publicCitationUrl: source.publicCitationUrl!, lineageId }],
       claims: item.claims.map((claim) => ({ subject: claim.subject, predicate: claim.predicate, value: claim.value, evidenceSourceId: inserted.id })),
     });
   }
   const content = buildDraftContent(item, source, claimIds, aiDraft);
   const articleId = await transaction.createArticleDraft({
     collectionId: item.collectionId,
     title: content.title,
     description: content.description,
     body: content.body,
     newsworthiness: score,
     confidence,
     sourceRefs: content.sourceRefs,
   });
   await transaction.recommendArticleCover({
     articleId,
     title: content.title,
     description: content.description,
     safeClaimText: safeClaims.map(({ claim }) => claimStatement(claim)),
   });
   return { sourceItemId: inserted.id, eventId, articleId, disposition, duplicate: false, warnings: safeClaims.length ? [] : ["No spoiler-safe claims were available for the public draft"] };
  });
}

export async function processFixture(persistence: GameIntelPersistence, fixture: Fixture, options: { allowFixture?: boolean } = {}): Promise<{ sourceItemId: string; eventId: string; articleId: string | null; duplicate: boolean }> {
  if (!options.allowFixture) throw new Error("Fixture ingestion requires an explicit trusted local invocation");
  if (!fixture.source.enabled) throw new Error(`Fixture source ${fixture.source.id} is disabled by source policy`);
  if (fixture.item.sourceStrength !== fixture.source.sourceStrength || fixture.item.publicationMode !== fixture.source.publicationMode) {
    throw new Error("Fixture item trust metadata must match its source");
  }
  const item = { ...fixture.item, sourceId: fixture.source.id } as NormalizedSourceItem;
  const result = await processNormalizedItem(persistence, item, fixture.source);
  return { sourceItemId: result.sourceItemId, eventId: result.eventId, articleId: result.articleId, duplicate: result.duplicate };
}

// Explicit reprocessing: re-interprets an immutable source revision with the
// current pipeline versions from its retained content, without refetching.
// Prior analysis runs for the revision are superseded, new claims/evidence
// are bound to the new run, and articles referencing the affected canonical
// claims are refreshed (their evidence needs fresh review again).
export async function reprocessSourceRevision(persistence: GameIntelPersistence, input: { revisionId: string; triggeredBy: string; reason?: string }): Promise<{ runId: string; claimCount: number; sourceItemId: string; articleId: string | null }> {
  if (!input.revisionId.trim()) throw new Error("A source revision id is required");
  if (!input.triggeredBy.trim()) throw new Error("A reprocessing actor is required");
  return persistence.transaction(async (transaction) => {
    const revision = await transaction.getRevisionForAnalysis(input.revisionId);
    if (!revision) throw new Error(`Source revision ${input.revisionId} not found`);
    if (revision.contentPurged) throw new Error("Source revision content was purged by retention; reprocessing is unavailable");
    const item: NormalizedSourceItem = {
      sourceId: revision.source.id,
      collectionId: revision.sourceItem.collectionId,
      externalId: revision.sourceItem.externalId,
      url: revision.sourceItem.url,
      title: revision.title,
      text: revision.content,
      sourceStrength: revision.sourceItem.sourceStrength,
      publicationMode: revision.sourceItem.publicationMode,
      discoveredAt: revision.sourceItem.discoveredAt,
      publishedAt: revision.sourceItem.publishedAt,
      lineageId: revision.sourceItem.lineageId,
      inputKind: revision.sourceItem.inputKind as InputKind,
      contentType: revision.sourceItem.contentType,
      language: revision.sourceItem.language,
      claims: [],
      processingVersion: NORMALIZATION_VERSION,
    };
    const versions: AnalysisVersions = {
      normalizationVersion: NORMALIZATION_VERSION,
      claimExtractorVersion: CLAIM_EXTRACTOR_VERSION,
      confidenceModelVersion: CONFIDENCE_MODEL_VERSION,
    };
    const existingRun = await transaction.getAnalysisRun(revision.id, versions);
    if (existingRun) throw new Error(`Source revision ${revision.id} is already analyzed with the current pipeline`);
    const run = await transaction.createAnalysisRun({
      sourceItemRevisionId: revision.id,
      versions,
      triggeredBy: input.triggeredBy,
      triggerReason: input.reason ?? "operator-reprocess",
    });
    const claimIds: string[] = [];
    const canonicalClaimIds: string[] = [];
    const provenance = await transaction.getSourceItemProvenance(revision.sourceItemId);
    const provenanceFamilyId = provenance?.provenanceFamilyId ?? revision.sourceItem.lineageId;
    const extracted = extractClaims(item, revision.sourceItem.sourceStrength);
    for (const claim of extracted) {
      const insertedClaim = await transaction.insertClaim(item, revision.sourceItemId, revision.id, run.id, provenanceFamilyId, claim, revision.sourceItem.lineageId);
      claimIds.push(insertedClaim.claimId);
      canonicalClaimIds.push(insertedClaim.canonicalClaimId);
    }
    const analyzedItem = { ...item, claims: extracted };
    await transaction.refreshClaimStatesForSourceItem(revision.sourceItemId);
    const sourceCanonicalClaimIds = await transaction.canonicalClaimIdsForSourceItem(revision.sourceItemId);
    const affectedCanonicalClaimIds = [...new Set([...canonicalClaimIds, ...sourceCanonicalClaimIds])];
    // The CLI uses the privileged runtime, so it can invalidate publications
    // before resolving continuity. As above, only the re-extracted claims can
    // select an existing article; historical claims are invalidation-only.
    await transaction.refreshArticlesForCanonicalClaims(affectedCanonicalClaimIds, "analysis_run.completed", "Source revision reprocessed with the current pipeline");
    const existingArticleId = await resolveArticleForClaims(transaction, canonicalClaimIds);
    if (existingArticleId && claimIds.length > 0 && revision.source.publicationMode === "normal" && revision.source.publicCitationUrl) {
      const publicCitationUrl = revision.source.publicCitationUrl;
      const sourceRefs = claimIds.map((claimId, index) => ({
        sourceId: revision.source.id,
        claimId,
        citationLabel: citationLabel(analyzedItem.claims[index]?.attributionType ?? "trusted_secondary", revision.source.type),
        publicCitationUrl,
      }));
      const existingClaims = await transaction.listClaimsForArticle(existingArticleId);
      const bodyClaims = [
        ...existingClaims.filter((claim) => claim.sourceItemId !== revision.sourceItemId),
        ...analyzedItem.claims.map((claim, index) => ({ ...claim, id: claimIds[index] })),
      ];
      await transaction.updateExistingArticle({
        articleId: existingArticleId,
        sourceItemId: revision.sourceItemId,
        sourceRefs,
        body: buildBodyFromClaims(bodyClaims),
        changeSummary: "Reprocessed source revision",
      });
    }
    return { runId: run.id, claimCount: claimIds.length, sourceItemId: revision.sourceItemId, articleId: existingArticleId };
  });
}
