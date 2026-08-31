import { beforeEach, describe, expect, test } from "bun:test";
import {
  GameProfileSchema,
  NORMALIZATION_VERSION,
  type NormalizedSourceItem,
} from "@gameintel/core";
import type { GameIntelPersistence, SourceInput } from "@gameintel/contracts";
import { createInMemoryRuntime, InMemoryPersistence, type InMemoryRuntime, type MemoryStore } from "@gameintel/in-memory";
import type { AiRuntime, LlmSemanticClaim } from "@gameintel/agent-runtime";
import { processNormalizedItem } from "./pipeline.ts";
import { generateGuide } from "./guides.ts";

const profilePath = new URL("../../../profiles/gta-vi/profile.json", import.meta.url);
const profile = GameProfileSchema.parse(await Bun.file(profilePath).json());

let runtime: InMemoryRuntime;

beforeEach(() => {
  runtime = createInMemoryRuntime();
});

function storeOf(persistence: GameIntelPersistence): MemoryStore {
  return (persistence as InMemoryPersistence).store;
}

// The Phase 8 demo catalog plus the alias the resolution scenarios rely on.
async function seedWorld(persistence: GameIntelPersistence): Promise<void> {
  await persistence.ensureGame(profile);
  await persistence.upsertEntity({ id: "vehicle:turismo-omaggio", collectionId: profile.id, type: "vehicle", canonicalName: "Grotti Turismo Omaggio", aliases: ["Turismo", "Grotti Turismo", "Turismo Omaggio"], properties: { acquisition_cost: "0", available_early: "true" } });
  await persistence.upsertEntity({ collectionId: profile.id, type: "location", canonicalName: "Casino Parking Lot", aliases: ["Vice City casino parking lot"], coordinates: { x: 100, y: 200 } });
  await persistence.upsertEntity({ collectionId: profile.id, type: "location", canonicalName: "Vice City Airport", coordinates: { x: 300, y: 400 } });
  await persistence.upsertEntity({ collectionId: profile.id, type: "region", canonicalName: "Vice City", aliases: ["VC"] });
  await persistence.upsertEntity({ collectionId: profile.id, type: "patch", canonicalName: "1.04", aliases: ["Patch 1.04"], properties: { build: "1.04" } });
  await persistence.upsertEntity({ collectionId: profile.id, type: "patch", canonicalName: "1.05", aliases: ["Patch 1.05"], properties: { build: "1.05" } });
  await persistence.upsertEntity({ collectionId: profile.id, type: "platform", canonicalName: "PS5", aliases: ["PlayStation 5"] });
  await persistence.upsertEntity({ collectionId: profile.id, type: "platform", canonicalName: "PC", aliases: ["Windows"] });
}

type TestClaim = NormalizedSourceItem["claims"][number];

function claim(input: Partial<TestClaim> & { subject: string; predicate: string; value: string }): TestClaim {
  return {
    subjectEntityId: null,
    objectEntityId: null,
    validBuildFrom: null,
    validBuildTo: null,
    qualifiers: {},
    spoilerTags: [],
    exploitClass: null,
    evidenceLevel: "suspected",
    attributionType: "trusted_secondary",
    statement: null,
    editorialAssessment: null,
    stance: "supports",
    evidenceType: "trusted_reporting",
    excerpt: "Ontology test observation.",
    startMs: null,
    endMs: null,
    ...input,
  };
}

const testPolicy = {
  accessMode: "manual" as const,
  requestsPerMinute: 1,
  retainRawTextDays: 7,
  mayStoreFullText: false,
  attributionRequired: true,
  termsReviewedAt: null,
  evidenceReview: { minimumApprovals: 1, preventSubmitterApproval: true },
};

