import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GameProfileSchema } from "@gameintel/core";
import {
  approveArticle,
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  closeDb,
  createDb,
  ensureGame,
  getArticle,
  importMediaCatalog,
  listCoverCandidates,
  markPublished,
  publicArticles,
  reviewArticle,
  reviewSource,
  setCoverMedia,
} from "@gameintel/db";
import type { Db } from "@gameintel/db";
import { loadFixture } from "./fixture.ts";
import { loadRegistry } from "./ingest.ts";
import { processFixture } from "./pipeline.ts";

const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/gta-vi-netflix-tudum.json", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../config/games/gta-vi/profile.json", import.meta.url));
const profile = GameProfileSchema.parse(await Bun.file(profilePath).json());

const rollback = new Error("rollback test transaction");

async function testFixture() {
  const fixture = await loadFixture(fixturePath);
  fixture.source.enabled = true;
  const marker = crypto.randomUUID();
  fixture.item.externalId = `${fixture.item.externalId}-${marker}`;
  fixture.item.text = `${fixture.item.text} Test run marker ${marker}.`;
  return fixture;
}

async function inRolledBackTransaction(callback: (transaction: Db) => Promise<void>): Promise<void> {
  const db = createDb();
  try {
    await expect(db.begin(async (transaction) => {
      await callback(transaction as unknown as Db);
      throw rollback;
    })).rejects.toThrow(rollback.message);
  } finally {
    await closeDb(db);
  }
}

