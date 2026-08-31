import { describe, expect, test } from "bun:test";
import {
  CLAIM_EXTRACTOR_VERSION,
  NORMALIZATION_VERSION,
  buildApplicability,
  canonicalClaimKey,
  claimsPotentiallyContradict,
  defaultOntology,
  entityIdFor,
  mergedOntology,
  normalizeEntityName,
  normalizePredicate,
  normalizeQualifiers,
  resolveMention,
  validateClaimAgainstOntology,
} from "./index.ts";

describe("ontology vocabulary", () => {
  test("normalizePredicate converges casing, spacing, and punctuation", () => {
    expect(normalizePredicate("spawns at")).toBe("SPAWNS_AT");
    expect(normalizePredicate("SPAWNS_AT")).toBe("SPAWNS_AT");
    expect(normalizePredicate(" spawns_at! ")).toBe("SPAWNS_AT");
  });

  test("normalizeEntityName and entityIdFor derive stable slugs", () => {
    expect(normalizeEntityName("Grotti Turismo Omaggio")).toBe("grotti turismo omaggio");
    expect(entityIdFor("vehicle", "Grotti Turismo Omaggio")).toBe("vehicle:grotti-turismo-omaggio");
    expect(entityIdFor("location", "- Casino, Parking -- Lot -")).toBe("location:casino-parking-lot");
  });

  test("resolveMention matches canonical names and aliases exactly", () => {
    const candidates = [
      { id: "vehicle:turismo", canonicalName: "Grotti Turismo Omaggio", aliases: ["Turismo", "Grotti Turismo"] },
      { id: "location:casino", canonicalName: "Casino Parking Lot", aliases: [] },
    ];
    expect(resolveMention(candidates, "Turismo")).toEqual({ status: "resolved", entityId: "vehicle:turismo", candidates: ["vehicle:turismo"] });
    expect(resolveMention(candidates, "grotti turismo omaggio")).toEqual({ status: "resolved", entityId: "vehicle:turismo", candidates: ["vehicle:turismo"] });
    expect(resolveMention(candidates, "Unknown Thing")).toEqual({ status: "unresolved", entityId: null, candidates: [] });
    expect(resolveMention(candidates, "Casino")).toEqual({ status: "unresolved", entityId: null, candidates: [] });
    const duplicated = [...candidates, { id: "vehicle:turismo-2", canonicalName: "Turismo", aliases: [] }];
    expect(resolveMention(duplicated, "turismo")).toEqual({ status: "ambiguous", entityId: null, candidates: ["vehicle:turismo", "vehicle:turismo-2"] });
  });

  test("defaultOntology and mergedOntology keep core vocabulary and add profile types", () => {
    const ontology = defaultOntology();
    expect(ontology.entityTypes).toContain("vehicle");
    expect(ontology.predicates.map((predicate) => predicate.id)).toContain("SPAWNS_AT");
    const merged = mergedOntology({ entityTypes: ["safehouse", "heist"], predicates: [] });
    expect(merged.entityTypes).toContain("vehicle");
    expect(merged.entityTypes).toContain("safehouse");
    const withPredicate = mergedOntology({ entityTypes: [], predicates: [{ id: "DRIFTS_IN", subjectTypes: ["vehicle"], objectTypes: ["location"] }] });
    expect(withPredicate.predicates.map((predicate) => predicate.id)).toEqual(expect.arrayContaining(["SPAWNS_AT", "DRIFTS_IN"]));
  });

  test("validateClaimAgainstOntology respects subject, object, literal, and wildcard types", () => {
    const ontology = defaultOntology();
    expect(validateClaimAgainstOntology({ predicate: "SPAWNS_AT", subjectType: "vehicle", objectType: "location", ontology })).toEqual([]);
    expect(validateClaimAgainstOntology({ predicate: "SPAWNS_AT", subjectType: "location", objectType: "location", ontology })).toHaveLength(1);
    expect(validateClaimAgainstOntology({ predicate: "SPAWNS_AT", subjectType: "vehicle", objectType: "vehicle", ontology })).toHaveLength(1);
    expect(validateClaimAgainstOntology({ predicate: "NOPE_AT", subjectType: "vehicle", objectType: "location", ontology })[0]).toContain("not in the ontology");
    expect(validateClaimAgainstOntology({ predicate: "REPORTS", subjectType: "vehicle", objectType: null, ontology })).toEqual([]);
    expect(validateClaimAgainstOntology({ predicate: "REQUIRES", subjectType: "vehicle", objectType: "weapon", ontology })).toEqual([]);
  });

  test("qualifier normalizers handle booleans and snake_case values", () => {
    expect(normalizeQualifiers({ online: "Yes" })).toEqual({ online: "true" });
    expect(normalizeQualifiers({ online: "NO" })).toEqual({ online: "false" });
    expect(normalizeQualifiers({ game_mode: "Online Mode" })).toEqual({ game_mode: "online_mode" });
    expect(normalizeQualifiers({ multiplayer: "1" })).toEqual({ multiplayer: "true" });
  });

  test("version constants are bumped for the semantic claim model", () => {
    expect(NORMALIZATION_VERSION).toBe("2");
    expect(CLAIM_EXTRACTOR_VERSION).toBe("2");
  });
});

