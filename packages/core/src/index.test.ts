import { describe, expect, test } from "bun:test";
import {
  canPublish,
  calculateConfidence,
  deriveClaimState,
  dispositionFor,
  effectivePublicationMode,
  evidenceReviewGate,
  PublicSubmissionReviewDecisionSchema,
  PublicSubmissionSchema,
  PublicSubmissionStateSchema,
  PublicHttpUrlSchema,
  scoreNewsworthiness,
  toSafeArticle,
  trustClassificationFor,
} from "./index";

describe("editorial rules", () => {
  test("scores and dispositions deterministically", () => {
    expect(scoreNewsworthiness({
       sourceAuthority: 1, novelty: 1, readerUsefulness: 1, collectionRelevance: 1,
      newInformation: 1, confirmationStrength: 1, communityInterest: 1, searchInterest: 1,
    })).toBe(1);
    expect(dispositionFor(0.2, null)).toBe("ignore");
    expect(dispositionFor(0.8, null)).toBe("research_new_article");
    expect(dispositionFor(0.8, "article-1")).toBe("update_existing");
  });

  test("requires every human publication gate", () => {
    expect(canPublish({ sourceReviewCompleted: true, editorReviewCompleted: true, articleSourcesComplete: true, approvedBy: "operator" })).toBe(true);
    expect(canPublish({ sourceReviewCompleted: true, editorReviewCompleted: true, articleSourcesComplete: false, approvedBy: "operator" })).toBe(false);
  });

  test("classifies every source strength deterministically", () => {
    expect(trustClassificationFor("PRIMARY")).toEqual({
      attributionType: "official",
      evidenceType: "official_document",
      initialPublicationMode: "normal",
    });
    expect(trustClassificationFor("DIRECT_EVIDENCE")).toEqual({
      attributionType: "direct_evidence",
      evidenceType: "independent_reproduction",
      initialPublicationMode: "normal",
    });
    expect(trustClassificationFor("TRUSTED_SECONDARY")).toEqual({
      attributionType: "trusted_secondary",
      evidenceType: "trusted_reporting",
      initialPublicationMode: "normal",
    });
    expect(trustClassificationFor("COMMUNITY")).toEqual({
      attributionType: "community",
      evidenceType: "community_report",
      initialPublicationMode: "discussion_only",
    });
    expect(trustClassificationFor("UNVERIFIED")).toEqual({
      attributionType: "unverified",
      evidenceType: "community_report",
      initialPublicationMode: "discussion_only",
    });
  });

  test("never gives community strengths a normal publication mode", () => {
    expect(effectivePublicationMode("COMMUNITY", "normal")).toBe("discussion_only");
    expect(effectivePublicationMode("UNVERIFIED", "normal")).toBe("discussion_only");
    expect(effectivePublicationMode("PRIMARY", "blocked")).toBe("blocked");
  });

  test("derives claim states from evidence and revision currency", () => {
    expect(deriveClaimState({ supportingFamilies: 0, contradictingFamilies: 0, strongestStrength: "UNVERIFIED", hasCurrentEvidence: false })).toBe("unverified");
    expect(deriveClaimState({ supportingFamilies: 0, contradictingFamilies: 0, strongestStrength: "UNVERIFIED", hasCurrentEvidence: false, hasHistoricalEvidence: true })).toBe("superseded");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "COMMUNITY", hasCurrentEvidence: true })).toBe("supported");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", hasCurrentEvidence: true })).toBe("confirmed");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 1, strongestStrength: "PRIMARY", hasCurrentEvidence: true })).toBe("contested");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", hasCurrentEvidence: false, hasHistoricalEvidence: true })).toBe("superseded");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", hasCurrentEvidence: true, retracted: true })).toBe("retracted");
  });

  test("blocks evidence from publication while any reviewer disputes or rejects it", () => {
    const vote = (reviewerId: string, decision: "approved" | "rejected" | "disputed", createdAt = 1) => ({ reviewerId, decision, createdAt });
    const policy = { minimumApprovals: 1 };

    expect(evidenceReviewGate([vote("a", "approved")], policy)).toEqual({ eligible: true, approvedCount: 1, blockedBy: null });
    expect(evidenceReviewGate([vote("a", "approved"), vote("b", "disputed")], policy)).toEqual({ eligible: false, approvedCount: 1, blockedBy: "disputed" });
    expect(evidenceReviewGate([vote("a", "approved"), vote("b", "rejected")], policy)).toEqual({ eligible: false, approvedCount: 1, blockedBy: "rejected" });

    const resolved = evidenceReviewGate([
      vote("a", "approved", 1),
      vote("b", "disputed", 2),
      vote("b", "approved", 3),
    ], policy);
    expect(resolved).toEqual({ eligible: true, approvedCount: 2, blockedBy: null });

    const rescinded = evidenceReviewGate([
      vote("a", "approved", 1),
      vote("b", "approved", 2),
      vote("b", "rejected", 3),
    ], { minimumApprovals: 2 });
    expect(rescinded).toEqual({ eligible: false, approvedCount: 1, blockedBy: "rejected" });
  });

  test("rejects public attempts to set trust or publication fields", () => {
    expect(PublicSubmissionSchema.safeParse({
      collectionId: "gta-vi",
      report: "Rare vehicle appears behind Ocean Hotel around midnight.",
      sourceStrength: "TRUSTED_SECONDARY",
    }).success).toBe(false);
    expect(PublicSubmissionSchema.parse({
      collectionId: "gta-vi",
      report: "Rare vehicle appears behind Ocean Hotel around midnight.",
      urls: ["https://example.com/report"],
    })).toEqual({
      collectionId: "gta-vi",
      report: "Rare vehicle appears behind Ocean Hotel around midnight.",
      urls: ["https://example.com/report"],
      mediaRefs: [],
    });
  });

  test("limits submission review state changes to non-promotion decisions", () => {
    expect(PublicSubmissionStateSchema.parse("under_review")).toBe("under_review");
    expect(PublicSubmissionReviewDecisionSchema.safeParse("promoted").success).toBe(false);
    expect(PublicSubmissionReviewDecisionSchema.parse("blocked")).toBe("blocked");
  });

  test("counts independent provenance families instead of repeated reports", () => {
    const evidence = (familyId: string, stance: "supports" | "contradicts" = "supports") => ({
      sourceItemId: `${familyId}-item`,
      provenanceFamilyId: familyId,
      stance,
      evidenceType: "independent_reproduction" as const,
      excerpt: "Observed under the reported conditions.",
      startMs: null,
      endMs: null,
      lineageId: `${familyId}-lineage`,
    });
    const oneFamily = calculateConfidence("COMMUNITY", [evidence("original")]);
    const copiedTenTimes = calculateConfidence("COMMUNITY", Array.from({ length: 10 }, () => evidence("original")));
    const independentReproduction = calculateConfidence("COMMUNITY", [evidence("original"), evidence("reproduction")]);
    const contradiction = calculateConfidence("COMMUNITY", [evidence("original"), evidence("failed-reproduction", "contradicts")]);

    expect(copiedTenTimes).toBe(oneFamily);
    expect(independentReproduction).toBeGreaterThan(oneFamily);
    expect(contradiction).toBeLessThan(oneFamily);
  });

  test("accepts only credential-free HTTP(S) URLs at public boundaries", () => {
    expect(PublicHttpUrlSchema.safeParse("https://example.com/source").success).toBe(true);
    expect(PublicHttpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(PublicHttpUrlSchema.safeParse("https://user:password@example.com/source").success).toBe(false);
  });

  test("removes spoiler sections from safe output", () => {
    const article = {
       id: "a", collectionId: "gta-vi", slug: "safe", title: "Safe", seoTitle: "Safe", description: "Desc",
      body: { summary: "Summary", sections: [
         { heading: "Confirmed", paragraphs: [{ text: "Visible", evidenceLevel: "confirmed" as const, attributionType: "official" as const, claimIds: ["claim-1"], editorialAssessment: null }], publicSafe: true, spoilerTags: [] },
         { heading: "Reveal", paragraphs: [{ text: "Hidden", evidenceLevel: "suspected" as const, attributionType: "community" as const, claimIds: ["claim-2"], editorialAssessment: null }], publicSafe: false, spoilerTags: ["story_event"] },
      ], unknowns: [] }, status: "approved" as const, newsworthiness: 0.8, confidence: 0.8,
      sourceReviewCompleted: true, editorReviewCompleted: true, articleSourcesComplete: true,
      sourceRefs: [{ sourceId: "s", claimId: null, citationLabel: "Official source", publicCitationUrl: "https://example.com/news" }],
      approvedBy: "operator", coverMedia: null, publishedAt: null, updatedAt: null,
    };
    expect(toSafeArticle(article)?.body.sections).toHaveLength(1);
  });

  test("withholds URLs and markup from generated public text", () => {
    const article = {
       id: "a", collectionId: "gta-vi", slug: "safe", title: "<b>Safe</b>", seoTitle: "Safe", description: "Read https://leak.example/file",
       body: { summary: "Summary https://leak.example/file", sections: [{ heading: "Confirmed", paragraphs: [{ text: "<script>bad</script>Official result", evidenceLevel: "confirmed" as const, attributionType: "official" as const, claimIds: [], editorialAssessment: null }], publicSafe: true, spoilerTags: [] }], unknowns: [] },
      status: "approved" as const, newsworthiness: 0.8, confidence: 0.8, sourceReviewCompleted: true, editorReviewCompleted: true,
       articleSourcesComplete: true, sourceRefs: [{ sourceId: "s", claimId: null, citationLabel: "Official", publicCitationUrl: "https://example.com" }], approvedBy: "operator", coverMedia: null, publishedAt: null, updatedAt: null,
    };
    const safe = toSafeArticle(article)!;
    expect(JSON.stringify(safe)).not.toContain("leak.example");
     expect(safe.body.sections[0].paragraphs[0].text).toBe("badOfficial result");
     expect(safe).not.toHaveProperty("confidence");
   });

   test("keeps evidence language and citation references on each fact", () => {
     const article = {
       id: "a", collectionId: "gta-vi", slug: "evidence", title: "Evidence", seoTitle: "Evidence", description: "Desc",
       body: { summary: "Summary", sections: [{ heading: "Evidence", paragraphs: [{
         text: "Many reports claim that Trevor Philips from GTA V has been spotted in Amborisa.",
         evidenceLevel: "suspected" as const, attributionType: "community" as const, claimIds: ["claim-1"],
         editorialAssessment: "GameIntel.gg has not found sufficient evidence to support this claim.",
       }], publicSafe: true, spoilerTags: [] }], unknowns: [] },
       status: "approved" as const, newsworthiness: 0.8, confidence: 0.8, sourceReviewCompleted: true, editorReviewCompleted: true,
        articleSourcesComplete: true, sourceRefs: [{ sourceId: "s", claimId: "claim-1", citationLabel: "Community report", publicCitationUrl: "https://example.com/report" }], approvedBy: "operator", coverMedia: null, publishedAt: null, updatedAt: null,
     };
     const safe = toSafeArticle(article)!;
     expect(safe.body.sections[0].paragraphs[0]).toMatchObject({
       text: "Many reports claim that Trevor Philips from GTA V has been spotted in Amborisa.",
       evidenceLevel: "suspected",
       editorialAssessment: "GameIntel.gg has not found sufficient evidence to support this claim.",
       citations: [1],
     });
     expect(safe.citations).toEqual([{ number: 1, label: "Community report", url: "https://example.com/report" }]);
   });
});
