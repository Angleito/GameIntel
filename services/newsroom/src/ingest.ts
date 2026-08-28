import { PublicHttpUrlSchema, type NormalizedSourceItem, type SourceStrength } from "@gameintel/core";
import { loadSourceRegistry, sourceRegistryPath, type SourceRegistryEntry } from "@gameintel/config";
import { createDb, type Db } from "@gameintel/db";
import { createManualSourceItem, fetchPermittedUrl, parseArticleHtml } from "@gameintel/source-sdk";
import { processNormalizedItem } from "./pipeline.ts";

export type RegistryEntry = SourceRegistryEntry;

export async function loadRegistry(path: string | URL = sourceRegistryPath()): Promise<RegistryEntry[]> {
  return loadSourceRegistry(path);
}

async function sourceFor(entry: RegistryEntry, citationUrl: string | null = null) {
  const citation = citationUrl ?? entry.public_citation_base ?? null;
  const publicCitationUrl = citation === null ? null : PublicHttpUrlSchema.parse(citation);
  return {
    id: entry.id,
    type: entry.access === "manual" ? "operator-note" : entry.access,
     canonicalUrl: entry.domains[0] ? `https://${entry.domains[0]}` : `urn:gameintelgg:source:${entry.id}`,
    publicCitationUrl,
    sourceStrength: entry.source_strength,
     publicationMode: entry.publication_mode,
    policy: {
      accessMode: entry.access,
      requestsPerMinute: entry.rpm,
      retainRawTextDays: entry.access === "manual" ? 7 : 2,
      mayStoreFullText: false,
      attributionRequired: true,
      termsReviewedAt: "2026-08-27",
    },
    enabled: entry.enabled,
  } as const;
}

function candidateClaim(item: NormalizedSourceItem, sourceStrength: SourceStrength): NormalizedSourceItem["claims"][number] {
  const value = item.text.split(/(?<=[.!?])\s+/, 1)[0].slice(0, 500) || item.text.slice(0, 500);
  return {
    subject: item.title,
    predicate: "reports",
    value,
    qualifiers: { input_kind: item.inputKind, review_status: "candidate" },
    spoilerTags: [],
    exploitClass: null,
    evidenceLevel: "suspected",
    attributionType: sourceStrength === "PRIMARY" ? "official" : "trusted_secondary",
    statement: null,
    editorialAssessment: null,
    evidenceType: sourceStrength === "PRIMARY" ? "official_document" : sourceStrength === "UNVERIFIED" ? "community_report" : "trusted_reporting",
    excerpt: value,
    startMs: null,
    endMs: null,
  };
}

export async function ingestUrl(db: Db, input: { collectionId: string; sourceId: string; url: string; profileId?: string }): Promise<Awaited<ReturnType<typeof processNormalizedItem>>> {
  const entry = (await loadRegistry(input.profileId ? sourceRegistryPath(input.profileId) : undefined)).find((candidate) => candidate.id === input.sourceId);
  if (!entry) throw new Error(`Source ${input.sourceId} is not registered`);
  if (entry.access === "manual") throw new Error(`Source ${input.sourceId} does not permit URL ingestion`);
  const source = await sourceFor(entry, entry.public_citation_base ?? input.url);
  const fetched = await fetchPermittedUrl(input.url, {
    source: { id: entry.id, domains: entry.domains, access: entry.access, rpm: entry.rpm, userAgent: entry.userAgent, enabled: entry.enabled },
    sourcePolicy: source.policy,
  });
  const parsed = parseArticleHtml(fetched.text);
  const item = {
     sourceId: entry.id, collectionId: input.collectionId, externalId: fetched.url, url: fetched.url,
    title: parsed.title, text: parsed.text, sourceStrength: entry.source_strength, publicationMode: source.publicationMode,
    discoveredAt: new Date().toISOString(), publishedAt: null, lineageId: null, inputKind: "url" as const,
    contentType: fetched.contentType, language: parsed.language, claims: [],
  } as NormalizedSourceItem;
  item.claims = [candidateClaim(item, entry.source_strength)];
  return processNormalizedItem(db, item, source);
}

export async function ingestText(db: Db, input: { collectionId: string; sourceId: string; title: string; text: string; citationUrl?: string | null; inputKind: "pasted_text" | "local_file"; profileId?: string }): Promise<Awaited<ReturnType<typeof processNormalizedItem>>> {
  const entry = (await loadRegistry(input.profileId ? sourceRegistryPath(input.profileId) : undefined)).find((candidate) => candidate.id === input.sourceId);
  if (!entry) throw new Error(`Source ${input.sourceId} is not registered`);
  if (entry.access !== "manual") throw new Error(`Source ${input.sourceId} requires URL ingestion`);
  const source = await sourceFor(entry, input.citationUrl ?? null);
  const item = createManualSourceItem({ sourceId: entry.id, collectionId: input.collectionId, title: input.title, text: input.text, citationUrl: input.citationUrl, inputKind: input.inputKind });
  item.claims = [candidateClaim(item, entry.source_strength)];
  return processNormalizedItem(db, item, source);
}

export async function ingestUrlWithNewDb(input: { collectionId: string; sourceId: string; url: string }) {
  const db = createDb();
  try { return await ingestUrl(db, input); } finally { await db.end({ timeout: 2 }); }
}
