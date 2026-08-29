import { describe, expect, mock, test } from "bun:test";
import { parseArticleHtml } from "./article-parser.ts";
import { createManualSourceItem } from "./manual-adapter.ts";

mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

const { assertRegisteredUrl, assertPublicHost, fetchPermittedUrl, privateIp } = await import("./http-policy.ts");

const tudumSource = (id: string, enabled = true) => ({
  id,
  domains: ["netflix.com"],
  access: "permitted_scrape" as const,
  rpm: 60_000_000,
  enabled,
});

const tudumPolicy = (source = tudumSource("tudum-policy")) => ({
  source,
  proxyUrl: "http://egress-proxy:3128",
  sourcePolicy: {
    accessMode: "permitted_scrape" as const,
    requestsPerMinute: source.rpm,
    retainRawTextDays: 2,
     mayStoreFullText: false,
     attributionRequired: true,
     termsReviewedAt: "2026-08-27",
     evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true },
  },
});

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

function htmlResponse(html = "<article><p>Readable source text.</p></article>"): Response {
  return new Response(html, { headers: { "content-type": "text/html" } });
}

describe("source intake policy", () => {
  test("extracts Tudum article text and removes executable and boilerplate content", () => {
    const article = parseArticleHtml(`
      <!doctype html>
      <html lang="en">
        <head>
          <title>Tudum | Grand Theft Auto VI</title>
          <style>.cookie-banner { display: none }</style>
        </head>
        <body>
          <header><nav>Home Games Sign in</nav></header>
          <div class="cookie-banner">Accept cookies</div>
          <main>
            <article>
              <h1>Grand Theft Auto VI</h1>
              <p>Rockstar Games shared a new detail about the game.</p>
              <p>The update is available today.</p>
            </article>
          </main>
          <aside>Read more celebrity news</aside>
          <footer>Privacy Terms</footer>
          <script>window.alert("ignore this executable content")</script>
          <iframe src="https://evil.example/tracker"></iframe>
        </body>
      </html>
    `);
    expect(article.title).toContain("Grand Theft Auto VI");
    expect(article.text).toContain("Rockstar Games shared a new detail about the game.");
    expect(article.text).not.toContain("ignore this executable content");
    expect(article.text).not.toContain("Accept cookies");
    expect(article.text).not.toContain("Privacy Terms");
    expect(article.language).toBe("en");
  });

  test("accepts Netflix subdomains and rejects off-domain URLs", () => {
    const source = tudumSource("tudum-url");
    expect(assertRegisteredUrl("https://www.netflix.com/tudum/articles/example", source).hostname).toBe("www.netflix.com");
    expect(() => assertRegisteredUrl("https://netflix.com.evil.example/story", source)).toThrow("not registered");
  });

  test("rejects private hosts", async () => {
    const source = { id: "example", domains: ["example.com"], access: "permitted_scrape" as const, rpm: 1, enabled: true };
    expect(() => assertRegisteredUrl("https://not-example.com/story", source)).toThrow("not registered");
    await expect(assertPublicHost("localhost")).rejects.toThrow("Private");
    expect(privateIp("::ffff:127.0.0.1")).toBe(true);
    expect(privateIp("::ffff:7f00:1")).toBe(true);
    expect(privateIp("100.64.0.1")).toBe(true);
  });

  test("does not fetch a disabled source", async () => {
    await withFetchStub(async () => {
      throw new Error("network should not be called");
    }, async () => {
      await expect(fetchPermittedUrl("https://www.netflix.com/tudum/disabled", tudumPolicy(tudumSource("tudum-disabled", false))))
        .rejects.toThrow("Source tudum-disabled is disabled");
    });
  });

  test("requires an explicit egress proxy for enabled sources", async () => {
    const { proxyUrl: _proxyUrl, ...withoutProxy } = tudumPolicy(tudumSource("tudum-no-proxy"));
    await expect(fetchPermittedUrl("https://www.netflix.com/tudum/articles/example", withoutProxy))
      .rejects.toThrow("SOURCE_FETCH_PROXY_URL is required");
  });

  test("accepts same-domain redirects", async () => {
    const source = tudumSource("tudum-same-domain-redirect");
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://www.netflix.com/tudum/articles/redirected" } }),
      htmlResponse(),
    ];
    const fetched = await withFetchStub(async (_input, init) => {
      expect((init as RequestInit & { proxy?: string }).proxy).toBe("http://egress-proxy:3128/");
      return responses.shift()!;
    }, () => fetchPermittedUrl("https://www.netflix.com/tudum/articles/original", tudumPolicy(source)));

    expect(fetched.url).toBe("https://www.netflix.com/tudum/articles/redirected");
    expect(fetched.text).toContain("Readable source text.");
  });

  test("rejects off-domain redirects", async () => {
    const source = tudumSource("tudum-off-domain-redirect");
    await withFetchStub(async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/article" },
    }), async () => {
      await expect(fetchPermittedUrl("https://www.netflix.com/tudum/articles/original", tudumPolicy(source)))
        .rejects.toThrow("not registered");
    });
  });

  test("rejects unsupported content types", async () => {
    const source = tudumSource("tudum-content-type");
    await withFetchStub(async () => new Response('{"error":"not an article"}', {
      headers: { "content-type": "application/json" },
    }), async () => {
      await expect(fetchPermittedUrl("https://www.netflix.com/tudum/articles/json", tudumPolicy(source)))
        .rejects.toThrow("Unsupported source content type: application/json");
    });
  });

  test("rejects streamed responses over the byte limit", async () => {
    const source = tudumSource("tudum-size-limit");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("123456789"));
        controller.close();
      },
    });
    await withFetchStub(async () => new Response(body, { headers: { "content-type": "text/html" } }), async () => {
      await expect(fetchPermittedUrl("https://www.netflix.com/tudum/articles/large", { ...tudumPolicy(source), maxBytes: 8 }))
        .rejects.toThrow("Source response exceeds size limit");
    });
  });

  test("uses a URN for manual material", () => {
    const item = createManualSourceItem({ sourceId: "operator-note", collectionId: "gta-vi", title: "Note", text: "A permitted note.", inputKind: "pasted_text" });
    expect(item.url).toStartWith("urn:gameintelgg:manual:");
    expect(item.inputKind).toBe("pasted_text");
  });
});
