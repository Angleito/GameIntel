import { describe, expect, test } from "bun:test";
import type { Clock } from "@gameintel/contracts";
import { InMemoryPacingStore } from "./pacing.ts";

function storeAt(initialNow: number): { store: InMemoryPacingStore; advanceTo(now: number): void } {
  let now = initialNow;
  const clock: Clock = { now: () => now, nowIso: () => new Date(now).toISOString() };
  return { store: new InMemoryPacingStore(clock), advanceTo: (value) => { now = value; } };
}

describe("InMemoryPacingStore", () => {
  test("first request for a source executes immediately", async () => {
    const { store } = storeAt(1000);
    expect(await store.acquireFetchSlot("source-a", 60)).toBe(0);
  });

  test("immediate second request waits exactly one interval", async () => {
    const { store } = storeAt(1000);
    await store.acquireFetchSlot("source-a", 60);
    expect(await store.acquireFetchSlot("source-a", 60)).toBe(1000);
  });

  test("idle source resumes immediately", async () => {
    const { store, advanceTo } = storeAt(1000);
    await store.acquireFetchSlot("source-a", 60);
    advanceTo(5000);
    expect(await store.acquireFetchSlot("source-a", 60)).toBe(0);
  });

  test("pacing state is per source", async () => {
    const { store } = storeAt(1000);
    await store.acquireFetchSlot("source-a", 60);
    expect(await store.acquireFetchSlot("source-b", 60)).toBe(0);
  });
});