describe("Tudum newsroom pipeline", () => {
  test("registers Tudum as an opt-in attributed secondary source", async () => {
    const source = (await loadRegistry()).find((candidate) => candidate.id === "netflix-tudum");

    expect(source).toMatchObject({
      domains: ["netflix.com"],
      access: "permitted_scrape",
      source_strength: "TRUSTED_SECONDARY",
      publication_mode: "normal",
      public_citation_base: "https://www.netflix.com/tudum/articles/grand-theft-auto-6-extended-first-look",
      enabled: false,
    });
  });

  test("stores claims with lineage and deduplicates the fixture", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();

      const first = await processFixture(db, fixture, { allowFixture: true });
      expect(first.articleId).not.toBeNull();
      expect(first.duplicate).toBe(false);

      const sourceItems = await db`SELECT source_id, external_id, lineage_id, input_kind, content_type, language FROM source_items WHERE id = ${first.sourceItemId}`;
      expect(sourceItems).toHaveLength(1);
      expect(sourceItems[0].source_id).toBe("netflix-tudum");
      expect(sourceItems[0].external_id).toContain("grand-theft-auto-6-extended-first-look");
      expect(sourceItems[0].lineage_id).toBe("fixture-lineage-gta-vi-netflix-tudum");
      expect(sourceItems[0].input_kind).toBe("manual_fixture");
      expect(sourceItems[0].content_type).toBe("text/html");
      expect(sourceItems[0].language).toBe("en");

      const claims = await db`SELECT c.subject, c.predicate, c.value, c.evidence_level, c.attribution_type, c.statement, e.excerpt, e.lineage_id FROM claims c JOIN evidence e ON e.claim_id = c.id WHERE c.source_item_id = ${first.sourceItemId} ORDER BY c.created_at`;
      expect(claims).toHaveLength(6);
      expect(claims.map((claim) => claim.lineage_id)).toEqual(Array(6).fill("fixture-lineage-gta-vi-netflix-tudum"));
      expect(claims.map((claim) => claim.value)).toContain("November 19");
      expect(claims.map((claim) => claim.excerpt)).toContain("An extended GTA VI look is available to Netflix subscribers.");
      expect(claims.map((claim) => claim.evidence_level)).toEqual(Array(6).fill("confirmed"));
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("trusted_secondary"));

      const second = await processFixture(db, fixture, { allowFixture: true });
      expect(second.duplicate).toBe(true);
      expect(second.articleId).toBeNull();
    });
  });

  test("requires human review before exposing the article publicly", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      const result = await processFixture(db, fixture, { allowFixture: true });
      const articleId = result.articleId!;
      const existingPublicCount = (await publicArticles(db, "gta-vi")).length;

      await expect(approveArticle(db, articleId, "test-approver")).rejects.toThrow("requires source review");
      expect(await publicArticles(db, "gta-vi")).toHaveLength(existingPublicCount);

      await reviewSource(db, fixture.source.id, "test-source-reviewer", "Tudum source reviewed");
      await reviewArticle(db, articleId, "test-editor", "Draft checked against the source");
      await approveArticle(db, articleId, "test-approver");
      if ((await getArticle(db, articleId))?.coverMedia) await approveCoverMedia(db, articleId, "test-media-reviewer");
      const published = await markPublished(db, articleId, "test-publisher");

      expect(published.status).toBe("published");
      expect(published.sourceReviewCompleted).toBe(true);
      expect(published.editorReviewCompleted).toBe(true);
      expect(published.approvedBy).toBe("test-approver");

      const publicSnapshot = await publicArticles(db, "gta-vi");
      expect(publicSnapshot).toHaveLength(existingPublicCount + 1);
      const article = publicSnapshot[0] as { title: string; citations: Array<{ url: string }>; body: { sections: Array<{ paragraphs: Array<{ text: string; evidenceLevel: string; citations: number[] }> }> } };
      expect(article.title).toBe(fixture.item.title);
      expect(article.citations).toHaveLength(1);
      expect(article.citations.every((citation) => citation.url === fixture.source.publicCitationUrl)).toBe(true);
      expect(article).not.toHaveProperty("confidence");
      expect(JSON.stringify(article)).not.toContain("<script");
      expect(article.body.sections.length).toBeGreaterThan(0);
      expect(article.body.sections[0].paragraphs[0]).toMatchObject({ evidenceLevel: "confirmed", citations: [1] });
    });
  });

  test("imports pending media and requires separate cover review before publication", async () => {
    const marker = crypto.randomUUID();
    const catalogPath = `/tmp/gameintel-media-${marker}.json`;
    const safeMediaId = `media-${marker}-safe`;
    const pendingMediaId = `media-${marker}-pending`;
    try {
      await Bun.write(catalogPath, JSON.stringify({ media: [
        {
          id: `media-${marker}-spoiler`, collectionId: "gta-vi", collection: "GTA VI", caption: "GTA VI extended look", altText: "Spoiler image",
          tags: ["gta vi extended look"], spoilerTags: ["story"], attribution: "Rockstar Games", sourceUrl: "https://example.com/spoiler.jpg", sourcePageUrl: "https://example.com/gallery",
          originalKey: `original/${marker}-spoiler.jpg`, displayKey: `display/${marker}-spoiler.jpg`, publicUrl: "https://media.example.com/spoiler.jpg", contentType: "image/jpeg", width: 100, height: 100,
          checksum: "a".repeat(64),
        },
        {
          id: safeMediaId, collectionId: "gta-vi", collection: "GTA VI", caption: "GTA VI extended look", altText: "GTA VI promotional image",
          tags: ["gta vi extended look"], spoilerTags: [], attribution: "Rockstar Games", sourceUrl: "https://example.com/safe.jpg", sourcePageUrl: "https://example.com/gallery",
          originalKey: `original/${marker}-safe.jpg`, displayKey: `display/${marker}-safe.jpg`, publicUrl: "https://media.example.com/safe.jpg", contentType: "image/jpeg", width: 100, height: 100,
          checksum: "b".repeat(64),
        },
        {
          id: pendingMediaId, collectionId: "gta-vi", collection: "GTA VI", caption: "GTA VI city image", altText: "GTA VI city image",
          tags: ["gta vi"], spoilerTags: [], attribution: "Rockstar Games", sourceUrl: "https://example.com/pending.jpg", sourcePageUrl: "https://example.com/gallery",
          originalKey: `original/${marker}-pending.jpg`, displayKey: `display/${marker}-pending.jpg`, publicUrl: "https://media.example.com/pending.jpg", contentType: "image/jpeg", width: 100, height: 100,
          checksum: "c".repeat(64),
        },
      ] }));
      await inRolledBackTransaction(async (db) => {
        await ensureGame(db, profile);
        expect(await importMediaCatalog(db, catalogPath)).toMatchObject({ imported: 3, collectionIds: ["gta-vi"] });
        expect((await db`SELECT review_status FROM media_assets WHERE id = ${safeMediaId}`)[0].review_status).toBe("pending");
        expect(await listCoverCandidates(db, "missing-article")).toEqual([]);

        await approveMediaAsset(db, safeMediaId, "test-media-reviewer");
        const fixture = await testFixture();
        const result = await processFixture(db, fixture, { allowFixture: true });
        const automaticCover = (await getArticle(db, result.articleId!))?.coverMedia;
        expect(automaticCover).toMatchObject({ id: safeMediaId, selectionSource: "automatic", reviewStatus: "pending" });
        expect(await listCoverCandidates(db, result.articleId!)).toHaveLength(1);

        await setCoverMedia(db, result.articleId!, pendingMediaId, "editor");
        await expect(approveCoverMedia(db, result.articleId!, "test-media-reviewer")).rejects.toThrow("Cover media asset must be approved");
        await setCoverMedia(db, result.articleId!, safeMediaId, "editor");
        expect((await getArticle(db, result.articleId!))?.coverMedia).toMatchObject({ selectionSource: "editor", reviewStatus: "pending" });
        await reviewSource(db, fixture.source.id, "test-source-reviewer", "Tudum source reviewed");
        await reviewArticle(db, result.articleId!, "test-editor", "Draft checked against the source");
        await approveArticle(db, result.articleId!, "test-approver");
        await expect(markPublished(db, result.articleId!, "test-publisher")).rejects.toThrow("Selected cover media must be approved");

        await approveCoverMedia(db, result.articleId!, "test-media-reviewer");
        await markPublished(db, result.articleId!, "test-publisher");
        const publicArticle = (await publicArticles(db, "gta-vi")).find((article) => (article as { id: string }).id === result.articleId!) as { coverMedia: { id: string } | null };
        expect(publicArticle.coverMedia).toMatchObject({ id: safeMediaId });
        expect(await approveMediaCollection(db, "gta-vi", "test-media-reviewer")).toBe(1);
        expect(await approveMediaCollection(db, "gta-vi", "test-media-reviewer")).toBe(0);
      });
    } finally {
      await rm(catalogPath, { force: true });
    }
  });

  test("preserves the suspected community-report wording", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      fixture.item.claims[0].evidenceLevel = "suspected";
      fixture.item.claims[0].attributionType = "community";
      fixture.item.claims[0].statement = "Many reports claim that Trevor Philips from GTA V has been spotted in Amborisa.";
      fixture.item.claims[0].editorialAssessment = "GameIntel.gg has not found sufficient evidence to support this claim.";
      const result = await processFixture(db, fixture, { allowFixture: true });
      const article = await getArticle(db, result.articleId!);
      const fact = article?.body.sections[0].paragraphs[0];

      expect(fact).toMatchObject({
        text: "Many reports claim that Trevor Philips from GTA V has been spotted in Amborisa.",
        evidenceLevel: "suspected",
        attributionType: "community",
        editorialAssessment: "GameIntel.gg has not found sufficient evidence to support this claim.",
      });
    });
  });

  test("uses the reviewed leak attribution wording", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      fixture.item.claims[0].evidenceLevel = "suspected";
      fixture.item.claims[0].attributionType = "reviewed_leak_reporting";
      fixture.item.claims[0].statement = null;
      fixture.item.claims[0].editorialAssessment = "GameIntel.gg has not found sufficient evidence to support this claim.";
      const result = await processFixture(db, fixture, { allowFixture: true });
      const article = await getArticle(db, result.articleId!);
      const fact = article?.body.sections[0].paragraphs[0];

      expect(fact?.text).toStartWith("According to hacked game leaks editorial team as reviewed,");
      expect(fact?.editorialAssessment).toBe("GameIntel.gg has not found sufficient evidence to support this claim.");
    });
  });

  test("can read the draft by its generated article id", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      const result = await processFixture(db, fixture, { allowFixture: true });
      const article = await getArticle(db, result.articleId!);

      expect(article?.collectionId).toBe("gta-vi");
      expect(article?.status).toBe("draft");
      expect(article?.description).toEndWith("...");
      expect(article?.description).not.toContain("Serie");
      expect(article?.body.sections.map((section) => section.heading)).toEqual(["Evidence", "What remains unknown"]);
    });
  });
});