async function ingestClaims(persistence: GameIntelPersistence, claims: TestClaim[], options: { inputKind?: "pasted_text" | "local_file" | "url"; ai?: AiRuntime | null; lineageId?: string | null; articleSource?: boolean } = {}): Promise<{ sourceItemId: string; claimIds: string[]; canonicalClaimIds: string[]; warnings: string[] }> {
  await persistence.ensureGame(profile);
  const sourceId = `ontology-source-${crypto.randomUUID().slice(0, 8)}`;
  const source: SourceInput = {
    id: sourceId,
    type: "manual",
    canonicalUrl: `https://ontology.example.com/${sourceId}`,
    publicCitationUrl: options.articleSource ? `https://ontology.example.com/${sourceId}/citation` : null,
    sourceStrength: "TRUSTED_SECONDARY",
    publicationMode: options.articleSource ? "normal" : "discussion_only",
    policy: testPolicy,
    enabled: true,
  };
  const item: NormalizedSourceItem = {
    sourceId,
    collectionId: profile.id,
    externalId: `ext-${crypto.randomUUID()}`,
    url: `urn:ontology:${sourceId}`,
    title: `Ontology test item ${crypto.randomUUID().slice(0, 8)}`,
    text: "Ontology test item text with a night-time observation.",
    sourceStrength: "TRUSTED_SECONDARY",
    publicationMode: options.articleSource ? "normal" : "discussion_only",
    discoveredAt: new Date().toISOString(),
    publishedAt: null,
    lineageId: options.lineageId ?? null,
    inputKind: options.inputKind ?? "pasted_text",
    contentType: "text/plain",
    language: "en",
    processingVersion: NORMALIZATION_VERSION,
    claims,
  };
  const result = await processNormalizedItem(persistence, item, source, { ai: options.ai ?? null });
  const store = storeOf(persistence);
  const inserted = [...store.claims.values()].filter((candidate) => candidate.sourceItemId === result.sourceItemId);
  return {
    sourceItemId: result.sourceItemId,
    claimIds: inserted.map((candidate) => candidate.id),
    canonicalClaimIds: inserted.map((candidate) => candidate.canonicalClaimId ?? candidate.id),
    warnings: result.warnings,
  };
}

