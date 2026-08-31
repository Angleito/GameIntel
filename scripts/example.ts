import { prepareIngestion } from "@gameintel/pipeline";
import { createOutputArtifact, writeJsonArtifact } from "@gameintel/output";
import { loadFixture } from "../services/newsroom/src/fixture.ts";

const fixture = await loadFixture(new URL("../fixtures/sources/software-release.json", import.meta.url).pathname);
const prepared = prepareIngestion({ ...fixture.item, sourceId: fixture.source.id }, {
  sourceAuthority: 1,
  novelty: 0.8,
  readerUsefulness: 0.8,
  collectionRelevance: 1,
  newInformation: 0.9,
  confirmationStrength: 1,
  communityInterest: 0.1,
  searchInterest: 0.2,
});
const output = new URL("../tmp/software-release-output.json", import.meta.url);
await writeJsonArtifact(output, createOutputArtifact({
  schemaVersion: "1.0",
  projectId: "gameintelgg",
  profileId: prepared.item.collectionId,
  records: [{ kind: "source-item", item: prepared.item, rawHash: prepared.rawHash, lineageId: prepared.lineageId, newsworthiness: prepared.newsworthiness, disposition: prepared.disposition }],
}));
console.log(`Wrote generic ingestion example to ${output.pathname}`);
