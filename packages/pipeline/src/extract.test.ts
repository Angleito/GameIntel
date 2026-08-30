import { describe, expect, test } from "bun:test";
import { CLAIM_EXTRACTOR_VERSION, canonicalClaimKey, canonicalizeClaimText } from "@gameintel/core";
import { extractClaims } from "./extract.ts";

describe("versioned claim extraction", () => {
  test("extracts a single candidate claim from the first sentence of URL content", () => {
    const claims = extractClaims({
      title: "GTA VI Trailer 2 Release Date",
      text: "Rockstar confirms the second trailer arrives next week. The trailer debuts on the official channel.",
      inputKind: "url",
      claims: [],
    }, "TRUSTED_SECONDARY");
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      subject: "GTA VI Trailer 2 Release Date",
      predicate: "reports",
      value: "Rockstar confirms the second trailer arrives next week.",
      qualifiers: {},
      stance: "supports",
      evidenceType: "trusted_reporting",
      attributionType: "trusted_secondary",
    });
    expect(claims[0].evidenceLevel).toBe("suspected");
  });

  test("keeps qualifiers strictly semantic; transport details stay out", () => {
    const url = extractClaims({ title: "Vehicle", text: "A rare vehicle spawned near the docks.", inputKind: "url", claims: [] }, "COMMUNITY");
    const pasted = extractClaims({ title: "Vehicle", text: "A rare vehicle spawned near the docks.", inputKind: "pasted_text", claims: [] }, "COMMUNITY");
    // Different transport kinds converge on the same canonical identity.
    expect(canonicalClaimKey({ subject: url[0].subject, predicate: url[0].predicate, value: url[0].value, qualifiers: url[0].qualifiers }))
      .toBe(canonicalClaimKey({ subject: pasted[0].subject, predicate: pasted[0].predicate, value: pasted[0].value, qualifiers: pasted[0].qualifiers }));
    expect(url[0].qualifiers).toEqual({});
  });

  test("does not extract from manually curated fixtures or empty content", () => {
    expect(extractClaims({ title: "Fixture", text: "Curated by an operator.", inputKind: "manual_fixture", claims: [] }, "PRIMARY")).toEqual([]);
    expect(extractClaims({ title: "Empty", text: "", inputKind: "url", claims: [] }, "PRIMARY")).toEqual([]);
    expect(extractClaims({ title: "Curated", text: "Provided claims win.", inputKind: "url", claims: [{ subject: "s", predicate: "p", value: "v", qualifiers: {}, spoilerTags: [], exploitClass: null, evidenceLevel: "suspected", attributionType: "trusted_secondary", statement: null, editorialAssessment: null, stance: "supports", evidenceType: "trusted_reporting", excerpt: "v", startMs: null, endMs: null }] }, "PRIMARY"))
      .toHaveLength(1);
  });
});

describe("canonical claim keys", () => {
  test("normalizes case, whitespace, and trailing punctuation", () => {
    expect(canonicalClaimKey({ subject: "GTA VI", predicate: "reports", value: "Trailer two arrives next week." }))
      .toBe(canonicalClaimKey({ subject: "  gta vi ", predicate: "reports", value: "Trailer two arrives next week" }));
  });

  test("orders qualifier keys deterministically and includes them in identity", () => {
    const withQualifiers = canonicalClaimKey({ subject: "Vehicle", predicate: "spawns at", value: "the docks", qualifiers: { platform: "pc", time: "night" } });
    const sameQualifiers = canonicalClaimKey({ subject: "Vehicle", predicate: "spawns at", value: "the docks", qualifiers: { time: "night", platform: "pc" } });
    const differentQualifiers = canonicalClaimKey({ subject: "Vehicle", predicate: "spawns at", value: "the docks", qualifiers: { time: "day" } });
    expect(withQualifiers).toBe(sameQualifiers);
    expect(withQualifiers).not.toBe(differentQualifiers);
  });

  test("distinguishes different values and normalizes subject text", () => {
    expect(canonicalizeClaimText("  GTA VI  Trailer. ")).toBe("gta vi trailer");
    expect(canonicalClaimKey({ subject: "A", predicate: "reports", value: "x" })).not.toBe(canonicalClaimKey({ subject: "A", predicate: "reports", value: "y" }));
  });

  test("exports the extractor version used by analysis runs", () => {
    expect(CLAIM_EXTRACTOR_VERSION).toBe("1");
  });
});