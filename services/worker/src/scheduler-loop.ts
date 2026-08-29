import type { JobQueue, SchedulableSource, SourceScheduler } from "@gameintel/contracts";
import type { Clock } from "@gameintel/contracts";

// Processes one scheduler tick. A source is marked scheduled only after a
// successful enqueue, so a transient enqueue or database failure retries on
// the next tick instead of waiting the full polling interval. Discovery
// sources enqueue a source_discover job for their feed URL; the isolated
// ingestion worker performs the feed fetch, item parsing, and per-item
// enqueueing. The feed URL is never enqueued as an article-ingestion job.
export async function processDueSources(input: {
  due: SchedulableSource[];
  jobQueue: JobQueue;
  clock: Clock;
  scheduler: SourceScheduler;
}): Promise<void> {
  for (const source of input.due) {
    try {
      const result = source.discoveryAdapter
        ? await input.jobQueue.enqueueSourceDiscoverJob({
          collectionId: source.collectionId,
          sourceId: source.sourceId,
          feedUrl: source.url,
          profileId: source.profileId,
        })
        : await input.jobQueue.enqueueSourceIngestJob({
          collectionId: source.collectionId,
          sourceId: source.sourceId,
          url: source.url,
          profileId: source.profileId,
        });
      console.log(`Scheduled ${source.sourceId}: ${result.duplicate ? "already active" : `queued as ${result.jobKey}`}`);
      await input.scheduler.markScheduled(source.sourceId, input.clock.now());
    } catch (error) {
      console.error(`Failed to schedule ${source.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}