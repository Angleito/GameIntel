import { describe, expect, mock, test } from "bun:test";
import type { ControlledFetchTransport, DnsResolver, FetchPolicy, RegisteredSource } from "@gameintel/contracts";
import { testPolicy } from "./fixtures.ts";

export type FetchTransportFactory = (options?: { resolver?: DnsResolver }) => { transport: ControlledFetchTransport };

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

function source(id = "contract-source", domains = ["contract.example.com"], enabled = true): RegisteredSource {
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

function htmlResponse(html = "<article><p>Readable source text.</p></article>", headers: Record<string, string> = { "content-type": "text/html" }): Response {
  return new Response(html, { headers });
}

function resolver(records: Array<{ address: string; family: number }>): DnsResolver {
  return async () => records;
}

// Behavioral contract every controlled fetch transport must satisfy:
// allowlists, redirect revalidation, private-IP denial, DNS behavior, and
// size/type/time limits.
export function runFetchTransportContract(factory: FetchTransportFactory): void {
  describe("controlled fetch transport contract", () => {
    test("fetches a permitted public page through the configured proxy", async () => {
      const transport = factory().transport;
      const requests: string[] = [];
      const result = await withFetchStub(async (input) => {
        requests.push(String(input));
        return htmlResponse();
      }, () => transport.fetch("https://contract.example.com/report", policy()));
      expect(result.status).toBe(200);
      expect(result.contentType).toBe("text/html");
      expect(result.text).toContain("Readable source text");
      expect(requests).toEqual(["https://contract.example.com/report"]);
    });

    test("rejects URLs outside the registered source domains", async () => {
      const transport = factory().transport;
      await expect(transport.fetch("https://evil.example.net/phish", policy())).rejects.toThrow("not registered");
    });

    test("rejects credentialed URLs and non-standard ports", async () => {
      const transport = factory().transport;
      await expect(transport.fetch("https://user:pass@contract.example.com/report", policy())).rejects.toThrow("Credentialed");
      await expect(transport.fetch("https://contract.example.com:8443/report", policy())).rejects.toThrow("Non-standard ports");
    });

    test("rejects requests from disabled sources and manual policies", async () => {
      const transport = factory().transport;
      await expect(transport.fetch("https://contract.example.com/report", policy({ source: source("contract-source", ["contract.example.com"], false) })))
        .rejects.toThrow("disabled");
      await expect(transport.fetch("https://contract.example.com/report", policy({ sourcePolicy: { ...testPolicy(), accessMode: "manual" } })))
        .rejects.toThrow("does not permit network fetching");
    });

    test("revalidates redirects and rejects off-domain or excessive hops", async () => {
      const transport = factory().transport;
      let calls = 0;
      await expect(withFetchStub(async (input) => {
        calls += 1;
        if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://evil.example.net/phish" } });
        return htmlResponse();
      }, () => transport.fetch("https://contract.example.com/report", policy()))).rejects.toThrow("not registered");

      calls = 0;
      await expect(withFetchStub(async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: `https://contract.example.com/loop/${calls}` } });
      }, () => transport.fetch("https://contract.example.com/report", policy({ maxRedirects: 3 })))).rejects.toThrow("Too many redirects");
    });

    test("denies private, loopback, and link-local destinations", async () => {
      const cases: Array<{ address: string; family: number }>[] = [
        [{ address: "10.0.0.5", family: 4 }],
        [{ address: "127.0.0.1", family: 4 }],
        [{ address: "169.254.169.254", family: 4 }],
        [{ address: "::1", family: 6 }],
        [{ address: "fd00::1", family: 6 }],
        [],
      ];
      for (const records of cases) {
        const transport = factory({ resolver: resolver(records) }).transport;
        await expect(withFetchStub(async () => htmlResponse(), () => transport.fetch("https://contract.example.com/report", policy())))
          .rejects.toThrow("Private or link-local");
      }
    });

    test("rejects unsupported content types and oversized responses", async () => {
      const transport = factory().transport;
      await expect(withFetchStub(async () => htmlResponse("<p>html</p>", { "content-type": "application/pdf" }), () => transport.fetch("https://contract.example.com/report", policy())))
        .rejects.toThrow("Unsupported source content type");
      await expect(withFetchStub(async () => new Response(htmlResponse().body, { headers: { "content-type": "text/html", "content-length": "999999999" } }), () => transport.fetch("https://contract.example.com/report", policy({ maxBytes: 100 }))))
        .rejects.toThrow("exceeds size limit");
      await expect(withFetchStub(async () => htmlResponse("x".repeat(5_000)), () => transport.fetch("https://contract.example.com/report", policy({ maxBytes: 100 }))))
        .rejects.toThrow("exceeds size limit");
    });

    test("fails non-2xx statuses", async () => {
      const transport = factory().transport;
      await expect(withFetchStub(async () => new Response("Not found", { status: 404, headers: { "content-type": "text/html" } }), () => transport.fetch("https://contract.example.com/report", policy())))
        .rejects.toThrow("HTTP 404");
    });

    test("returns a fetched resource shape", async () => {
      const transport = factory().transport;
      const result = await withFetchStub(async () => htmlResponse(), () => transport.fetch("https://contract.example.com/report", policy()));
      expect(result.url).toBe("https://contract.example.com/report");
      expect(result.contentType).toBe("text/html");
      expect(result.status).toBe(200);
      expect(typeof result.text).toBe("string");
    });
  });
}