import {
  applySourceHealthDisable,
  applySourceHealthUpdate,
  type SourceHealthRecord,
  type SourceHealthStatus,
  type SourceHealthStore,
} from "@gameintel/contracts";
import { inTransaction, type Db } from "./db.ts";

type HealthRow = {
  source_id: string;
  status: string;
  checked_at: Date;
  message: string | null;
  consecutive_failures: number;
  disabled_at: Date | null;
  disabled_reason: string | null;
};

function rowToRecord(row: HealthRow): SourceHealthRecord {
  return {
    sourceId: row.source_id,
    status: row.status as SourceHealthStatus,
    checkedAt: new Date(row.checked_at).toISOString(),
    message: row.message,
    consecutiveFailures: row.consecutive_failures,
    disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
    disabledReason: row.disabled_reason,
  };
}

// PostgreSQL source health store: upsert by source_id with the auto-disable
// policy computed in contracts and enforced by the ingest/discover/scheduler
// kill-switch checks.
export class PostgresSourceHealthStore implements SourceHealthStore {
  constructor(private readonly handle: Db) {}

  private async getRecord(sourceId: string): Promise<SourceHealthRecord | null> {
    const rows = await this.handle`
      SELECT source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason
      FROM source_health
      WHERE source_id = ${sourceId}
      LIMIT 1
    `;
    return rows.length ? rowToRecord(rows[0] as HealthRow) : null;
  }

  private async upsert(record: SourceHealthRecord): Promise<void> {
    await this.handle`
      INSERT INTO source_health (source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason)
      VALUES (${record.sourceId}, ${record.status}, ${record.checkedAt}, ${record.message}, ${record.consecutiveFailures}, ${record.disabledAt}, ${record.disabledReason})
      ON CONFLICT (source_id) DO UPDATE SET
        status = EXCLUDED.status,
        checked_at = EXCLUDED.checked_at,
        message = EXCLUDED.message,
        consecutive_failures = EXCLUDED.consecutive_failures,
        disabled_at = EXCLUDED.disabled_at,
        disabled_reason = EXCLUDED.disabled_reason,
        updated_at = now()
    `;
  }

  async recordSourceHealth(input: { sourceId: string; status: SourceHealthStatus; checkedAt: string; message?: string | null }): Promise<SourceHealthRecord> {
    // One transaction: concurrent workers serialize on the row lock so no
    // increment is lost, and the stale-observation guard in contracts never
    // lets an older check overwrite a newer one.
    return inTransaction(this.handle, async (transaction) => {
      // Serialize concurrent first-creators on the unique primary key; the
      // placeholder values are always overwritten by the UPDATE below.
      await transaction`
        INSERT INTO source_health (source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason)
        VALUES (${input.sourceId}, 'ok', ${input.checkedAt}, NULL, 0, NULL, NULL)
        ON CONFLICT (source_id) DO NOTHING
      `;
      const rows = await transaction`
        SELECT source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason
        FROM source_health
        WHERE source_id = ${input.sourceId}
        FOR UPDATE
      `;
      const previous = rows.length ? rowToRecord(rows[0] as HealthRow) : null;
      const record = applySourceHealthUpdate(previous, input);
      await transaction`
        UPDATE source_health
        SET status = ${record.status}, checked_at = ${record.checkedAt}, message = ${record.message},
          consecutive_failures = ${record.consecutiveFailures}, disabled_at = ${record.disabledAt},
          disabled_reason = ${record.disabledReason}, updated_at = now()
        WHERE source_id = ${record.sourceId}
      `;
      return record;
    });
  }

  async getSourceHealth(sourceId: string): Promise<SourceHealthRecord | null> {
    return this.getRecord(sourceId);
  }

  async listSourceHealth(): Promise<SourceHealthRecord[]> {
    const rows = await this.handle`
      SELECT source_id, status, checked_at, message, consecutive_failures, disabled_at, disabled_reason
      FROM source_health
      ORDER BY source_id
    `;
    return rows.map((row) => rowToRecord(row as HealthRow));
  }

  async setSourceDisabled(sourceId: string, disabled: boolean, reason: string, actor: string): Promise<SourceHealthRecord> {
    const previous = await this.getRecord(sourceId);
    const record = applySourceHealthDisable(sourceId, previous, disabled, reason, new Date().toISOString());
    await this.upsert(record);
    return record;
  }
}
