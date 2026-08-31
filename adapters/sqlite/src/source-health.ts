import type { Database } from "bun:sqlite";
import {
  applySourceHealthDisable,
  applySourceHealthUpdate,
  type SourceHealthRecord,
  type SourceHealthStatus,
  type SourceHealthStore,
} from "@gameintel/contracts";
import { isoNow } from "./database.ts";

type HealthRow = {
  source_id: string;
  status: string;
  checked_at: string;
  message: string | null;
  consecutive_failures: number;
  disabled_at: string | null;
  disabled_reason: string | null;
};

function rowToRecord(row: HealthRow): SourceHealthRecord {
  return {
    sourceId: row.source_id,
    status: row.status as SourceHealthStatus,
    checkedAt: row.checked_at,
    message: row.message,
    consecutiveFailures: row.consecutive_failures,
    disabledAt: row.disabled_at,
    disabledReason: row.disabled_reason,
  };
}

// SQLite source health store: upsert by source_id with the same auto-disable
// and kill-switch semantics as the PostgreSQL reference adapter.
export class SQLiteSourceHealthStore implements SourceHealthStore {
  constructor(private readonly db: Database) {}

  private getRecord(sourceId: string): SourceHealthRecord | null {
    const row = this.db.query(
      "SELECT source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason FROM source_health WHERE source_id = ?",
    ).get(sourceId) as HealthRow | null;
    return row ? rowToRecord(row) : null;
  }

  private upsert(record: SourceHealthRecord): void {
    this.db.query(
      `INSERT INTO source_health (source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_id) DO UPDATE SET
         status = excluded.status,
         checked_at = excluded.checked_at,
         message = excluded.message,
         consecutive_failures = excluded.consecutive_failures,
         disabled_at = excluded.disabled_at,
         disabled_reason = excluded.disabled_reason`,
    ).run(record.sourceId, record.status, record.checkedAt, record.message, record.consecutiveFailures, record.disabledAt, record.disabledReason);
  }

  async recordSourceHealth(input: { sourceId: string; status: SourceHealthStatus; checkedAt: string; message?: string | null }): Promise<SourceHealthRecord> {
    const record = applySourceHealthUpdate(this.getRecord(input.sourceId), input);
    this.upsert(record);
    return record;
  }

  async getSourceHealth(sourceId: string): Promise<SourceHealthRecord | null> {
    return this.getRecord(sourceId);
  }

  async listSourceHealth(): Promise<SourceHealthRecord[]> {
    const rows = this.db.query(
      "SELECT source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason FROM source_health",
    ).all() as HealthRow[];
    return rows.map(rowToRecord);
  }

  async setSourceDisabled(sourceId: string, disabled: boolean, reason: string, actor: string): Promise<SourceHealthRecord> {
    const previous = this.getRecord(sourceId);
    const record = applySourceHealthDisable(sourceId, previous, disabled, reason, isoNow());
    this.upsert(record);
    return record;
  }
}
