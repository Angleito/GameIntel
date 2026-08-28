import { readFile } from "node:fs/promises";
import { loadProjectConfig } from "@gameintel/config";
import { loadFixture } from "./fixture.ts";
import { ingestText, ingestUrl } from "./ingest.ts";
import {
  approveArticle,
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  clearCoverMedia,
  closeDb,
  createDb,
  importMediaCatalog,
  listArticles,
  listCoverCandidates,
  markPublished,
  publicArticles,
  rejectCoverMedia,
  reviewArticle,
  reviewSource,
  setCoverMedia,
} from "@gameintel/db";
import { processFixture } from "./pipeline.ts";

const db = createDb();
const operator = "local-operator";
const [command, ...args] = process.argv.slice(2);
const commandOptions = options(args);
const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
const profileId = typeof commandOptions.profile === "string" ? commandOptions.profile : process.env.GAMEINTEL_PROFILE ?? project.defaultProfileId;

function options(values: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function required(values: Record<string, string | boolean>, key: string): string {
  const value = values[key];
  if (typeof value !== "string" || !value) throw new Error(`Missing --${key}`);
  return value;
}

function collectionId(values: Record<string, string | boolean>): string {
  return typeof values.collection === "string" ? values.collection : required(values, "game");
}

try {
  if (command === "ingest") {
    if (!args[0]) throw new Error("Usage: newsroom ingest <fixture.json>");
    if (commandOptions["allow-fixtures"] !== true) throw new Error("Fixture ingestion requires --allow-fixtures and is intended only for trusted local test data");
    const fixture = await loadFixture(args[0]);
    console.log(JSON.stringify(await processFixture(db, fixture, { allowFixture: true }), null, 2));
  } else if (command === "ingest-url") {
    const values = options(args);
    console.log(JSON.stringify(await ingestUrl(db, { collectionId: collectionId(values), sourceId: required(values, "source"), url: required(values, "url"), profileId: values.profile as string | undefined }), null, 2));
  } else if (command === "ingest-text") {
    const values = options(args);
    const text = values.stdin === true ? await new Response(Bun.stdin.stream()).text() : await readFile(required(values, "text-file"), "utf8");
    console.log(JSON.stringify(await ingestText(db, {
      collectionId: collectionId(values), sourceId: (values.source as string | undefined) ?? "operator-note", profileId: values.profile as string | undefined,
      title: (values.title as string | undefined) ?? "Operator note", text,
      citationUrl: (values["citation-url"] as string | undefined) ?? null,
      inputKind: values.stdin === true ? "pasted_text" : "local_file",
    }), null, 2));
  } else if (command === "list") {
    console.log(JSON.stringify(await listArticles(db, profileId, false), null, 2));
  } else if (command === "import-media") {
    if (!args[0]) throw new Error("Usage: newsroom import-media <catalog.json>");
    console.log(JSON.stringify(await importMediaCatalog(db, args[0]), null, 2));
  } else if (command === "list-cover-candidates") {
    if (!args[0]) throw new Error("Usage: newsroom list-cover-candidates <article-id>");
    console.log(JSON.stringify(await listCoverCandidates(db, args[0]), null, 2));
  } else if (command === "set-cover") {
    if (!args[0] || !args[1]) throw new Error("Usage: newsroom set-cover <article-id> <media-id>");
    await setCoverMedia(db, args[0], args[1], "editor");
    console.log(`Cover media ${args[1]} selected for ${args[0]} and pending review.`);
  } else if (command === "approve-media") {
    if (commandOptions.all === true) {
      const approved = await approveMediaCollection(db, profileId, operator);
      console.log(`${approved} pending media asset(s) approved for ${profileId}.`);
    } else {
      if (!args[0]) throw new Error("Usage: newsroom approve-media <media-id> | approve-media --all [--profile <profile-id>]");
      await approveMediaAsset(db, args[0], operator);
      console.log(`Media asset ${args[0]} approved.`);
    }
  } else if (command === "approve-cover") {
    if (!args[0]) throw new Error("Usage: newsroom approve-cover <article-id>");
    await approveCoverMedia(db, args[0], operator);
    console.log(`Selected cover for ${args[0]} approved.`);
  } else if (command === "reject-cover") {
    if (!args[0]) throw new Error("Usage: newsroom reject-cover <article-id>");
    await rejectCoverMedia(db, args[0], operator);
    console.log(`Selected cover for ${args[0]} rejected.`);
  } else if (command === "clear-cover") {
    if (!args[0]) throw new Error("Usage: newsroom clear-cover <article-id>");
    await clearCoverMedia(db, args[0]);
    console.log(`Selected cover for ${args[0]} cleared.`);
  } else if (command === "review-source") {
    if (!args[0]) throw new Error("Usage: newsroom review-source <source-id>");
    await reviewSource(db, args[0], operator, "Reviewed by local operator");
    console.log(`Source ${args[0]} approved.`);
  } else if (command === "review-article") {
    if (!args[0]) throw new Error("Usage: newsroom review-article <article-id>");
    await reviewArticle(db, args[0], operator, "Reviewed by local operator");
    console.log(`Article ${args[0]} editorially reviewed.`);
  } else if (command === "approve") {
    if (!args[0]) throw new Error("Usage: newsroom approve <article-id>");
    await approveArticle(db, args[0], operator);
    console.log(`Article ${args[0]} approved for publication.`);
  } else if (command === "publish") {
    if (!args[0]) throw new Error("Usage: newsroom publish <article-id>");
    const article = await markPublished(db, args[0], operator);
    console.log(`Article ${article.id} published. Run 'bun run build' to build Astro.`);
  } else if (command === "public-snapshot") {
    console.log(JSON.stringify(await publicArticles(db, profileId), null, 2));
  } else {
    console.log("Commands: ingest <fixture.json> --allow-fixtures, ingest-url --collection <profile-id> --source <id> --url <url> [--profile <profile-id>], ingest-text --collection <profile-id> --source <id> --title <title> --text-file <path> [--citation-url <url>] [--profile <profile-id>], list [--profile <profile-id>], import-media <catalog.json>, list-cover-candidates <article-id>, set-cover <article-id> <media-id>, approve-media <media-id> | approve-media --all [--profile <profile-id>], approve-cover <article-id>, reject-cover <article-id>, clear-cover <article-id>, review-source <id>, review-article <id>, approve <id>, publish <id>, public-snapshot [--profile <profile-id>]");
  }
} finally {
  await closeDb(db);
}
