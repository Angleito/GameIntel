import { describe, expect, test } from "bun:test";
import { createInMemoryRuntime } from "./index.ts";

describe("createInMemoryRuntime scheduler assembly", () => {
  test("leaves the scheduler unset when no sources are configured", () => {
    const runtime = createInMemoryRuntime();
    expect(runtime.scheduler).toBeNull();
  });

  test("assembles a live scheduler for an explicit empty source set", async () => {
    const runtime = createInMemoryRuntime({ schedulerSources: [] });
    expect(runtime.scheduler).not.toBeNull();
    expect(await runtime.scheduler!.dueSources()).toEqual([]);
  });

  test("assembles a scheduler for configured sources", async () => {
    const runtime = createInMemoryRuntime({
      schedulerSources: [{
        sourceId: "contract-source",
        collectionId: "contract-test",
        url: "https://contract.example.com/report",
        pollIntervalSeconds: 60,
      }],
    });
    expect(runtime.scheduler).not.toBeNull();
    expect((await runtime.scheduler!.dueSources()).map((source) => source.sourceId)).toEqual(["contract-source"]);
  });
});