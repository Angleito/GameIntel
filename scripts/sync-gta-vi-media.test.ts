import { describe, expect, test } from "bun:test";
import { assertOfficialAssetUrl, assertSafeObjectKey, parseSourceConfig } from "./sync-gta-vi-media.ts";

const config = parseSourceConfig({
  version: "1",
  gameId: "gta-vi",
  collectionId: "gta-vi",
  sourcePageUrl: "https://www.rockstargames.com/VI/media/screenshots",
  expectedMediaCount: 133,
  assetPathPrefix: "/VI/_next/static/media/",
  attribution: "Rockstar Games",
  workingDirectory: "tmp/gta-vi-media",
  catalogPath: "tmp/gta-vi-media/catalog.json",
  originalPrefix: "gta-vi/originals",
  displayPrefix: "gta-vi/display",
  catalogKey: "gta-vi/catalogs/official-screenshots-v1.json",
  requestsPerMinute: 2,
});

describe("media synchronization boundaries", () => {
  test("rejects unsafe object keys and off-origin asset URLs", () => {
    expect(assertSafeObjectKey("gta-vi/display/example.jpg")).toBe("gta-vi/display/example.jpg");
    expect(() => assertSafeObjectKey("gta-vi/../private.jpg")).toThrow("safe lowercase path segments");
    expect(() => assertOfficialAssetUrl("https://evil.example/VI/_next/static/media/image.jpg", config)).toThrow("non-official");
  });
});
