import { describe, expect, test } from "bun:test";
import type { SourceHealthStore } from "@gameintel/contracts";

export type SourceHealthFactory = () => Promise<{
  store: SourceHealthStore;
  close?: () => Promise<void>;
}>;

// Behavioral contract every source health store must satisfy: upsert by
// source id, auto-disable after three consecutive failures, an operator
// kill-switch that survives later healthy checks, and an enable round-trip.
export function runSourceHealthContract(factory: SourceHealthFactory): void {
  describe("source health contract", () => {
    test("records healthy and failing checks with the persisted fields", async () => {
      const { store, close } = await factory();
      try {
        const ok = await store.recordSourceHealth({ sourceId: "source-a", status: "ok", checkedAt: "2026-08-27T00:00:00.000Z" });
        expect(ok).toEqual({
          sourceId: "source-a",
          status: "ok",
          checkedAt: "2026-08-27T00:00:00.000Z",
          message: null,
          consecutiveFailures: 0,
          disabledAt: null,
          disabledReason: null,
        });
        const down = await store.recordSourceHealth({
          sourceId: "source-a",
          status: "down",
          checkedAt: "2026-08-27T00:00:01.000Z",
          message: "fetch failed",
        });
        expect(down.consecutiveFailures).toBe(1);
        expect(down.status).toBe("down");
        expect(down.message).toBe("fetch failed");
        expect(await store.getSourceHealth("source-a")).toEqual(down);
      } finally {
        await close?.();
      }
    });

    test("auto-disables after three consecutive failures", async () => {
      const { store, close } = await factory();
      try {
        await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:01.000Z" });
        await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:02.000Z" });
        const third = await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:03.000Z" });
        expect(third.consecutiveFailures).toBe(3);
        expect(third.disabledAt).toBe("2026-08-27T00:00:03.000Z");
        expect(third.disabledReason).toBe("automatically disabled after 3 consecutive failures");
      } finally {
        await close?.();
      }
    });

    test("a healthy check after auto-disable keeps the disable in place", async () => {
      const { store, close } = await factory();
      try {
        await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:01.000Z" });
        await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:02.000Z" });
        await store.recordSourceHealth({ sourceId: "source-a", status: "down", checkedAt: "2026-08-27T00:00:03.000Z" });
        const recovered = await store.recordSourceHealth({ sourceId: "source-a", status: "ok", checkedAt: "2026-08-27T00:00:04.000Z" });
        expect(recovered.status).toBe("ok");
        expect(recovered.consecutiveFailures).toBe(0);
        expect(recovered.disabledAt).not.toBeNull();
        expect(recovered.disabledReason).toBe("automatically disabled after 3 consecutive failures");
      } finally {
        await close?.();
      }
    });

    test("the operator kill switch disables immediately and enable clears the state", async () => {
      const { store, close } = await factory();
      try {
        await store.recordSourceHealth({ sourceId: "source-a", status: "ok", checkedAt: "2026-08-27T00:00:00.000Z" });
        const disabled = await store.setSourceDisabled("source-a", true, "maintenance window", "operator-1");
        expect(disabled.disabledAt).not.toBeNull();
        expect(disabled.disabledReason).toBe("maintenance window");
        expect(disabled.consecutiveFailures).toBe(0);

        const enabled = await store.setSourceDisabled("source-a", false, "maintenance complete", "operator-1");
        expect(enabled.disabledAt).toBeNull();
        expect(enabled.disabledReason).toBeNull();
        expect(enabled.consecutiveFailures).toBe(0);
        expect(enabled.status).toBe("ok");
        expect(await store.getSourceHealth("source-a")).toEqual(enabled);
      } finally {
        await close?.();
      }
    });

    test("returns null for unknown sources and lists every record", async () => {
      const { store, close } = await factory();
      try {
        expect(await store.getSourceHealth("missing")).toBeNull();
        await store.recordSourceHealth({ sourceId: "source-a", status: "ok", checkedAt: "2026-08-27T00:00:00.000Z" });
        await store.recordSourceHealth({ sourceId: "source-b", status: "down", checkedAt: "2026-08-27T00:00:01.000Z" });
        const records = await store.listSourceHealth();
        expect(records.map((record) => record.sourceId).sort()).toEqual(["source-a", "source-b"]);
      } finally {
        await close?.();
      }
    });
  });
}