describe("canonical claim identity", () => {
  test("entity ids make display-text spelling irrelevant", () => {
    const a = canonicalClaimKey({ subject: "Turismo", subjectEntityId: "vehicle:turismo", predicate: "SPAWNS_AT", value: "Casino", objectEntityId: "location:casino", qualifiers: {} });
    const b = canonicalClaimKey({ subject: "Grotti Turismo Omaggio", subjectEntityId: "vehicle:turismo", predicate: "SPAWNS_AT", value: "Vice City casino parking lot", objectEntityId: "location:casino", qualifiers: {} });
    expect(a).toBe(b);
    const textOnly = canonicalClaimKey({ subject: "Grotti Turismo Omaggio", predicate: "SPAWNS_AT", value: "Vice City casino parking lot", qualifiers: {} });
    expect(textOnly).not.toBe(a);
  });

  test("predicate case and spacing do not split identities", () => {
    expect(canonicalClaimKey({ subject: "A", predicate: "spawns at", value: "B", qualifiers: {} }))
      .toBe(canonicalClaimKey({ subject: "A", predicate: "SPAWNS_AT", value: "B", qualifiers: {} }));
  });
});

describe("build applicability", () => {
  test("matrix of current, historical, superseded, unknown", () => {
    const range = { validBuildFrom: "1.04", validBuildTo: "1.05" };
    expect(buildApplicability(range, null)).toBe("unknown");
    expect(buildApplicability({ validBuildFrom: null, validBuildTo: null }, "1.05")).toBe("unknown");
    expect(buildApplicability(range, "1.04")).toBe("current");
    expect(buildApplicability(range, "1.05")).toBe("current");
    expect(buildApplicability(range, "1.03")).toBe("historical");
    expect(buildApplicability(range, "1.06")).toBe("superseded");
    expect(buildApplicability({ validBuildFrom: null, validBuildTo: "1.05" }, "1.06")).toBe("superseded");
    expect(buildApplicability({ validBuildFrom: "1.04", validBuildTo: null }, "1.03")).toBe("historical");
  });
});

describe("claim contradiction", () => {
  const supports = (overrides: Partial<Parameters<typeof claimsPotentiallyContradict>[0]> = {}) => ({
    subjectEntityId: "vehicle:x",
    subject: "X",
    predicate: "SPAWNS_AT",
    objectEntityId: "location:y",
    value: "Y",
    qualifiers: {},
    stance: "supports" as const,
    ...overrides,
  });

  test("same triple, opposite stances is a contradiction", () => {
    expect(claimsPotentiallyContradict(supports(), supports({ stance: "contradicts" }))).toBe("contradiction");
  });

  test("build-qualifier-only differences are a build change, not a contradiction", () => {
    expect(claimsPotentiallyContradict(supports({ qualifiers: { build: "1.04" } }), supports({ qualifiers: { build: "1.05" }, stance: "contradicts" }))).toBe("build_change");
    expect(claimsPotentiallyContradict(supports({ qualifiers: { patch: "p1" } }), supports({ qualifiers: { patch: "p2" }, stance: "contradicts" }))).toBe("build_change");
    expect(claimsPotentiallyContradict(supports({ qualifiers: { build: "1.04" } }), supports({ qualifiers: { time_of_day: "night" }, stance: "contradicts" }))).toBe("contradiction");
  });

  test("different object or same stance is distinct", () => {
    expect(claimsPotentiallyContradict(supports(), supports({ objectEntityId: "location:z", value: "Z" }))).toBe("distinct");
    expect(claimsPotentiallyContradict(supports(), supports())).toBe("distinct");
    // Opposite stances where neither is "contradicts" still contradict per
    // the plan: only same-stance pairs are distinct.
    expect(claimsPotentiallyContradict(supports(), supports({ stance: "context" }))).toBe("contradiction");
  });
});
