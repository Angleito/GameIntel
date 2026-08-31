import { describe, expect, test } from "bun:test";
import { LocalAbuseProtection } from "./identity.ts";

describe("LocalAbuseProtection", () => {
  const proxyToken = "p".repeat(32);

  test("requires an authenticated ingress before trusting forwarded client identity", () => {
    const protection = new LocalAbuseProtection({
      secret: "s".repeat(32),
      trustProxy: true,
      trustedProxyToken: proxyToken,
    });

    expect(protection.isTrustedSubmissionProxy(proxyToken)).toBe(true);
    expect(protection.isTrustedSubmissionProxy("incorrect")).toBe(false);
    expect(protection.isTrustedSubmissionProxy(null)).toBe(false);
  });

  test("does not trust proxy headers without a configured ingress secret", () => {
    const protection = new LocalAbuseProtection({ secret: "s".repeat(32), trustProxy: true });
    expect(protection.isTrustedSubmissionProxy(proxyToken)).toBe(false);
  });
});
