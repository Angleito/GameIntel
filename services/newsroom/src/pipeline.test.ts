import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { beforeEach, describe, expect, test } from "bun:test";
import { CLAIM_EXTRACTOR_VERSION, GameProfileSchema, type NormalizedSourceItem } from "@gameintel/core";
import { IngestionLeaseLostError, type GameIntelPersistence } from "@gameintel/contracts";
import { createInMemoryRuntime, InMemoryJobQueue, InMemoryPersistence, type InMemoryRuntime, type MemoryStore } from "@gameintel/in-memory";
import { loadFixture } from "./fixture.ts";
import { loadRegistry, promotePublicSubmission } from "./ingest.ts";
import { processFixture, processNormalizedItem, reprocessSourceRevision } from "./pipeline.ts";

const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/gta-vi-netflix-tudum.json", import.meta.url));
const profilePath = fileURLToPath(new URL("../../../profiles/gta-vi/profile.json", import.meta.url));
const egressAllowlistPath = fileURLToPath(new URL("../../../deployments/local/egress/allowed-domains.acl", import.meta.url));
const profile = GameProfileSchema.parse(await Bun.file(profilePath).json());

const rollback = new Error("rollback test transaction");

let runtime: InMemoryRuntime;

beforeEach(() => {
  runtime = createInMemoryRuntime();
});

async function testFixture() {
  const fixture = await loadFixture(fixturePath);
  fixture.source.enabled = true;
  const marker = crypto.randomUUID();
  fixture.item.externalId = `${fixture.item.externalId}-${marker}`;
  fixture.item.text = `${fixture.item.text} Test run marker ${marker}.`;
  return fixture;
}

async function inRolledBackTransaction(callback: (transaction: GameIntelPersistence) => Promise<void>): Promise<void> {
  await expect(runtime.persistence.transaction(async (transaction) => {
    await callback(transaction);
    throw rollback;
  })).rejects.toThrow(rollback.message);
}

function storeOf(persistence: GameIntelPersistence): MemoryStore {
  return (persistence as InMemoryPersistence).store;
}

function sourceItemRecord(persistence: GameIntelPersistence, id: string) {
  const record = storeOf(persistence).sourceItems.get(id);
  if (!record) throw new Error(`Missing source item ${id}`);
  return record;
}

