# Source Adapters

Adapters live in `@gameintel/source-sdk`. Implement `SourceAdapter` for a new
provider:

```ts
interface SourceAdapter {
  id: string;
  policy: SourcePolicy;
  supportedCollectionIds: string[];
  discover(): AsyncIterable<DiscoveredRef>;   // optional pattern, may be empty
  fetch(ref: DiscoveredRef): Promise<NormalizedSourceItem>;
  healthCheck(): Promise<AdapterHealth>;
}
```

Adapters should:

- Declare an identifier and supported collection profiles.
- Respect the supplied source policy.
- Return validated normalized source items.
- Preserve external IDs, canonical URLs, and lineage inputs.
- Avoid storing or exposing restricted source material.
- Return a health result that explains disabled or degraded sources.

## Polling and discovery

Two ingestion patterns are supported:

- **Poll known target**: a registered URL checked repeatedly. The scheduler
  enqueues the registry `poll_url` on `poll_interval_seconds`; the isolated
  worker performs the controlled fetch.
- **Discover new items**: an RSS/API/index page whose items are queued
  individually. A registry source with `discovery: { adapter: rss,
  enabled: true }` gets a `source_discover` job on each cadence; the isolated
  ingestion worker fetches the feed through the controlled fetch transport
  (egress proxy, pacing, SSRF hardening), parses the items, and enqueues each
  one as its own ingestion job. The feed itself is never ingested as an
  article, and the scheduler stays networkless.

`FixtureAdapter` is available for deterministic tests and development.
`RssAdapter` implements the rss discovery adapter, and `parseRssFeed` is the
shared pure XML parser used by discovery jobs. Additional adapters
(filesystem, webhook, REST API, platform APIs) are added only when a
demonstrated need exists.

## Controlled fetching

Network adapters must go through the `ControlledFetchTransport` capability
(`@gameintel/controlled-fetch`), which enforces registered domains, private-IP
blocking, redirect revalidation, size/type/time limits, and source enablement.
Per-source request pacing is owned by the `SourcePacingStore`, applied
immediately before each transport fetch. Provider
credentials, rate limits, retention, and public citation rules belong in
configuration (the source registry), never in adapter-specific constants.

Every adapter should include tests for disabled sources, malformed input,
duplicate references, policy violations, and representative normalization.