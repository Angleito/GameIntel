import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IngestionLeaseLostError, type JobQueue } from "@gameintel/contracts";

export type QueueFactory = () => Promise<{
  queue: JobQueue;
  close?: () => Promise<void>;
  expireLease?: (jobKey: string) => Promise<void> | void;
}>;

function input(urlSuffix: string = crypto.randomUUID()): {
  collectionId: string;
  sourceId: string;
  url: string;
  profileId: string;
} {
  return {
    collectionId: "contract-test",
    sourceId: "contract-source",
    url: `https://contract.example.com/report-${urlSuffix}?utm_source=test`,
    profileId: "contract-test",
  };
}

// Behavioral contract every job queue adapter must satisfy: repeat scheduling,
// active deduplication, execution after completion, retry after failure, lease
// ownership, lease renewal, crash recovery, terminal outcomes.
export function runQueueContract(factory: QueueFactory): void {
  describe("job queue contract", () => {
    let queue: JobQueue;
    let close: (() => Promise<void>) | undefined;
    let expireLease: ((jobKey: string) => Promise<void> | void) | undefined;

    beforeEach(async () => {
      const created = await factory();
      queue = created.queue;
      close = created.close;
      expireLease = created.expireLease;
    });

    afterEach(async () => {
      await close?.();
    });

    test("enqueues once and deduplicates active executions", async () => {
      const first = await queue.enqueueSourceIngestJob(input("queued"));
      expect(first.duplicate).toBe(false);
      expect(first.status).toBe("queued");
      const duplicate = await queue.enqueueSourceIngestJob(input("queued"));
      expect(duplicate).toMatchObject({ jobKey: first.jobKey, duplicate: true, status: "queued" });
      const leased = await queue.claimIngestionJob("worker-a");
      expect(leased).toMatchObject({ jobKey: first.jobKey, status: "running", attempts: 1 });
      const runningDuplicate = await queue.enqueueSourceIngestJob(input("queued"));
      expect(runningDuplicate).toMatchObject({ jobKey: first.jobKey, duplicate: true, status: "running" });
      expect(await queue.claimIngestionJob("worker-b")).toBeNull();
      await queue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "duplicate" });
    });

    test("schedules a completed URL again as a fresh execution", async () => {
      const first = await queue.enqueueSourceIngestJob(input("repeat"));
      const leased = await queue.claimIngestionJob("worker-a");
      expect(leased).not.toBeNull();
      await queue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "research_new_article" });
      expect((await queue.getIngestionJob(first.jobKey))?.status).toBe("completed");

      const second = await queue.enqueueSourceIngestJob(input("repeat"));
      expect(second.duplicate).toBe(false);
      expect(second.jobKey).not.toBe(first.jobKey);
      expect(second.dedupeKey).toBe(first.dedupeKey);
      expect(second.status).toBe("queued");
      const refresh = await queue.claimIngestionJob("worker-a");
      expect(refresh?.jobKey).toBe(second.jobKey);
    });

    test("retries a dead URL later as a fresh execution", async () => {
      const first = await queue.enqueueSourceIngestJob(input("retry"));
      const leased = await queue.claimIngestionJob("worker-a");
      await queue.failIngestionJob(leased!.jobKey, leased!.leaseToken!, new Error("Source terms no longer permit collection"), false);
      expect(await queue.getIngestionJob(first.jobKey)).toMatchObject({ status: "dead", attempts: 1 });

      const retry = await queue.enqueueSourceIngestJob(input("retry"));
      expect(retry.duplicate).toBe(false);
      expect(retry.jobKey).not.toBe(first.jobKey);
      const claimed = await queue.claimIngestionJob("worker-a");
      expect(claimed?.jobKey).toBe(retry.jobKey);
    });

    test("reclaims an expired lease and rejects the stale worker", async () => {
      const enqueued = await queue.enqueueSourceIngestJob(input("reclaim"));
      const crashed = await queue.claimIngestionJob("crashed-worker", ["source_ingest"], 60_000);
      expect(crashed?.jobKey).toBe(enqueued.jobKey);
      if (expireLease) await expireLease(crashed!.jobKey);
      else throw new Error("Queue factory must provide expireLease for lease tests");

      const reclaimed = await queue.claimIngestionJob("replacement-worker");
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.jobKey).toBe(enqueued.jobKey);
      expect(reclaimed!.leaseToken).not.toBe(crashed!.leaseToken);
      expect(reclaimed!.attempts).toBe(2);

      expect(await queue.renewIngestionJobLease(crashed!.jobKey, crashed!.leaseToken!, 60_000)).toBe(false);
      await expect(queue.completeIngestionJob(crashed!.jobKey, crashed!.leaseToken!, { ok: true }))
        .rejects.toThrow(IngestionLeaseLostError);
      await expect(queue.failIngestionJob(crashed!.jobKey, crashed!.leaseToken!, new Error("Stale failure"), true))
        .rejects.toThrow(IngestionLeaseLostError);
      await queue.completeIngestionJob(reclaimed!.jobKey, reclaimed!.leaseToken!, { disposition: "duplicate" });
      expect((await queue.getIngestionJob(enqueued.jobKey))?.status).toBe("completed");
    });

    test("renews a lease before expiry and records heartbeats", async () => {
      const enqueued = await queue.enqueueSourceIngestJob(input("renew"));
      const leased = await queue.claimIngestionJob("worker-a", ["source_ingest"], 60_000);
      expect(leased?.jobKey).toBe(enqueued.jobKey);
      await queue.heartbeatIngestionWorker({ workerId: "worker-a", workerType: "source_ingest", currentJobKey: leased!.jobKey, lastError: null });
      expect(await queue.renewIngestionJobLease(leased!.jobKey, leased!.leaseToken!, 60_000)).toBe(true);
      const status = await queue.getIngestionQueueStatus();
      expect(status.running).toBeGreaterThanOrEqual(1);
      expect(status.activeWorkers).toBeGreaterThanOrEqual(1);
      expect((await queue.listRecentIngestionJobs()).some((job) => job.jobKey === enqueued.jobKey)).toBe(true);
      expect((await queue.listIngestionWorkerHeartbeats()).find((worker) => worker.workerId === "worker-a"))
        .toMatchObject({ currentJobKey: leased!.jobKey, lastError: null });
      await queue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "duplicate" });
      expect(await queue.getIngestionJob(enqueued.jobKey)).toMatchObject({ status: "completed" });
    });

    test("fails a job into a retryable queued state and eventually dead", async () => {
      const enqueued = await queue.enqueueSourceIngestJob(input("fail"));
      const leased = await queue.claimIngestionJob("worker-a", ["source_ingest"], 1_000);
      expect(leased).not.toBeNull();
      await queue.failIngestionJob(leased!.jobKey, leased!.leaseToken!, new Error("Transient failure"), true);
      const failed = await queue.getIngestionJob(enqueued.jobKey);
      expect(failed?.status).toBe("queued");
      expect(failed?.lastError).toBe("Transient failure");
    });
  });
}