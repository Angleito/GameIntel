import { describe, expect, test } from "bun:test";
import { IngestionLeaseLostError, type IngestionJob } from "@gameintel/db";
import { runWorkerLoop, retryableWorkerError, type WorkerLeaseDeps } from "./worker-loop.ts";

function fakeJob(jobKey: string): IngestionJob {
  return {
    jobKey,
    jobType: "source_ingest",
    status: "running",
    payload: { collectionId: "gta-vi", sourceId: "netflix-tudum", url: "https://example.com/report", profileId: "gta-vi" },
    attempts: 1,
    maxAttempts: 5,
    leaseToken: `lease-${jobKey}`,
    leaseExpiresAt: null,
    lastError: null,
    result: null,
  };
}

async function runOnce(deps: Partial<WorkerLeaseDeps>, processJob: (job: IngestionJob, isLeaseLost: () => boolean) => Promise<unknown>): Promise<void> {
  let checks = 0;
  const jobs: IngestionJob[] = [fakeJob("job-one")];
  await runWorkerLoop({
    workerId: "test-worker",
    pollMs: 100,
    leaseMs: 3_000,
    isStopping: () => ++checks >= 4,
    deps: {
      claim: async () => jobs.length ? jobs.shift()! : null,
      heartbeat: async () => undefined,
      renewLease: async () => true,
      complete: async () => undefined,
      fail: async () => undefined,
      ...deps,
    },
    processJob,
  });
}

describe("ingestion worker loop", () => {
  test("completes a job whose lease is held", async () => {
    let completed: unknown = null;
    await runOnce({
      complete: async (_job, result) => { completed = result; },
    }, async () => ({ disposition: "research_new_article" }));
    expect(completed).toEqual({ disposition: "research_new_article" });
  });

  test("records a failure and keeps the loop running", async () => {
    const failures: Array<{ jobKey: string; retryable: boolean }> = [];
    await runOnce({
      fail: async (job, error, retryable) => {
        failures.push({ jobKey: job.jobKey, retryable });
        expect(error).toBeInstanceOf(Error);
      },
    }, async () => {
      throw new Error("Source fetch timed out");
    });
    expect(failures).toEqual([{ jobKey: "job-one", retryable: true }]);
  });

  test("does not kill the worker when the lease is lost", async () => {
    let completes = 0;
    let failures = 0;
    await runOnce({
      renewLease: async () => false,
      complete: async () => { completes += 1; },
      fail: async () => { failures += 1; },
    }, async (_job, isLeaseLost) => {
      for (let attempt = 0; attempt < 200 && !isLeaseLost(); attempt += 1) await Bun.sleep(10);
      return { disposition: "research_new_article" };
    });
    expect(completes).toBe(0);
    expect(failures).toBe(0);
  });

  test("discards an execution that lost its lease while processing", async () => {
    let completes = 0;
    await runOnce({
      renewLease: async () => false,
      complete: async () => { completes += 1; },
    }, async (_job, isLeaseLost) => {
      for (let attempt = 0; attempt < 200 && !isLeaseLost(); attempt += 1) await Bun.sleep(10);
      throw new Error("Lease lost mid-fetch");
    });
    expect(completes).toBe(0);
  });

  test("never completes or fails after a reclaimed lease", async () => {
    let completes = 0;
    let failures = 0;
    await runOnce({
      renewLease: async () => false,
      complete: async () => { completes += 1; },
      fail: async () => { failures += 1; },
    }, async () => {
      await Bun.sleep(1_100);
      return { ok: true };
    });
    expect(completes).toBe(0);
    expect(failures).toBe(0);
  });

  test("does not record a failure when the fence detects lease loss", async () => {
    let failures = 0;
    await runOnce({
      fail: async () => { failures += 1; },
    }, async () => {
      throw new IngestionLeaseLostError("job-one");
    });
    expect(failures).toBe(0);
  });

  test("classifies permanent source errors as non-retryable", () => {
    expect(retryableWorkerError(new Error("Source netflix-tudum is not registered"))).toBe(false);
    expect(retryableWorkerError(new Error("Source does not permit URL ingestion"))).toBe(false);
    expect(retryableWorkerError(new Error("Source is disabled by source policy"))).toBe(false);
    expect(retryableWorkerError(new Error("SOURCE_FETCH_PROXY_URL is required"))).toBe(false);
    expect(retryableWorkerError(new Error("Source fetch failed with HTTP 503"))).toBe(true);
    expect(retryableWorkerError(new Error("Temporary network error"))).toBe(true);
  });
});