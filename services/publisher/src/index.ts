import { loadProjectConfig } from "@gameintel/config";
import { createPublicOutputArtifact, writeJsonArtifact } from "@gameintel/output";
import { createServiceRuntime } from "@gameintel/newsroom/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function writeKnowledgeArtifact(path: URL, artifact: Record<string, unknown>): Promise<void> {
  const filePath = fileURLToPath(path);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
}

const runtime = createServiceRuntime();
try {
  const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
  const profileId = process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;
  const articles = await runtime.persistence.listPublicArticles(profileId);
  const output = new URL("../../../apps/web/src/data/publication.json", import.meta.url);
  await writeJsonArtifact(output, createPublicOutputArtifact({ schemaVersion: "1.0", projectId: project.id, profileId, records: articles }));
  console.log(`Wrote ${articles.length} safe article(s) to ${output.pathname}`);

  // Knowledge projections are artifacts, same as articles: the web app never
  // queries the database. The map is the SPAWNS_AT/LOCATED_AT marker set; the
  // guide catalog is the published guide set with their claim lists.
  const markers = await runtime.persistence.getMapProjection(profileId);
  const mapOutput = new URL("../../../apps/web/src/data/map-markers.json", import.meta.url);
  await writeKnowledgeArtifact(mapOutput, { schemaVersion: "1.0", generatedAt: new Date().toISOString(), projectId: project.id, profileId, markers });
  console.log(`Wrote ${markers.length} map marker(s) to ${mapOutput.pathname}`);

  const publishedGuides = (await runtime.persistence.listGuides(profileId)).filter((guide) => guide.status === "published");
  const guides = [];
  for (const guide of publishedGuides) {
    guides.push({ ...guide, claims: await runtime.persistence.listGuideClaims(guide.id) });
  }
  const guideOutput = new URL("../../../apps/web/src/data/guides.json", import.meta.url);
  await writeKnowledgeArtifact(guideOutput, { schemaVersion: "1.0", generatedAt: new Date().toISOString(), projectId: project.id, profileId, guides });
  console.log(`Wrote ${guides.length} published guide(s) to ${guideOutput.pathname}`);
} finally {
  await runtime.close();
}