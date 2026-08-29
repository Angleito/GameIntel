import { loadProjectConfig } from "@gameintel/config";
import { createPublicOutputArtifact, writeJsonArtifact } from "@gameintel/output";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";

const runtime = createServiceRuntime();
try {
  const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
  const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
  const articles = await runtime.persistence.publicArticles(profileId);
  const output = new URL("../../../apps/web/src/data/publication.json", import.meta.url);
  await writeJsonArtifact(output, createPublicOutputArtifact({ schemaVersion: "1.0", projectId: project.id, profileId, records: articles }));
  console.log(`Wrote ${articles.length} safe article(s) to ${output.pathname}`);
} finally {
  await runtime.close();
}