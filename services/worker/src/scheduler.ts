import type { SchedulableSource } from "@gameintel/contracts";
import { loadCollectionProfile, loadProjectConfig, loadSourceRegistry, profilePath, sourceRegistryPath } from "@gameintel/config";
import { processDueSources } from "./scheduler-loop.ts";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";

// Continuous scheduler: determines which registered enabled network sources
// are due and enqueues their ingestion work. Polled sources enqueue their
// poll_url; discovery sources enqueue a source_discover job for the feed URL
// and the isolated ingestion worker fetches the feed and enqueues each
// discovered reference as its own ingestion job. The scheduler never fetches
// and never reviews: it stays on the internal database network, the queue
// deduplicates active executions, and the pacing layer decides when a request
// is actually allowed. The registry is loaded once at startup; an explicit
// empty source set still creates a live, idle scheduler, avoiding a restart
// loop when no network sources are currently enabled.

function pollIntervalMs(): number {
  const value = Number(process.env.SCHEDULER_POLL_MS ?? 10_000);
  return Number.isInteger(value) && value >= 1_000 && value <= 3_600_000 ? value : 10_000;
}

const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
const profile = await loadCollectionProfile(profilePath(profileId));
const entries = await loadSourceRegistry(sourceRegistryPath(profileId));

// RSS discovery sources poll their feed URL through the discovery job; the
// feed itself is never enqueued as an article-ingestion URL.
const pollable = entries.filter((entry) =>
  entry.enabled
  && entry.access !== "manual"
  && entry.poll_interval_seconds !== undefined
  && entry.poll_url !== undefined
  && (entry.access !== "rss" || entry.discovery?.enabled === true),
);
const sources: SchedulableSource[] = pollable.map((entry) => ({
  sourceId: entry.id,
  collectionId: profile.id,
  url: entry.poll_url!,
  profileId,
  pollIntervalSeconds: entry.poll_interval_seconds!,
  discoveryAdapter: entry.access === "rss" ? "rss" : null,
}));

const runtime = createServiceRuntime({ schedulerSources: sources });
const scheduler = runtime.scheduler;
const pollMs = pollIntervalMs();
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
    await processDueSources({ due, jobQueue: runtime.jobQueue, clock: runtime.clock, scheduler });
    await Bun.sleep(pollMs);
  }
} finally {
  await runtime.close();
}