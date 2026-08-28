import { describe, expect, test } from "bun:test";
import { prepareIngestion } from "./index.ts";

describe("generic ingestion preparation", () => {
  test("validates, hashes, and scores a source item without game-specific assumptions", () => {
    const result = prepareIngestion({
      sourceId: "release-feed",
      collectionId: "software-project",
      externalId: "release-1",
      url: "urn:example:release:1",
      title: "Version 1",
      text: "A new version is available.",
      sourceStrength: "TRUSTED_SECONDARY",
      publicationMode: "normal",
      discoveredAt: new Date().toISOString(),
      publishedAt: null,
      lineageId: null,
      inputKind: "manual_fixture",
      contentType: "text/plain",
      language: "en",
      claims: [],
    }, {
      sourceAuthority: 0.8,
      novelty: 0.8,
      readerUsefulness: 0.8,
      collectionRelevance: 1,
      newInformation: 0.8,
      confirmationStrength: 0.6,
      communityInterest: 0.2,
      searchInterest: 0.2,
    });

    expect(result.item.collectionId).toBe("software-project");
    expect(result.rawHash).toHaveLength(64);
    expect(result.lineageId).toHaveLength(64);
    expect(result.disposition).toBe("research_new_article");
  });
});
