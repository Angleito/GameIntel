import { loadCollectionProfile, loadProjectConfig, profilePath } from "@gameintel/config";
import type { SourceInput } from "@gameintel/contracts";
import { InMemoryPersistence } from "@gameintel/in-memory";
import { createOutputArtifact, writeJsonArtifact } from "@gameintel/output";
import { loadFixture } from "../services/newsroom/src/fixture.ts";
import { processFixture, processNormalizedItem } from "../services/newsroom/src/pipeline.ts";
import { createRuntime } from "../services/newsroom/src/runtime.ts";

// Generic-core audit (TASK-001): proves the engine handles a non-game
// profile through configuration only — profile, fixture, ingestion, claim
// convergence, and stored qualifier normalization, with zero game
// vocabulary in the resulting claims.
const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

function recordCheck(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

const runtime = createRuntime("memory");
try {
  const project = await loadProjectConfig(new URL("../config/project.json", import.meta.url));
  const profile = await loadCollectionProfile(profilePath("software-releases"));
  const fixture = await loadFixture(new URL("../fixtures/sources/software-release.json", import.meta.url).pathname);

  await runtime.persistence.ensureGame(profile);
  const first = await processFixture(runtime.persistence, fixture, { allowFixture: true });

  // A differently-worded second item with an unnormalized platform
  // qualifier must converge onto the same canonical claim.
  const variantItem = {
    ...fixture.item,
    sourceId: fixture.source.id,
    externalId: "release-1.4.0-community",
    url: "urn:example:software-release:1.4.0-community",
    title: "Project 1.4.0 ships export command",
    text: "Community post: the new 1.4.0 release adds an export command and a documented output schema.",
    claims: [{ ...fixture.item.claims[0], qualifiers: { platform: "  ALL  " } }],
  };
  const source: SourceInput = { ...fixture.source, enabled: true };
  const second = await processNormalizedItem(runtime.persistence, variantItem, source);

  const firstIds = await runtime.persistence.canonicalClaimIdsForSourceItem(first.sourceItemId);
  const secondIds = await runtime.persistence.canonicalClaimIdsForSourceItem(second.sourceItemId);

  const store = (runtime.persistence as InMemoryPersistence).store;
  const secondClaims = [...store.claims.values()].filter((row) => row.sourceItemId === second.sourceItemId);
  const evidenceByClaim = new Map([...store.evidence.values()].map((row) => [row.claimId, row]));
  const storedTexts = secondClaims.flatMap((row) => [row.subject, row.predicate, row.value, evidenceByClaim.get(row.id)?.excerpt ?? ""]);

  recordCheck(
    "profile-is-non-game",
    profile.id === "software-releases" && !/gta|vehicle|mission/.test(JSON.stringify(profile).toLowerCase()),
    `profile ${profile.id} with categories ${profile.categories.join(", ")}`,
  );
  recordCheck("fixture-produces-draft", first.articleId !== null, `articleId=${first.articleId}`);
  recordCheck(
    "claims-converge-across-items",
    firstIds.some((id) => secondIds.includes(id)),
    `first=${firstIds.length} canonical claim(s), second=${secondIds.length} canonical claim(s)`,
  );
  // Platform values keep their case by design ("PS5", "ALL"); normalization
  // collapses the raw "  ALL  " input to the stored "ALL" form, and canonical
  // identity still converges through canonicalClaimKey's lowercasing.
  recordCheck(
    "stored-qualifiers-normalized",
    secondClaims.length > 0 && secondClaims.every((row) => row.qualifiers.platform === "ALL"),
    JSON.stringify(secondClaims.map((row) => row.qualifiers)),
  );
  recordCheck(
    "no-game-vocabulary-in-claims",
    storedTexts.every((text) => !/gta|vehicle|mission/.test(text.toLowerCase())),
    `checked ${secondClaims.length} stored claim(s)`,
  );

  const output = new URL("../tmp/generic-core-audit.json", import.meta.url);
  await writeJsonArtifact(output, createOutputArtifact({
    schemaVersion: "1.0",
    projectId: project.id,
    profileId: "software-releases",
    records: [{
      kind: "generic-core-audit",
      checks,
      canonicalClaimIds: [...new Set([...firstIds, ...secondIds])],
      articleId: first.articleId,
      profileId: profile.id,
    }],
  }));
  console.log(`Wrote generic-core audit artifact to ${output.pathname}`);

  if (checks.some((check) => !check.passed)) process.exit(1);
} finally {
  await runtime.close();
}
