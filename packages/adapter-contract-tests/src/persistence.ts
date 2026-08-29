import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GameIntelPersistence } from "@gameintel/contracts";
import { hashText, lineageFor } from "@gameintel/core";
import { testItem, testPolicy, testProfile, testSourceInput } from "./fixtures.ts";

export type PersistenceFactory = () => Promise<{ persistence: GameIntelPersistence; close?: () => Promise<void> }>;

// Behavioral contract every persistence adapter must satisfy: source
// revisions, transactions, duplicates, evidence relationships, publication
// invalidation, review gates, audit behavior.
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

    async function seeded(): Promise<{ sourceItemId: string; revisionId: string; provenanceFamilyId: string; claimId: string }> {
      await persistence.ensureGame(testProfile());
      await persistence.ensureSource(testSourceInput());
      const item = testItem();
      const rawHash = hashText(`${item.title}\n${item.text}`);
      const lineageId = lineageFor(item);
      const inserted = await persistence.insertSourceItem(item, rawHash, lineageId, testPolicy(), null);
      if (!inserted.revisionId) throw new Error("Expected a source revision");
      const claimId = await persistence.insertClaim(item, inserted.id, inserted.revisionId, inserted.provenanceFamilyId, item.claims[0], lineageId);
      return { sourceItemId: inserted.id, revisionId: inserted.revisionId, provenanceFamilyId: inserted.provenanceFamilyId, claimId };
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
      expect(duplicate.revisionId).toBeNull();
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
      const publicArticles = await persistence.publicArticles("contract-test");
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
      if (!first.revisionId) throw new Error("Expected a source revision");
      const claimId = await persistence.insertClaim(item, first.id, first.revisionId, first.provenanceFamilyId, item.claims[0], lineageId);
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