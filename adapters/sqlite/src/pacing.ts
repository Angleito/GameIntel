import { assertPacingSourceId, computeFetchSlot, type SourcePacingStore } from "@gameintel/contracts";
import type { Database } from "bun:sqlite";

// SQLite pacing store: serialized on the single connection, with the same
// next_allowed_at semantics as the PostgreSQL reference adapter.
export class SQLitePacingStore implements SourcePacingStore {
  constructor(private readonly db: Database) {}

  async acquireFetchSlot(sourceId: string, requestsPerMinute: number): Promise<number> {
    assertPacingSourceId(sourceId);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(
        "INSERT INTO source_fetch_pacing (source_id, next_allowed_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (source_id) DO NOTHING",
      ).run(sourceId, now, now);
      const row = this.db.query("SELECT next_allowed_at FROM source_fetch_pacing WHERE source_id = ?").get(sourceId) as { next_allowed_at: number };
      const { scheduledAtMs, waitMs } = computeFetchSlot(now, row.next_allowed_at, requestsPerMinute);
      this.db.query(
        "UPDATE source_fetch_pacing SET next_allowed_at = ?, updated_at = ? WHERE source_id = ?",
      ).run(scheduledAtMs, now, sourceId);
      this.db.exec("COMMIT");
      return waitMs;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}