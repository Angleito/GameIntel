import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, test } from "bun:test";
import { GameProfileSchema } from "@gameintel/core";
import { loadCollectionProfile, profilePath } from "@gameintel/config";
import type { GameIntelPersistence, SourceInput } from "@gameintel/contracts";
import { createInMemoryRuntime, InMemoryPersistence, type InMemoryRuntime, type MemoryStore } from "@gameintel/in-memory";
import { loadFixture } from "./fixture.ts";
import { processFixture, processNormalizedItem } from "./pipeline.ts";

const fixturePath = fileURLToPath(new URL("../../../fixtures/sources/software-release.json", import.meta.url));
const profile = GameProfileSchema.parse(await Bun.file(new URL("../../../profiles/software-releases/profile.json", import.meta.url)).json());

let runtime: InMemoryRuntime;

beforeEach(() => {
  runtime = createInMemoryRuntime();
});

function storeOf(persistence: GameIntelPersistence): MemoryStore {
  return (persistence as InMemoryPersistence).store;
}

function storedClaims(persistence: GameIntelPersistence, sourceItemId: string) {
  const store = storeOf(persistence);
  return [...store.claims.values()]
    .filter((claim) => claim.sourceItemId === sourceItemId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

describe("generic-core conformance", () => {
  test("ingests the software-release fixture end-to-end", async () => {
    await runtime.persistence.ensureGame(profile);
    const fixture = await loadFixture(fixturePath);

    const first = await processFixture(runtime.persistence, fixture, { allowFixture: true });
    expect(first.sourceItemId).toBeTruthy();
    expect(first.articleId).not.toBeNull();

    const ids = await runtime.persistence.canonicalClaimIdsForSourceItem(first.sourceItemId);
    expect(ids).toHaveLength(1);

    const claims = storedClaims(runtime.persistence, first.sourceItemId);
    expect(claims).toHaveLength(1);
    const { subject, predicate, value } = claims[0];
    expect(`${subject} ${predicate} ${value}`).not.toMatch(/gta|vehicle|mission/i);
  });

  test("converges a differently-worded second item onto the same canonical claim", async () => {
    await runtime.persistence.ensureGame(profile);
    const fixture = await loadFixture(fixturePath);
    const first = await processFixture(runtime.persistence, fixture, { allowFixture: true });

    const source: SourceInput = { ...fixture.source, enabled: true };
    const variant = {
      ...fixture.item,
      sourceId: fixture.source.id,
      externalId: "release-1.4.0-community",
      url: "urn:example:software-release:1.4.0-community",
      title: "Project 1.4.0 ships export command",
      text: "Community post: the new 1.4.0 release adds an export command and a documented output schema.",
      claims: [{ ...fixture.item.claims[0], qualifiers: { platform: "  ALL  " } }],
    };
    const second = await processNormalizedItem(runtime.persistence, variant, source);

    const firstIds = await runtime.persistence.canonicalClaimIdsForSourceItem(first.sourceItemId);
    const secondIds = await runtime.persistence.canonicalClaimIdsForSourceItem(second.sourceItemId);
    expect(firstIds.some((id) => secondIds.includes(id))).toBe(true);

    const stored = storedClaims(runtime.persistence, second.sourceItemId);
    expect(stored.length).toBeGreaterThan(0);
    // Platform qualifier values keep case by design; the raw "  ALL  " input
    // must be stored in its normalized "ALL" form.
    expect(stored.every((row) => row.qualifiers.platform === "ALL")).toBe(true);
  });

  test("a second profile needs no core changes", async () => {
    const loaded = await loadCollectionProfile(profilePath("software-releases"));
    expect(loaded.id).toBe("software-releases");
    const roundTripped = GameProfileSchema.parse(loaded);
    expect(roundTripped.categories).toEqual(["release", "changelog"]);
  });
});
