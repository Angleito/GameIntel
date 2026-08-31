import { describe, expect, test } from "bun:test";
import { closeDb, createDb } from "./index.ts";
import { PostgresSourceHealthStore } from "./source-health.ts";

// Conformance for the atomic source-health updates: concurrent workers must
// serialize on the row lock without losing increments, and stale observations
// must never overwrite fresher state. Requires a migrated database
// (GAMEINTEL_TEST_POSTGRES=true); skipped by default so `bun test` runs
// without Docker or a database.

describe("PostgreSQL source health atomicity", () => {
  const enabled = process.env.GAMEINTEL_TEST_POSTGRES === "true";

  if (!enabled) {
    test("skipped; set GAMEINTEL_TEST_POSTGRES=true to run against the reference PostgreSQL deployment", () => {});
    return;
  }

  test("concurrent health updates serialize without losing increments", async () => {
    const db = createDb();
    const store = new PostgresSourceHealthStore(db);
    try {
      const sourceId = "contract-health";
      // Identical checkedAt: the stale-observation guard must not interfere
      // with the unordered pair — each observation is a distinct check.
      await Promise.all([
        store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:00.000Z" }),
        store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:00.000Z" }),
      ]);
      const record = await store.getSourceHealth(sourceId);
      expect(record?.consecutiveFailures).toBe(2);
      expect(record?.disabledAt).toBeNull();
    } finally {
      await db`DELETE FROM source_health WHERE source_id = 'contract-health'`;
      await closeDb(db);
    }
  });

  test("auto-disable completes at three failures", async () => {
    const db = createDb();
    const store = new PostgresSourceHealthStore(db);
    try {
      const sourceId = "contract-health";
      await Promise.all([
        store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:00.000Z" }),
        store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:00.000Z" }),
      ]);
      const third = await store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:01.000Z" });
      expect(third.consecutiveFailures).toBe(3);
      expect(third.disabledAt).toBe("2026-08-27T00:00:01.000Z");
      expect(third.disabledReason).toBe("automatically disabled after 3 consecutive failures");
    } finally {
      await db`DELETE FROM source_health WHERE source_id = 'contract-health'`;
      await closeDb(db);
    }
  });

  test("stale observations are ignored", async () => {
    const db = createDb();
    const store = new PostgresSourceHealthStore(db);
    try {
      const sourceId = "contract-health";
      await store.recordSourceHealth({ sourceId, status: "ok", checkedAt: "2026-08-27T00:00:02.000Z" });
      const stale = await store.recordSourceHealth({ sourceId, status: "down", checkedAt: "2026-08-27T00:00:01.000Z" });
      expect(stale.status).toBe("ok");
      expect(stale.checkedAt).toBe("2026-08-27T00:00:02.000Z");
      expect(stale.consecutiveFailures).toBe(0);
      expect(await store.getSourceHealth(sourceId)).toEqual(stale);
    } finally {
      await db`DELETE FROM source_health WHERE source_id = 'contract-health'`;
      await closeDb(db);
    }
  });
});
