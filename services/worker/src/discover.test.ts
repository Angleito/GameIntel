import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionLeaseLostError, type GameIntelRuntime, type IngestionJob } from "@gameintel/contracts";
import { processDiscoveryJob } from "./discover.ts";

const FEED_XML = `<rss version="2.0"><channel><title>Contract Feed</title>
  <item><guid>item-1</guid><title>First item</title><link>https://contract.example.com/a</link></item>
  <item><guid>item-2</guid><title>Second item</title><link>https://contract.example.com/b</link></item>
</channel></rss>`;

function fakeJob(feedUrl: string): IngestionJob {
  return {
    jobKey: "discover-job",
    jobType: "source_discover",
    status: "running",
    payload: { collectionId: "contract-test", sourceId: "contract-feed", feedUrl, profileId: undefined },
    attempts: 1,
    maxAttempts: 5,
    leaseToken: "lease-token",
    leaseExpiresAt: null,
    lastError: null,
    result: null,
  };
}

function fakeRuntime(options: {
  feedText?: string;
  leaseHeld?: boolean;
  pacingMs?: number;
} = {}): GameIntelRuntime & { enqueuedUrls: string[] } {
  const enqueuedUrls: string[] = [];
  const leaseHeld = options.leaseHeld ?? true;
  const runtime = {
    enqueuedUrls,
    persistence: {
      ensureSource: async () => undefined,
      assertIngestionJobLeaseHeld: async () => {
        if (!leaseHeld) throw new IngestionLeaseLostError("discover-job");
      },
    },
    pacing: {
      acquireFetchSlot: async () => options.pacingMs ?? 0,
    },
    fetchTransport: {
      fetch: async (url: string) => ({
        url,
        status: 200,
        contentType: "application/rss+xml",
        text: options.feedText ?? FEED_XML,
      }),
    },
    jobQueue: {
      enqueueSourceIngestJob: async (input: { url: string }) => {
        enqueuedUrls.push(input.url);
        return { jobKey: `job-${enqueuedUrls.length}`, dedupeKey: `dedupe-${input.url}`, duplicate: false, status: "queued" };
      },
    },
  } as unknown as GameIntelRuntime & { enqueuedUrls: string[] };
  return runtime;
}

describe("discovery job execution in the isolated worker", () => {
  let directory: string;
  let registryPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gameintel-discover-"));
    registryPath = join(directory, "source-registry.yaml");
    await writeFile(registryPath, `
sources:
  - id: contract-feed
    domains: [contract.example.com]
    access: rss
    rpm: 60
    poll_interval_seconds: 60
    poll_url: https://contract.example.com/feed.xml
    discovery:
      adapter: rss
      enabled: true
    source_strength: TRUSTED_SECONDARY
    publication_mode: normal
    enabled: true
`);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  test("fetches the feed and enqueues each item as its own ingestion job", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime();
    const result = await processDiscoveryJob(
      runtime,
      fakeJob("https://contract.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    );
    expect(result).toEqual({ feedUrl: "https://contract.example.com/feed.xml", discovered: 2, enqueued: 2, duplicate: 0 });
    expect(runtime.enqueuedUrls).toEqual(["https://contract.example.com/a", "https://contract.example.com/b"]);
  });

  test("rejects a feed URL that does not match the registered poll_url", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime();
    await expect(processDiscoveryJob(
      runtime,
      fakeJob("https://evil.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    )).rejects.toThrow("does not match the registered poll_url");
  });

  test("rejects when the lease is lost mid-processing", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime({ leaseHeld: false });
    await expect(processDiscoveryJob(
      runtime,
      fakeJob("https://contract.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    )).rejects.toThrow(IngestionLeaseLostError);
  });

  test("rejects execution outside the isolated worker", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "false";
    const runtime = fakeRuntime();
    await expect(processDiscoveryJob(
      runtime,
      fakeJob("https://contract.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    )).rejects.toThrow("restricted to the isolated ingestion worker");
  });

  test("rejects unknown or non-discovery sources", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime();
    const unknown = { ...fakeJob("https://contract.example.com/feed.xml"), payload: { collectionId: "contract-test", sourceId: "missing", feedUrl: "https://contract.example.com/feed.xml" } };
    await expect(processDiscoveryJob(runtime, unknown, { jobKey: "discover-job", leaseToken: "lease-token" }, { registryPath })).rejects.toThrow("not registered");
  });
});