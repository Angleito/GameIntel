import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisVersions, GameIntelPersistence } from "@gameintel/contracts";
import { CLAIM_EXTRACTOR_VERSION, CONFIDENCE_MODEL_VERSION, NORMALIZATION_VERSION, canonicalClaimKey, hashText, lineageFor } from "@gameintel/core";
import { testItem, testPolicy, testProfile, testSourceInput } from "./fixtures.ts";

export type PersistenceFactory = () => Promise<{ persistence: GameIntelPersistence; close?: () => Promise<void> }>;

const testVersions: AnalysisVersions = {
  normalizationVersion: NORMALIZATION_VERSION,
  claimExtractorVersion: CLAIM_EXTRACTOR_VERSION,
  confidenceModelVersion: CONFIDENCE_MODEL_VERSION,
};

// Behavioral contract every persistence adapter must satisfy: source
// revisions, transactions, duplicates, canonical claim identity, analysis
// runs, evidence relationships, publication invalidation, review gates,
// audit behavior.
export function runPersistenceContract(factory: PersistenceFactory): void {
  describe("persistence contract", () => {
    let persistence: GameIntelPersistence;
    let close: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const created = await factory();
      persistence = created.persistence;
      close = created.close;
    });

    afterEach(async () => {
      await close?.();
    });

    async function seeded(): Promise<{ sourceItemId: string; revisionId: string; provenanceFamilyId: string; claimId: string; canonicalClaimId: string }> {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: inserted.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const insertedClaim = await persistence.insertClaim(item, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, item.claims[0], lineageId);
      return { sourceItemId: inserted.id, revisionId: inserted.revisionId, provenanceFamilyId: inserted.provenanceFamilyId, claimId: insertedClaim.claimId, canonicalClaimId: insertedClaim.canonicalClaimId };
    }

    test("stores immutable source revisions and deduplicates unchanged content", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      expect(inserted.duplicate).toBe(false);
      expect(inserted.revisionId).not.toBeNull();
      const duplicate = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      expect(duplicate.duplicate).toBe(true);
      // A duplicate returns the current revision id so the pipeline can
      // decide whether that revision's analysis is up to date.
      expect(duplicate.revisionId).toBe(inserted.revisionId);
      const changed = await persistence.insertSourceItem(
        { ...item, text: `${item.text} Material change.` },
        hashText(`${item.title}\n${item.text} Material change.`),
        lineageId,
        testPolicy(),
        null,
      );
      expect(changed.duplicate).toBe(false);
      expect(changed.materialChange).toBe(true);
      expect(changed.revisionId).not.toBe(inserted.revisionId);
    });

    test("records the processing version on each source revision", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem("contract-source", { processingVersion: "2.3" });
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      expect(inserted.revisionId).not.toBeNull();
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: inserted.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const insertedClaim = await persistence.insertClaim(item, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, item.claims[0], lineageId);
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Versioned article",
        description: "Versioned.",
        body: { summary: "Versioned.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: insertedClaim.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].processingVersion).toBe("2.3");
      const changed = await persistence.insertSourceItem(
        { ...item, text: `${item.text} Reprocessed with a newer pipeline.` },
        hashText(`${item.title}\n${item.text} Reprocessed with a newer pipeline.`),
        lineageId,
        testPolicy(),
        null,
      );
      expect(changed.revisionId).not.toBe(inserted.revisionId);
    });

    test("converges identical normalized claims from different sources onto one canonical claim", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const urlItem = testItem("contract-source", { inputKind: "url", externalId: "external-url-source", lineageId: "lineage-url-source" });
      const textItem = testItem("contract-source", { inputKind: "pasted_text", externalId: "external-text-source", lineageId: "lineage-text-source" });
      const first = await persistence.insertSourceItem(urlItem, hashText(`${urlItem.title}\n${urlItem.text}`), urlItem.lineageId!, testPolicy(), null);
      const second = await persistence.insertSourceItem(textItem, hashText(`${textItem.title}\n${textItem.text}`), textItem.lineageId!, testPolicy(), null);
      const firstRun = await persistence.createAnalysisRun({ sourceItemRevisionId: first.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const secondRun = await persistence.createAnalysisRun({ sourceItemRevisionId: second.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const firstClaim = await persistence.insertClaim(urlItem, first.id, first.revisionId, firstRun.id, first.provenanceFamilyId, urlItem.claims[0], urlItem.lineageId!);
      const secondClaim = await persistence.insertClaim(textItem, second.id, second.revisionId, secondRun.id, second.provenanceFamilyId, textItem.claims[0], textItem.lineageId!);
      // Same normalized fact, different transport kind: same canonical claim.
      expect(firstClaim.canonicalClaimId).toBe(secondClaim.canonicalClaimId);
      expect(firstClaim.claimId).not.toBe(secondClaim.claimId);
      // Confidence aggregates evidence from both member claims.
      const confidence = await persistence.calculateClaimConfidence(firstClaim.claimId);
      expect(confidence).toBeGreaterThan(0);
    });

    test("keeps qualifier-differentiated claims distinct within one source item", async () => {
      const seededResult = await seeded();
      const item = testItem();
      const run = await persistence.getAnalysisRun(seededResult.revisionId, testVersions);
      const qualified = { ...item.claims[0], qualifiers: { time: "night" } };
      const inserted = await persistence.insertClaim(item, seededResult.sourceItemId, seededResult.revisionId, run!.id, seededResult.provenanceFamilyId, qualified, "lineage-qualified");
      expect(inserted.claimId).not.toBe(seededResult.claimId);
      expect(inserted.canonicalClaimId).not.toBe(seededResult.canonicalClaimId);
    });

    test("confirms primary claims only after current evidence approval", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput({ sourceStrength: "PRIMARY" }));
      const item = testItem("contract-source", { sourceStrength: "PRIMARY" });
      const inserted = await persistence.insertSourceItem(item, hashText(`${item.title}\n${item.text}`), item.lineageId!, testPolicy(), null);
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: inserted.revisionId, versions: testVersions, triggerReason: "claim-state-review" });
      const claim = await persistence.insertClaim(item, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, item.claims[0], item.lineageId!);

      expect(await persistence.refreshClaimState(claim.claimId)).toBe("supported");
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Primary claim",
        description: "Primary claim.",
        body: { summary: "Primary claim.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: claim.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      await persistence.reviewEvidence(evidence[0]!.id, "reviewer-a", "approved", "Approves primary evidence");
      expect(await persistence.refreshClaimState(claim.claimId)).toBe("confirmed");
    });

    test("propagates a rejected or disputed review across canonical claim members", async () => {
      const first = await seeded();
      await persistence.ensureSource(testSourceInput({ id: "second-source", canonicalUrl: "https://second.example.com", publicCitationUrl: "https://second.example.com/report" }));
      const sibling = testItem("second-source", { inputKind: "pasted_text", externalId: "external-sibling", lineageId: "lineage-sibling" });
      const inserted = await persistence.insertSourceItem(sibling, hashText(`${sibling.title}\n${sibling.text}`), sibling.lineageId!, testPolicy(), null);
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: inserted.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const siblingClaim = await persistence.insertClaim(sibling, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, sibling.claims[0], sibling.lineageId!);
      expect(siblingClaim.canonicalClaimId).toBe(first.canonicalClaimId);

      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Canonical article",
        description: "Canonical.",
        body: { summary: "Canonical.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: first.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence).toHaveLength(2);
      const ownEvidence = evidence.find((item) => item.claimId === first.claimId)!;
      const siblingEvidence = evidence.find((item) => item.claimId === siblingClaim.claimId)!;
      await persistence.reviewEvidence(ownEvidence.id, "reviewer-a", "approved", "Approves");
      // Unreviewed sibling evidence is editorial attention, not a gate on an
      // article that directly cites the reviewed member claim.
      await persistence.reviewArticle(articleId, "editor", "Editorial review");
      await persistence.approveArticle(articleId, "approver");
      expect((await persistence.getArticle(articleId))?.status).toBe("approved");

      // A dispute on the sibling's evidence (semantically the same claim)
      // demotes the article that only references the first member claim.
      await persistence.reviewEvidence(siblingEvidence.id, "reviewer-b", "disputed", "Conflicting conditions");
      expect(await persistence.getArticle(articleId)).toMatchObject({ status: "draft", sourceReviewCompleted: false, approvedBy: null });
      await expect(persistence.reviewArticle(articleId, "editor", "Blocked")).rejects.toThrow("current evidence approval");
    });

    test("requires current direct evidence for every selected source reference", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      await persistence.ensureSource(testSourceInput({ id: "second-source", canonicalUrl: "https://second.example.com", publicCitationUrl: "https://second.example.com/report" }));
      const sourceA = testItem("contract-source", { externalId: "stale-source-a", lineageId: "stale-lineage-a" });
      const insertedA = await persistence.insertSourceItem(sourceA, hashText(`${sourceA.title}\n${sourceA.text}`), sourceA.lineageId!, testPolicy(), null);
      const runA = await persistence.createAnalysisRun({ sourceItemRevisionId: insertedA.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const claimA = await persistence.insertClaim(sourceA, insertedA.id, insertedA.revisionId, runA.id, insertedA.provenanceFamilyId, sourceA.claims[0], sourceA.lineageId!);
      const sourceB = testItem("second-source", { externalId: "stale-source-b", lineageId: "stale-lineage-b" });
      const insertedB = await persistence.insertSourceItem(sourceB, hashText(`${sourceB.title}\n${sourceB.text}`), sourceB.lineageId!, testPolicy(), null);
      const runB = await persistence.createAnalysisRun({ sourceItemRevisionId: insertedB.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const claimB = await persistence.insertClaim(sourceB, insertedB.id, insertedB.revisionId, runB.id, insertedB.provenanceFamilyId, sourceB.claims[0], sourceB.lineageId!);
      expect(claimB.canonicalClaimId).toBe(claimA.canonicalClaimId);

      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Two source article",
        description: "Two source article.",
        body: { summary: "Two source article.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [
          { sourceId: "contract-source", claimId: claimA.claimId, citationLabel: "Source A", publicCitationUrl: "https://contract.example.com/report" },
          { sourceId: "second-source", claimId: claimB.claimId, citationLabel: "Source B", publicCitationUrl: "https://second.example.com/report" },
        ],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      await persistence.reviewEvidence(evidence.find((item) => item.claimId === claimA.claimId)!.id, "reviewer-a", "approved", "Approves A");
      await persistence.reviewEvidence(evidence.find((item) => item.claimId === claimB.claimId)!.id, "reviewer-a", "approved", "Approves B");
      await persistence.reviewArticle(articleId, "editor", "Editorial review");
      await persistence.approveArticle(articleId, "approver");
      expect((await persistence.getArticle(articleId))?.status).toBe("approved");

      const claimY = { ...sourceA.claims[0], value: "an unrelated revised observation" };
      const changedA = { ...sourceA, text: `${sourceA.text} Materially revised.`, claims: [claimY] };
      const changed = await persistence.insertSourceItem(changedA, hashText(`${changedA.title}\n${changedA.text}`), sourceA.lineageId!, testPolicy(), null);
      expect(changed.materialChange).toBe(true);
      const changedRun = await persistence.createAnalysisRun({ sourceItemRevisionId: changed.revisionId, versions: testVersions, triggerReason: "material-change" });
      const changedClaim = await persistence.insertClaim(changedA, changed.id, changed.revisionId, changedRun.id, changed.provenanceFamilyId, claimY, sourceA.lineageId!);
      await persistence.refreshArticlesForCanonicalClaims([claimA.canonicalClaimId, changedClaim.canonicalClaimId], "analysis_run.completed", "Source A changed from X to Y");

      expect(await persistence.getArticle(articleId)).toMatchObject({ status: "draft", sourceReviewCompleted: false, approvedBy: null });
      await expect(persistence.reviewArticle(articleId, "editor", "Stale citation")).rejects.toThrow("current evidence approval");
    });

    test("analysis runs are idempotent per version tuple and supersede prior runs on rerun", async () => {
      const seededResult = await seeded();
      const rerun = await persistence.getAnalysisRun(seededResult.revisionId, testVersions);
      expect(rerun).not.toBeNull();
      const runs = await persistence.listAnalysisRuns(seededResult.revisionId);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("completed");

      const newVersions: AnalysisVersions = { ...testVersions, claimExtractorVersion: "2" };
      const rerunRun = await persistence.createAnalysisRun({ sourceItemRevisionId: seededResult.revisionId, versions: newVersions, triggeredBy: "operator", triggerReason: "extractor-upgrade" });
      expect(rerunRun.claimExtractorVersion).toBe("2");
      const after = await persistence.listAnalysisRuns(seededResult.revisionId);
      expect(after).toHaveLength(2);
      expect(after.find((run) => run.status === "completed")?.id).toBe(rerunRun.id);
      expect(after.find((run) => run.status === "superseded")?.id).toBe(runs[0].id);
      // Same version tuple is idempotent.
      const again = await persistence.getAnalysisRun(seededResult.revisionId, newVersions);
      expect(again?.id).toBe(rerunRun.id);
    });

    test("reprocessing a revision binds new evidence to the new run and supersedes the old", async () => {
      const seededResult = await seeded();
      const item = testItem();
      const initialRun = await persistence.getAnalysisRun(seededResult.revisionId, testVersions);
      const insertedClaim = await persistence.insertClaim(item, seededResult.sourceItemId, seededResult.revisionId, initialRun!.id, seededResult.provenanceFamilyId, item.claims[0], "lineage-rerun");
      expect(insertedClaim.claimId).toBe(seededResult.claimId);
      expect(insertedClaim.canonicalClaimId).toBe(seededResult.canonicalClaimId);

      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Rerun article",
        description: "Rerun.",
        body: { summary: "Rerun.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: seededResult.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      expect(await persistence.listArticleEvidence(articleId)).toHaveLength(1);
      const versionBump: AnalysisVersions = { ...testVersions, confidenceModelVersion: "2" };
      const rerunRun = await persistence.createAnalysisRun({ sourceItemRevisionId: seededResult.revisionId, versions: versionBump, triggeredBy: "operator", triggerReason: "confidence-model-upgrade" });
      await persistence.insertClaim(item, seededResult.sourceItemId, seededResult.revisionId, rerunRun.id, seededResult.provenanceFamilyId, item.claims[0], "lineage-rerun-2");
      // The old evidence row still exists but is no longer current.
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence).toHaveLength(2);
      expect(evidence.filter((row) => row.current)).toHaveLength(1);
      await persistence.refreshArticlesForCanonicalClaims([seededResult.canonicalClaimId], "analysis_run.completed", "Rerun refresh");
      expect(await persistence.getArticle(articleId)).toMatchObject({ status: "draft", sourceReviewCompleted: false });
    });

    test("resolves an existing article from canonical claim identity and supports update_existing", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: inserted.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const claim = await persistence.insertClaim(item, inserted.id, inserted.revisionId, run.id, inserted.provenanceFamilyId, item.claims[0], lineageId);
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Resolvable article",
        description: "Resolvable.",
        body: { summary: "Resolvable.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: claim.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      expect(await persistence.resolveExistingArticleForCanonicalClaims([claim.canonicalClaimId])).toBe(articleId);
      expect(await persistence.resolveExistingArticleForCanonicalClaims([canonicalClaimKey({ subject: "Unrelated", predicate: "is", value: "nothing" })])).toBeNull();

      // A material change to the same source item produces a different
      // claim; update_existing replaces the article's references for that
      // source item with the new claim.
      const changedItem = { ...item, text: `${item.text} Revised observation.` } as typeof item;
      changedItem.claims = [{ ...item.claims[0], value: "a different observation" }];
      const changed = await persistence.insertSourceItem(changedItem, hashText(`${changedItem.title}\n${changedItem.text}`), lineageId, testPolicy(), null);
      expect(changed.materialChange).toBe(true);
      const changedRun = await persistence.createAnalysisRun({ sourceItemRevisionId: changed.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const changedClaim = await persistence.insertClaim(changedItem, changed.id, changed.revisionId, changedRun.id, changed.provenanceFamilyId, changedItem.claims[0], lineageId);
      expect(changedClaim.canonicalClaimId).not.toBe(claim.canonicalClaimId);
      await persistence.updateExistingArticle({
        articleId,
        sourceItemId: changed.id,
        body: { summary: "Resolved.", sections: [], unknowns: [] },
        sourceRefs: [{ sourceId: "contract-source", claimId: changedClaim.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const updated = await persistence.getArticle(articleId);
      expect(updated).toMatchObject({ title: "Resolvable article", status: "draft" });
      // The old reference was replaced; only the revised claim's evidence remains.
      expect((await persistence.listArticleEvidence(articleId)).map((row) => row.claimId)).toEqual([changedClaim.claimId]);
    });

    test("rolls back all writes when the transaction callback throws", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem("contract-source", { externalId: "external-rollback" });
      const rawHash = hashText(`${item.title}\n${item.text}`);
      await expect(persistence.transaction(async (transaction) => {
        await transaction.insertSourceItem(item, rawHash, lineageFor(item), testPolicy(), null);
        throw new Error("rollback");
      })).rejects.toThrow("rollback");
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageFor(item), testPolicy(), null);
      expect(inserted.duplicate).toBe(false);
      expect(inserted.revisionId).not.toBeNull();
    });

    test("commits transaction writes on success", async () => {
      const item = testItem("contract-source", { externalId: "external-committed" });
      const rawHash = hashText(`${item.title}\n${item.text}`);
      await persistence.transaction(async (transaction) => {
        await transaction.ensureGame(testProfile());
        await transaction.ensureSource(testSourceInput());
        await transaction.insertSourceItem(item, rawHash, lineageFor(item), testPolicy(), null);
      });
      const committed = await persistence.insertSourceItem(item, rawHash, lineageFor(item), testPolicy(), null);
      expect(committed.duplicate).toBe(true);
    });

    test("links evidence to claims and supports the publication review flow", async () => {
      const seededResult = await seeded();
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Contract test article",
        description: "A contract test article.",
        body: {
          summary: "A contract test summary.",
          sections: [
            { heading: "Evidence", paragraphs: [{ text: "Verified observation.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [seededResult.claimId], editorialAssessment: null }], publicSafe: true, spoilerTags: [] },
            { heading: "Internal note", paragraphs: [{ text: "Editorial-only detail.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [], editorialAssessment: null }], publicSafe: false, spoilerTags: [] },
            { heading: "Spoiler section", paragraphs: [{ text: "Spoiler detail.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [], editorialAssessment: null }], publicSafe: true, spoilerTags: ["spoiler"] },
          ],
          unknowns: [],
        },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: seededResult.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      expect(await persistence.getPublicArticle(articleId)).toBeNull();
      const evidence = await persistence.listArticleEvidence(articleId);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].current).toBe(true);

      await expect(persistence.reviewArticle(articleId, "editor", "Review")).rejects.toThrow("current evidence approval");
      await persistence.reviewEvidence(evidence[0].id, "reviewer-a", "approved", "Supports the claim");
      await persistence.reviewArticle(articleId, "editor", "Review complete");
      await persistence.approveArticle(articleId, "approver");
      const published = await persistence.markPublished(articleId, "publisher");
      expect(published.status).toBe("published");
      const publicArticles = await persistence.listPublicArticles("contract-test");
      expect(publicArticles).toHaveLength(1);
      const safe = publicArticles[0] as { title: string; citations: Array<{ number: number; label: string; url: string }>; body: { sections: Array<{ heading: string }> } };
      expect(safe.title).toBe("Contract test article");
      expect(safe.citations).toEqual([{ number: 1, label: "Contract source", url: "https://contract.example.com/report" }]);
      expect(safe.body.sections.map((section) => section.heading)).toEqual(["Evidence"]);
      const safeSingle = await persistence.getPublicArticle(articleId);
      expect(safeSingle).not.toBeNull();
      expect(JSON.stringify(safeSingle)).not.toContain("Internal note");
      expect(JSON.stringify(safeSingle)).not.toContain("Spoiler section");
      expect(JSON.stringify(safeSingle)).not.toContain("approvedBy");
      expect(safeSingle!.citations).toEqual([{ number: 1, label: "Contract source", url: "https://contract.example.com/report" }]);
      expect(safeSingle!.body.sections.every((section) => section.publicSafe && section.spoilerTags.length === 0)).toBe(true);
      const raw = await persistence.getArticle(articleId);
      expect(JSON.stringify(raw?.body)).toContain("Internal note");
    });

    test("keeps the public surface in sync with post-publication cover changes", async () => {
      const seededResult = await seeded();
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Cover sync article",
        description: "Cover sync.",
        body: {
          summary: "Cover sync.",
          sections: [{ heading: "Evidence", paragraphs: [{ text: "Verified observation.", evidenceLevel: "suspected", attributionType: "trusted_secondary", claimIds: [seededResult.claimId], editorialAssessment: null }], publicSafe: true, spoilerTags: [] }],
          unknowns: [],
        },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: seededResult.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      await persistence.reviewEvidence(evidence[0].id, "reviewer-a", "approved", "Supports the claim");
      await persistence.reviewArticle(articleId, "editor", "Review complete");
      await persistence.approveArticle(articleId, "approver");
      await persistence.markPublished(articleId, "publisher");
      expect((await persistence.getPublicArticle(articleId))?.coverMedia).toBeNull();

      const directory = await mkdtemp(join(tmpdir(), "gameintel-cover-"));
      const catalogPath = join(directory, "catalog.json");
      await writeFile(catalogPath, JSON.stringify({
        media: [{
          id: "media-contract-cover", collectionId: "contract-test", collection: "Screenshots", caption: "Cover", altText: "Cover alt",
          tags: ["official"], spoilerTags: [], attribution: "Contract", sourceUrl: "https://contract.example.com/src.jpg",
          sourcePageUrl: "https://contract.example.com/page", originalKey: "originals/x", displayKey: "display/x",
          publicUrl: "https://media.example.com/x.jpg", contentType: "image/jpeg", width: 10, height: 10, checksum: "a".repeat(64),
        }],
      }));
      try {
        await persistence.importMediaCatalog(catalogPath);
        await persistence.approveMediaAsset("media-contract-cover", "editor");
        await persistence.setCoverMedia(articleId, "media-contract-cover", "editor");
        await persistence.approveCoverMedia(articleId, "editor");
        expect((await persistence.getPublicArticle(articleId))?.coverMedia?.id).toBe("media-contract-cover");
        expect((await persistence.getArticle(articleId))?.coverMedia?.reviewStatus).toBe("approved");

        await persistence.rejectCoverMedia(articleId, "editor");
        expect((await persistence.getArticle(articleId))?.coverMedia?.reviewStatus).toBe("rejected");
        expect((await persistence.getPublicArticle(articleId))?.coverMedia).toBeNull();

        await persistence.setCoverMedia(articleId, "media-contract-cover", "editor");
        await persistence.approveCoverMedia(articleId, "editor");
        expect((await persistence.getPublicArticle(articleId))?.coverMedia?.id).toBe("media-contract-cover");

        await persistence.clearCoverMedia(articleId);
        expect((await persistence.getArticle(articleId))?.coverMedia).toBeNull();
        expect((await persistence.getPublicArticle(articleId))?.coverMedia).toBeNull();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });

    test("blocks publication while any reviewer rejects or disputes evidence", async () => {
      const seededResult = await seeded();
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Disputed article",
        description: "Disputed.",
        body: { summary: "Disputed.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId: seededResult.claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      await persistence.reviewEvidence(evidence[0].id, "reviewer-a", "approved", "Approves");
      await persistence.reviewArticle(articleId, "editor", "Editorial review");
      await persistence.approveArticle(articleId, "approver");
      await persistence.reviewEvidence(evidence[0].id, "reviewer-b", "disputed", "Conflicting conditions");
      const article = await persistence.getArticle(articleId);
      expect(article).toMatchObject({ status: "draft", sourceReviewCompleted: false, approvedBy: null });
      await expect(persistence.reviewArticle(articleId, "editor", "Blocked")).rejects.toThrow("current evidence approval");
    });

    test("invalidates stale publication eligibility when source material changes", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const lineageId = lineageFor(item);
      const first = await persistence.insertSourceItem(item, hashText(`${item.title}\n${item.text}`), lineageId, testPolicy(), null);
      const run = await persistence.createAnalysisRun({ sourceItemRevisionId: first.revisionId, versions: testVersions, triggerReason: "contract-test" });
      const insertedClaim = await persistence.insertClaim(item, first.id, first.revisionId, run.id, first.provenanceFamilyId, item.claims[0], lineageId);
      const claimId = insertedClaim.claimId;
      const articleId = await persistence.createArticleDraft({
        collectionId: "contract-test",
        title: "Staleness article",
        description: "Staleness.",
        body: { summary: "Staleness.", sections: [], unknowns: [] },
        newsworthiness: 0.5,
        confidence: 0.5,
        sourceRefs: [{ sourceId: "contract-source", claimId, citationLabel: "Contract source", publicCitationUrl: "https://contract.example.com/report" }],
      });
      const evidence = await persistence.listArticleEvidence(articleId);
      for (const evidenceItem of evidence) await persistence.reviewEvidence(evidenceItem.id, "reviewer-a", "approved", "Initial approval");
      await persistence.reviewArticle(articleId, "editor", "Initial review");
      await persistence.approveArticle(articleId, "approver");
      expect((await persistence.getArticle(articleId))?.status).toBe("approved");

      const changed = await persistence.insertSourceItem(
        { ...item, text: `${item.text} The source was materially revised.` },
        hashText(`${item.title}\n${item.text} The source was materially revised.`),
        lineageId,
        testPolicy(),
        null,
      );
      expect(changed.materialChange).toBe(true);
      await persistence.invalidateEvidenceApprovalsForSourceItem(first.id);
      const invalidated = await persistence.getArticle(articleId);
      expect(invalidated).toMatchObject({ status: "draft", sourceReviewCompleted: false, approvedBy: null });
      await expect(persistence.markPublished(articleId, "publisher")).rejects.toThrow("approved articles");
    });

    test("initializes source provenance with original/lineage semantics and updates it on linking", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      const provenance = await persistence.getSourceItemProvenance(inserted.id);
      expect(provenance).toMatchObject({ relationship: "original", clusteringMethod: "lineage" });
      expect(provenance?.provenanceFamilyId).toBe(inserted.provenanceFamilyId);

      const changed = await persistence.insertSourceItem(
        { ...item, text: `${item.text} Material change.` },
        hashText(`${item.title}\n${item.text} Material change.`),
        lineageId,
        testPolicy(),
        null,
      );
      expect(await persistence.getSourceItemProvenance(changed.id)).toMatchObject({ relationship: "original", clusteringMethod: "lineage" });

      const other = testItem("contract-source", { externalId: "external-provenance-link", lineageId: `lineage-other-${Date.now()}` });
      const otherInserted = await persistence.insertSourceItem(other, hashText(`${other.title}\n${other.text}`), other.lineageId!, testPolicy(), null);
      await persistence.linkSourceItemProvenance({
        sourceItemId: inserted.id,
        relatedSourceItemId: otherInserted.id,
        relationship: "copied_from",
        reviewerId: "provenance-reviewer",
        notes: "Copies the original report.",
      });
      const linked = await persistence.getSourceItemProvenance(inserted.id);
      expect(linked?.relationship).toBe("copied_from");
      expect(linked?.provenanceFamilyId).toBe(otherInserted.provenanceFamilyId);
    });

    test("records audit entries for operator actions", async () => {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      await persistence.audit("operator-a", "test.action", "source", "contract-source", "Audit contract check");
      const articles = await persistence.listArticles("contract-test");
      expect(articles).toHaveLength(0);
      expect(await persistence.getArticle("missing")).toBeNull();
    });

    test("quarantines public submissions and purges expired ones", async () => {
      await persistence.ensureGame(testProfile());
      const input = {
        submission: {
          collectionId: "contract-test" as const,
          title: "Community report",
          report: "A community report for the contract test.",
          urls: ["https://example.com/community-report"],
          mediaRefs: [] as Array<{ uploadId: string }>,
        },
        submitterSessionHash: "a".repeat(64),
        submitterIpHash: "b".repeat(64),
        retentionDays: 1,
      };
      const first = await persistence.createQuarantinedSubmission(input);
      const duplicate = await persistence.createQuarantinedSubmission(input);
      expect(first.duplicate).toBe(false);
      expect(duplicate).toEqual({ id: first.id, duplicate: true });
      const listed = await persistence.listPublicSubmissionsForModeration("contract-test");
      expect(listed).toHaveLength(1);
      expect(listed[0].state).toBe("quarantined");
      expect(JSON.stringify(listed[0])).not.toContain("a".repeat(64));
      expect(await persistence.getPublicSubmissionForModeration(first.id)).toMatchObject({ state: "quarantined" });
      expect((await persistence.listPublicSubmissionModerationActions(first.id)).map((action) => action.action)).toEqual(["submitted"]);
    });
  });
}
