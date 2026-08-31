import { IngestionLeaseLostError, type IngestionJob } from "@gameintel/contracts";
import { ingestUrl } from "@gameintel/newsroom";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";
import { processDiscoveryJob } from "./discover.ts";
import { runWorkerLoop, retryableWorkerError } from "./worker-loop.ts";
import { recordJobHealth } from "./job-health.ts";

function workerId(): string {
  return process.env.INGESTION_WORKER_ID ?? `ingest-worker-${crypto.randomUUID().slice(0, 8)}`;
}

function pollInterval(): number {
  const value = Number(process.env.INGESTION_WORKER_POLL_MS ?? 500);
  return Number.isInteger(value) && value >= 100 && value <= 10_000 ? value : 500;
}

function sourceIngestPayload(value: unknown): Parameters<typeof ingestUrl>[1] {
  if (!value || typeof value !== "object") throw new Error("Source ingestion job payload is invalid");
  const payload = value as Record<string, unknown>;
  if (typeof payload.collectionId !== "string" || typeof payload.sourceId !== "string" || typeof payload.url !== "string") {
    throw new Error("Source ingestion job payload is invalid");
  }
  if (payload.profileId !== undefined && typeof payload.profileId !== "string") throw new Error("Source ingestion job profile is invalid");
  return {
    collectionId: payload.collectionId,
    sourceId: payload.sourceId,
    url: payload.url,
    profileId: payload.profileId as string | undefined,
  };
}

// The ingestion worker never wires an AI runtime: AI drafting and semantic
// extraction belong to operator processes (the CLI), which construct their
// own runtime from AI_PROVIDER. Isolation by construction, not by flag.
if (!process.env.SOURCE_FETCH_PROXY_URL) {
  throw new Error("SOURCE_FETCH_PROXY_URL is required for the ingestion worker");
}
process.env.GAMEINTEL_FETCH_WORKER = "true";

const runtime = createServiceRuntime();
const id = workerId();
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

try {
  await runtime.jobQueue.heartbeatIngestionWorker({ workerId: id, workerType: "source_ingest", currentJobKey: null, lastError: null });
  await runWorkerLoop({
    workerId: id,
    pollMs: pollInterval(),
    leaseMs: 60_000,
    isStopping: () => stopping,
    deps: {
      claim: (workerId) => runtime.jobQueue.claimIngestionJob(workerId, ["source_ingest", "source_discover"], 60_000),
      heartbeat: (currentJobKey, lastError) => runtime.jobQueue.heartbeatIngestionWorker({
        workerId: id,
        workerType: "source_ingest",
        currentJobKey,
        lastError: lastError === undefined ? null : lastError,
      }),
      renewLease: (job) => runtime.jobQueue.renewIngestionJobLease(job.jobKey, job.leaseToken ?? "", 60_000),
      complete: (job, result) => runtime.jobQueue.completeIngestionJob(job.jobKey, job.leaseToken ?? "", result),
      fail: (job, error, retryable) => runtime.jobQueue.failIngestionJob(job.jobKey, job.leaseToken ?? "", error, retryable),
    },
    processJob: async (job: IngestionJob, isLeaseLost: () => boolean) => {
      if (job.jobType !== "source_ingest" && job.jobType !== "source_discover") throw new Error("Unsupported ingestion job");
      if (isLeaseLost()) throw new IngestionLeaseLostError(job.jobKey);
      const payload = job.payload as Record<string, unknown> | null;
      const sourceId = payload && typeof payload.sourceId === "string" ? payload.sourceId : null;
      if (!sourceId) throw new Error("Source ingestion job payload is invalid");
      const fence = { jobKey: job.jobKey, leaseToken: job.leaseToken ?? "" };
      try {
        const result = job.jobType === "source_discover"
          ? await processDiscoveryJob(runtime, job, fence)
          : await ingestUrl(runtime, sourceIngestPayload(job.payload), fence);
        await recordJobHealth({ sourceHealth: runtime.sourceHealth, clock: runtime.clock, sourceId, job });
        return result;
      } catch (error) {
        // Only typed source-availability failures from the controlled-fetch
        // layer count against source health, and only on a job's first
        // execution; policy and application errors never touch the record.
        await recordJobHealth({ sourceHealth: runtime.sourceHealth, clock: runtime.clock, sourceId, job, error }).catch(() => undefined);
        throw error;
      }
    },
  });
} finally {
  await runtime.close();
}

export { retryableWorkerError };
