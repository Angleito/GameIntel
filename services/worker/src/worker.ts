import { IngestionLeaseLostError, type IngestionJob } from "@gameintel/contracts";
import { ingestUrl } from "@gameintel/newsroom";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";
import { runWorkerLoop, retryableWorkerError } from "./worker-loop.ts";

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

if (process.env.OPENCODE_ENABLED === "true") {
  throw new Error("The ingestion worker must not run AI drafting; use a separately isolated AI worker");
}
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
      claim: (workerId) => runtime.jobQueue.claimIngestionJob(workerId, ["source_ingest"], 60_000),
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
      if (job.jobType !== "source_ingest") throw new Error("Unsupported ingestion job");
      if (isLeaseLost()) throw new IngestionLeaseLostError(job.jobKey);
      const payload = sourceIngestPayload(job.payload);
      return ingestUrl(runtime, payload, { jobKey: job.jobKey, leaseToken: job.leaseToken ?? "" });
    },
  });
} finally {
  await runtime.close();
}

export { retryableWorkerError };