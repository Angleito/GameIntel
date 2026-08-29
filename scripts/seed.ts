import { loadCollectionProfile, loadProjectConfig, profilePath } from "@gameintel/config";
import { createRuntime } from "../services/newsroom/src/runtime.ts";
import { processFixture } from "../services/newsroom/src/pipeline.ts";
import { FixtureSchema } from "../services/newsroom/src/fixture.ts";

const runtime = createRuntime();
try {
  const project = await loadProjectConfig(new URL("../config/project.json", import.meta.url));
  const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
  const profile = await loadCollectionProfile(profilePath(profileId));
  const fixture = FixtureSchema.parse(await Bun.file(new URL("../fixtures/sources/launch-profile.json", import.meta.url)).json());
  await runtime.persistence.ensureGame(profile);
  const result = await processFixture(runtime.persistence, fixture, { allowFixture: true });
  console.log(`Seeded ${profile.canonicalName}: ${JSON.stringify(result)}`);
} finally {
  await runtime.close();
}