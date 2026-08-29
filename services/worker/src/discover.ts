import { IngestionLeaseLostError, type GameIntelRuntime, type IngestionJob, type SourceDiscoverJobPayload } from "@gameintel/contracts";
import { parseRssFeed } from "@gameintel/source-sdk";
import { loadRegistry, sourceFor, type RegistryEntry } from "@gameintel/newsroom";
import { sourceRegistryPath } from "@gameintel/config";

function discoverPayload(value: unknown): SourceDiscoverJobPayload {
  if (!value || typeof value !== "object") throw new Error("Source discovery job payload is invalid");
  const payload = value as Record<string, unknown>;
  if (typeof payload.collectionId !== "string" || typeof payload.sourceId !== "string" || typeof payload.feedUrl !== "string") {
    throw new Error("Source discovery job payload is invalid");
  }
  if (payload.profileId !== undefined && typeof payload.profileId !== "string") throw new Error("Source discovery job profile is invalid");
  return {
    collectionId: payload.collectionId,
    sourceId: payload.sourceId,
    feedUrl: payload.feedUrl,
    profileId: payload.profileId as string | undefined,
  };
}

function assertDiscoveryEntry(entry: RegistryEntry): void {
  if (entry.access !== "rss" || !entry.discovery?.enabled) {
    throw new Error(`Source ${entry.id} is not an enabled discovery source`);
  }
}

// Discovery job execution in the isolated ingestion worker: fetch the feed
// through the controlled fetch transport (egress proxy, pacing, SSRF
// hardening), parse its items, and enqueue each item as its own source_ingest
// job. The queue deduplicates active item executions, and completed items are
// safely re-refreshable later. The feed itself is never ingested as an
// article.
//
// Lease fencing note: the per-item assertIngestionJobLeaseHeld checks narrow
// the reclaim window but are not atomic with the enqueues (the FOR UPDATE
// lock commits before each child INSERT). This is acceptable because the
// worker loop's lease-verified complete/fail calls discard this execution's
// outcome after a loss, and the child jobs are themselves deduplicated and
// policy-bound regardless of when they were enqueued.
export async function processDiscoveryJob(
  runtime: GameIntelRuntime,
  job: IngestionJob,
  fence: { jobKey: string; leaseToken: string },
  options: { registryPath?: string | URL } = {},
): Promise<{ feedUrl: string; discovered: number; enqueued: number; duplicate: number }> {
  if (process.env.GAMEINTEL_FETCH_WORKER !== "true") {
    throw new Error("Source discovery is restricted to the isolated ingestion worker");
  }
  const payload = discoverPayload(job.payload);
  const entry = (await loadRegistry(options.registryPath ?? (payload.profileId ? sourceRegistryPath(payload.profileId) : undefined))).find((candidate) => candidate.id === payload.sourceId);
  if (!entry) throw new Error(`Source ${payload.sourceId} is not registered`);
  assertDiscoveryEntry(entry);
  if (entry.poll_url !== payload.feedUrl) throw new Error(`Discovery feed URL does not match the registered poll_url for ${entry.id}`);

  const source = await sourceFor(entry, entry.public_citation_base ?? null);
  await runtime.persistence.ensureSource(source);
  const waitMs = await runtime.pacing.acquireFetchSlot(entry.id, source.policy.requestsPerMinute);
  if (waitMs) await Bun.sleep(waitMs);
  const fetched = await runtime.fetchTransport.fetch(payload.feedUrl, {
    source: { id: entry.id, domains: entry.domains, access: entry.access, rpm: entry.rpm, userAgent: entry.userAgent, enabled: entry.enabled },
    sourcePolicy: source.policy,
    proxyUrl: process.env.SOURCE_FETCH_PROXY_URL,
  });

  const items = parseRssFeed(fetched.text);
  let enqueued = 0;
  let duplicate = 0;
  for (const item of items) {
    if (fence) await runtime.persistence.assertIngestionJobLeaseHeld(fence.jobKey, fence.leaseToken);
    const result = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: payload.collectionId,
      sourceId: payload.sourceId,
      url: item.url,
      profileId: payload.profileId,
    });
    if (result.duplicate) duplicate += 1;
    else enqueued += 1;
  }
  return { feedUrl: payload.feedUrl, discovered: items.length, enqueued, duplicate };
}