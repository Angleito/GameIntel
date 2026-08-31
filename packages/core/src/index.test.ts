import { describe, expect, test } from "bun:test";
import {
  canPublish,
  calculateConfidence,
  applicabilityFromQualifiers,
  assembleDiscovery,
  applyActiveBuildChange,
  canonicalClaimKey,
  claimBuildStatus,
  CollectionProfileSchema,
  compareBuildVersions,
  ConditionsSchema,
  deriveClaimState,
  DiscoverySchema,
  dispositionFor,
  effectivePublicationMode,
  evidenceReviewGate,
  evidenceSummaryFor,
  type Evidence,
  GameBuildSchema,
  normalizeQualifiers,
  ReproductionSchema,
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
    expect(deriveClaimState({ supportingFamilies: 0, contradictingFamilies: 0, strongestStrength: "UNVERIFIED", strongestApprovedStrength: "UNVERIFIED", hasCurrentEvidence: false })).toBe("unverified");
    expect(deriveClaimState({ supportingFamilies: 0, contradictingFamilies: 0, strongestStrength: "UNVERIFIED", strongestApprovedStrength: "UNVERIFIED", hasCurrentEvidence: false, hasHistoricalEvidence: true })).toBe("superseded");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "COMMUNITY", strongestApprovedStrength: "UNVERIFIED", hasCurrentEvidence: true })).toBe("supported");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", strongestApprovedStrength: "UNVERIFIED", hasCurrentEvidence: true })).toBe("supported");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", strongestApprovedStrength: "PRIMARY", hasCurrentEvidence: true })).toBe("confirmed");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 1, strongestStrength: "PRIMARY", strongestApprovedStrength: "PRIMARY", hasCurrentEvidence: true })).toBe("contested");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", strongestApprovedStrength: "PRIMARY", hasCurrentEvidence: false, hasHistoricalEvidence: true })).toBe("superseded");
    expect(deriveClaimState({ supportingFamilies: 2, contradictingFamilies: 0, strongestStrength: "PRIMARY", strongestApprovedStrength: "PRIMARY", hasCurrentEvidence: true, retracted: true })).toBe("retracted");
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
    expect(JSON.stringify(toSafeArticle(article))).not.toContain("claim-1");
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
      expect(safe.body.sections[0].paragraphs[0]).not.toHaveProperty("claimIds");
     expect(safe.citations).toEqual([{ number: 1, label: "Community report", url: "https://example.com/report" }]);
   });
});
describe("qualifier vocabulary and build applicability", () => {
  test("normalizes qualifier keys and values deterministically", () => {
    expect(normalizeQualifiers({ " Platform ": "  PS5  " })).toEqual({ platform: "PS5" });
    expect(normalizeQualifiers({ mode: " Online ", time_of_day: " Night ", weather: " Clear " })).toEqual({
      mode: "online",
      time_of_day: "night",
      weather: "clear",
    });
    expect(normalizeQualifiers({ wanted_level: " 3 " })).toEqual({ wanted_level: "3" });
    expect(normalizeQualifiers({ status: " Source-Stated " })).toEqual({ status: "Source-Stated" });
    expect(normalizeQualifiers({ wanted_level: "abc" })).toEqual({ wanted_level: "abc" });
    expect(normalizeQualifiers({ wanted_level: "3.5" })).toEqual({ wanted_level: "3.5" });
  });

  test("canonical claim keys ignore qualifier casing and whitespace", () => {
    const typed = canonicalClaimKey({ subject: "S", predicate: "P", value: "V", qualifiers: { platform: "PS5", time_of_day: "Night" } });
    const sloppy = canonicalClaimKey({ subject: "S", predicate: "P", value: "V", qualifiers: { platform: " PS5 ", time_of_day: "night" } });
    const different = canonicalClaimKey({ subject: "S", predicate: "P", value: "V", qualifiers: { platform: "PS5", time_of_day: "day" } });
    expect(typed).toBe(sloppy);
    expect(typed).not.toBe(different);
  });

  test("derives structured applicability from qualifiers", () => {
    expect(applicabilityFromQualifiers({ platform: "PS5", build: "1.4.0", mode: "Online", mission: "mission_04" })).toEqual({
      platform: "PS5",
      build: "1.4.0",
      mode: "online",
      region: null,
      progressionContext: "mission_04",
    });
    expect(applicabilityFromQualifiers({})).toEqual({ platform: null, build: null, mode: null, region: null, progressionContext: null });
  });

  test("compares build versions segment-wise", () => {
    expect(compareBuildVersions("1.4.0", "1.4.0")).toBe(0);
    expect(compareBuildVersions("1.4.0", "1.10.0")).toBeLessThan(0);
    expect(compareBuildVersions("1.4", "1.4.0")).toBe(0);
  });

  test("classifies claim build status against the current build", () => {
    expect(claimBuildStatus(null, "1.4.0")).toBe("unknown");
    expect(claimBuildStatus("1.4.0", "1.4.0")).toBe("current");
    expect(claimBuildStatus("1.0", "1.4.0")).toBe("superseded");
    expect(claimBuildStatus("1.4.0", null)).toBe("current");
  });

  test("profiles accept a builds registry and default it to empty", () => {
    expect(CollectionProfileSchema.parse({
      id: "test", canonicalName: "Test", aliases: [], version: "1",
      builds: [{ id: "build-1", version: "1.4.0" }],
    }).builds).toEqual([{ id: "build-1", platform: null, mode: null, region: null, version: "1.4.0", releasedAt: null, active: true }]);
    expect(CollectionProfileSchema.parse({ id: "test", canonicalName: "Test", aliases: [], version: "1" }).builds).toEqual([]);
    expect(GameBuildSchema.safeParse({ id: "b", version: "v1.2.3" }).success).toBe(false);
    expect(GameBuildSchema.safeParse({ id: "b", version: "1.2.3-beta" }).success).toBe(false);
    expect(GameBuildSchema.safeParse({ id: "b", version: "1.4" }).success).toBe(true);
  });
});
describe("discovery schema", () => {
  const evidence = (family: string | undefined, lineage: string, type: Evidence["evidenceType"], stance: "supports" | "contradicts" = "supports") => ({
    sourceItemId: "item-1",
    provenanceFamilyId: family,
    stance,
    evidenceType: type,
    excerpt: "Observed under the reported conditions.",
    startMs: null,
    endMs: null,
    lineageId: lineage,
  });
  type EvidenceRow = {
    sourceItemId: string;
    provenanceFamilyId: string | undefined;
    stance: "supports" | "contradicts";
    evidenceType: Evidence["evidenceType"];
    excerpt: string;
    startMs: null;
    endMs: null;
    lineageId: string;
  };
  const claim = (id: string, rows: EvidenceRow[]) => ({
    id,
    collectionId: "gta-vi",
    subject: "Subject",
    predicate: "predicate",
    value: "value",
    qualifiers: {},
    spoilerTags: [],
    exploitClass: null,
    evidenceLevel: "confirmed" as const,
    attributionType: "official" as const,
    statement: null,
    editorialAssessment: null,
    evidence: rows,
  });
  const assemble = (status: "verified" | "needs_retest" | "rejected", builds: string[]) => assembleDiscovery({
    id: "d", collectionId: "gta-vi", gameProfileVersion: "1", canonicalTitle: "T",
    categoryId: "vehicle", summary: "S", status, confidence: 0.9, newsworthiness: 80,
    conditions: ConditionsSchema.parse({}), firstSeenAt: "2026-08-27T00:00:00.000Z", gameBuilds: builds,
    claims: [claim("c1", [evidence("family-a", "lineage-1", "official_document")])],
  });

  test("parses a full discovery document and applies defaults", () => {
    const parsed = DiscoverySchema.parse({
      id: "discovery-1",
      collectionId: "gta-vi",
      gameProfileVersion: "1",
      canonicalTitle: "Rare vehicle at the docks",
      titleSafe: "Rare vehicle at the docks",
      categoryId: "vehicle",
      summary: "A rare vehicle was observed.",
      status: "reported",
      confidence: 0.6,
      newsworthiness: 70,
      conditions: { timeOfDay: "night" },
      firstSeenAt: "2026-08-27T00:00:00.000Z",
      claimIds: ["claim-1"],
      evidenceSummary: { supportingLineages: 1, contradictingLineages: 0, strongestEvidenceType: "community_report" },
    });
    expect(parsed.platforms).toEqual([]);
    expect(parsed.gameBuilds).toEqual([]);
    expect(parsed.spoilerTags).toEqual([]);
    expect(parsed.reproductions).toEqual([]);
    expect(parsed.verifiedAt).toBeNull();
    expect(parsed.conditions).toEqual({ timeOfDay: "night", weather: null, mission: null, wantedLevel: null, inventory: [], mode: null });
  });

  test("counts distinct evidence lineages and picks the strongest supporting type", () => {
    const summary = evidenceSummaryFor([
      claim("claim-1", [
        evidence("family-a", "lineage-1", "community_report"),
        evidence("family-a", "lineage-2", "video_result"),
        evidence(undefined, "lineage-3", "official_document"),
        evidence("family-b", "lineage-4", "screenshot_log", "contradicts"),
        evidence("family-b", "lineage-5", "trusted_reporting", "contradicts"),
      ]),
    ]);
    expect(summary).toEqual({
      supportingLineages: 2,
      contradictingLineages: 1,
      strongestEvidenceType: "official_document",
    });
    expect(evidenceSummaryFor([claim("claim-2", [evidence("family-b", "lineage-6", "community_report", "contradicts")])]).strongestEvidenceType).toBeNull();
  });

  test("derives evidence summary and title defaults when assembling", () => {
    const assembled = assembleDiscovery({
      id: "discovery-2",
      collectionId: "gta-vi",
      gameProfileVersion: "1",
      canonicalTitle: "Title",
      categoryId: "vehicle",
      summary: "Summary",
      status: "verified",
      confidence: 0.9,
      newsworthiness: 80,
      conditions: ConditionsSchema.parse({ mode: "online" }),
      firstSeenAt: "2026-08-27T00:00:00.000Z",
      claims: [claim("claim-1", [evidence("family-a", "lineage-1", "official_document")])],
    });
    expect(assembled.titleSafe).toBe("Title");
    expect(assembled.claimIds).toEqual(["claim-1"]);
    expect(assembled.evidenceSummary).toEqual({ supportingLineages: 1, contradictingLineages: 0, strongestEvidenceType: "official_document" });
    expect(ConditionsSchema.safeParse({ timeOfDay: "night", unknown: "x" }).success).toBe(false);
  });

  test("demotes verified discoveries when an active build supersedes them", () => {
    expect(applyActiveBuildChange(assemble("verified", ["1.0"]), "1.4.0").status).toBe("needs_retest");
    expect(applyActiveBuildChange(assemble("needs_retest", ["1.0"]), "1.4.0").status).toBe("needs_retest");
    expect(applyActiveBuildChange(assemble("rejected", ["1.0"]), "1.4.0").status).toBe("rejected");
    expect(applyActiveBuildChange(assemble("verified", ["1.0"]), "1.0").status).toBe("verified");
    expect(applyActiveBuildChange(assemble("verified", []), "1.4.0").status).toBe("verified");
    expect(applyActiveBuildChange(assemble("verified", ["1.0"]), null).status).toBe("verified");
    expect(applyActiveBuildChange(assemble("verified", ["1.0", "1.4.0"]), "1.4.0").status).toBe("verified");
    expect(applyActiveBuildChange(assemble("verified", ["1.0", "1.4.0"]), "1.5.0").status).toBe("needs_retest");
  });

  test("requires a 64-character lowercase hex steps hash for reproductions", () => {
    expect(ReproductionSchema.safeParse({
      id: "r1", discoveryId: "d1", actorId: "actor-1", outcome: "reproduced",
      stepsHash: "not-a-hash",
    }).success).toBe(false);
    expect(ReproductionSchema.safeParse({
      id: "r1", discoveryId: "d1", actorId: "actor-1", outcome: "reproduced",
      stepsHash: "a".repeat(64),
    }).success).toBe(true);
  });
});
