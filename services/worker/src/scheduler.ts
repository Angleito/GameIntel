import type { SourceAdapter } from "@gameintel/source-sdk";
import { RssAdapter } from "@gameintel/source-sdk";
import type { SchedulableSource } from "@gameintel/contracts";
import { loadCollectionProfile, loadProjectConfig, loadSourceRegistry, profilePath, sourceRegistryPath, type SourceRegistryEntry } from "@gameintel/config";
import { processDueSources, type DiscoveryRunner } from "./scheduler-loop.ts";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";

// Continuous scheduler: determines which registered enabled network sources
// are due and enqueues their ingestion work. Polled sources enqueue their
// poll_url; discovery sources additionally run their adapter's discover()
// against the feed URL and enqueue each discovered reference as its own
// ingestion job. The scheduler never reviews; the queue deduplicates active
// executions and the pacing layer decides when a request is actually allowed.
// The registry is loaded once at startup; an explicit empty source set still
// creates a live, idle scheduler, avoiding a restart loop when no network
// sources are currently enabled.

function pollIntervalMs(): number {
  const value = Number(process.env.SCHEDULER_POLL_MS ?? 10_000);
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 10_000;
}

// Discovery adapters are constructed from the registry entry and the active
// profile, so no game-specific logic lives in the scheduler. Only the rss
// adapter is currently implemented; additional adapters are added here.
export function discoveryAdapterFor(entry: SourceRegistryEntry, collectionId: string): SourceAdapter | null {
  if (!entry.discovery?.enabled) return null;
  if (entry.discovery.adapter === "rss") {
    if (!entry.poll_url) throw new Error(`RSS discovery source ${entry.id} requires a feed poll_url`);
    return new RssAdapter({
      sourceId: entry.id,
      feedUrl: entry.poll_url,
      domains: entry.domains,
      rpm: entry.rpm,
      userAgent: entry.userAgent,
      collectionId,
      sourceStrength: entry.source_strength,
      publicationMode: entry.publication_mode,
      policy: {
        accessMode: "rss",
        requestsPerMinute: entry.rpm,
        retainRawTextDays: entry.retain_raw_text_days ?? 2,
        mayStoreFullText: entry.may_store_full_text ?? false,
        attributionRequired: true,
        termsReviewedAt: entry.terms_reviewed_at ?? null,
        evidenceReview: entry.evidence_review ?? { minimumApprovals: 1, preventSubmitterApproval: true },
      },
      enabled: entry.enabled,
    });
  }
  return null;
}

export type { DiscoveryRunner } from "./scheduler-loop.ts";

export function discoveryRunnerFor(entry: SourceRegistryEntry, collectionId: string): DiscoveryRunner {
  const adapter = discoveryAdapterFor(entry, collectionId);
  if (!adapter) return async function* () {};
  return async function* () {
    yield* adapter.discover();
  };
}

const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
const profile = await loadCollectionProfile(profilePath(profileId));
const entries = await loadSourceRegistry(sourceRegistryPath(profileId));

const pollable = entries.filter((entry) => entry.enabled && entry.access !== "manual" && entry.poll_interval_seconds !== undefined && entry.poll_url !== undefined);
const sources: SchedulableSource[] = pollable.map((entry) => ({
  sourceId: entry.id,
  collectionId: profile.id,
  url: entry.poll_url!,
  profileId,
  pollIntervalSeconds: entry.poll_interval_seconds!,
  discoveryAdapter: entry.discovery?.enabled ? entry.discovery.adapter : null,
}));

const runtime = createServiceRuntime({ schedulerSources: sources });
const scheduler = runtime.scheduler;
const pollMs = pollIntervalMs();
const discovery = new Map<string, DiscoveryRunner>(pollable.map((entry) => [entry.id, discoveryRunnerFor(entry, profile.id)]));
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

try {
  if (!scheduler) {
    console.log(`Scheduler has no pollable sources for ${profileId}; exiting.`);
    await runtime.close();
    process.exit(0);
  }
  console.log(`Scheduler running for ${profileId} with ${sources.length} pollable source(s); checking every ${pollMs}ms`);
  while (!stopping) {
    const due = await scheduler.dueSources();
    await processDueSources({ due, jobQueue: runtime.jobQueue, clock: runtime.clock, scheduler, discovery });
    await Bun.sleep(pollMs);
  }
} finally {
  await runtime.close();
}