import { describe, expect, test } from "bun:test";
import { assertR2Endpoint } from "./publish-gta-vi-media.ts";

describe("R2 publishing boundaries", () => {
  const accountId = "0123456789abcdef0123456789abcdef";

  test("accepts only the account's canonical HTTPS R2 endpoint", () => {
    expect(assertR2Endpoint(accountId).hostname).toBe(`${accountId}.r2.cloudflarestorage.com`);
    expect(() => assertR2Endpoint(accountId, "http://evil.example")).toThrow("R2_ENDPOINT");
    expect(() => assertR2Endpoint(accountId, "https://user:password@evil.example")).toThrow("R2_ENDPOINT");
    expect(() => assertR2Endpoint(accountId, "https://evil.example")).toThrow("R2_ENDPOINT");
  });
});