function claimsWithEvidence(persistence: GameIntelPersistence, sourceItemId: string): Array<Record<string, unknown>> {
  const store = storeOf(persistence);
  return [...store.claims.values()]
    .filter((claim) => claim.sourceItemId === sourceItemId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((claim) => {
      const evidence = [...store.evidence.values()].find((record) => record.claimId === claim.id);
      return {
        subject: claim.subject,
        predicate: claim.predicate,
        value: claim.value,
        evidence_level: claim.evidenceLevel,
        attribution_type: claim.attributionType,
        statement: claim.statement,
        excerpt: evidence?.excerpt,
        evidence_type: evidence?.evidenceType,
        lineage_id: evidence?.lineageId,
      };
    });
}

function claimStates(persistence: GameIntelPersistence, sourceItemId: string): string[] {
  const store = storeOf(persistence);
  return [...store.claims.values()]
    .filter((claim) => claim.sourceItemId === sourceItemId)
    .map((claim) => claim.state);
}

describe("Tudum newsroom pipeline", () => {
  test("registers Tudum as an opt-in attributed secondary source", async () => {
    const source = (await loadRegistry()).find((candidate) => candidate.id === "netflix-tudum");

    expect(source).toMatchObject({
      domains: ["netflix.com"],
      access: "permitted_scrape",
      poll_interval_seconds: 300,
      poll_url: "https://www.netflix.com/tudum/articles/grand-theft-auto-6-extended-first-look",
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
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();

      const first = await processFixture(persistence, fixture, { allowFixture: true });
      expect(first.articleId).not.toBeNull();
      expect(first.duplicate).toBe(false);

      const item = sourceItemRecord(persistence, first.sourceItemId);
      expect(item).toMatchObject({
        sourceId: "netflix-tudum",
        inputKind: "manual_fixture",
        contentType: "text/html",
        language: "en",
      });
      expect(item.externalId).toContain("grand-theft-auto-6-extended-first-look");
      expect(item.lineageId).toBe("fixture-lineage-gta-vi-netflix-tudum");

      const claims = claimsWithEvidence(persistence, first.sourceItemId);
      expect(claims).toHaveLength(6);
      expect(claims.map((claim) => claim.lineage_id)).toEqual(Array(6).fill("fixture-lineage-gta-vi-netflix-tudum"));
      expect(claims.map((claim) => claim.value)).toContain("November 19");
      expect(claims.map((claim) => claim.excerpt)).toContain("An extended GTA VI look is available to Netflix subscribers.");
      expect(claims.map((claim) => claim.evidence_level)).toEqual(Array(6).fill("confirmed"));
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("trusted_secondary"));

      const second = await processFixture(persistence, fixture, { allowFixture: true });
      expect(second.duplicate).toBe(true);
      expect(second.articleId).toBeNull();
    });
  });

  test("requires human review before exposing the article publicly", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const articleId = result.articleId!;
      const existingPublicCount = (await persistence.publicArticles("gta-vi")).length;

      await expect(persistence.approveArticle(articleId, "test-approver")).rejects.toThrow("current editorial review");
      expect(await persistence.publicArticles("gta-vi")).toHaveLength(existingPublicCount);

      await persistence.reviewSource(fixture.source.id, "test-source-reviewer", "Tudum source policy reviewed");
      await expect(persistence.reviewArticle(articleId, "test-editor", "Draft checked against the source"))
        .rejects.toThrow("current evidence approval");
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence).toHaveLength(6);
      for (const item of evidence) await persistence.reviewEvidence(item.id, "test-evidence-reviewer", "approved", "Evidence supports the claim");
      await persistence.reviewArticle(articleId, "test-editor", "Draft checked against the source");
      await persistence.approveArticle(articleId, "test-approver");
      if ((await persistence.getArticle(articleId))?.coverMedia) await persistence.approveCoverMedia(articleId, "test-media-reviewer");
      const published = await persistence.markPublished(articleId, "test-publisher");

      expect(published.status).toBe("published");
      expect(published.sourceReviewCompleted).toBe(true);
      expect(published.editorReviewCompleted).toBe(true);
      expect(published.approvedBy).toBe("test-approver");

      const publicSnapshot = await persistence.publicArticles("gta-vi");
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
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const first = await processFixture(persistence, fixture, { allowFixture: true });
      const articleId = first.articleId!;
      for (const evidence of await persistence.listArticleEvidence(articleId)) {
        await persistence.reviewEvidence(evidence.id, "first-evidence-reviewer", "approved", "Initial evidence review");
      }
      await persistence.reviewArticle(articleId, "first-editor", "Initial editorial review");
      await persistence.approveArticle(articleId, "first-approver");

      fixture.item.text = `${fixture.item.text} This source item was materially revised.`;
      const revised = await processFixture(persistence, fixture, { allowFixture: true });
      expect(revised.duplicate).toBe(false);

      const invalidated = await persistence.getArticle(articleId);
      expect(invalidated).toMatchObject({
        status: "draft",
        sourceReviewCompleted: false,
        editorReviewCompleted: false,
        approvedBy: null,
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence.some((item) => !item.current)).toBe(true);
      expect(evidence.some((item) => item.current)).toBe(true);
      const states = claimStates(persistence, first.sourceItemId);
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((state) => ["supported", "confirmed", "contested"].includes(state))).toBe(true);
      await expect(persistence.reviewEvidence(evidence.find((item) => !item.current)!.id, "second-evidence-reviewer"))
        .rejects.toThrow("current source revision");
      await expect(persistence.reviewArticle(articleId, "second-editor", "Cannot review stale evidence"))
        .rejects.toThrow("current evidence approval");
    });
  });

  test("derives claim state from current source revisions only", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const first = await processFixture(persistence, fixture, { allowFixture: true });
      const states = async (sourceItemId: string) => [...new Set(claimStates(persistence, sourceItemId))];
      expect(await states(first.sourceItemId)).toEqual(["supported"]);

      fixture.source.sourceStrength = "PRIMARY";
      fixture.item.sourceStrength = "PRIMARY";
      fixture.item.text = `${fixture.item.text} Official confirmation added.`;
      const primary = await processFixture(persistence, fixture, { allowFixture: true });
      expect(primary.duplicate).toBe(false);
      expect(await states(primary.sourceItemId)).toEqual(["confirmed"]);

      fixture.source.sourceStrength = "COMMUNITY";
      fixture.item.sourceStrength = "COMMUNITY";
      fixture.item.text = `${fixture.item.text} Community follow-up report.`;
      const community = await processFixture(persistence, fixture, { allowFixture: true });
      expect(community.duplicate).toBe(false);
      expect(await states(community.sourceItemId)).toEqual(["supported"]);
    });
  });

  test("marks claims superseded when a material change drops them", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const first = await processFixture(persistence, fixture, { allowFixture: true });
      expect(storeOf(persistence).claims.size).toBeGreaterThan(0);

      fixture.item.claims = [];
      fixture.item.text = `${fixture.item.text} The claims were removed from this revision.`;
      const revised = await processFixture(persistence, fixture, { allowFixture: true });
      expect(revised.duplicate).toBe(false);

      expect([...new Set(claimStates(persistence, first.sourceItemId))]).toEqual(["superseded"]);
    });
  });

  test("requires independent reviewers when source policy requires two approvals", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      fixture.source.policy.evidenceReview.minimumApprovals = 2;
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const evidence = await persistence.listArticleEvidence(result.articleId!);
      for (const item of evidence) {
        await persistence.reviewEvidence(item.id, "first-reviewer", "approved", "First independent review");
        await persistence.reviewEvidence(item.id, "first-reviewer", "approved", "Duplicate approval does not count twice");
      }
      await expect(persistence.reviewArticle(result.articleId!, "editor", "One reviewer is insufficient"))
        .rejects.toThrow("current evidence approval");
      for (const item of evidence) await persistence.reviewEvidence(item.id, "second-reviewer", "approved", "Second independent review");
      await persistence.reviewArticle(result.articleId!, "editor", "Two independent reviews complete");
    });
  });

  test("keeps public submissions quarantined, deduplicated, and purgeable", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const input = {
        submission: {
          collectionId: "gta-vi",
          title: "Rare vehicle report",
          report: "A rare vehicle appeared behind Ocean Hotel around midnight.",
          urls: ["https://example.com/community-report"],
          mediaRefs: [] as Array<{ uploadId: string }>,
        },
        submitterSessionHash: "a".repeat(64),
        submitterIpHash: "b".repeat(64),
        retentionDays: 1,
      };
      const existingPublic = await persistence.publicArticles("gta-vi");
      const first = await persistence.createQuarantinedSubmission(input);
      const duplicate = await persistence.createQuarantinedSubmission(input);

      expect(first.duplicate).toBe(false);
      expect(duplicate).toEqual({ id: first.id, duplicate: true });
      expect(await persistence.publicArticles("gta-vi")).toEqual(existingPublic);
      const stored = storeOf(persistence).publicSubmissions.get(first.id);
      expect(stored).toMatchObject({ state: "quarantined", report: input.submission.report, contentPurgedAt: null });
      expect(stored!.contentHash).toHaveLength(64);

      (persistence as InMemoryPersistence).expireSubmissionRetentionForTest(first.id);
      expect(await persistence.purgeExpiredPublicSubmissions()).toEqual({ eligibleSubmissions: 1, purgedSubmissions: 0, dryRun: true });
      expect(await persistence.purgeExpiredPublicSubmissions({ execute: true })).toEqual({ eligibleSubmissions: 1, purgedSubmissions: 1, dryRun: false });
      const purged = storeOf(persistence).publicSubmissions.get(first.id);
      expect(purged!.state).toBe("expired");
      expect(purged!.title).toBeNull();
      expect(purged!.report).toBe("");
      expect(purged!.contentPurgedAt).not.toBeNull();
    });
  });

  test("promotes only reviewed submissions as non-publishable community evidence", async () => {
    const persistence = runtime.persistence;
    await persistence.ensureGame(profile);
    const existingPublic = await persistence.publicArticles("gta-vi");
    const submitted = await persistence.createQuarantinedSubmission({
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

    await expect(promotePublicSubmission(runtime, {
      submissionId: submitted.id,
      actorId: "moderator-one",
      profileId: "gta-vi",
    })).rejects.toThrow("must be under review");
    const listed = await persistence.listPublicSubmissionsForModeration("gta-vi");
    const listedSubmission = listed.find((submission) => submission.id === submitted.id);
    expect(listedSubmission).toBeDefined();
    expect(JSON.stringify(listedSubmission)).not.toContain("c".repeat(64));
    expect(await persistence.getPublicSubmissionForModeration(submitted.id)).toMatchObject({ state: "quarantined" });

    await persistence.reviewPublicSubmission({
      submissionId: submitted.id,
      actorId: "moderator-one",
      decision: "under_review",
      notes: "Report is ready for attribution-only evidence intake.",
    });
    const promoted = await promotePublicSubmission(runtime, {
      submissionId: submitted.id,
      actorId: "moderator-two",
      notes: "Promoted as unverified community evidence only.",
      profileId: "gta-vi",
    });
    const stored = storeOf(persistence).publicSubmissions.get(submitted.id);
    expect(stored).toMatchObject({ state: "promoted", promotedSourceItemId: promoted.sourceItemId });
    const sourceItem = sourceItemRecord(persistence, promoted.sourceItemId);
    expect(sourceItem).toMatchObject({ sourceStrength: "COMMUNITY", publicationMode: "discussion_only" });
    expect(sourceItem.url).toStartWith("urn:gameintelgg:manual:");
    const evidence = claimsWithEvidence(persistence, promoted.sourceItemId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      attribution_type: "community",
      evidence_type: "community_report",
    });
    expect(sourceItem.submittedBy).toBe("moderator-two");
    const evidenceRecord = [...storeOf(persistence).evidence.values()].find((record) => record.claimId === [...storeOf(persistence).claims.values()].find((claim) => claim.sourceItemId === promoted.sourceItemId)?.id);
    await expect(persistence.reviewEvidence(evidenceRecord!.id, "moderator-two", "approved"))
      .rejects.toThrow("Submitters cannot approve their own evidence");
    expect(await persistence.publicArticles("gta-vi")).toEqual(existingPublic);
    expect((await persistence.listPublicSubmissionModerationActions(submitted.id)).map((action) => action.action))
      .toEqual(["submitted", "state:under_review", "promoted"]);
    await expect(persistence.reviewPublicSubmission({
      submissionId: submitted.id,
      actorId: "moderator-one",
      decision: "rejected",
    })).rejects.toThrow("no longer available");
  });

  test("groups copied reports into one provenance family without merging independent evidence", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
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

      const originalResult = await processFixture(persistence, original, { allowFixture: true });
      const copiedResult = await processFixture(persistence, copied, { allowFixture: true });
      const independentResult = await processFixture(persistence, independent, { allowFixture: true });
      await persistence.linkSourceItemProvenance({
        sourceItemId: copiedResult.sourceItemId,
        relatedSourceItemId: originalResult.sourceItemId,
        relationship: "copied_from",
        reviewerId: "provenance-reviewer",
        notes: "The report cites the original article.",
      });
      await persistence.linkSourceItemProvenance({
        sourceItemId: independentResult.sourceItemId,
        relatedSourceItemId: originalResult.sourceItemId,
        relationship: "independent_reproduction",
        reviewerId: "provenance-reviewer",
        notes: "Separate player reproduction.",
      });
      const evidence = [...storeOf(persistence).evidence.values()]
        .filter((record) => [originalResult.sourceItemId, copiedResult.sourceItemId, independentResult.sourceItemId].includes(record.sourceItemId));
      const familyFor = (sourceItemId: string) => evidence.find((record) => record.sourceItemId === sourceItemId)?.provenanceFamilyId;

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
      await inRolledBackTransaction(async (persistence) => {
        await persistence.ensureGame(profile);
        expect(await persistence.importMediaCatalog(catalogPath)).toMatchObject({ imported: 3, collectionIds: ["gta-vi"] });
        expect(storeOf(persistence).mediaAssets.get(safeMediaId)?.reviewStatus).toBe("pending");
        expect(await persistence.listCoverCandidates("missing-article")).toEqual([]);

        await persistence.approveMediaAsset(safeMediaId, "test-media-reviewer");
        const fixture = await testFixture();
        const result = await processFixture(persistence, fixture, { allowFixture: true });
        const automaticCover = (await persistence.getArticle(result.articleId!))?.coverMedia;
        expect(automaticCover).toMatchObject({ id: safeMediaId, selectionSource: "automatic", reviewStatus: "pending" });
        expect(await persistence.listCoverCandidates(result.articleId!)).toHaveLength(1);

        await persistence.setCoverMedia(result.articleId!, pendingMediaId, "editor");
        await expect(persistence.approveCoverMedia(result.articleId!, "test-media-reviewer")).rejects.toThrow("Cover media asset must be approved");
        await persistence.setCoverMedia(result.articleId!, safeMediaId, "editor");
        expect((await persistence.getArticle(result.articleId!))?.coverMedia).toMatchObject({ selectionSource: "editor", reviewStatus: "pending" });
        await persistence.reviewSource(fixture.source.id, "test-source-reviewer", "Tudum source policy reviewed");
        for (const evidence of await persistence.listArticleEvidence(result.articleId!)) {
          await persistence.reviewEvidence(evidence.id, "test-evidence-reviewer", "approved", "Evidence supports the claim");
        }
        await persistence.reviewArticle(result.articleId!, "test-editor", "Draft checked against the source");
        await persistence.approveArticle(result.articleId!, "test-approver");
        await expect(persistence.markPublished(result.articleId!, "test-publisher")).rejects.toThrow("Selected cover media must be approved");

        await persistence.approveCoverMedia(result.articleId!, "test-media-reviewer");
        await persistence.markPublished(result.articleId!, "test-publisher");
        const publicArticle = (await persistence.publicArticles("gta-vi")).find((article) => (article as { id: string }).id === result.articleId!) as { coverMedia: { id: string } | null };
        expect(publicArticle.coverMedia).toMatchObject({ id: safeMediaId });
        expect(await persistence.approveMediaCollection("gta-vi", "test-media-reviewer")).toBe(1);
        expect(await persistence.approveMediaCollection("gta-vi", "test-media-reviewer")).toBe(0);
      });
    } finally {
      await rm(catalogPath, { force: true });
    }
  });

  test("derives claim attribution and evidence type from source strength", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      fixture.item.claims[0].attributionType = "community";
      fixture.item.claims[0].evidenceType = "community_report";
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const claims = claimsWithEvidence(persistence, result.sourceItemId);

      expect(claims).toHaveLength(6);
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("trusted_secondary"));
      expect(claims.map((claim) => claim.evidence_type)).toEqual(Array(6).fill("trusted_reporting"));
    });
  });

  test("never creates an article directly from a community source", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      fixture.source.sourceStrength = "COMMUNITY";
      fixture.source.publicationMode = "normal";
      fixture.item.sourceStrength = "COMMUNITY";
      fixture.item.publicationMode = "normal";
      fixture.item.claims[0].attributionType = "trusted_secondary";
      fixture.item.claims[0].evidenceType = "trusted_reporting";
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const claims = claimsWithEvidence(persistence, result.sourceItemId);

      expect(result.articleId).toBeNull();
      expect(claims.map((claim) => claim.attribution_type)).toEqual(Array(6).fill("community"));
      expect(claims.map((claim) => claim.evidence_type)).toEqual(Array(6).fill("community_report"));
    });
  });

  test("leases source-ingestion jobs once and records terminal outcomes", async () => {
    const first = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/queued-report?utm_source=test",
      profileId: "gta-vi",
    });
    const duplicate = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/queued-report",
      profileId: "gta-vi",
    });
    expect(duplicate).toMatchObject({ jobKey: first.jobKey, duplicate: true, status: "queued" });

    const leased = await runtime.jobQueue.claimIngestionJob("worker-one");
    expect(leased).toMatchObject({
      jobKey: first.jobKey,
      status: "running",
      attempts: 1,
      payload: { collectionId: "gta-vi", sourceId: "netflix-tudum", url: "https://www.netflix.com/tudum/articles/queued-report", profileId: "gta-vi" },
    });
    expect(await runtime.jobQueue.claimIngestionJob("worker-two")).toBeNull();
    await runtime.jobQueue.heartbeatIngestionWorker({
      workerId: "worker-one",
      workerType: "source_ingest",
      currentJobKey: first.jobKey,
      lastError: null,
    });
    expect((await runtime.jobQueue.listIngestionWorkerHeartbeats()).find((worker) => worker.workerId === "worker-one"))
      .toMatchObject({ currentJobKey: first.jobKey, lastError: null });
    const queueStatus = await runtime.jobQueue.getIngestionQueueStatus();
    expect(queueStatus.running).toBeGreaterThanOrEqual(1);
    expect(queueStatus.activeWorkers).toBeGreaterThanOrEqual(1);
    expect((await runtime.jobQueue.listRecentIngestionJobs()).some((job) => job.jobKey === first.jobKey)).toBe(true);
    await runtime.jobQueue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "research_new_article" });
    await runtime.jobQueue.heartbeatIngestionWorker({ workerId: "worker-one", workerType: "source_ingest", currentJobKey: null, lastError: null });
    expect(await runtime.jobQueue.getIngestionJob(first.jobKey)).toMatchObject({
      status: "completed",
      attempts: 1,
      leaseToken: null,
      result: { disposition: "research_new_article" },
    });

    const terminal = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/invalid-source",
    });
    const terminalLease = await runtime.jobQueue.claimIngestionJob("worker-one");
    await runtime.jobQueue.failIngestionJob(terminalLease!.jobKey, terminalLease!.leaseToken!, new Error("Source is disabled"), false);
    expect(await runtime.jobQueue.getIngestionJob(terminal.jobKey)).toMatchObject({ status: "dead", attempts: 1, lastError: "Source is disabled" });
  });

  test("schedules a completed URL again as a fresh execution", async () => {
    const input = {
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/repeat-report",
      profileId: "gta-vi",
    };
    const first = await runtime.jobQueue.enqueueSourceIngestJob(input);
    const leased = await runtime.jobQueue.claimIngestionJob("worker-one");
    expect(leased).not.toBeNull();
    await runtime.jobQueue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "research_new_article" });
    expect(await runtime.jobQueue.getIngestionJob(first.jobKey)).toMatchObject({ status: "completed" });

    const second = await runtime.jobQueue.enqueueSourceIngestJob(input);
    expect(second.duplicate).toBe(false);
    expect(second.jobKey).not.toBe(first.jobKey);
    expect(second.dedupeKey).toBe(first.dedupeKey);
    expect(second.status).toBe("queued");

    const refresh = await runtime.jobQueue.claimIngestionJob("worker-one");
    expect(refresh?.jobKey).toBe(second.jobKey);
  });

  test("retries a dead URL later as a fresh execution", async () => {
    const input = {
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/retry-report",
      profileId: "gta-vi",
    };
    const first = await runtime.jobQueue.enqueueSourceIngestJob(input);
    const leased = await runtime.jobQueue.claimIngestionJob("worker-one");
    await runtime.jobQueue.failIngestionJob(leased!.jobKey, leased!.leaseToken!, new Error("Source terms no longer permit collection"), false);
    expect(await runtime.jobQueue.getIngestionJob(first.jobKey)).toMatchObject({ status: "dead", attempts: 1 });

    const retry = await runtime.jobQueue.enqueueSourceIngestJob(input);
    expect(retry.duplicate).toBe(false);
    expect(retry.jobKey).not.toBe(first.jobKey);

    const claimed = await runtime.jobQueue.claimIngestionJob("worker-one");
    expect(claimed?.jobKey).toBe(retry.jobKey);
  });

  test("prevents concurrent duplicate executions without blocking future refreshes", async () => {
    const input = {
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/active-report",
      profileId: "gta-vi",
    };
    const first = await runtime.jobQueue.enqueueSourceIngestJob(input);
    const claimed = await runtime.jobQueue.claimIngestionJob("worker-one");
    const running = await runtime.jobQueue.enqueueSourceIngestJob(input);
    expect(running).toMatchObject({ jobKey: first.jobKey, duplicate: true, status: "running" });
    expect(await runtime.jobQueue.claimIngestionJob("worker-two")).toBeNull();
    await runtime.jobQueue.completeIngestionJob(claimed!.jobKey, claimed!.leaseToken!, { disposition: "duplicate" });

    const afterCompletion = await runtime.jobQueue.enqueueSourceIngestJob(input);
    expect(afterCompletion.duplicate).toBe(false);
    expect(afterCompletion.jobKey).not.toBe(first.jobKey);
  });

  test("blocks publication while any reviewer disputes or rejects evidence", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const articleId = result.articleId!;
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence.length).toBeGreaterThan(0);

      for (const item of evidence) await persistence.reviewEvidence(item.id, "reviewer-one", "approved", "Supports the claim");
      await persistence.reviewArticle(articleId, "reviewer-one", "Editorial review");
      await persistence.approveArticle(articleId, "reviewer-one");

      await persistence.reviewEvidence(evidence[0].id, "reviewer-two", "disputed", "Conflicting conditions observed");
      const disputedArticle = await persistence.getArticle(articleId);
      expect(disputedArticle).toMatchObject({
        status: "draft",
        sourceReviewCompleted: false,
        editorReviewCompleted: false,
        approvedBy: null,
      });
      await expect(persistence.reviewArticle(articleId, "reviewer-one", "Cannot review blocked evidence"))
        .rejects.toThrow("current evidence approval");

      await persistence.reviewEvidence(evidence[0].id, "reviewer-two", "approved", "Dispute resolved after reproduction");
      for (const item of evidence.slice(1)) await persistence.reviewEvidence(item.id, "reviewer-two", "approved", "Second independent approval");
      await persistence.reviewArticle(articleId, "reviewer-one", "Re-reviewed after dispute resolution");
      await persistence.approveArticle(articleId, "reviewer-one");
      expect((await persistence.getArticle(articleId))?.status).toBe("approved");

      await persistence.reviewEvidence(evidence[0].id, "reviewer-three", "rejected", "Stale revision material");
      expect((await persistence.getArticle(articleId))?.status).toBe("draft");
    });
  });

  test("renews an ingestion job lease before expiry", async () => {
    const enqueued = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/lease-renewal",
      profileId: "gta-vi",
    });
    const leased = await runtime.jobQueue.claimIngestionJob("worker-one", ["source_ingest"], 60_000);
    expect(leased?.jobKey).toBe(enqueued.jobKey);
    (runtime.jobQueue as InMemoryJobQueue).expireLeaseForTest(leased!.jobKey);

    expect(await runtime.jobQueue.renewIngestionJobLease(leased!.jobKey, leased!.leaseToken!, 60_000)).toBe(true);
    const afterRenewal = (runtime.jobQueue as InMemoryJobQueue).jobForTest(leased!.jobKey);
    expect(afterRenewal!.leaseExpiresAt!).toBeGreaterThan(Date.now());
    await runtime.jobQueue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: "duplicate" });
    expect(await runtime.jobQueue.getIngestionJob(leased!.jobKey)).toMatchObject({ status: "completed" });
  });

  test("reclaims an expired job and rejects the stale worker's lease", async () => {
    const enqueued = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/reclaim-report",
      profileId: "gta-vi",
    });
    const crashed = await runtime.jobQueue.claimIngestionJob("crashed-worker", ["source_ingest"], 60_000);
    expect(crashed?.jobKey).toBe(enqueued.jobKey);
    (runtime.jobQueue as InMemoryJobQueue).expireLeaseForTest(crashed!.jobKey);

    const reclaimed = await runtime.jobQueue.claimIngestionJob("replacement-worker");
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.jobKey).toBe(enqueued.jobKey);
    expect(reclaimed!.leaseToken).not.toBe(crashed!.leaseToken);
    expect(reclaimed!.attempts).toBe(2);

    expect(await runtime.jobQueue.renewIngestionJobLease(crashed!.jobKey, crashed!.leaseToken!, 60_000)).toBe(false);
    await expect(runtime.jobQueue.completeIngestionJob(crashed!.jobKey, crashed!.leaseToken!, { ok: true }))
      .rejects.toThrow("lease is no longer held");
    await expect(runtime.jobQueue.failIngestionJob(crashed!.jobKey, crashed!.leaseToken!, new Error("Stale failure"), true))
      .rejects.toThrow("lease is no longer held");

    await runtime.jobQueue.completeIngestionJob(reclaimed!.jobKey, reclaimed!.leaseToken!, { disposition: "duplicate" });
    expect(await runtime.jobQueue.getIngestionJob(enqueued.jobKey)).toMatchObject({ status: "completed" });
  });

  test("fences ingestion transactions against a reclaimed lease", async () => {
    await runtime.persistence.ensureGame(profile);
    const fixture = await testFixture();
    const enqueued = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/fenced-report",
      profileId: "gta-vi",
    });
    const stalled = await runtime.jobQueue.claimIngestionJob("stalled-worker", ["source_ingest"], 60_000);
    (runtime.jobQueue as InMemoryJobQueue).expireLeaseForTest(stalled!.jobKey);
    const reclaimed = await runtime.jobQueue.claimIngestionJob("replacement-worker");
    expect(reclaimed?.jobKey).toBe(enqueued.jobKey);

    await expect(processNormalizedItem(runtime.persistence, { ...fixture.item, sourceId: fixture.source.id }, fixture.source, {
      leaseFence: { jobKey: enqueued.jobKey, leaseToken: stalled!.leaseToken! },
    })).rejects.toThrow(IngestionLeaseLostError);
    expect([...storeOf(runtime.persistence).sourceItems.values()].filter((item) => item.sourceId === fixture.source.id && item.externalId === fixture.item.externalId)).toHaveLength(0);
    expect([...storeOf(runtime.persistence).claims.values()].filter((claim) => {
      const item = storeOf(runtime.persistence).sourceItems.get(claim.sourceItemId);
      return item?.externalId === fixture.item.externalId;
    })).toHaveLength(0);
    expect(await runtime.jobQueue.getIngestionJob(enqueued.jobKey)).toMatchObject({ status: "running", lastError: null });
  });

  test("allows ingestion while the fence lease is still held", async () => {
    await runtime.persistence.ensureGame(profile);
    const fixture = await testFixture();
    const enqueued = await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: "gta-vi",
      sourceId: "netflix-tudum",
      url: "https://www.netflix.com/tudum/articles/fenced-success",
      profileId: "gta-vi",
    });
    const leased = await runtime.jobQueue.claimIngestionJob("worker-a", ["source_ingest"], 60_000);
    const result = await processNormalizedItem(runtime.persistence, { ...fixture.item, sourceId: fixture.source.id }, fixture.source, {
      leaseFence: { jobKey: enqueued.jobKey, leaseToken: leased!.leaseToken! },
    });
    expect(result.duplicate).toBe(false);
    expect(result.articleId).not.toBeNull();
    await runtime.jobQueue.completeIngestionJob(leased!.jobKey, leased!.leaseToken!, { disposition: result.disposition });
    expect(await runtime.jobQueue.getIngestionJob(enqueued.jobKey)).toMatchObject({ status: "completed" });
  });

  test("can read the draft by its generated article id", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const result = await processFixture(persistence, fixture, { allowFixture: true });
      const article = await persistence.getArticle(result.articleId!);

      expect(article?.collectionId).toBe("gta-vi");
      expect(article?.status).toBe("draft");
      expect(article?.description).toEndWith("...");
      expect(article?.description).not.toContain("Serie");
      expect(article?.body.sections.map((section) => section.heading)).toEqual(["Evidence", "What remains unknown"]);
    });
  });

  test("converges a URL and a community observation onto one canonical claim", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const urlItem = { ...fixture.item, sourceId: fixture.source.id, inputKind: "url" as const, claims: [] } as NormalizedSourceItem;
      const first = await processNormalizedItem(persistence, urlItem, fixture.source);
      expect(first.articleId).not.toBeNull();

      // The same fact reported through a different transport resolves to the
      // same canonical claim instead of spawning a parallel draft.
      const communitySource = { ...fixture.source, id: "community-observation", sourceStrength: "COMMUNITY" as const, publicationMode: "discussion_only" as const, canonicalUrl: "https://community.example.com", publicCitationUrl: null };
      const communityItem = { ...fixture.item, sourceId: "community-observation", sourceStrength: "COMMUNITY" as const, inputKind: "pasted_text" as const, claims: [], externalId: "external-community", lineageId: "lineage-community" } as NormalizedSourceItem;
      const second = await processNormalizedItem(persistence, communityItem, communitySource);
      expect(second.duplicate).toBe(false);
      expect(second.articleId).toBeNull(); // discussion-only community evidence never becomes a draft

      const store = storeOf(persistence);
      const urlClaim = [...store.claims.values()].find((claim) => claim.sourceItemId === first.sourceItemId);
      const communityClaim = [...store.claims.values()].find((claim) => claim.sourceItemId === second.sourceItemId);
      expect(urlClaim?.canonicalClaimId).toBe(communityClaim?.canonicalClaimId);
      expect(urlClaim?.id).not.toBe(communityClaim?.id);
      expect([...store.canonicalClaims.values()]).toHaveLength(1);
    });
  });

  test("routes a revised high-newsworthiness source to its existing article via canonical identity", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const item = { ...fixture.item, sourceId: fixture.source.id, inputKind: "pasted_text" as const, claims: [] } as NormalizedSourceItem;
      const first = await processNormalizedItem(persistence, item, fixture.source);
      expect(first.disposition).toBe("research_new_article");
      const articleId = first.articleId!;
      expect((await persistence.listArticles("gta-vi")).map((article) => article.id)).toEqual([articleId]);

      // A material change that preserves the same fact resolves to the
      // existing article: update_existing, never a parallel draft.
      const revisedItem = { ...item, text: `${item.text} A materially revised follow-up.` } as NormalizedSourceItem;
      const revised = await processNormalizedItem(persistence, revisedItem, fixture.source);
      expect(revised.duplicate).toBe(false);
      expect(revised.disposition).toBe("update_existing");
      expect(revised.articleId).toBe(articleId);
      expect((await persistence.listArticles("gta-vi")).map((article) => article.id)).toEqual([articleId]);
      const updated = await persistence.getArticle(articleId);
      expect(updated?.title).toBe(item.title);
      // The updated article requires fresh evidence review.
      expect(updated).toMatchObject({ status: "draft", sourceReviewCompleted: false });
    });
  });

  test("reruns analysis when versions change and reprocesses revisions on demand", async () => {
    await inRolledBackTransaction(async (persistence) => {
      await persistence.ensureGame(profile);
      const fixture = await testFixture();
      const item = { ...fixture.item, sourceId: fixture.source.id, inputKind: "pasted_text" as const, claims: [] } as NormalizedSourceItem;
      const first = await processNormalizedItem(persistence, item, fixture.source);
      expect(first.duplicate).toBe(false);
      const revisionId = [...storeOf(persistence).revisions.values()].find((revision) => revision.sourceItemId === first.sourceItemId && revision.isCurrent)!.id;

      // Unchanged content ingested with a newer processing version is not a
      // plain duplicate: the stale run is superseded by a fresh run.
      const newer = await processNormalizedItem(persistence, { ...item, processingVersion: "2.0" } as NormalizedSourceItem, fixture.source);
      expect(newer.duplicate).toBe(true);
      expect(newer.warnings[0]).toContain("analysis rerun");
      let runs = await persistence.listAnalysisRuns(revisionId);
      expect(runs).toHaveLength(2);
      expect(runs.find((run) => run.status === "completed")?.processingVersion).toBe("2.0");
      expect(runs.find((run) => run.status === "superseded")?.processingVersion).toBe(item.processingVersion);

      // The current pipeline versions have not interpreted this revision
      // yet, so an operator-triggered reprocess runs a fresh analysis.
      const reprocessed = await reprocessSourceRevision(persistence, { revisionId, triggeredBy: "test-operator", reason: "verify extractor v1 output" });
      expect(reprocessed.claimCount).toBe(1);
      expect(reprocessed.sourceItemId).toBe(first.sourceItemId);
      runs = await persistence.listAnalysisRuns(revisionId);
      expect(runs).toHaveLength(3);
      const completed = runs.filter((run) => run.status === "completed");
      expect(completed).toHaveLength(1);
      expect(completed[0].claimExtractorVersion).toBe(CLAIM_EXTRACTOR_VERSION);
      expect(runs.filter((run) => run.status === "superseded")).toHaveLength(2);
      await expect(reprocessSourceRevision(persistence, { revisionId, triggeredBy: "test-operator" })).rejects.toThrow("already analyzed");
    });
  });
});