describe("ontology newsroom", () => {
  test("resolves mentions, guards alias collisions, and never auto-creates entities", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const resolved = await persistence.resolveEntityMention(profile.id, "Turismo");
    expect(resolved).toMatchObject({ status: "resolved", entityId: "vehicle:turismo-omaggio" });
    await expect(persistence.upsertEntity({ collectionId: profile.id, type: "vehicle", canonicalName: "Turismo" })).rejects.toThrow(/alias already belongs to entity/i);
    const unknown = await persistence.resolveEntityMention(profile.id, "Unknown Thing");
    expect(unknown).toMatchObject({ status: "unresolved", entityId: null, entity: null });
    expect((await persistence.listEntities(profile.id)).map((entity) => entity.id)).not.toContain("vehicle:unknown-thing");
  });

  test("links pipeline claims to entities through resolution", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const result = await ingestClaims(persistence, [
      claim({ subject: "Turismo Omaggio", predicate: "SPAWNS_AT", value: "Casino Parking Lot" }),
    ]);
    const store = storeOf(persistence);
    const stored = [...store.claims.values()].find((candidate) => candidate.id === result.claimIds[0])!;
    expect(stored.subjectEntityId).toBe("vehicle:turismo-omaggio");
    expect(stored.objectEntityId).toBe("location:casino-parking-lot");
  });

  test("semantic dedup: different wording with the same entities converges on one canonical claim", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const first = await ingestClaims(persistence, [
      claim({ subject: "Turismo", predicate: "spawns at", value: "Casino Parking Lot", qualifiers: { time_of_day: "night" } }),
    ]);
    const second = await ingestClaims(persistence, [
      claim({ subject: "Grotti Turismo Omaggio", predicate: "SPAWNS_AT", value: "Vice City casino parking lot", qualifiers: { time_of_day: "Night" } }),
    ]);
    expect(second.canonicalClaimIds[0]).toBe(first.canonicalClaimIds[0]);
    // The observations remain distinct claims under one canonical identity.
    expect(second.claimIds[0]).not.toBe(first.claimIds[0]);
    const explanation = await persistence.explainClaim(first.claimIds[0]);
    expect(explanation?.claim.canonicalClaimId).toBe(first.canonicalClaimIds[0]);
  });

  test("qualifiers keep distinct identities: night vs day, build 1.04 vs 1.05", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const night = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { time_of_day: "night" } })]);
    const day = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { time_of_day: "day" } })]);
    expect(day.canonicalClaimIds[0]).not.toBe(night.canonicalClaimIds[0]);
    const build104 = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { build: "1.04" } })]);
    const build105 = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { build: "1.05" } })]);
    expect(build105.canonicalClaimIds[0]).not.toBe(build104.canonicalClaimIds[0]);
  });

  test("AI drafting failure degrades to a non-fatal warning and never blocks ingestion", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const failingAi: AiRuntime = {
      draft: async () => {
        throw new Error("provider unavailable");
      },
      extract: async () => null,
    };
    const result = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })], { ai: failingAi, articleSource: true });
    expect(result.sourceItemId).toBeTruthy();
    expect(result.claimIds).toHaveLength(1);
    expect(result.warnings).toContain("AI drafting failed: provider unavailable");
  });

  test("LLM extraction normalizes into the same model and falls back deterministically", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const semantic: LlmSemanticClaim = {
      subject: { type: "vehicle", name: "Grotti Turismo Omaggio" },
      predicate: "spawns at",
      object: { type: "location", name: "Casino Parking Lot" },
      qualifiers: { time_of_day: "Night" },
      stance: "supports",
      validBuildFrom: null,
      validBuildTo: null,
    };
    const fakeAi: AiRuntime = {
      draft: async () => null,
      extract: async () => [semantic],
    };
    const result = await ingestClaims(persistence, [], { ai: fakeAi });
    const store = storeOf(persistence);
    const stored = [...store.claims.values()].find((candidate) => candidate.id === result.claimIds[0])!;
    expect(stored.subject).toBe("Grotti Turismo Omaggio");
    expect(stored.predicate).toBe("spawns at");
    expect(stored.subjectEntityId).toBe("vehicle:turismo-omaggio");
    expect(stored.objectEntityId).toBe("location:casino-parking-lot");
    expect(stored.qualifiers).toEqual({ time_of_day: "night" });
    expect(stored.evidenceLevel).toBe("suspected");

    const nullAi: AiRuntime = { draft: async () => null, extract: async () => null };
    const fallback = await ingestClaims(persistence, [], { ai: nullAi });
    const fallbackClaim = [...storeOf(persistence).claims.values()].find((candidate) => candidate.id === fallback.claimIds[0])!;
    expect(fallbackClaim.predicate).toBe("reports");
    expect(fallbackClaim.subjectEntityId).toBeNull();
  });

  test("ontology validation gates entity linking by predicate types", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const valid = await ingestClaims(persistence, [
      claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" }),
    ]);
    const invalid = await ingestClaims(persistence, [
      // A location cannot spawn at anything per SPAWNS_AT's subjectTypes.
      claim({ subject: "Casino Parking Lot", predicate: "SPAWNS_AT", value: "Vice City Airport" }),
    ]);
    const store = storeOf(persistence);
    const validClaim = [...store.claims.values()].find((candidate) => candidate.id === valid.claimIds[0])!;
    const invalidClaim = [...store.claims.values()].find((candidate) => candidate.id === invalid.claimIds[0])!;
    expect(validClaim.subjectEntityId).toBe("vehicle:turismo-omaggio");
    expect(validClaim.objectEntityId).toBe("location:casino-parking-lot");
    expect(invalidClaim.subjectEntityId).toBeNull();
    expect(invalidClaim.objectEntityId).toBeNull();
  });

  test("provenance families aggregate in explainClaim", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const shared = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })], { lineageId: "shared-lineage" });
    const lineage = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })], { lineageId: "shared-lineage" });
    // Same lineage -> one family.
    const explanation = await persistence.explainClaim(shared.claimIds[0]);
    expect(explanation?.provenanceFamilies).toHaveLength(1);
    expect(explanation?.evidence).toHaveLength(2);
    // Different lineage -> two families.
    const item: NormalizedSourceItem = {
      sourceId: `ontology-source-${crypto.randomUUID().slice(0, 8)}`,
      collectionId: profile.id,
      externalId: `ext-${crypto.randomUUID()}`,
      url: `urn:ontology:lineage`,
      title: "Lineage item",
      text: "Lineage item text.",
      sourceStrength: "TRUSTED_SECONDARY",
      publicationMode: "discussion_only",
      discoveredAt: new Date().toISOString(),
      publishedAt: null,
      lineageId: "independent-lineage",
      inputKind: "pasted_text",
      contentType: "text/plain",
      language: "en",
      processingVersion: NORMALIZATION_VERSION,
      claims: [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })],
    };
    const source: SourceInput = {
      id: item.sourceId,
      type: "manual",
      canonicalUrl: `https://ontology.example.com/${item.sourceId}`,
      publicCitationUrl: null,
      sourceStrength: "TRUSTED_SECONDARY",
      publicationMode: "discussion_only",
      policy: testPolicy,
      enabled: true,
    };
    await processNormalizedItem(persistence, item, source, { ai: null });
    const after = await persistence.explainClaim(shared.claimIds[0]);
    expect(after?.provenanceFamilies).toHaveLength(2);
  });

  test("contradicting members contest a claim; build-differing members are build changes", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const supports = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })]);
    const contradicts = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", stance: "contradicts" })]);
    await persistence.refreshClaimState(supports.claimIds[0]);
    expect((await persistence.getClaim(supports.claimIds[0]))?.state).toBe("contested");
    const explanation = await persistence.explainClaim(supports.claimIds[0]);
    expect(explanation?.contradictions.some((contradiction) => contradiction.kind === "contradiction")).toBe(true);

    const build104 = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { build: "1.04" } })]);
    const build105 = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", qualifiers: { build: "1.05" }, stance: "contradicts" })]);
    const buildExplanation = await persistence.explainClaim(build104.claimIds[0]);
    expect(buildExplanation?.contradictions.some((contradiction) => contradiction.kind === "build_change")).toBe(true);
  });

  test("patch supersession: valid-build ranges and change claims answer what changed", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    await persistence.upsertEntity({ collectionId: profile.id, type: "vehicle", canonicalName: "Vapid A" });
    const spawn = await ingestClaims(persistence, [
      claim({ subject: "Vapid A", predicate: "SPAWNS_AT", value: "Casino Parking Lot", validBuildTo: "1.04" }),
    ]);
    await persistence.setClaimBuildRange(spawn.claimIds[0], { to: "1.04" });
    const change = await ingestClaims(persistence, [
      claim({ subject: "Vapid A", predicate: "REMOVED_BY", value: "Patch 1.05", qualifiers: { aspect: "spawn" } }),
    ]);
    const at104 = await persistence.findClaimsByBuild(profile.id, "1.04");
    expect(at104.find((row) => row.id === spawn.claimIds[0])?.buildApplicability).toBe("current");
    const at105 = await persistence.findClaimsByBuild(profile.id, "1.05");
    expect(at105.find((row) => row.id === spawn.claimIds[0])?.buildApplicability).toBe("superseded");
    const changed = await persistence.findRelationships({ collectionId: profile.id, objectEntityId: "patch:1-05" });
    expect(changed.map((row) => row.claimId)).toContain(change.claimIds[0]);
    expect(changed.find((row) => row.claimId === change.claimIds[0])?.predicate).toBe("REMOVED_BY");
  });

  test("unknown builds report unknown applicability", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const result = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })]);
    const atUnknown = await persistence.findRelationships({ collectionId: profile.id, predicate: "SPAWNS_AT", build: "9.99" });
    expect(atUnknown[0].buildApplicability).toBe("unknown");
    expect(result.claimIds).toHaveLength(1);
  });

  test("multi-hop traversal through getEntityRelationships", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    await persistence.upsertEntity({ collectionId: profile.id, type: "mission", canonicalName: "First Contact" });
    const unlock = await ingestClaims(persistence, [claim({ subject: "First Contact", predicate: "UNLOCKS", value: "Turismo Omaggio" })]);
    const spawn = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })]);
    const oneHop = await persistence.getEntityRelationships("mission:first-contact", { collectionId: profile.id, hops: 1 });
    expect(oneHop.map((row) => row.claimId)).toEqual([unlock.claimIds[0]]);
    const twoHops = await persistence.getEntityRelationships("mission:first-contact", { collectionId: profile.id, hops: 2 });
    expect(twoHops.map((row) => row.claimId)).toEqual(expect.arrayContaining([unlock.claimIds[0], spawn.claimIds[0]]));
    expect(twoHops.find((row) => row.claimId === spawn.claimIds[0])?.hops).toBe(2);
  });

  test("map projection follows claim state and filters retracted markers", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const result = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })]);
    const markers = await persistence.getMapProjection(profile.id);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      claimId: result.claimIds[0],
      coordinates: { x: 100, y: 200 },
      state: "supported",
    });
    // A contradicting member contests the claim; the marker reflects it.
    await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", stance: "contradicts" })]);
    await persistence.refreshClaimState(result.claimIds[0]);
    expect((await persistence.getMapProjection(profile.id))[0].state).toBe("contested");
  });

  test("guide projection: generate, publish, and the article dependency re-verified", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    await persistence.upsertEntity({ collectionId: profile.id, type: "vehicle", canonicalName: "Vapid A" });
    await ingestClaims(persistence, [
      claim({ subject: "Vapid A", predicate: "SPAWNS_AT", value: "Casino Parking Lot" }),
      claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" }),
    ]);
    const guide = await generateGuide(persistence, {
      id: "turismo-guide",
      title: "Turismo guide",
      description: "Where the Turismo spawns.",
      query: { subjectType: "vehicle", properties: { acquisition_cost: "0" }, minState: "unverified", build: null },
      sections: [{ heading: "Spawns", text: "Casino parking lot." }],
    }, profile.id);
    expect(guide.claimCount).toBe(1);
    const guideClaims = await persistence.listGuideClaims(guide.guideId);
    expect(guideClaims).toHaveLength(1);
    expect(guideClaims[0].subject).toBe("Turismo");
    const published = await persistence.publishGuide(guide.guideId, "operator");
    expect(published.status).toBe("published");
  });

  test("publication invalidation demotes guides when a referenced claim is disputed", async () => {
    const persistence = runtime.persistence;
    await seedWorld(persistence);
    const result = await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot" })]);
    await persistence.refreshClaimState(result.claimIds[0]);
    const guideId = await persistence.createGuideDraft({
      collectionId: profile.id,
      title: "Turismo guide",
      description: "Where the Turismo spawns.",
      spec: { id: "turismo-guide", title: "Turismo guide", description: "Where the Turismo spawns.", query: { subjectType: "vehicle", properties: {}, minState: "supported", build: null }, sections: [] },
      claimRefs: result.claimIds,
    });
    expect((await persistence.publishGuide(guideId, "operator")).status).toBe("published");
    // A contradicting member contests the claim; the guide demotes and the
    // publication boundary blocks re-publishing until the claim recovers.
    await ingestClaims(persistence, [claim({ subject: "Turismo", predicate: "SPAWNS_AT", value: "Casino Parking Lot", stance: "contradicts" })]);
    await persistence.refreshClaimState(result.claimIds[0]);
    await persistence.refreshPublicationsForCanonicalClaims(result.canonicalClaimIds, "evidence_review.disputed", "Ontology invalidation test");
    expect((await persistence.getGuide(guideId))?.status).toBe("draft");
    await expect(persistence.publishGuide(guideId, "operator")).rejects.toThrow(/cannot be published/);
  });
});
