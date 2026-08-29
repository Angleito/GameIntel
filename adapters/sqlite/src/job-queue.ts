import {
  IngestionLeaseLostError,
  type Clock,
  type IdGenerator,
  type IngestionJob,
  type IngestionQueueStatus,
  type IngestionWorkerHeartbeat,
  type JobQueue,
  type SourceIngestEnqueueResult,
  type SourceIngestJobPayload,
} from "@gameintel/contracts";
import { canonicalizeUrl, hashText, PublicHttpUrlSchema } from "@gameintel/core";
import type { Database } from "bun:sqlite";
import { json, parseJson } from "./database.ts";

type JobRow = {
  job_key: string;
  job_type: string;
  status: "queued" | "running" | "completed" | "dead";
  payload: string;
  dedupe_key: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: number;
  leased_by: string | null;
  lease_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

function parseJob(row: JobRow): IngestionJob {
  return {
    jobKey: row.job_key,
    jobType: row.job_type,
    status: row.status,
    payload: parseJson<SourceIngestJobPayload>(row.payload),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at === null ? null : new Date(row.lease_expires_at).toISOString(),
    lastError: row.last_error,
    result: row.result === null ? null : parseJson(row.result),
  };
}

// SQLite job queue: same semantics as the PostgreSQL reference adapter. A
// single connection serializes execution, so crash recovery is purely
// lease-expiry based and there is no SKIP LOCKED equivalent.
export class SQLiteJobQueue implements JobQueue {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  expireLeaseForTest(jobKey: string): void {
    this.db.query("UPDATE jobs SET lease_expires_at = ? WHERE job_key = ?").run(this.clock.now() - 1_000, jobKey);
  }

  async enqueueSourceIngestJob(input: SourceIngestJobPayload): Promise<SourceIngestEnqueueResult> {
    const collectionId = input.collectionId.trim();
    const sourceId = input.sourceId.trim();
    if (!collectionId || !sourceId) throw new Error("Source ingestion jobs require a collection and source");
    const url = canonicalizeUrl(PublicHttpUrlSchema.parse(input.url));
    const payload: SourceIngestJobPayload = { collectionId, sourceId, url, profileId: input.profileId?.trim() || undefined };
    const jobKey = this.ids.generate("source_ingest");
    const dedupeKey = `source_ingest:${collectionId}:${sourceId}:${hashText(url)}`;
    const now = this.clock.now();
    const existing = this.db.query(
      "SELECT job_key, status FROM jobs WHERE dedupe_key = ? AND status IN ('queued', 'running') LIMIT 1",
    ).get(dedupeKey) as { job_key: string; status: string } | null;
    if (existing) return { jobKey: existing.job_key, dedupeKey, duplicate: true, status: existing.status as "queued" | "running" };
    this.db.query(
      `INSERT INTO jobs (job_key, job_type, status, payload, dedupe_key, priority, attempts, max_attempts, available_at, leased_by, lease_token, lease_expires_at, last_error, result, created_at, updated_at, completed_at)
       VALUES (?, 'source_ingest', 'queued', ?, ?, 100, 0, 5, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)`,
    ).run(jobKey, json(payload), dedupeKey, now, now, now);
    return { jobKey, dedupeKey, duplicate: false, status: "queued" };
  }

  async claimIngestionJob(workerId: string, jobTypes: string[] = ["source_ingest"], leaseMs = 60_000): Promise<IngestionJob | null> {
    if (!workerId.trim() || !jobTypes.length || !Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 300_000) {
      throw new Error("Invalid ingestion job lease request");
    }
    const now = this.clock.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(
        `UPDATE jobs SET status = 'dead', completed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ?,
          last_error = COALESCE(last_error, 'Job lease expired after maximum attempts')
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempts >= max_attempts`,
      ).run(now, now, now);
      this.db.query(
        `UPDATE jobs SET status = 'queued', leased_by = NULL, lease_token = NULL, lease_expires_at = NULL, available_at = ?, updated_at = ?
         WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? AND attempts < max_attempts`,
      ).run(now, now, now);
      const placeholders = jobTypes.map(() => "?").join(", ");
      const candidate = this.db.query(
        `SELECT * FROM jobs WHERE status = 'queued' AND available_at <= ? AND job_type IN (${placeholders})
         ORDER BY priority DESC, available_at ASC, created_at ASC LIMIT 1`,
      ).get(now, ...jobTypes) as JobRow | null;
      if (!candidate) {
        this.db.exec("COMMIT");
        return null;
      }
      const leaseToken = this.ids.generate("lease");
      this.db.query(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, leased_by = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?, last_error = NULL
         WHERE job_key = ?`,
      ).run(workerId, leaseToken, now + leaseMs, now, candidate.job_key);
      this.db.exec("COMMIT");
      return parseJob({ ...candidate, status: "running", attempts: candidate.attempts + 1, leased_by: workerId, lease_token: leaseToken, lease_expires_at: now + leaseMs, updated_at: now, last_error: null });
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async completeIngestionJob(jobKey: string, leaseToken: string, result: unknown): Promise<void> {
    const completed = this.db.query(
      "UPDATE jobs SET status = 'completed', result = ?, completed_at = ?, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_key = ? AND status = 'running' AND lease_token = ?",
    ).run(json(result), this.clock.now(), this.clock.now(), jobKey, leaseToken);
    if (completed.changes === 0) throw new IngestionLeaseLostError(jobKey);
  }

  async failIngestionJob(jobKey: string, leaseToken: string, error: unknown, retryable = true): Promise<void> {
    const row = this.db.query(
      "SELECT attempts, max_attempts FROM jobs WHERE job_key = ? AND status = 'running' AND lease_token = ?",
    ).get(jobKey, leaseToken) as { attempts: number; max_attempts: number } | null;
    if (!row) throw new IngestionLeaseLostError(jobKey);
    const now = this.clock.now();
    const terminal = !retryable || row.attempts >= row.max_attempts;
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, row.attempts - 1));
    const message = error instanceof Error ? error.message : String(error);
    this.db.query(
      `UPDATE jobs SET status = ?, last_error = ?, available_at = ?, lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = ? WHERE job_key = ?`,
    ).run(terminal ? "dead" : "queued", message.slice(0, 2_000), now + delayMs, terminal ? now : null, now, jobKey);
  }

  async renewIngestionJobLease(jobKey: string, leaseToken: string, durationMs: number): Promise<boolean> {
    if (!jobKey.trim() || !leaseToken.trim() || !Number.isInteger(durationMs) || durationMs < 1_000 || durationMs > 3_600_000) {
      throw new Error("Invalid ingestion job lease renewal request");
    }
    const renewed = this.db.query(
      "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE job_key = ? AND status = 'running' AND lease_token = ?",
    ).run(this.clock.now() + durationMs, this.clock.now(), jobKey, leaseToken);
    return renewed.changes > 0;
  }

  async getIngestionJob(jobKey: string): Promise<IngestionJob | null> {
    const row = this.db.query("SELECT * FROM jobs WHERE job_key = ? LIMIT 1").get(jobKey) as JobRow | null;
    return row ? parseJob(row) : null;
  }

  async listRecentIngestionJobs(limit = 25): Promise<IngestionJob[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Ingestion job list limit must be between 1 and 100");
    return (this.db.query(
      "SELECT * FROM jobs ORDER BY updated_at DESC, job_key ASC LIMIT ?",
    ).all(limit) as JobRow[]).map(parseJob);
  }

  async getIngestionQueueStatus(staleAfterMs = 30_000): Promise<IngestionQueueStatus> {
    if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 3_600_000) {
      throw new Error("Ingestion worker stale threshold must be between 1 second and 1 hour");
    }
    const now = this.clock.now();
    const counts = this.db.query(
      `SELECT
        SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead,
        MIN(CASE WHEN status = 'queued' THEN available_at END) AS oldest_queued
       FROM jobs WHERE job_type = 'source_ingest'`,
    ).get() as { queued: number | null; running: number | null; completed: number | null; dead: number | null; oldest_queued: number | null };
    const workers = this.db.query("SELECT * FROM ingestion_worker_heartbeats").all() as Array<{ worker_id: string; last_seen_at: number }>;
    return {
      queued: counts.queued ?? 0,
      running: counts.running ?? 0,
      completed: counts.completed ?? 0,
      dead: counts.dead ?? 0,
      oldestQueuedAt: counts.oldest_queued === null ? null : new Date(counts.oldest_queued).toISOString(),
      activeWorkers: workers.filter((worker) => worker.last_seen_at >= now - staleAfterMs).length,
      staleWorkers: workers.filter((worker) => worker.last_seen_at < now - staleAfterMs).length,
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
    this.db.query(
      `INSERT INTO ingestion_worker_heartbeats (worker_id, worker_type, current_job_key, last_error, last_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (worker_id) DO UPDATE SET worker_type = excluded.worker_type, current_job_key = excluded.current_job_key,
         last_error = CASE WHEN ? THEN last_error ELSE excluded.last_error END,
         last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
    ).run(workerId, input.workerType, currentJobKey, lastError, now, now, retainLastError ? 1 : 0);
  }

  async listIngestionWorkerHeartbeats(): Promise<IngestionWorkerHeartbeat[]> {
    return (this.db.query(
      "SELECT * FROM ingestion_worker_heartbeats ORDER BY last_seen_at DESC, worker_id ASC",
    ).all() as Array<{ worker_id: string; worker_type: "source_ingest"; current_job_key: string | null; last_error: string | null; last_seen_at: number }>).map((worker) => ({
      workerId: worker.worker_id,
      workerType: worker.worker_type,
      currentJobKey: worker.current_job_key,
      lastError: worker.last_error,
      lastSeenAt: new Date(worker.last_seen_at).toISOString(),
    }));
  }
}