import { describe, expect, test } from "bun:test";
import type { Clock, IngestionJob, SourceHealthRecord, SourceHealthStore } from "@gameintel/contracts";
import { SourceFetchError } from "@gameintel/controlled-fetch";
import { recordJobHealth } from "./job-health.ts";

const FIXED_NOW = "2026-08-27T12:00:00.000Z";

const fakeClock: Clock = { nowIso: () => FIXED_NOW, now: () => Date.parse(FIXED_NOW) };

class FakeSourceHealthStore implements SourceHealthStore {
  records: Array<{ sourceId: string; status: "ok" | "down"; checkedAt: string; message: string | null }> = [];

  async recordSourceHealth(input: { sourceId: string; status: "ok" | "down"; checkedAt: string; message?: string | null }): Promise<SourceHealthRecord> {
    this.records.push({ sourceId: input.sourceId, status: input.status, checkedAt: input.checkedAt, message: input.message ?? null });
    return {
      sourceId: input.sourceId,
      status: input.status,
      checkedAt: input.checkedAt,
      message: input.message ?? null,
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
    };
  }

  async getSourceHealth(): Promise<SourceHealthRecord | null> {
    return null;
  }

  async listSourceHealth(): Promise<SourceHealthRecord[]> {
    return [];
  }
  async setSourceDisabled(): Promise<SourceHealthRecord> {
    throw new Error("not used by recordJobHealth");
  }
}

function job(attempts: number): IngestionJob {
  return {
    jobKey: "ingest-job",
    jobType: "source_ingest",
    status: "running",
    payload: { collectionId: "contract-test", sourceId: "contract-source", url: "https://contract.example.com/report", profileId: undefined },
    attempts,
    maxAttempts: 5,
    leaseToken: "lease-token",
    leaseExpiresAt: null,
    lastError: null,
    result: null,
  };
}

describe("recordJobHealth", () => {
  test("records ok on success regardless of attempt count", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({ sourceHealth: store, clock: fakeClock, sourceId: "contract-source", job: job(3) });
    expect(store.records).toEqual([{ sourceId: "contract-source", status: "ok", checkedAt: FIXED_NOW, message: null }]);
  });

  test("records down on the first execution of a source-unavailable failure", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({
      sourceHealth: store,
      clock: fakeClock,
      sourceId: "contract-source",
      job: job(1),
      error: new SourceFetchError("source_unavailable", "Source fetch failed with HTTP 503", { status: 503 }),
    });
    expect(store.records).toEqual([{ sourceId: "contract-source", status: "down", checkedAt: FIXED_NOW, message: "Source fetch failed with HTTP 503" }]);
  });

  test("does not record down on retried attempts of the same job", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({
      sourceHealth: store,
      clock: fakeClock,
      sourceId: "contract-source",
      job: job(2),
      error: new SourceFetchError("source_unavailable", "Source fetch failed with HTTP 503", { status: 503 }),
    });
    expect(store.records).toEqual([]);
  });
  test("never records proxy/transport failures", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({ sourceHealth: store, clock: fakeClock, sourceId: "contract-source", job: job(1), error: new SourceFetchError("transport_unavailable", "Source fetch failed: fetch failed") });
    expect(store.records).toEqual([]);
  });

  test("never records application failures", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({ sourceHealth: store, clock: fakeClock, sourceId: "contract-source", job: job(1), error: new Error("persistence exploded") });
    expect(store.records).toEqual([]);
  });

  test("never records url_not_found failures", async () => {
    const store = new FakeSourceHealthStore();
    await recordJobHealth({
      sourceHealth: store,
      clock: fakeClock,
      sourceId: "contract-source",
      job: job(1),
      error: new SourceFetchError("url_not_found", "Source fetch failed with HTTP 404", { status: 404 }),
    });
    expect(store.records).toEqual([]);
  });
});
