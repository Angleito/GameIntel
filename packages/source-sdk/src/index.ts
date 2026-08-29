import { NormalizedSourceItemSchema, SourcePolicySchema, type NormalizedSourceItem, type SourcePolicy } from "@gameintel/core";
import { fetchPermittedUrl } from "@gameintel/controlled-fetch";
export * from "./article-parser.ts";
export * from "./manual-adapter.ts";
export type { ControlledFetchTransport, FetchedResource, FetchPolicy, RegisteredSource } from "@gameintel/contracts";

export type DiscoveredRef = { externalId: string; url: string; title?: string };
export type AdapterHealth = { adapterId: string; enabled: boolean; message?: string };

export interface SourceAdapter {
  id: string;
  policy: SourcePolicy;
  supportedCollectionIds: string[];
  discover(): AsyncIterable<DiscoveredRef>;
  fetch(ref: DiscoveredRef): Promise<NormalizedSourceItem>;
  healthCheck(): Promise<AdapterHealth>;
}

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

export class FixtureAdapter implements SourceAdapter {
  readonly id: string;
  readonly policy: SourcePolicy;
  readonly supportedCollectionIds: string[];
  private readonly fixture: Fixture;

  constructor(fixture: Fixture) {
    this.fixture = fixture;
    this.id = fixture.source.id;
    this.policy = SourcePolicySchema.parse(fixture.source.policy);
    if (this.policy.accessMode !== "manual") throw new Error(`Fixture adapter ${this.id} requires manual source policy`);
    this.supportedCollectionIds = [fixture.item.collectionId];
  }

  async *discover(): AsyncIterable<DiscoveredRef> {
    yield { externalId: this.fixture.item.externalId, url: this.fixture.item.url, title: this.fixture.item.title };
  }

  async fetch(ref: DiscoveredRef): Promise<NormalizedSourceItem> {
    if (!this.fixture.source.enabled) throw new Error(`Adapter ${this.id} is disabled by source policy`);
    if (ref.externalId !== this.fixture.item.externalId) throw new Error("Unknown fixture reference");
    return NormalizedSourceItemSchema.parse({ ...this.fixture.item, sourceId: this.fixture.source.id });
  }

  async healthCheck(): Promise<AdapterHealth> {
    return { adapterId: this.id, enabled: this.fixture.source.enabled !== false };
  }
}

export type RssAdapterConfig = {
  sourceId: string;
  feedUrl: string;
  domains: string[];
  rpm: number;
  userAgent?: string;
  collectionId: string;
  sourceStrength: NormalizedSourceItem["sourceStrength"];
  publicationMode: NormalizedSourceItem["publicationMode"];
  policy: SourcePolicy;
  enabled: boolean;
};

function xmlText(value: string): string {
  return value.replaceAll(/<!\[CDATA\[|\]\]>/g, "").replaceAll(/<[^>]+>/g, "").replaceAll(/&amp;/g, "&").trim();
}

export class RssAdapter implements SourceAdapter {
  readonly id: string;
  readonly policy: SourcePolicy;
  readonly supportedCollectionIds: string[];
  private readonly config: RssAdapterConfig;

  constructor(config: RssAdapterConfig) {
    this.config = config;
    this.id = config.sourceId;
    this.policy = SourcePolicySchema.parse(config.policy);
    if (this.policy.accessMode !== "rss") throw new Error(`RSS adapter ${this.id} requires rss source policy`);
    this.supportedCollectionIds = [config.collectionId];
  }

  private fetchPolicy() {
    return {
      source: {
        id: this.config.sourceId,
        domains: this.config.domains,
        access: "rss" as const,
        rpm: this.config.rpm,
        userAgent: this.config.userAgent,
        enabled: this.config.enabled,
      },
      sourcePolicy: this.policy,
    };
  }

  async *discover(): AsyncIterable<DiscoveredRef> {
    if (!this.config.enabled) throw new Error(`Adapter ${this.id} is disabled by source policy`);
    const response = await fetchPermittedUrl(this.config.feedUrl, this.fetchPolicy());
    const xml = response.text;
    for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
      const item = match[0];
      const link = xmlText(item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? "");
      const title = xmlText(item.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
      const externalId = xmlText(item.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ?? link);
      if (link && title && externalId) yield { externalId, url: link, title };
    }
  }

  async fetch(ref: DiscoveredRef): Promise<NormalizedSourceItem> {
    if (!this.config.enabled) throw new Error(`Adapter ${this.id} is disabled by source policy`);
    const response = await fetchPermittedUrl(ref.url, this.fetchPolicy());
    const html = response.text;
    const text = xmlText(html).slice(0, 4000);
    return NormalizedSourceItemSchema.parse({
      sourceId: this.id, collectionId: this.config.collectionId, externalId: ref.externalId, url: ref.url,
      title: ref.title ?? ref.url, text, sourceStrength: this.config.sourceStrength,
      publicationMode: this.config.publicationMode, discoveredAt: new Date().toISOString(), publishedAt: null,
      lineageId: null, claims: [],
    });
  }

  async healthCheck(): Promise<AdapterHealth> {
    return { adapterId: this.id, enabled: this.config.enabled, message: "RSS adapter is policy-bound and static-fetch only" };
  }
}
