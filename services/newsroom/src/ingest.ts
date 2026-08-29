import {
  effectivePublicationMode,
  PublicHttpUrlSchema,
  trustClassificationFor,
  type NormalizedSourceItem,
  type SourceStrength,
} from "@gameintel/core";
import type { GameIntelPersistence, GameIntelRuntime, SourceInput } from "@gameintel/contracts";
import { loadSourceRegistry, sourceRegistryPath, type SourceRegistryEntry } from "@gameintel/config";
import { createManualSourceItem, parseArticleHtml } from "@gameintel/source-sdk";
import { processNormalizedItem } from "./pipeline.ts";

export type RegistryEntry = SourceRegistryEntry;

export async function loadRegistry(path: string | URL = sourceRegistryPath()): Promise<RegistryEntry[]> {
  return loadSourceRegistry(path);
}

export async function sourceFor(entry: RegistryEntry, citationUrl: string | null = null): Promise<SourceInput> {
  const citation = citationUrl ?? entry.public_citation_base ?? null;
  const publicCitationUrl = citation === null ? null : PublicHttpUrlSchema.parse(citation);
  return {
    id: entry.id,
    type: entry.access === "manual" ? "operator-note" : entry.access,
     canonicalUrl: entry.domains[0] ? `https://${entry.domains[0]}` : `urn:gameintelgg:source:${entry.id}`,
    publicCitationUrl,
    sourceStrength: entry.source_strength,
    publicationMode: effectivePublicationMode(entry.source_strength, entry.publication_mode),
    policy: {
      accessMode: entry.access,
      requestsPerMinute: entry.rpm,
      retainRawTextDays: entry.retain_raw_text_days ?? (entry.access === "manual" ? 7 : 2),
      mayStoreFullText: entry.may_store_full_text ?? false,
      attributionRequired: true,
      termsReviewedAt: entry.terms_reviewed_at ?? null,
      evidenceReview: entry.evidence_review ?? {
        minimumApprovals: 1,
        preventSubmitterApproval: true,
      },
    },
    enabled: entry.enabled,
  } as const;
}

function candidateClaim(item: NormalizedSourceItem, sourceStrength: SourceStrength): NormalizedSourceItem["claims"][number] {
  const value = item.text.split(/(?<=[.!?])\s+/, 1)[0].slice(0, 500) || item.text.slice(0, 500);
  const trust = trustClassificationFor(sourceStrength);
  return {
    subject: item.title,
    predicate: "reports",
    value,
    qualifiers: { input_kind: item.inputKind, review_status: "candidate" },
    spoilerTags: [],
    exploitClass: null,
    evidenceLevel: "suspected",
    attributionType: trust.attributionType,
    statement: null,
    editorialAssessment: null,
    stance: "supports",
    evidenceType: trust.evidenceType,
    excerpt: value,
    startMs: null,
    endMs: null,
  };
}

export async function ingestUrl(runtime: GameIntelRuntime, input: { collectionId: string; sourceId: string; url: string; profileId?: string }, fence?: { jobKey: string; leaseToken: string }): Promise<Awaited<ReturnType<typeof processNormalizedItem>>> {
  if (process.env.GAMEINTEL_FETCH_WORKER !== "true") {
    throw new Error("Registered URL ingestion is restricted to the isolated ingestion worker");
  }
  const entry = (await loadRegistry(input.profileId ? sourceRegistryPath(input.profileId) : undefined)).find((candidate) => candidate.id === input.sourceId);
  if (!entry) throw new Error(`Source ${input.sourceId} is not registered`);
  if (entry.access === "manual") throw new Error(`Source ${input.sourceId} does not permit URL ingestion`);
  const source = await sourceFor(entry, entry.public_citation_base ?? input.url);
  await runtime.persistence.ensureSource(source);
  const waitMs = await runtime.pacing.acquireFetchSlot(entry.id, source.policy.requestsPerMinute);
  if (waitMs) await Bun.sleep(waitMs);
  const fetched = await runtime.fetchTransport.fetch(input.url, {
    source: { id: entry.id, domains: entry.domains, access: entry.access, rpm: entry.rpm, userAgent: entry.userAgent, enabled: entry.enabled },
    sourcePolicy: source.policy,
    proxyUrl: process.env.SOURCE_FETCH_PROXY_URL,
  });
  const parsed = parseArticleHtml(fetched.text);
  const item = {
     sourceId: entry.id, collectionId: input.collectionId, externalId: fetched.url, url: fetched.url,
    title: parsed.title, text: parsed.text, sourceStrength: entry.source_strength, publicationMode: source.publicationMode,
    discoveredAt: new Date().toISOString(), publishedAt: null, lineageId: null, inputKind: "url" as const,
    contentType: fetched.contentType, language: parsed.language, claims: [],
  } as NormalizedSourceItem;
  item.claims = [candidateClaim(item, entry.source_strength)];
  return processNormalizedItem(runtime.persistence, item, source, { leaseFence: fence ?? null });
}

export async function ingestText(persistence: GameIntelPersistence, input: {
  collectionId: string;
  sourceId: string;
  title: string;
  text: string;
  citationUrl?: string | null;
  inputKind: "pasted_text" | "local_file";
  profileId?: string;
  submittedBy?: string | null;
}): Promise<Awaited<ReturnType<typeof processNormalizedItem>>> {
  const entry = (await loadRegistry(input.profileId ? sourceRegistryPath(input.profileId) : undefined)).find((candidate) => candidate.id === input.sourceId);
  if (!entry) throw new Error(`Source ${input.sourceId} is not registered`);
  if (entry.access !== "manual") throw new Error(`Source ${input.sourceId} requires URL ingestion`);
  const source = await sourceFor(entry, input.citationUrl ?? null);
  const item = createManualSourceItem({ sourceId: entry.id, collectionId: input.collectionId, title: input.title, text: input.text, citationUrl: input.citationUrl, inputKind: input.inputKind });
  item.sourceStrength = entry.source_strength;
  item.publicationMode = source.publicationMode;
  item.claims = [candidateClaim(item, entry.source_strength)];
  return processNormalizedItem(persistence, item, source, { submittedBy: input.submittedBy });
}

// Public report promotion is deliberate and preserves its lower trust class.
// It never fetches reporter URLs or creates a normal publication candidate.
export async function promotePublicSubmission(runtime: GameIntelRuntime, input: {
  submissionId: string;
  actorId: string;
  notes?: string;
  profileId?: string;
}): Promise<{ submissionId: string; sourceItemId: string; eventId: string; duplicate: boolean }> {
  if (!input.submissionId.trim()) throw new Error("A submission id is required");
  if (!input.actorId.trim()) throw new Error("A promotion actor is required");
  return runtime.persistence.transaction(async (transaction) => {
    const submission = await transaction.getPublicSubmissionForPromotion(input.submissionId);
    const profileId = input.profileId ?? submission.collectionId;
    if (profileId !== submission.collectionId) throw new Error("Submission does not belong to the active collection");
    const result = await ingestText(transaction, {
      collectionId: submission.collectionId,
      sourceId: "community-submission",
      title: submission.title ?? `Community report ${submission.id.slice(-8)}`,
      text: submission.report,
      citationUrl: null,
      inputKind: "pasted_text",
      profileId,
      submittedBy: input.actorId,
    });
    await transaction.markPublicSubmissionPromoted({
      submissionId: submission.id,
      sourceItemId: result.sourceItemId,
      actorId: input.actorId,
      notes: input.notes,
    });
    return {
      submissionId: submission.id,
      sourceItemId: result.sourceItemId,
      eventId: result.eventId,
      duplicate: result.duplicate,
    };
  });
}
