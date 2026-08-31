import { describe, expect, test } from "bun:test";
import { createOutputArtifact, PublicOutputArtifactSchema } from "./index.ts";

describe("output artifacts", () => {
  test("creates a versioned, project-scoped record envelope", () => {
    const artifact = createOutputArtifact({
      schemaVersion: "1.0",
      projectId: "gameintelgg",
      profileId: "software-releases",
      records: [{ id: "release-1", kind: "source-item" }],
    });

    expect(artifact).toMatchObject({
      schemaVersion: "1.0",
      projectId: "gameintelgg",
      profileId: "software-releases",
      records: [{ id: "release-1", kind: "source-item" }],
    });
    expect(artifact.generatedAt).toBeString();
  });

  test("rejects active URL schemes from public artifacts", () => {
    const result = PublicOutputArtifactSchema.safeParse({
      schemaVersion: "1.0",
      generatedAt: "2026-08-28T00:00:00.000Z",
      projectId: "gameintelgg",
      profileId: "gta-vi",
      records: [{
        id: "article-1",
        collectionId: "gta-vi",
        slug: "article-one",
        title: "Article one",
        seoTitle: "Article one",
        description: "Description",
        body: {
          summary: "Summary",
          sections: [{
            heading: "Evidence",
            paragraphs: [{ text: "Evidence", evidenceLevel: "confirmed", attributionType: "official", editorialAssessment: null, citations: [1] }],
            publicSafe: true,
            spoilerTags: [],
          }],
          unknowns: [],
        },
        status: "published",
        publishedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: null,
        citations: [{ number: 1, label: "Unsafe", url: "javascript:alert(1)" }],
        coverMedia: null,
      }],
    });

    expect(result.success).toBe(false);
  });
});
