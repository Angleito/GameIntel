import { describe, expect, test } from "bun:test";
import { canPublish, dispositionFor, PublicHttpUrlSchema, scoreNewsworthiness, toSafeArticle } from "./index";

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
