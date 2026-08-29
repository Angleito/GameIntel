import { describe, expect, test } from "bun:test";
import { RegistryPollingScheduler, schedulerForSources, type Clock, type SchedulableSource } from "./index.ts";

function fakeClock(initial = 0): Clock {
  let now = initial;
  return {
    now: () => now,
    nowIso: () => new Date(now).toISOString(),
    advance: (ms: number) => { now += ms; },
  } as Clock & { advance: (ms: number) => void };
}

const source = (sourceId: string, pollIntervalSeconds: number): SchedulableSource => ({
  sourceId,
  collectionId: "contract-test",
  url: `https://example.com/${sourceId}`,
  profileId: "contract-test",
  pollIntervalSeconds,
});

describe("RegistryPollingScheduler", () => {
  test("returns every configured source on the first tick", async () => {
    const clock = fakeClock(10_000_000);
    const scheduler = new RegistryPollingScheduler([source("a", 60), source("b", 120)], clock);
    const due = await scheduler.dueSources();
    expect(due.map((candidate) => candidate.sourceId).sort()).toEqual(["a", "b"]);
  });

  test("does not return a source again until its interval has elapsed", async () => {
    const clock = fakeClock(10_000_000);
    const scheduler = new RegistryPollingScheduler([source("a", 300)], clock);
    await scheduler.markScheduled("a", clock.now());
    expect(await scheduler.dueSources()).toEqual([]);
    (clock as Clock & { advance: (ms: number) => void }).advance(299_000);
    expect(await scheduler.dueSources()).toEqual([]);
    (clock as Clock & { advance: (ms: number) => void }).advance(1_000);
    expect(await scheduler.dueSources()).toHaveLength(1);
  });

  test("preserves each source's configured poll url", async () => {
    const clock = fakeClock(10_000_000);
    const scheduler = new RegistryPollingScheduler([source("a", 60)], clock);
    const [due] = await scheduler.dueSources();
    expect(due.url).toBe("https://example.com/a");
  });

  test("honors per-source intervals independently", async () => {
    const clock = fakeClock(10_000_000);
    const scheduler = new RegistryPollingScheduler([source("fast", 10), source("slow", 600)], clock);
    await scheduler.markScheduled("fast", clock.now());
    await scheduler.markScheduled("slow", clock.now());
    (clock as Clock & { advance: (ms: number) => void }).advance(10_000);
    const due = await scheduler.dueSources();
    expect(due.map((candidate) => candidate.sourceId)).toEqual(["fast"]);
  });
});
describe("schedulerForSources", () => {
  test("returns null when the scheduler is not configured", () => {
    expect(schedulerForSources(undefined, fakeClock())).toBeNull();
  });

  test("returns a live idle scheduler for an explicit empty source set", async () => {
    const scheduler = schedulerForSources([], fakeClock());
    expect(scheduler).not.toBeNull();
    expect(await scheduler!.dueSources()).toEqual([]);
    await scheduler!.markScheduled("anything", 0);
  });

  test("returns a scheduler that reports configured sources as due", async () => {
    const clock = fakeClock(10_000_000);
    const scheduler = schedulerForSources([source("a", 60)], clock)!;
    const due = await scheduler.dueSources();
    expect(due.map((candidate) => candidate.sourceId)).toEqual(["a"]);
    expect(scheduler).toBeInstanceOf(RegistryPollingScheduler);
  });
});
