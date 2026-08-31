// The transport contract runner injects DNS resolvers per test; no global
// module mocking is needed. The default resolver is stubbed so the suite runs
// offline.
import { describe, expect, mock, test } from "bun:test";
import { runFetchTransportContract, testPolicy } from "@gameintel/adapter-contract-tests";
import type { DnsResolver, FetchPolicy, RegisteredSource } from "@gameintel/contracts";
import { fetchPermittedUrl, SourceFetchError } from "./http-policy.ts";
import { HttpControlledFetchTransport } from "./transport.ts";

mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

runFetchTransportContract((options) => ({ transport: new HttpControlledFetchTransport(options?.resolver) }));

// Typed source-availability failures: only `source_unavailable` counts against
// source health; 4xx (url_not_found) and malformed responses (`response`)
// never do. Policy errors stay plain `Error`.
type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withFetchStub<T>(handler: FetchStub, callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(handler) as unknown as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function source(id = "kind-source", domains = ["contract.example.com"], enabled = true): RegisteredSource {
  return { id, domains, access: "permitted_scrape", rpm: 60_000_000, userAgent: "gameintelgg/0.1", enabled };
}

function policy(overrides: Partial<FetchPolicy> = {}): FetchPolicy {
  return {
    source: source(),
    sourcePolicy: testPolicy({ requestsPerMinute: 60_000_000 }),
    proxyUrl: "http://egress-proxy:3128",
    ...overrides,
  };
}

const publicResolver: DnsResolver = async () => [{ address: "93.184.216.34", family: 4 }];

async function fetchError(url: string): Promise<unknown> {
  return fetchPermittedUrl(url, policy(), publicResolver).then(
    () => null,
    (caught: unknown) => caught,
  );
}

describe("typed source fetch failures", () => {
  test("classifies 4xx as url_not_found with the HTTP status in the message", async () => {
    await withFetchStub(
      async () => new Response("Not found", { status: 404, headers: { "content-type": "text/html" } }),
      async () => {
        const error = await fetchError("http://contract.example.com/missing");
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).kind).toBe("url_not_found");
        expect((error as Error).message).toContain("HTTP 404");
      },
    );
  });

  test("classifies 5xx as source_unavailable", async () => {
    await withFetchStub(
      async () => new Response("Unavailable", { status: 503, headers: { "content-type": "text/html" } }),
      async () => {
        const error = await fetchError("http://contract.example.com/down");
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).kind).toBe("source_unavailable");
        expect((error as SourceFetchError).status).toBe(503);
      },
    );
  });

  test("classifies proxy/transport fetch rejections as transport_unavailable", async () => {
    await withFetchStub(
      async () => { throw new TypeError("fetch failed"); },
      async () => {
        const error = await fetchError("http://contract.example.com/unreachable");
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).kind).toBe("transport_unavailable");
        expect((error as Error).message).toContain("fetch failed");
        expect((error as SourceFetchError).status).toBeNull();
      },
    );
  });

  test("classifies DNS resolution failures as source_unavailable", async () => {
    const dnsFailure = async () => { throw new Error("getaddrinfo ENOTFOUND contract.example.com"); };
    const error = await fetchPermittedUrl("http://contract.example.com/report", policy(), dnsFailure).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SourceFetchError);
    expect((error as SourceFetchError).kind).toBe("source_unavailable");
    expect((error as Error).message).toContain("DNS");
    expect((error as SourceFetchError).status).toBeNull();
  });

  test("classifies unsupported content types as response failures", async () => {
    await withFetchStub(
      async () => new Response("pdf", { status: 200, headers: { "content-type": "application/pdf" } }),
      async () => {
        const error = await fetchError("http://contract.example.com/doc");
        expect(error).toBeInstanceOf(SourceFetchError);
        expect((error as SourceFetchError).kind).toBe("response");
        expect((error as Error).message).toContain("Unsupported source content type");
      },
    );
  });
});
