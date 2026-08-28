import { publicArticles, createDb, closeDb } from "@gameintel/db";
import { loadProjectConfig } from "@gameintel/config";
import { createPublicOutputArtifact, writeJsonArtifact } from "@gameintel/output";

const db = createDb();
try {
  const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
  const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
  const articles = await publicArticles(db, profileId);
  const output = new URL("../../../apps/web/src/data/publication.json", import.meta.url);
  await writeJsonArtifact(output, createPublicOutputArtifact({ schemaVersion: "1.0", projectId: project.id, profileId, records: articles }));
  console.log(`Wrote ${articles.length} safe article(s) to ${output.pathname}`);
} finally {
  await closeDb(db);
}
