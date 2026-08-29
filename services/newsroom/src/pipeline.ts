import {
  effectivePublicationMode,
  PublicationModeSchema,
  SourcePolicySchema,
  SourceStrengthSchema,
  trustClassificationFor,
  type AttributionType,
  type EvidenceLevel,
  type NormalizedSourceItem,
} from "@gameintel/core";
import {
  createArticleDraft,
  calculateClaimConfidence,
  createEvent,
  ensureSource,
  inTransaction,
  insertClaim,
  insertSourceItem,
  invalidateEvidenceApprovalsForSourceItem,
  recommendArticleCover,
  type Db,
} from "@gameintel/db";
import { OpenCodeRuntime, type ArticleDraft } from "@gameintel/ai-runtime";
import { prepareIngestion } from "@gameintel/pipeline";
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

export async function processNormalizedItem(db: Db, item: NormalizedSourceItem, source: {
  id: string; type: string; canonicalUrl: string; publicCitationUrl: string | null;
  sourceStrength: string; publicationMode: string; policy: unknown; enabled?: boolean;
}, options: { submittedBy?: string | null } = {}): Promise<{ sourceItemId: string; eventId: string; articleId: string | null; disposition: string; duplicate: boolean; warnings: string[] }> {
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
    sourceStrength,
    publicationMode,
    claims: item.claims.map((claim) => ({
      ...claim,
      attributionType: trust.attributionType,
      evidenceType: trust.evidenceType,
    })),
  };

  return inTransaction(db, async (transaction) => {
  await ensureSource(transaction, source);
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
    const inserted = await insertSourceItem(transaction, item, prepared.rawHash, lineageId, policy, options.submittedBy ?? null);
   if (inserted.duplicate) return { sourceItemId: inserted.id, eventId: "duplicate", articleId: null, disposition: "duplicate", duplicate: true, warnings: ["Source content was already ingested"] };
   if (!inserted.revisionId) throw new Error("Changed source item did not create an evidence revision");
   if (inserted.materialChange) await invalidateEvidenceApprovalsForSourceItem(transaction, inserted.id);

   const score = prepared.newsworthiness;
   const disposition = prepared.disposition;
   const eventId = await createEvent(transaction, { collectionId: item.collectionId, sourceItemId: inserted.id, newsworthiness: score, disposition });
   const claimIds: string[] = [];
   for (const claim of item.claims) {
     claimIds.push(await insertClaim(transaction, item, inserted.id, inserted.revisionId, inserted.provenanceFamilyId, claim, lineageId));
   }

  if (disposition !== "research_new_article" || !source.publicCitationUrl || source.publicationMode !== "normal") {
    return { sourceItemId: inserted.id, eventId, articleId: null, disposition, duplicate: false, warnings: ["Source policy or public citation does not permit article output"] };
  }

   const claimConfidences: number[] = [];
   for (const claimId of claimIds) claimConfidences.push(await calculateClaimConfidence(transaction, claimId));
   const confidence = claimConfidences.length
     ? Math.round((claimConfidences.reduce((sum, value) => sum + value, 0) / claimConfidences.length) * 100) / 100
     : 0;
  const safeClaims = item.claims.map((claim, index) => ({ claim, claimId: claimIds[index] })).filter(({ claim }) => claim.spoilerTags.length === 0);
  let aiDraft: ArticleDraft | null = null;
  if (process.env.OPENCODE_ENABLED === "true") {
    aiDraft = await new OpenCodeRuntime().draft({
      jobId: eventId,
      collectionId: item.collectionId,
      sourceItems: [{ id: inserted.id, title: item.title, excerpt: item.text.slice(0, 4_000), publicCitationUrl: source.publicCitationUrl, lineageId }],
      claims: item.claims.map((claim) => ({ subject: claim.subject, predicate: claim.predicate, value: claim.value, evidenceSourceId: inserted.id })),
    });
  }
  const sourceRefs = claimIds.length
    ? claimIds.map((claimId, index) => ({
      sourceId: source.id,
      claimId,
      citationLabel: citationLabel(item.claims[index].attributionType, source.type),
      publicCitationUrl: source.publicCitationUrl!,
    }))
    : [{ sourceId: source.id, claimId: null, citationLabel: citationLabel("trusted_secondary", source.type), publicCitationUrl: source.publicCitationUrl! }];
  const title = aiDraft?.title ?? item.title;
  const description = aiDraft?.description ?? boundedDescription(item.text, 155);
  const articleId = await createArticleDraft(transaction, {
    collectionId: item.collectionId,
    title,
    description,
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
    newsworthiness: score,
    confidence,
    sourceRefs,
  });
  await recommendArticleCover(transaction, {
    articleId,
    title,
    description,
    safeClaimText: safeClaims.map(({ claim }) => claimStatement(claim)),
  });
  return { sourceItemId: inserted.id, eventId, articleId, disposition, duplicate: false, warnings: safeClaims.length ? [] : ["No spoiler-safe claims were available for the public draft"] };
  });
}

export async function processFixture(db: Db, fixture: Fixture, options: { allowFixture?: boolean } = {}): Promise<{ sourceItemId: string; eventId: string; articleId: string | null; duplicate: boolean }> {
  if (!options.allowFixture) throw new Error("Fixture ingestion requires an explicit trusted local invocation");
  if (!fixture.source.enabled) throw new Error(`Fixture source ${fixture.source.id} is disabled by source policy`);
  if (fixture.item.sourceStrength !== fixture.source.sourceStrength || fixture.item.publicationMode !== fixture.source.publicationMode) {
    throw new Error("Fixture item trust metadata must match its source");
  }
  const item = { ...fixture.item, sourceId: fixture.source.id } as NormalizedSourceItem;
  const result = await processNormalizedItem(db, item, fixture.source);
  return { sourceItemId: result.sourceItemId, eventId: result.eventId, articleId: result.articleId, duplicate: result.duplicate };
}
