import { type NormalizedSourceItem, type SourcePolicy } from "@gameintel/core";
export * from "./article-parser.ts";
export * from "./manual-adapter.ts";
export type { ControlledFetchTransport, FetchedResource, FetchPolicy, RegisteredSource } from "@gameintel/contracts";

export type DiscoveredRef = { externalId: string; url: string; title?: string };

export type Fixture = {
  source: {
    id: string;
    type: string;
    canonicalUrl: string;
    publicCitationUrl: string | null;
    sourceStrength: NormalizedSourceItem["sourceStrength"];
    publicationMode: NormalizedSourceItem["publicationMode"];
    policy: SourcePolicy;
    enabled?: boolean;
  };
  item: Omit<NormalizedSourceItem, "sourceId">;
};

function xmlText(value: string): string {
  return value.replaceAll(/<!\[CDATA\[|\]\]>/g, "").replaceAll(/<[^>]+>/g, "").replaceAll(/&amp;/g, "&").trim();
}

// Pure RSS item extraction, shared by the ingestion worker's discovery jobs.
// Never performs network access.
export function parseRssFeed(xml: string): DiscoveredRef[] {
  const refs: DiscoveredRef[] = [];
  for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const item = match[0];
    const link = xmlText(item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "");
    const title = xmlText(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
    const externalId = xmlText(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? link);
    if (link && title && externalId) refs.push({ externalId, url: link, title });
  }
  return refs;
}
