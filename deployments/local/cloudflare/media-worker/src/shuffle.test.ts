import { describe, expect, test } from "bun:test";
import { isSafeR2Key, parseMediaCatalog } from "./catalog";
import { shuffleWithSeed, utcDate } from "./shuffle";

describe("shuffleWithSeed", () => {
  test("is stable for a seed and does not mutate the catalog order", () => {
    const items = ["one", "two", "three", "four", "five"];
    const seed = new Uint8Array(32);
    seed[0] = 1;
    seed[31] = 255;

    expect(shuffleWithSeed(items, seed)).toEqual(shuffleWithSeed(items, seed));
    expect(shuffleWithSeed(items, seed)).not.toEqual(items);
    expect(items).toEqual(["one", "two", "three", "four", "five"]);
  });
});

test("utcDate is independent of the worker's local timezone", () => {
  expect(utcDate(new Date("2025-06-01T00:30:00+02:00"))).toBe("2025-05-31");
});

test("catalog parsing returns only the public slideshow shape", () => {
  const catalog = parseMediaCatalog({
    version: "2025-06-01.1",
    collectionId: "gta-vi",
    generatedAt: "2025-06-01T00:00:00.000Z",
    media: [{
      id: "lucia-01",
      collectionId: "gta-vi",
      collection: "Official screenshots",
      caption: "Lucia in Leonida",
      altText: "A private accessibility description",
      tags: ["character"],
      spoilerTags: ["trailer-two"],
      attribution: "Rockstar Games",
      sourceUrl: "https://www.rockstargames.com/",
      sourcePageUrl: "https://www.rockstargames.com/VI",
      originalKey: "private/original.jpg",
      displayKey: "private/display.webp",
      publicUrl: "https://media.example.com/gta-vi/lucia-01.webp",
      contentType: "image/webp",
      width: 1920,
      height: 1080,
      checksum: "private-checksum",
    }],
  });

  expect(catalog?.media).toEqual([{
    id: "lucia-01",
    url: "https://media.example.com/gta-vi/lucia-01.webp",
    caption: "Lucia in Leonida",
    collection: "Official screenshots",
    attribution: "Rockstar Games",
    sourceUrl: "https://www.rockstargames.com/",
  }]);
});

test("catalog parsing rejects credentialed public URLs and unsafe R2 keys", () => {
  const catalog = parseMediaCatalog({
    version: "2025-06-01.1",
    collectionId: "gta-vi",
    generatedAt: "2025-06-01T00:00:00.000Z",
    media: [{
      id: "lucia-01",
      collectionId: "gta-vi",
      collection: "Official screenshots",
      caption: "Lucia in Leonida",
      altText: "A description",
      tags: ["character"],
      spoilerTags: [],
      attribution: "Rockstar Games",
      sourceUrl: "https://www.rockstargames.com/",
      sourcePageUrl: "https://www.rockstargames.com/VI",
      originalKey: "private/original.jpg",
      displayKey: "private/display.webp",
      publicUrl: "https://user:password@media.example.com/gta-vi/lucia-01.webp",
      contentType: "image/webp",
      width: 1920,
      height: 1080,
      checksum: "private-checksum",
    }],
  });

  expect(catalog).toBeNull();
  expect(isSafeR2Key("gta-vi/catalogs/official.json")).toBe(true);
  expect(isSafeR2Key("../private-key")).toBe(false);
});
