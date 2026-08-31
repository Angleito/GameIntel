import {
  applySourceHealthUpdate,
  type Clock,
  type SourceHealthRecord,
  type SourceHealthStatus,
  type SourceHealthStore,
} from "@gameintel/contracts";

// In-memory source health store: per-source record map with the same upsert
// and kill-switch semantics as the reference adapters. Timestamps come from
// the runtime clock so fake-clock tests stay deterministic.
export class InMemorySourceHealthStore implements SourceHealthStore {
  private readonly records = new Map<string, SourceHealthRecord>();

  constructor(private readonly clock: Clock) {}

  async recordSourceHealth(input: { sourceId: string; status: SourceHealthStatus; checkedAt: string; message?: string | null }): Promise<SourceHealthRecord> {
    const record = applySourceHealthUpdate(this.records.get(input.sourceId) ?? null, input);
    this.records.set(input.sourceId, record);
    return record;
  }

  async getSourceHealth(sourceId: string): Promise<SourceHealthRecord | null> {
    return this.records.get(sourceId) ?? null;
  }

  async listSourceHealth(): Promise<SourceHealthRecord[]> {
    return [...this.records.values()];
  }

  async setSourceDisabled(sourceId: string, disabled: boolean, reason: string, actor: string): Promise<SourceHealthRecord> {
    const previous = this.records.get(sourceId) ?? null;
    const now = this.clock.nowIso();
    const record: SourceHealthRecord = disabled
      ? {
          sourceId,
          status: previous?.status ?? "ok",
          checkedAt: previous?.checkedAt ?? now,
          message: previous?.message ?? null,
          consecutiveFailures: previous?.consecutiveFailures ?? 0,
          disabledAt: now,
          disabledReason: reason,
        }
      : {
          sourceId,
          status: "ok",
          checkedAt: previous?.checkedAt ?? now,
          message: previous?.message ?? null,
          consecutiveFailures: 0,
          disabledAt: null,
          disabledReason: null,
        };
    this.records.set(sourceId, record);
    return record;
  }
}
