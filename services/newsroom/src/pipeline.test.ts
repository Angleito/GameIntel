import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GameProfileSchema } from "@gameintel/core";
import {
  approveArticle,
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  claimIngestionJob,
  closeDb,
  completeIngestionJob,
  createDb,
  createQuarantinedSubmission,
  enqueueSourceIngestJob,
  ensureGame,
  failIngestionJob,
   getArticle,
   getIngestionJob,
   getIngestionQueueStatus,
   getPublicSubmissionForModeration,
   heartbeatIngestionWorker,
   importMediaCatalog,
  linkSourceItemProvenance,
   listArticleEvidence,
   listCoverCandidates,
   listIngestionWorkerHeartbeats,
   listRecentIngestionJobs,
   listPublicSubmissionModerationActions,
   listPublicSubmissionsForModeration,
  markPublished,
  publicArticles,
  purgeExpiredPublicSubmissions,
   reviewArticle,
   reviewEvidence,
   reviewPublicSubmission,
   reviewSource,
  setCoverMedia,
} from "@gameintel/db";
import type { Db } from "@gameintel/db";
import { loadFixture } from "./fixture.ts";
import { loadRegistry, promotePublicSubmission } from "./ingest.ts";
import { processFixture } from "./pipeline.ts";

const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/gta-vi-netflix-tudum.json", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../config/games/gta-vi/profile.json", import.meta.url));
const egressAllowlistPath = fileURLToPath(new URL("../../../infra/egress/allowed-domains.acl", import.meta.url));
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

  test("keeps the egress allowlist aligned with registered network sources", async () => {
    const allowlist = new Set((await Bun.file(egressAllowlistPath).text()).split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")));
    const networkDomains = (await loadRegistry())
      .filter((source) => source.access !== "manual")
      .flatMap((source) => source.domains);

    for (const domain of networkDomains) expect(allowlist).toContain(`.${domain}`);
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

       await expect(approveArticle(db, articleId, "test-approver")).rejects.toThrow("current editorial review");
      expect(await publicArticles(db, "gta-vi")).toHaveLength(existingPublicCount);

       await reviewSource(db, fixture.source.id, "test-source-reviewer", "Tudum source policy reviewed");
       await expect(reviewArticle(db, articleId, "test-editor", "Draft checked against the source"))
         .rejects.toThrow("current evidence approval");
       const evidence = await listArticleEvidence(db, articleId);
       expect(evidence).toHaveLength(6);
       for (const item of evidence) await reviewEvidence(db, item.id, "test-evidence-reviewer", "approved", "Evidence supports the claim");
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

  test("requires fresh evidence review after a source item materially changes", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      const first = await processFixture(db, fixture, { allowFixture: true });
      const articleId = first.articleId!;
      for (const evidence of await listArticleEvidence(db, articleId)) {
        await reviewEvidence(db, evidence.id, "first-evidence-reviewer", "approved", "Initial evidence review");
      }
      await reviewArticle(db, articleId, "first-editor", "Initial editorial review");
      await approveArticle(db, articleId, "first-approver");

      fixture.item.text = `${fixture.item.text} This source item was materially revised.`;
      const revised = await processFixture(db, fixture, { allowFixture: true });
      expect(revised.duplicate).toBe(false);

      const invalidated = await getArticle(db, articleId);
      expect(invalidated).toMatchObject({
        status: "draft",
        sourceReviewCompleted: false,
        editorReviewCompleted: false,
        approvedBy: null,
      });
      const evidence = await listArticleEvidence(db, articleId);
      expect(evidence.some((item) => !item.current)).toBe(true);
      expect(evidence.some((item) => item.current)).toBe(true);
      await expect(reviewEvidence(db, evidence.find((item) => !item.current)!.id, "second-evidence-reviewer"))
        .rejects.toThrow("current source revision");
      await expect(reviewArticle(db, articleId, "second-editor", "Cannot review stale evidence"))
        .rejects.toThrow("current evidence approval");
    });
  });

  test("requires independent reviewers when source policy requires two approvals", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      fixture.source.policy.evidenceReview.minimumApprovals = 2;
      const result = await processFixture(db, fixture, { allowFixture: true });
      const evidence = await listArticleEvidence(db, result.articleId!);
      for (const item of evidence) {
        await reviewEvidence(db, item.id, "first-reviewer", "approved", "First independent review");
        await reviewEvidence(db, item.id, "first-reviewer", "approved", "Duplicate approval does not count twice");
      }
      await expect(reviewArticle(db, result.articleId!, "editor", "One reviewer is insufficient"))
        .rejects.toThrow("current evidence approval");
      for (const item of evidence) await reviewEvidence(db, item.id, "second-reviewer", "approved", "Second independent review");
      await reviewArticle(db, result.articleId!, "editor", "Two independent reviews complete");
    });
  });

  test("keeps public submissions quarantined, deduplicated, and purgeable", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const input = {
        submission: {
          collectionId: "gta-vi",
          title: "Rare vehicle report",
          report: "A rare vehicle appeared behind Ocean Hotel around midnight.",
          urls: ["https://example.com/community-report"],
          mediaRefs: [],
        },
        submitterSessionHash: "a".repeat(64),
        submitterIpHash: "b".repeat(64),
        retentionDays: 1,
      };
      const existingPublic = await publicArticles(db, "gta-vi");
      const first = await createQuarantinedSubmission(db, input);
      const duplicate = await createQuarantinedSubmission(db, input);

      expect(first.duplicate).toBe(false);
      expect(duplicate).toEqual({ id: first.id, duplicate: true });
      expect(await publicArticles(db, "gta-vi")).toEqual(existingPublic);
      const stored = await db`SELECT state, report, content_hash, content_purged_at FROM public_submissions WHERE id = ${first.id}`;
      expect(stored[0]).toMatchObject({ state: "quarantined", report: input.submission.report, content_purged_at: null });
      expect(stored[0].content_hash).toHaveLength(64);

      await db`UPDATE public_submissions SET retention_until = now() - interval '1 second' WHERE id = ${first.id}`;
      expect(await purgeExpiredPublicSubmissions(db)).toEqual({ eligibleSubmissions: 1, purgedSubmissions: 0, dryRun: true });
      expect(await purgeExpiredPublicSubmissions(db, { execute: true })).toEqual({ eligibleSubmissions: 1, purgedSubmissions: 1, dryRun: false });
      const purged = await db`SELECT state, title, report, urls, media_refs, content_purged_at FROM public_submissions WHERE id = ${first.id}`;
      expect(purged[0].state).toBe("expired");
      expect(purged[0].title).toBeNull();
      expect(purged[0].report).toBe("");
      expect(purged[0].content_purged_at).not.toBeNull();
    });
  });

  test("promotes only reviewed submissions as non-publishable community evidence", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const existingPublic = await publicArticles(db, "gta-vi");
      const submitted = await createQuarantinedSubmission(db, {
        submission: {
          collectionId: "gta-vi",
          title: "Night-time vehicle report",
          report: "A vehicle appeared behind Ocean Hotel around midnight. The report is not independently verified.",
          urls: ["https://example.com/community-report"],
          mediaRefs: [],
        },
        submitterSessionHash: "c".repeat(64),
        submitterIpHash: "d".repeat(64),
      });

      await expect(promotePublicSubmission(db, {
        submissionId: submitted.id,
        actorId: "moderator-one",
        profileId: "gta-vi",
      })).rejects.toThrow("must be under review");
      const listed = await listPublicSubmissionsForModeration(db, "gta-vi");
      const listedSubmission = listed.find((submission) => submission.id === submitted.id);
      expect(listedSubmission).toBeDefined();
      expect(JSON.stringify(listedSubmission)).not.toContain("c".repeat(64));
      expect(await getPublicSubmissionForModeration(db, submitted.id)).toMatchObject({ state: "quarantined" });

      await reviewPublicSubmission(db, {
        submissionId: submitted.id,
        actorId: "moderator-one",
        decision: "under_review",
        notes: "Report is ready for attribution-only evidence intake.",
      });
      const promoted = await promotePublicSubmission(db, {
        submissionId: submitted.id,
        actorId: "moderator-two",
        notes: "Promoted as unverified community evidence only.",
        profileId: "gta-vi",
      });
      const stored = await db`
        SELECT state, promoted_source_item_id
        FROM public_submissions
        WHERE id = ${submitted.id}
      `;
      expect(stored[0]).toMatchObject({ state: "promoted", promoted_source_item_id: promoted.sourceItemId });
      const sourceItem = await db`
        SELECT source_strength, publication_mode, url
        FROM source_items
        WHERE id = ${promoted.sourceItemId}
      `;
      expect(sourceItem[0]).toMatchObject({ source_strength: "COMMUNITY", publication_mode: "discussion_only" });
      expect(sourceItem[0].url).toStartWith("urn:gameintelgg:manual:");
      const evidence = await db`
        SELECT c.attribution_type, e.evidence_type, e.id AS evidence_id, source_item.submitted_by
        FROM claims c
        JOIN evidence e ON e.claim_id = c.id
        JOIN source_items source_item ON source_item.id = e.source_item_id
        WHERE c.source_item_id = ${promoted.sourceItemId}
      `;
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({
        attribution_type: "community",
        evidence_type: "community_report",
        submitted_by: "moderator-two",
      });
      await expect(reviewEvidence(db, evidence[0].evidence_id as string, "moderator-two", "approved"))
        .rejects.toThrow("Submitters cannot approve their own evidence");
      expect(await publicArticles(db, "gta-vi")).toEqual(existingPublic);
      expect((await listPublicSubmissionModerationActions(db, submitted.id)).map((action) => action.action))
        .toEqual(["submitted", "state:under_review", "promoted"]);
      await expect(reviewPublicSubmission(db, {
        submissionId: submitted.id,
        actorId: "moderator-one",
        decision: "rejected",
      })).rejects.toThrow("no longer available");
    });
  });

  test("groups copied reports into one provenance family without merging independent evidence", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const original = await testFixture();
      const copied = await testFixture();
      copied.source.id = `copy-source-${crypto.randomUUID()}`;
      copied.source.canonicalUrl = `https://${copied.source.id}.example.com`;
      copied.source.publicCitationUrl = `https://${copied.source.id}.example.com/report`;
      copied.item.lineageId = `copy-lineage-${crypto.randomUUID()}`;
      const independent = await testFixture();
      independent.source.id = `independent-source-${crypto.randomUUID()}`;
      independent.source.canonicalUrl = `https://${independent.source.id}.example.com`;
      independent.source.publicCitationUrl = `https://${independent.source.id}.example.com/report`;
      independent.item.lineageId = `independent-lineage-${crypto.randomUUID()}`;

      const originalResult = await processFixture(db, original, { allowFixture: true });
      const copiedResult = await processFixture(db, copied, { allowFixture: true });
      const independentResult = await processFixture(db, independent, { allowFixture: true });
      await linkSourceItemProvenance(db, {
        sourceItemId: copiedResult.sourceItemId,
        relatedSourceItemId: originalResult.sourceItemId,
        relationship: "copied_from",
        reviewerId: "provenance-reviewer",
        notes: "The report cites the original article.",
      });
      await linkSourceItemProvenance(db, {
        sourceItemId: independentResult.sourceItemId,
        relatedSourceItemId: originalResult.sourceItemId,
        relationship: "independent_reproduction",
        reviewerId: "provenance-reviewer",
        notes: "Separate player reproduction.",
      });
      const evidence = await db`
        SELECT source_item_id, provenance_family_id
        FROM evidence
        WHERE source_item_id = ANY(${db.array([originalResult.sourceItemId, copiedResult.sourceItemId, independentResult.sourceItemId])})
      `;
      const familyFor = (sourceItemId: string) => evidence.find((item) => item.source_item_id === sourceItemId)?.provenance_family_id;

      expect(familyFor(copiedResult.sourceItemId)).toBe(familyFor(originalResult.sourceItemId));
      expect(familyFor(independentResult.sourceItemId)).not.toBe(familyFor(originalResult.sourceItemId));
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
         await reviewSource(db, fixture.source.id, "test-source-reviewer", "Tudum source policy reviewed");
         for (const evidence of await listArticleEvidence(db, result.articleId!)) {
           await reviewEvidence(db, evidence.id, "test-evidence-reviewer", "approved", "Evidence supports the claim");
         }
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

  test("derives claim attribution and evidence type from source strength", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      fixture.item.claims[0].attributionType = "community";
      fixture.item.claims[0].evidenceType = "community_report";
      const result = await processFixture(db, fixture, { allowFixture: true });
      const claims = await db`
        SELECT c.attribution_type, e.evidence_type
        FROM claims c JOIN evidence e ON e.claim_id = c.id
        WHERE c.source_item_id = ${result.sourceItemId}
      `;

      expect(claims).toHaveLength(6);
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("trusted_secondary"));
      expect(claims.map((claim) => claim.evidence_type)).toEqual(Array(6).fill("trusted_reporting"));
    });
  });

  test("never creates an article directly from a community source", async () => {
    await inRolledBackTransaction(async (db) => {
      await ensureGame(db, profile);
      const fixture = await testFixture();
      fixture.source.sourceStrength = "COMMUNITY";
      fixture.source.publicationMode = "normal";
      fixture.item.sourceStrength = "COMMUNITY";
      fixture.item.publicationMode = "normal";
      fixture.item.claims[0].attributionType = "trusted_secondary";
      fixture.item.claims[0].evidenceType = "trusted_reporting";
      const result = await processFixture(db, fixture, { allowFixture: true });
      const claims = await db`
        SELECT c.attribution_type, e.evidence_type
        FROM claims c JOIN evidence e ON e.claim_id = c.id
        WHERE c.source_item_id = ${result.sourceItemId}
      `;

      expect(result.articleId).toBeNull();
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("community"));
      expect(claims.map((claim) => claim.evidence_type)).toEqual(Array(6).fill("community_report"));
    });
  });

  test("leases source-ingestion jobs once and records terminal outcomes", async () => {
    await inRolledBackTransaction(async (db) => {
      const first = await enqueueSourceIngestJob(db, {
        collectionId: "gta-vi",
        sourceId: "netflix-tudum",
        url: "https://www.netflix.com/tudum/articles/queued-report?utm_source=test",
        profileId: "gta-vi",
      });
      const duplicate = await enqueueSourceIngestJob(db, {
        collectionId: "gta-vi",
        sourceId: "netflix-tudum",
        url: "https://www.netflix.com/tudum/articles/queued-report",
        profileId: "gta-vi",
      });
      expect(duplicate).toMatchObject({ jobKey: first.jobKey, duplicate: true, status: "queued" });

      const leased = await claimIngestionJob(db, "worker-one");
      expect(leased).toMatchObject({
        jobKey: first.jobKey,
        status: "running",
        attempts: 1,
        payload: { collectionId: "gta-vi", sourceId: "netflix-tudum", url: "https://www.netflix.com/tudum/articles/queued-report", profileId: "gta-vi" },
      });
      expect(await claimIngestionJob(db, "worker-two")).toBeNull();
      await heartbeatIngestionWorker(db, {
        workerId: "worker-one",
        workerType: "source_ingest",
        currentJobKey: first.jobKey,
        lastError: null,
      });
      expect((await listIngestionWorkerHeartbeats(db)).find((worker) => worker.workerId === "worker-one"))
        .toMatchObject({ currentJobKey: first.jobKey, lastError: null });
      const queueStatus = await getIngestionQueueStatus(db);
      expect(queueStatus.running).toBeGreaterThanOrEqual(1);
      expect(queueStatus.activeWorkers).toBeGreaterThanOrEqual(1);
      expect((await listRecentIngestionJobs(db)).some((job) => job.jobKey === first.jobKey)).toBe(true);
      await completeIngestionJob(db, leased!.jobKey, leased!.leaseToken!, { disposition: "research_new_article" });
      await heartbeatIngestionWorker(db, { workerId: "worker-one", workerType: "source_ingest", currentJobKey: null, lastError: null });
      expect(await getIngestionJob(db, first.jobKey)).toMatchObject({
        status: "completed",
        attempts: 1,
        leaseToken: null,
        result: { disposition: "research_new_article" },
      });

      const terminal = await enqueueSourceIngestJob(db, {
        collectionId: "gta-vi",
        sourceId: "netflix-tudum",
        url: "https://www.netflix.com/tudum/articles/invalid-source",
      });
      const terminalLease = await claimIngestionJob(db, "worker-one");
      await failIngestionJob(db, terminalLease!.jobKey, terminalLease!.leaseToken!, new Error("Source is disabled"), false);
      expect(await getIngestionJob(db, terminal.jobKey)).toMatchObject({ status: "dead", attempts: 1, lastError: "Source is disabled" });
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
