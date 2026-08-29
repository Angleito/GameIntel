import { IngestionLeaseLostError, type IngestionJob } from "@gameintel/contracts";

export type WorkerLeaseDeps = {
  claim: (workerId: string) => Promise<IngestionJob | null>;
  heartbeat: (currentJobKey: string | null, lastError?: string | null) => Promise<void>;
  renewLease: (job: IngestionJob) => Promise<boolean>;
  complete: (job: IngestionJob, result: unknown) => Promise<void>;
  fail: (job: IngestionJob, error: unknown, retryable: boolean) => Promise<void>;
};

export function retryableWorkerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !/(?:not registered|does not permit|disabled|restricted to the isolated|SOURCE_FETCH_PROXY_URL|required|payload is invalid)/i.test(message);
}

// Continuous worker loop with lease ownership. The worker renews its lease
// before expiry while processing. Lease loss stops the current execution and
// continues the loop; it never terminates the worker process. A stale worker
// cannot complete or fail an execution that another worker has reclaimed.
export async function runWorkerLoop(options: {
  workerId: string;
  pollMs: number;
  leaseMs: number;
  deps: WorkerLeaseDeps;
  processJob: (job: IngestionJob, isLeaseLost: () => boolean) => Promise<unknown>;
  isStopping?: () => boolean;
}): Promise<void> {
  const { workerId, pollMs, leaseMs, deps, processJob, isStopping = () => false } = options;
  if (!workerId.trim() || !Number.isInteger(pollMs) || pollMs < 100 || pollMs > 10_000 || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
    throw new Error("Invalid ingestion worker loop configuration");
  }
  while (!isStopping()) {
    const job = await deps.claim(workerId);
    if (!job) {
      await deps.heartbeat(null);
      await Bun.sleep(pollMs);
      continue;
    }
    if (!job.leaseToken) {
      console.error(`Claimed ingestion job ${job.jobKey} has no lease token`);
      continue;
    }
    let leaseLost = false;
    let pendingError: string | null = null;
    const renewalMs = Math.max(1_000, Math.floor(leaseMs / 3));
    const renewalTimer = setInterval(() => {
      void deps.renewLease(job).then((renewed) => {
        if (!renewed) leaseLost = true;
      }).catch(() => {
        leaseLost = true;
      });
    }, renewalMs);
    try {
      await deps.heartbeat(job.jobKey, null);
      const result = await processJob(job, () => leaseLost);
      if (leaseLost) {
        console.error(`Lease lost for ingestion job ${job.jobKey}; execution outcome discarded`);
        continue;
      }
      await deps.complete(job, result);
      console.log(`Completed ingestion job ${job.jobKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (leaseLost || error instanceof IngestionLeaseLostError) {
        console.error(`Lease lost for ingestion job ${job.jobKey}; stopping this execution: ${message}`);
        continue;
      }
      pendingError = message;
      await deps.fail(job, error, retryableWorkerError(error)).catch((failError) => {
        console.error(`Failed to record failure for ingestion job ${job.jobKey}: ${failError instanceof Error ? failError.message : String(failError)}`);
      });
      console.error(`Failed ingestion job ${job.jobKey}: ${message}`);
    } finally {
      clearInterval(renewalTimer);
      await deps.heartbeat(null, pendingError ?? null).catch(() => undefined);
    }
  }
}