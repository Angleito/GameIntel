import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionLeaseLostError, type GameIntelRuntime, type IngestionJob } from "@gameintel/contracts";
import { processDiscoveryJob } from "./discover.ts";
import { fileURLToPath } from "node:url";
import { parseRssFeed } from "@gameintel/source-sdk";

const FEED_XML = `<rss version="2.0"><channel><title>Contract Feed</title>
  <item><guid>item-1</guid><title>First item</title><link>https://contract.example.com/a</link></item>
  <item><guid>item-2</guid><title>Second item</title><link>https://contract.example.com/b</link></item>
</channel></rss>`;

function feedWithUrls(urls: string[]): string {
  return `<rss version="2.0"><channel><title>Contract Feed</title>${urls.map((url, index) => `
    <item><guid>item-${index}</guid><title>Item ${index}</title><link>${url}</link></item>`).join("")}
  </channel></rss>`;
}

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
    sourceHealth: {
      getSourceHealth: async () => null,
      listSourceHealth: async () => [],
      recordSourceHealth: async (input: { sourceId: string; status: "ok" | "down"; checkedAt: string; message?: string | null }) => ({
        sourceId: input.sourceId,
        status: input.status,
        checkedAt: input.checkedAt,
        message: input.message ?? null,
        consecutiveFailures: 0,
        disabledAt: null,
        disabledReason: null,
      }),
      setSourceDisabled: async () => {
        throw new Error("not implemented");
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

  test("skips invalid, off-domain, and duplicate item URLs before queueing", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime({ feedText: feedWithUrls([
      "https://contract.example.com/a",
      "https://evil.example.com/a",
      "ftp://contract.example.com/a",
      "https://user:password@contract.example.com/a",
      "https://CONTRACT.example.com/a",
      "https://contract.example.com/b",
    ]) });
    const result = await processDiscoveryJob(
      runtime,
      fakeJob("https://contract.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    );
    expect(result).toEqual({ feedUrl: "https://contract.example.com/feed.xml", discovered: 6, enqueued: 2, duplicate: 1 });
    expect(runtime.enqueuedUrls).toEqual(["https://contract.example.com/a", "https://contract.example.com/b"]);
  });

  test("caps queue submissions to 100 unique valid URLs per feed", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const runtime = fakeRuntime({
      feedText: feedWithUrls(Array.from({ length: 101 }, (_, index) => `https://contract.example.com/item-${index}`)),
    });
    const result = await processDiscoveryJob(
      runtime,
      fakeJob("https://contract.example.com/feed.xml"),
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath },
    );
    expect(result).toEqual({ feedUrl: "https://contract.example.com/feed.xml", discovered: 101, enqueued: 100, duplicate: 0 });
    expect(runtime.enqueuedUrls).toHaveLength(100);
    expect(runtime.enqueuedUrls).not.toContain("https://contract.example.com/item-100");
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
  test("parses the official-source RSS fixture", async () => {
    const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/rockstar-official-news-feed.xml", import.meta.url));
    const items = parseRssFeed(await Bun.file(fixturePath).text());
    expect(items.map((item) => item.title)).toEqual([
      "GTA Online: The Chop Shop",
      "GTA Online: The Cluckin' Bell Farm Raid",
      "GTA Online: Bottom Dollar Bounties",
    ]);
  });

  test("discovers items from the official-source RSS fixture through the worker", async () => {
    process.env.GAMEINTEL_FETCH_WORKER = "true";
    const rockstarRegistryPath = join(directory, "rockstar-source-registry.yaml");
    await writeFile(rockstarRegistryPath, `
sources:
  - id: rockstar-official-news-feed
    domains: [rockstargames.com]
    access: rss
    rpm: 60
    poll_interval_seconds: 300
    poll_url: https://www.rockstargames.com/newswire/feed
    discovery:
      adapter: rss
      enabled: true
    source_strength: PRIMARY
    publication_mode: normal
    enabled: true
`);
    const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/rockstar-official-news-feed.xml", import.meta.url));
    const runtime = fakeRuntime({ feedText: await Bun.file(fixturePath).text() });
    const job = {
      ...fakeJob("https://www.rockstargames.com/newswire/feed"),
      payload: { collectionId: "gta-vi", sourceId: "rockstar-official-news-feed", feedUrl: "https://www.rockstargames.com/newswire/feed" },
    };
    const result = await processDiscoveryJob(
      runtime,
      job,
      { jobKey: "discover-job", leaseToken: "lease-token" },
      { registryPath: rockstarRegistryPath },
    );
    expect(result).toEqual({ feedUrl: "https://www.rockstargames.com/newswire/feed", discovered: 3, enqueued: 3, duplicate: 0 });
    expect(runtime.enqueuedUrls).toHaveLength(3);
    for (const url of runtime.enqueuedUrls) expect(url.startsWith("https://www.rockstargames.com/newswire/article/")).toBe(true);
  });
});
