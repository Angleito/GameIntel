import { describe, expect, test } from "bun:test";
import { SourceRegistrySchema } from "./index.ts";

function networkSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "test-source",
    domains: ["example.com"],
    access: "permitted_scrape",
    rpm: 2,
    source_strength: "TRUSTED_SECONDARY",
    publication_mode: "normal",
    enabled: true,
    ...overrides,
  };
}

describe("source registry scheduling configuration", () => {
  test("accepts a poll_url on a registered domain", () => {
    const result = SourceRegistrySchema.safeParse({
      sources: [networkSource({ poll_interval_seconds: 300, poll_url: "https://www.example.com/news" })],
    });
    expect(result.success).toBe(true);
  });

  test("accepts subdomains of a registered domain", () => {
    const result = SourceRegistrySchema.safeParse({
      sources: [networkSource({ poll_url: "https://news.example.com/feed.xml" })],
    });
    expect(result.success).toBe(true);
  });

  test("rejects a poll_url outside the registered domains", () => {
    const result = SourceRegistrySchema.safeParse({
      sources: [networkSource({ poll_url: "https://evil.example.net/phish" })],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toContain("registered domain");
  });

  test("requires an explicit poll_url when a poll interval is configured", () => {
    const result = SourceRegistrySchema.safeParse({
      sources: [networkSource({ poll_interval_seconds: 300 })],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toContain("explicit poll_url");
  });

  test("rejects poll_url and poll intervals on manual sources", () => {
    const withInterval = SourceRegistrySchema.safeParse({
      sources: [networkSource({ access: "manual", domains: [], rpm: 0, poll_interval_seconds: 300 })],
    });
    expect(withInterval.success).toBe(false);
    const withUrl = SourceRegistrySchema.safeParse({
      sources: [networkSource({ access: "manual", domains: [], rpm: 0, poll_url: "https://example.com/x" })],
    });
    expect(withUrl.success).toBe(false);
  });
});