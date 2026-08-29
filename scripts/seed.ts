import { loadCollectionProfile } from "@gameintel/config";
import { createRuntime } from "../services/newsroom/src/runtime.ts";
import { processFixture } from "../services/newsroom/src/pipeline.ts";
import { FixtureSchema } from "../services/newsroom/src/fixture.ts";

const runtime = createRuntime();
try {
  const profile = await loadCollectionProfile(new URL("../config/games/gta-vi/profile.json", import.meta.url));
  const fixture = FixtureSchema.parse(await Bun.file(new URL("../fixtures/sources/launch-profile.json", import.meta.url)).json());
  await runtime.persistence.ensureGame(profile);
  const result = await processFixture(runtime.persistence, fixture, { allowFixture: true });
  console.log(`Seeded ${profile.canonicalName}: ${JSON.stringify(result)}`);
} finally {
  await runtime.close();
}