import { describe, expect, test } from "bun:test";
import { applySourceHealthUpdate, SOURCE_HEALTH_DISABLE_AFTER_FAILURES } from "./index.ts";

const at = (checkedAt: string) => ({ sourceId: "source-a", checkedAt });

function down(previous: ReturnType<typeof applySourceHealthUpdate> | null, checkedAt: string, message?: string) {
  return applySourceHealthUpdate(previous, { ...at(checkedAt), status: "down", message });
}

function ok(previous: ReturnType<typeof applySourceHealthUpdate> | null, checkedAt: string) {
  return applySourceHealthUpdate(previous, { ...at(checkedAt), status: "ok" });
}

describe("source health", () => {
  test("keeps the failure counter at zero across healthy checks", () => {
    const first = ok(null, "2026-08-27T00:00:00.000Z");
    expect(first.consecutiveFailures).toBe(0);
    expect(first.disabledAt).toBeNull();
    const second = ok(first, "2026-08-27T00:00:01.000Z");
    expect(second.consecutiveFailures).toBe(0);
    expect(second.disabledAt).toBeNull();
    expect(second.status).toBe("ok");
  });

  test("auto-disables after three consecutive failures", () => {
    const first = down(null, "2026-08-27T00:00:00.000Z");
    expect(first.consecutiveFailures).toBe(1);
    expect(first.disabledAt).toBeNull();

    const second = down(first, "2026-08-27T00:00:01.000Z");
    expect(second.consecutiveFailures).toBe(2);
    expect(second.disabledAt).toBeNull();

    const third = down(second, "2026-08-27T00:00:02.000Z");
    expect(third.consecutiveFailures).toBe(3);
    expect(third.disabledAt).toBe("2026-08-27T00:00:02.000Z");
    expect(third.disabledReason).toBe(`automatically disabled after ${SOURCE_HEALTH_DISABLE_AFTER_FAILURES} consecutive failures`);
  });

  test("a healthy check does not clear an existing auto-disable", () => {
    const disabled = down(down(down(null, "t1"), "t2"), "t3");
    const recovered = ok(disabled, "t4");
    expect(recovered.status).toBe("ok");
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.disabledAt).toBe("t3");
    expect(recovered.disabledReason).toBe(`automatically disabled after ${SOURCE_HEALTH_DISABLE_AFTER_FAILURES} consecutive failures`);
  });

  test("a later failure keeps an existing disable and its reason", () => {
    const disabled = down(down(down(null, "t1"), "t2"), "t3");
    const laterFailure = down(disabled, "t4");
    expect(laterFailure.consecutiveFailures).toBe(4);
    expect(laterFailure.disabledAt).toBe("t3");
    expect(laterFailure.disabledReason).toBe(`automatically disabled after ${SOURCE_HEALTH_DISABLE_AFTER_FAILURES} consecutive failures`);
  });

  test("message defaults to null", () => {
    expect(down(null, "t1").message).toBeNull();
    expect(down(null, "t1", "fetch failed").message).toBe("fetch failed");
  });
});
