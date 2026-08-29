import {
  IngestionLeaseLostError,
  type Clock,
  type IdGenerator,
  type IngestionJob,
  type IngestionQueueStatus,
  type IngestionWorkerHeartbeat,
  type JobQueue,
  type SourceDiscoverJobPayload,
  type SourceIngestEnqueueResult,
  type SourceIngestJobPayload,
} from "@gameintel/contracts";
import { canonicalizeUrl, hashText, PublicHttpUrlSchema } from "@gameintel/core";
import type { JobRecord, WorkerHeartbeatRecord } from "./store.ts";

// Shared lease state between the in-memory job queue and the in-memory
// persistence fence: a reclaimed lease invalidates the stale worker's fence
// check exactly like the PostgreSQL FOR UPDATE row lock.
export class MemoryLeaseRegistry {
  private readonly leases = new Map<string, { token: string; held: boolean }>();

  acquire(jobKey: string, token: string): void {
    this.leases.set(jobKey, { token, held: true });
  }

  release(jobKey: string): void {
    this.leases.delete(jobKey);
  }

  held(jobKey: string, token: string): boolean {
    const entry = this.leases.get(jobKey);
    return entry !== undefined && entry.held && entry.token === token;
  }
}

function parseJob(row: JobRecord): IngestionJob {
  return {
    jobKey: row.jobKey,
    jobType: row.jobType,
    status: row.status,
    payload: { ...row.payload },
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseToken: row.leaseToken,
    leaseExpiresAt: row.leaseExpiresAt === null ? null : new Date(row.leaseExpiresAt).toISOString(),
    lastError: row.lastError,
    result: row.result,
  };
}

