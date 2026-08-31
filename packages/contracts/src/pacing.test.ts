import { describe, expect, test } from "bun:test";
import { computeFetchSlot } from "./index.ts";

describe("computeFetchSlot", () => {
  test("first request for a source executes immediately", () => {
    expect(computeFetchSlot(1000, 1000, 60)).toEqual({ nextAllowedAtMs: 2000, waitMs: 0 });
  });

  test("immediate second request waits exactly one interval", () => {
    expect(computeFetchSlot(1000, 2000, 60)).toEqual({ nextAllowedAtMs: 3000, waitMs: 1000 });
  });

  test("idle source resumes immediately", () => {
    expect(computeFetchSlot(5000, 2000, 60)).toEqual({ nextAllowedAtMs: 6000, waitMs: 0 });
  });

  test("rejects a non-positive request rate", () => {
    const message = "Source fetch pacing requires a positive request rate";
    expect(() => computeFetchSlot(1000, 1000, 0)).toThrow(message);
    expect(() => computeFetchSlot(1000, 1000, -1)).toThrow(message);
    expect(() => computeFetchSlot(1000, 1000, NaN)).toThrow(message);
  });
});
