import type { JobQueue, SchedulableSource, SourceScheduler } from "@gameintel/contracts";
import type { Clock } from "@gameintel/contracts";
import type { DiscoveredRef } from "@gameintel/source-sdk";

export type DiscoveryRunner = (source: SchedulableSource) => AsyncIterable<DiscoveredRef>;

// Processes one scheduler tick. A source is marked scheduled only after a
// successful enqueue, so a transient enqueue or database failure retries on
// the next tick instead of waiting the full polling interval. Sources with a
// discovery adapter additionally enqueue each discovered reference as its own
// ingestion job; active executions are deduplicated by the queue while
// completed references may be refreshed again later.
export async function processDueSources(input: {
  due: SchedulableSource[];
  jobQueue: JobQueue;
  clock: Clock;
  scheduler: SourceScheduler;
  discovery?: Map<string, DiscoveryRunner>;
}): Promise<void> {
  for (const source of input.due) {
    try {
      const result = await input.jobQueue.enqueueSourceIngestJob({
        collectionId: source.collectionId,
        sourceId: source.sourceId,
        url: source.url,
        profileId: source.profileId,
      });
      console.log(`Scheduled ${source.sourceId}: ${result.duplicate ? "already active" : `queued as ${result.jobKey}`}`);
      await input.scheduler.markScheduled(source.sourceId, input.clock.now());
    } catch (error) {
      console.error(`Failed to schedule ${source.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const runner = source.discoveryAdapter ? input.discovery?.get(source.sourceId) : undefined;
    if (!runner) continue;
    try {
      let discovered = 0;
      for await (const ref of runner(source)) {
        const refResult = await input.jobQueue.enqueueSourceIngestJob({
          collectionId: source.collectionId,
          sourceId: source.sourceId,
          url: ref.url,
          profileId: source.profileId,
        });
        discovered += 1;
        console.log(`Discovered ${source.sourceId} -> ${ref.url}: ${refResult.duplicate ? "already active" : `queued as ${refResult.jobKey}`}`);
      }
      if (discovered === 0) console.log(`Discovery for ${source.sourceId} found no new references`);
    } catch (error) {
      console.error(`Discovery failed for ${source.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}