export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly heartbeats = new Map<string, WorkerHeartbeatRecord>();

  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly leases: MemoryLeaseRegistry,
  ) {}

  // Diagnostic surface for conformance tests: forces a lease to expire.
  expireLeaseForTest(jobKey: string): void {
    const job = this.jobs.get(jobKey);
    if (job) job.leaseExpiresAt = this.clock.now() - 1_000;
  }

  jobForTest(jobKey: string): JobRecord | undefined {
    return this.jobs.get(jobKey);
  }

  async enqueueSourceIngestJob(input: SourceIngestJobPayload): Promise<SourceIngestEnqueueResult> {
    const collectionId = input.collectionId.trim();
    const sourceId = input.sourceId.trim();
    if (!collectionId || !sourceId) throw new Error("Source ingestion jobs require a collection and source");
    const url = canonicalizeUrl(PublicHttpUrlSchema.parse(input.url));
    const payload: SourceIngestJobPayload = { collectionId, sourceId, url, profileId: input.profileId?.trim() || undefined };
    const jobKey = this.ids.generate("source_ingest");
    const dedupeKey = `source_ingest:${collectionId}:${sourceId}:${hashText(url)}`;
    for (const existing of this.jobs.values()) {
      if (existing.dedupeKey === dedupeKey && (existing.status === "queued" || existing.status === "running")) {
        return { jobKey: existing.jobKey, dedupeKey, duplicate: true, status: existing.status };
      }
    }
    const now = this.clock.now();
    this.jobs.set(jobKey, {
      jobKey,
      jobType: "source_ingest",
      status: "queued",
      payload,
      dedupeKey,
      priority: 100,
      attempts: 0,
      maxAttempts: 5,
      availableAt: now,
      leasedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    return { jobKey, dedupeKey, duplicate: false, status: "queued" };
  }

  async enqueueSourceDiscoverJob(input: SourceDiscoverJobPayload): Promise<SourceIngestEnqueueResult> {
    const collectionId = input.collectionId.trim();
    const sourceId = input.sourceId.trim();
    if (!collectionId || !sourceId) throw new Error("Source discovery jobs require a collection and source");
    const feedUrl = canonicalizeUrl(PublicHttpUrlSchema.parse(input.feedUrl));
    const payload: SourceDiscoverJobPayload = { collectionId, sourceId, feedUrl, profileId: input.profileId?.trim() || undefined };
    const jobKey = this.ids.generate("source_discover");
    const dedupeKey = `source_discover:${collectionId}:${sourceId}:${hashText(feedUrl)}`;
    for (const existing of this.jobs.values()) {
      if (existing.dedupeKey === dedupeKey && (existing.status === "queued" || existing.status === "running")) {
        return { jobKey: existing.jobKey, dedupeKey, duplicate: true, status: existing.status };
      }
    }
    const now = this.clock.now();
    this.jobs.set(jobKey, {
      jobKey,
      jobType: "source_discover",
      status: "queued",
      payload,
      dedupeKey,
      priority: 100,
      attempts: 0,
      maxAttempts: 5,
      availableAt: now,
      leasedBy: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });
    return { jobKey, dedupeKey, duplicate: false, status: "queued" };
  }

  async claimIngestionJob(workerId: string, jobTypes: string[] = ["source_ingest"], leaseMs = 60_000): Promise<IngestionJob | null> {
    if (!workerId.trim() || !jobTypes.length || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Invalid ingestion job lease request");
    }
    const now = this.clock.now();
    for (const job of this.jobs.values()) {
      if (job.status !== "running" || job.leaseExpiresAt === null || job.leaseExpiresAt > now) continue;
      if (job.attempts >= job.maxAttempts) {
        job.status = "dead";
        job.lastError = job.lastError ?? "Job lease expired after maximum attempts";
        job.leaseToken = null;
        job.leaseExpiresAt = null;
        job.completedAt = now;
        job.updatedAt = now;
      } else {
        job.status = "queued";
        job.leasedBy = null;
        job.leaseToken = null;
        job.leaseExpiresAt = null;
        job.availableAt = now;
        job.updatedAt = now;
      }
      this.leases.release(job.jobKey);
    }
    const candidates = [...this.jobs.values()]
      .filter((job) => job.status === "queued" && job.availableAt <= now && jobTypes.includes(job.jobType))
      .sort((left, right) => right.priority - left.priority || left.availableAt - right.availableAt || left.createdAt - right.createdAt);
    const candidate = candidates[0];
    if (!candidate) return null;
    const leaseToken = this.ids.generate("lease");
    candidate.status = "running";
    candidate.attempts += 1;
    candidate.leasedBy = workerId;
    candidate.leaseToken = leaseToken;
    candidate.leaseExpiresAt = now + leaseMs;
    candidate.lastError = null;
    candidate.updatedAt = now;
    this.leases.acquire(candidate.jobKey, leaseToken);
    return parseJob(candidate);
  }

  async completeIngestionJob(jobKey: string, leaseToken: string, result: unknown): Promise<void> {
    const job = this.jobs.get(jobKey);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) throw new IngestionLeaseLostError(jobKey);
    job.status = "completed";
    job.result = result;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.completedAt = this.clock.now();
    job.updatedAt = this.clock.now();
    this.leases.release(jobKey);
  }

  async failIngestionJob(jobKey: string, leaseToken: string, error: unknown, retryable = true): Promise<void> {
    const job = this.jobs.get(jobKey);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) throw new IngestionLeaseLostError(jobKey);
    const now = this.clock.now();
    const terminal = !retryable || job.attempts >= job.maxAttempts;
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
    const message = error instanceof Error ? error.message : String(error);
    job.status = terminal ? "dead" : "queued";
    job.lastError = message.slice(0, 2_000);
    job.availableAt = now + delayMs;
    job.leaseToken = null;
    job.leaseExpiresAt = null;
    job.completedAt = terminal ? now : null;
    job.updatedAt = now;
    this.leases.release(jobKey);
  }

  async renewIngestionJobLease(jobKey: string, leaseToken: string, durationMs: number): Promise<boolean> {
    if (!jobKey.trim() || !leaseToken.trim() || !Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
      throw new Error("Invalid ingestion job lease renewal request");
    }
    const job = this.jobs.get(jobKey);
    if (!job || job.status !== "running" || job.leaseToken !== leaseToken) return false;
    job.leaseExpiresAt = this.clock.now() + durationMs;
    job.updatedAt = this.clock.now();
    return true;
  }

  async getIngestionJob(jobKey: string): Promise<IngestionJob | null> {
    const job = this.jobs.get(jobKey);
    return job ? parseJob(job) : null;
  }

  async listRecentIngestionJobs(limit = 25): Promise<IngestionJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Ingestion job list limit must be between 1 and 100");
    return [...this.jobs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.jobKey.localeCompare(right.jobKey))
      .slice(0, limit)
      .map(parseJob);
  }

  async getIngestionQueueStatus(staleAfterMs = 30_000): Promise<IngestionQueueStatus> {
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 3_600_000) {
      throw new Error("Ingestion worker stale threshold must be between 1 second and 1 hour");
    }
    const now = this.clock.now();
    const jobs = [...this.jobs.values()].filter((job) => job.jobType === "source_ingest" || job.jobType === "source_discover");
    const queued = jobs.filter((job) => job.status === "queued");
    const workers = [...this.heartbeats.values()];
    return {
      queued: queued.length,
      running: jobs.filter((job) => job.status === "running").length,
      completed: jobs.filter((job) => job.status === "completed").length,
      dead: jobs.filter((job) => job.status === "dead").length,
      oldestQueuedAt: queued.length ? new Date(Math.min(...queued.map((job) => job.availableAt))).toISOString() : null,
      activeWorkers: workers.filter((worker) => worker.lastSeenAt >= now - staleAfterMs).length,
      staleWorkers: workers.filter((worker) => worker.lastSeenAt < now - staleAfterMs).length,
    };
  }

  async heartbeatIngestionWorker(input: {
    workerId: string;
    workerType: "source_ingest";
    currentJobKey?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    const workerId = input.workerId.trim();
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(workerId)) throw new Error("A valid ingestion worker id is required");
    const currentJobKey = input.currentJobKey ?? null;
    const retainLastError = input.lastError === undefined;
    const lastError = input.lastError?.slice(0, 2_000) ?? null;
    const now = this.clock.now();
    const existing = this.heartbeats.get(workerId);
    this.heartbeats.set(workerId, {
      workerId,
      workerType: input.workerType,
      currentJobKey,
      lastError: retainLastError && existing ? existing.lastError : lastError,
      lastSeenAt: now,
      updatedAt: now,
    });
  }

  async listIngestionWorkerHeartbeats(): Promise<IngestionWorkerHeartbeat[]> {
    return [...this.heartbeats.values()]
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || left.workerId.localeCompare(right.workerId))
      .map((worker) => ({
        workerId: worker.workerId,
        workerType: worker.workerType,
        currentJobKey: worker.currentJobKey,
        lastError: worker.lastError,
        lastSeenAt: new Date(worker.lastSeenAt).toISOString(),
      }));
  }
}