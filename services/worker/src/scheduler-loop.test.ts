import { describe, expect, test } from "bun:test";
import type { JobQueue, SchedulableSource, SourceScheduler } from "@gameintel/contracts";
import { processDueSources, type DiscoveryRunner } from "./scheduler-loop.ts";

function fakeClock(initial = 1_000_000): { now: () => number; nowIso: () => string } {
  let now = initial;
  return {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
  };
}

const source = (sourceId: string): SchedulableSource => ({
  sourceId,
  collectionId: "contract-test",
  url: `https://example.com/${sourceId}`,
  profileId: "contract-test",
  pollIntervalSeconds: 60,
});

function fakeScheduler(): SourceScheduler & { scheduled: string[] } {
  const scheduled: string[] = [];
  return {
    scheduled,
    dueSources: async () => [],
    markScheduled: async (sourceId: string) => { scheduled.push(sourceId); },
  };
}

function fakeQueue(enqueueError?: Error): JobQueue & { enqueued: string[] } {
  const enqueued: string[] = [];
  return {
    enqueued,
    enqueueSourceIngestJob: async (input) => {
      if (enqueueError) throw enqueueError;
      enqueued.push(input.sourceId);
      return { jobKey: `job-${input.sourceId}`, dedupeKey: `dedupe-${input.sourceId}`, duplicate: false, status: "queued" };
    },
    claimIngestionJob: async () => null,
    completeIngestionJob: async () => undefined,
    failIngestionJob: async () => undefined,
    renewIngestionJobLease: async () => false,
    getIngestionJob: async () => null,
    listRecentIngestionJobs: async () => [],
    getIngestionQueueStatus: async () => ({ queued: 0, running: 0, completed: 0, dead: 0, oldestQueuedAt: null, activeWorkers: 0, staleWorkers: 0 }),
    heartbeatIngestionWorker: async () => undefined,
    listIngestionWorkerHeartbeats: async () => [],
  };
}

describe("scheduler loop tick", () => {
  test("enqueues due sources and marks them scheduled on success", async () => {
    const queue = fakeQueue();
    const scheduler = fakeScheduler();
    const clock = fakeClock();
    await processDueSources({ due: [source("a"), source("b")], jobQueue: queue, clock, scheduler });
    expect(queue.enqueued).toEqual(["a", "b"]);
    expect(scheduler.scheduled).toEqual(["a", "b"]);
  });

  test("does not mark a source scheduled when enqueue fails, so the next tick retries", async () => {
    const queue = fakeQueue(new Error("database unavailable"));
    const scheduler = fakeScheduler();
    const clock = fakeClock();
    await processDueSources({ due: [source("a")], jobQueue: queue, clock, scheduler });
    expect(queue.enqueued).toEqual([]);
    expect(scheduler.scheduled).toEqual([]);
  });

  test("marks successful sources and leaves failed ones due within the same tick", async () => {
    let failures = 1;
    const queue: JobQueue & { enqueued: string[] } = {
      enqueued: [],
      enqueueSourceIngestJob: async (input) => {
        if (input.sourceId === "broken" && failures > 0) {
          failures -= 1;
          throw new Error("transient failure");
        }
        queue.enqueued.push(input.sourceId);
        return { jobKey: `job-${input.sourceId}`, dedupeKey: `dedupe-${input.sourceId}`, duplicate: false, status: "queued" };
      },
      claimIngestionJob: async () => null,
      completeIngestionJob: async () => undefined,
      failIngestionJob: async () => undefined,
      renewIngestionJobLease: async () => false,
      getIngestionJob: async () => null,
      listRecentIngestionJobs: async () => [],
      getIngestionQueueStatus: async () => ({ queued: 0, running: 0, completed: 0, dead: 0, oldestQueuedAt: null, activeWorkers: 0, staleWorkers: 0 }),
      heartbeatIngestionWorker: async () => undefined,
      listIngestionWorkerHeartbeats: async () => [],
    };
    const scheduler = fakeScheduler();
    await processDueSources({ due: [source("broken"), source("ok")], jobQueue: queue, clock: fakeClock(), scheduler });
    expect(queue.enqueued).toEqual(["ok"]);
    expect(scheduler.scheduled).toEqual(["ok"]);
  });

  test("enqueues discovered references from a discovery source after its poll", async () => {
    const queue = fakeQueue();
    const scheduler = fakeScheduler();
    const discovery = new Map<string, DiscoveryRunner>([
      ["rss-feed", async function* () {
        yield { externalId: "item-1", url: "https://example.com/rss-feed/item-1", title: "Item 1" };
        yield { externalId: "item-2", url: "https://example.com/rss-feed/item-2", title: "Item 2" };
      }],
    ]);
    const rssSource = { ...source("rss-feed"), discoveryAdapter: "rss" as const };
    await processDueSources({ due: [rssSource], jobQueue: queue, clock: fakeClock(), scheduler, discovery });
    expect(queue.enqueued).toEqual(["rss-feed", "rss-feed", "rss-feed"]);
    expect(scheduler.scheduled).toEqual(["rss-feed"]);
  });

  test("marks the source scheduled even when discovery yields nothing or fails", async () => {
    const queue = fakeQueue();
    const scheduler = fakeScheduler();
    const discovery = new Map<string, DiscoveryRunner>([
      ["empty-feed", async function* () {}],
      ["broken-feed", async function* () {
        throw new Error("feed unavailable");
      }],
    ]);
    await processDueSources({
      due: [{ ...source("empty-feed"), discoveryAdapter: "rss" }, { ...source("broken-feed"), discoveryAdapter: "rss" }],
      jobQueue: queue,
      clock: fakeClock(),
      scheduler,
      discovery,
    });
    expect(queue.enqueued).toEqual(["empty-feed", "broken-feed"]);
    expect(scheduler.scheduled).toEqual(["empty-feed", "broken-feed"]);
  });
});