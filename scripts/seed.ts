import { createDb, closeDb, ensureGame } from "@gameintel/db";
import { loadCollectionProfile } from "@gameintel/config";
import { processFixture } from "../services/newsroom/src/pipeline.ts";
import { FixtureSchema } from "../services/newsroom/src/fixture.ts";

const db = createDb();
try {
  const profile = await loadCollectionProfile(new URL("../config/games/gta-vi/profile.json", import.meta.url));
  const fixture = FixtureSchema.parse(await Bun.file(new URL("../fixtures/sources/launch-profile.json", import.meta.url)).json());
  await ensureGame(db, profile);
  const result = await processFixture(db, fixture, { allowFixture: true });
  console.log(`Seeded ${profile.canonicalName}: ${JSON.stringify(result)}`);
} finally {
  await closeDb(db);
}
