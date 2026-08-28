import { access, copyFile, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { PublicOutputArtifactSchema } from "@gameintel/output";

const output = new URL("../apps/web/src/data/publication.json", import.meta.url);
const example = new URL("../apps/web/src/data/publication.example.json", import.meta.url);

try {
  await access(output, constants.F_OK);
} catch {
  await mkdir(new URL(".", output), { recursive: true });
  await copyFile(example, output);
  console.log("Created an empty local publication artifact from publication.example.json");
}

try {
  PublicOutputArtifactSchema.parse(JSON.parse(await readFile(output, "utf8")));
} catch {
  throw new Error("Publication artifact must be valid public output before the site can build");
}
