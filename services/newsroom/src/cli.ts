import { readFile } from "node:fs/promises";
import { loadProjectConfig } from "@gameintel/config";
import { PublicSubmissionReviewDecisionSchema } from "@gameintel/core";
import { loadFixture } from "./fixture.ts";
import { ingestText, promotePublicSubmission } from "./ingest.ts";
import { processFixture, reprocessSourceRevision } from "./pipeline.ts";
import { createRuntime } from "./runtime.ts";
import { createAiRuntime } from "@gameintel/agent-runtime";
import { generateGuide, GuideSpecSchema } from "./guides.ts";
import type { EntityUpsertInput } from "@gameintel/core";

const runtime = createRuntime();
const operator = process.env.OPERATOR_ID ?? "local-operator";
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
  if (typeof values.collection === "string") return values.collection;
  if (typeof values.game === "string") return values.game;
  return profileId;
}
function parseProps(raw: string | undefined): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`Property must be key=value, received '${trimmed}'`);
    properties[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
  }
  return properties;
}

function parseCoords(raw: string | undefined): { x: number; y: number; z?: number } | null {
  if (raw === undefined || raw === "") return null;
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("Coordinates must be 'x,y' or 'x,y,z'");
  }
  return parts.length === 2 ? { x: parts[0], y: parts[1] } : { x: parts[0], y: parts[1], z: parts[2] };
}

try {
  if (command === "ingest") {
    if (!args[0]) throw new Error("Usage: newsroom ingest <fixture.json>");
    if (commandOptions["allow-fixtures"] !== true) throw new Error("Fixture ingestion requires --allow-fixtures and is intended only for trusted local test data");
    const fixture = await loadFixture(args[0]);
    // AI is wired at the operator entry point: drafting/extraction belong to
    // operator processes, never to the ingestion worker or the API. A
    // misconfigured provider fails this command fast (or degrades to a
    // warning inside the pipeline), and never blocks ingestion.
    console.log(JSON.stringify(await processFixture(runtime.persistence, fixture, { allowFixture: true, ai: createAiRuntime() }), null, 2));
  } else if (command === "ingest-url") {
    const values = options(args);
    console.log(JSON.stringify(await runtime.jobQueue.enqueueSourceIngestJob({
      collectionId: collectionId(values), sourceId: required(values, "source"), url: required(values, "url"), profileId: values.profile as string | undefined,
    }), null, 2));
  } else if (command === "ingest-text") {
    const values = options(args);
    const text = values.stdin === true ? await new Response(Bun.stdin.stream()).text() : await readFile(required(values, "text-file"), "utf8");
    console.log(JSON.stringify(await ingestText(runtime.persistence, {
      collectionId: collectionId(values), sourceId: (values.source as string | undefined) ?? "operator-note", profileId: values.profile as string | undefined,
      title: (values.title as string | undefined) ?? "Operator note", text,
      citationUrl: (values["citation-url"] as string | undefined) ?? null,
      inputKind: values.stdin === true ? "pasted_text" : "local_file",
      submittedBy: operator,
    }, { ai: createAiRuntime() }), null, 2));
  } else if (command === "list-submissions") {
    console.log(JSON.stringify(await runtime.persistence.listPublicSubmissionsForModeration(profileId), null, 2));
  } else if (command === "review-submission") {
    if (!args[0]) throw new Error("Usage: newsroom review-submission <submission-id> --decision under_review|rejected|blocked [--notes <text>]");
    const decision = PublicSubmissionReviewDecisionSchema.parse(required(commandOptions, "decision"));
    console.log(JSON.stringify(await runtime.persistence.reviewPublicSubmission({
      submissionId: args[0], actorId: operator, decision,
      notes: typeof commandOptions.notes === "string" ? commandOptions.notes : undefined,
    }), null, 2));
  } else if (command === "promote-submission") {
    if (!args[0]) throw new Error("Usage: newsroom promote-submission <submission-id> [--notes <text>] [--profile <profile-id>]");
    console.log(JSON.stringify(await promotePublicSubmission(runtime, {
      submissionId: args[0], actorId: operator,
      notes: typeof commandOptions.notes === "string" ? commandOptions.notes : undefined,
      profileId,
    }, { ai: createAiRuntime() }), null, 2));
  } else if (command === "list-analysis-runs") {
    if (!args[0]) throw new Error("Usage: newsroom list-analysis-runs <source-revision-id>");
    console.log(JSON.stringify(await runtime.persistence.listAnalysisRuns(args[0]), null, 2));
  } else if (command === "reprocess-revision") {
    if (!args[0]) throw new Error("Usage: newsroom reprocess-revision <source-revision-id> [--reason <text>]");
    console.log(JSON.stringify(await reprocessSourceRevision(runtime.persistence, {
      revisionId: args[0],
      triggeredBy: operator,
      reason: typeof commandOptions.reason === "string" ? commandOptions.reason : undefined,
    }), null, 2));
  } else if (command === "entity" && args[0] === "upsert") {
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.upsertEntity({
      collectionId: collectionId(values),
      type: required(values, "type"),
      canonicalName: required(values, "name"),
      id: values.id as string | undefined,
      aliases: (values.aliases as string | undefined)?.split(",").map((alias) => alias.trim()).filter(Boolean),
      properties: parseProps(values.props as string | undefined),
      coordinates: parseCoords(values.coords as string | undefined),
    }), null, 2));
  } else if (command === "entity" && args[0] === "alias") {
    if (!args[1] || !args[2]) throw new Error("Usage: newsroom entity alias <entity-id> <alias>");
    await runtime.persistence.addEntityAlias(args[1], args[2]);
    console.log(`Alias '${args[2]}' added to ${args[1]}.`);
  } else if (command === "entity" && args[0] === "list") {
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.listEntities(collectionId(values)), null, 2));
  } else if (command === "entity" && args[0] === "resolve") {
    if (!args[1]) throw new Error("Usage: newsroom entity resolve <mention> [--profile <profile-id>]");
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.resolveEntityMention(collectionId(values), args[1]), null, 2));
  } else if (command === "entity" && args[0] === "import") {
    if (!args[1]) throw new Error("Usage: newsroom entity import <entities.json> [--profile <profile-id>]");
    const values = options(args.slice(1));
    const catalog = JSON.parse(await readFile(args[1], "utf8")) as { collectionId: string; entities: EntityUpsertInput[] };
    if (!catalog.collectionId || !Array.isArray(catalog.entities)) throw new Error("Catalog must be { collectionId, entities: EntityUpsertInput[] }");
    const results = [];
    for (const entity of catalog.entities) {
      results.push(await runtime.persistence.upsertEntity({ ...entity, collectionId: entity.collectionId ?? catalog.collectionId }));
    }
    console.log(JSON.stringify({ imported: results.length, entities: results }, null, 2));
  } else if (command === "claim" && args[0] === "range") {
    if (!args[1]) throw new Error("Usage: newsroom claim range <claim-id> [--from <build>] [--to <build>]");
    const values = options(args.slice(1));
    await runtime.persistence.setClaimBuildRange(args[1], {
      from: (values.from as string | undefined) ?? null,
      to: (values.to as string | undefined) ?? null,
    });
    console.log(`Build range updated for ${args[1]}.`);
  } else if (command === "knowledge" && args[0] === "explain") {
    if (!args[1]) throw new Error("Usage: newsroom knowledge explain <claim-id> [--build <build>]");
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.explainClaim(args[1], { currentBuild: (values.build as string | undefined) ?? null }), null, 2));
  } else if (command === "knowledge" && args[0] === "relationships") {
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.findRelationships({
      collectionId: collectionId(values),
      subjectEntityId: (values.subject as string | undefined) ?? undefined,
      predicate: (values.predicate as string | undefined) ?? undefined,
      objectEntityId: (values.object as string | undefined) ?? undefined,
      subjectType: (values.subjectType as string | undefined) ?? undefined,
      objectType: (values.objectType as string | undefined) ?? undefined,
      states: values.state ? [(values.state as string) as "unverified" | "supported" | "contested" | "confirmed" | "superseded" | "retracted"] : undefined,
      build: (values.build as string | undefined) ?? null,
    }), null, 2));
  } else if (command === "knowledge" && args[0] === "entity-relationships") {
    if (!args[1]) throw new Error("Usage: newsroom knowledge entity-relationships <entity-id> [--hops 1|2|3] [--build <build>] [--profile <profile-id>]");
    const values = options(args.slice(1));
    const hops = values.hops === undefined ? 1 : Number(values.hops);
    if (![1, 2, 3].includes(hops)) throw new Error("--hops must be 1, 2, or 3");
    console.log(JSON.stringify(await runtime.persistence.getEntityRelationships(args[1], {
      collectionId: values.collection ? (values.collection as string) : undefined,
      hops: hops as 1 | 2 | 3,
      build: (values.build as string | undefined) ?? null,
    }), null, 2));
  } else if (command === "knowledge" && args[0] === "claims-by-build") {
    if (!args[1]) throw new Error("Usage: newsroom knowledge claims-by-build <build> [--predicate <P>] [--state <s>] [--profile <profile-id>]");
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.findClaimsByBuild(collectionId(values), args[1], {
      predicate: (values.predicate as string | undefined) ?? undefined,
      states: values.state ? [(values.state as string) as "unverified" | "supported" | "contested" | "confirmed" | "superseded" | "retracted"] : undefined,
    }), null, 2));
  } else if (command === "knowledge" && args[0] === "claims-by-location") {
    if (!args[1]) throw new Error("Usage: newsroom knowledge claims-by-location <entity-id> [--profile <profile-id>]");
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.findClaimsByLocation(collectionId(values), args[1]), null, 2));
  } else if (command === "knowledge" && args[0] === "map") {
    const values = options(args.slice(1));
    console.log(JSON.stringify(await runtime.persistence.getMapProjection(collectionId(values), { build: (values.build as string | undefined) ?? null }), null, 2));
  } else if (command === "knowledge" && args[0] === "publications") {
    if (args.length < 2) throw new Error("Usage: newsroom knowledge publications <claim-id>...");
    console.log(JSON.stringify(await runtime.persistence.listPublicationsForClaims(args.slice(1)), null, 2));
  } else if (command === "guide" && args[0] === "generate") {
    if (!args[1]) throw new Error("Usage: newsroom guide generate <spec.json> [--profile <profile-id>]");
    const spec = GuideSpecSchema.parse(JSON.parse(await readFile(args[1], "utf8")));
    console.log(JSON.stringify(await generateGuide(runtime.persistence, spec, profileId), null, 2));
  } else if (command === "guide" && args[0] === "list") {
    console.log(JSON.stringify(await runtime.persistence.listGuides(profileId), null, 2));
  } else if (command === "guide" && args[0] === "publish") {
    if (!args[1]) throw new Error("Usage: newsroom guide publish <guide-id>");
    console.log(JSON.stringify(await runtime.persistence.publishGuide(args[1], operator), null, 2));
  } else if (command === "list") {
    console.log(JSON.stringify(await runtime.persistence.listArticles(profileId), null, 2));
  } else if (command === "import-media") {
    if (!args[0]) throw new Error("Usage: newsroom import-media <catalog.json>");
    console.log(JSON.stringify(await runtime.persistence.importMediaCatalog(args[0]), null, 2));
  } else if (command === "list-cover-candidates") {
    if (!args[0]) throw new Error("Usage: newsroom list-cover-candidates <article-id>");
    console.log(JSON.stringify(await runtime.persistence.listCoverCandidates(args[0]), null, 2));
  } else if (command === "set-cover") {
    if (!args[0] || !args[1]) throw new Error("Usage: newsroom set-cover <article-id> <media-id>");
    await runtime.persistence.setCoverMedia(args[0], args[1], "editor");
    console.log(`Cover media ${args[1]} selected for ${args[0]} and pending review.`);
  } else if (command === "approve-media") {
    if (commandOptions.all === true) {
      const approved = await runtime.persistence.approveMediaCollection(profileId, operator);
      console.log(`${approved} pending media asset(s) approved for ${profileId}.`);
    } else {
      if (!args[0]) throw new Error("Usage: newsroom approve-media <media-id> | approve-media --all [--profile <profile-id>]");
      await runtime.persistence.approveMediaAsset(args[0], operator);
      console.log(`Media asset ${args[0]} approved.`);
    }
  } else if (command === "approve-cover") {
    if (!args[0]) throw new Error("Usage: newsroom approve-cover <article-id>");
    await runtime.persistence.approveCoverMedia(args[0], operator);
    console.log(`Selected cover for ${args[0]} approved.`);
  } else if (command === "reject-cover") {
    if (!args[0]) throw new Error("Usage: newsroom reject-cover <article-id>");
    await runtime.persistence.rejectCoverMedia(args[0], operator);
    console.log(`Selected cover for ${args[0]} rejected.`);
  } else if (command === "clear-cover") {
    if (!args[0]) throw new Error("Usage: newsroom clear-cover <article-id>");
    await runtime.persistence.clearCoverMedia(args[0]);
    console.log(`Selected cover for ${args[0]} cleared.`);
  } else if (command === "review-source") {
    if (!args[0]) throw new Error("Usage: newsroom review-source <source-id>");
    await runtime.persistence.reviewSource(args[0], operator, "Source access metadata reviewed by local operator");
    console.log(`Access metadata recorded for source ${args[0]}. This does not approve evidence; collection follows the registry enabled state.`);
  } else if (command === "list-evidence") {
    if (!args[0]) throw new Error("Usage: newsroom list-evidence <article-id>");
    console.log(JSON.stringify(await runtime.persistence.listArticleEvidence(args[0]), null, 2));
  } else if (command === "review-evidence") {
    if (!args[0]) throw new Error("Usage: newsroom review-evidence <evidence-id> [--decision approved|rejected|disputed]");
    const decision = typeof commandOptions.decision === "string" ? commandOptions.decision as "approved" | "rejected" | "disputed" : "approved";
    await runtime.persistence.reviewEvidence(args[0], operator, decision, "Evidence reviewed by local operator");
    console.log(`Evidence ${args[0]} marked ${decision}.`);
  } else if (command === "review-article") {
    if (!args[0]) throw new Error("Usage: newsroom review-article <article-id>");
    await runtime.persistence.reviewArticle(args[0], operator, "Reviewed by local operator");
    console.log(`Article ${args[0]} editorially reviewed.`);
  } else if (command === "approve") {
    if (!args[0]) throw new Error("Usage: newsroom approve <article-id>");
    await runtime.persistence.approveArticle(args[0], operator);
    console.log(`Article ${args[0]} approved for publication.`);
  } else if (command === "publish") {
    if (!args[0]) throw new Error("Usage: newsroom publish <article-id>");
    const article = await runtime.persistence.markPublished(args[0], operator);
    console.log(`Article ${article.id} published. Run 'bun run build' to build Astro.`);
  } else if (command === "public-snapshot") {
    console.log(JSON.stringify(await runtime.persistence.listPublicArticles(profileId), null, 2));
  } else if (command === "source-health") {
    console.log(JSON.stringify(await runtime.sourceHealth.listSourceHealth(), null, 2));
  } else if (command === "disable-source") {
    const sourceId = args[0];
    if (!sourceId) throw new Error("Missing source id");
    const reason = required(commandOptions, "reason");
    await runtime.sourceHealth.setSourceDisabled(sourceId, true, reason, operator);
    await runtime.persistence.audit(operator, "disable-source", "source", sourceId, reason);
    console.log(`Disabled source ${sourceId}: ${reason}`);
  } else if (command === "enable-source") {
    const sourceId = args[0];
    if (!sourceId) throw new Error("Missing source id");
    const reason = required(commandOptions, "reason");
    await runtime.sourceHealth.setSourceDisabled(sourceId, false, reason, operator);
    await runtime.persistence.audit(operator, "enable-source", "source", sourceId, reason);
    console.log(`Enabled source ${sourceId}: ${reason}`);
  } else {
    console.log("Commands: ingest <fixture.json> --allow-fixtures, ingest-url --collection <profile-id> --source <id> --url <url> [--profile <profile-id>], ingest-text --collection <profile-id> --source <id> --title <title> --text-file <path> [--citation-url <url>] [--profile <profile-id>], list-submissions [--profile <profile-id>], review-submission <submission-id> --decision under_review|rejected|blocked [--notes <text>], promote-submission <submission-id> [--notes <text>] [--profile <profile-id>], list [--profile <profile-id>], import-media <catalog.json>, list-cover-candidates <article-id>, set-cover <article-id> <media-id>, approve-media <media-id> | approve-media --all [--profile <profile-id>], approve-cover <article-id>, reject-cover <article-id>, clear-cover <article-id>, review-source <id>, list-evidence <article-id>, review-evidence <id> [--decision approved|rejected|disputed], review-article <id>, approve <id>, publish <id>, public-snapshot [--profile <profile-id>], list-analysis-runs <source-revision-id>, reprocess-revision <source-revision-id> [--reason <text>], source-health, disable-source <id> --reason <text>, enable-source <id> --reason <text>, entity upsert --type <type> --name <name> [--id <id>] [--aliases \"a,b\"] [--props \"k=v,k2=v2\"] [--coords \"x,y[,z]\"] [--profile <profile-id>], entity alias <entity-id> <alias>, entity list [--profile <profile-id>], entity resolve <mention> [--profile <profile-id>], entity import <entities.json> [--profile <profile-id>], claim range <claim-id> [--from <build>] [--to <build>], knowledge explain <claim-id> [--build <build>], knowledge relationships [--subject <entity-id>] [--predicate <P>] [--object <entity-id>] [--state <s>] [--build <b>] [--profile <profile-id>], knowledge entity-relationships <entity-id> [--hops 1|2|3] [--build <build>] [--profile <profile-id>], knowledge claims-by-build <build> [--predicate <P>] [--state <s>] [--profile <profile-id>], knowledge claims-by-location <entity-id> [--profile <profile-id>], knowledge map [--build <build>] [--profile <profile-id>], knowledge publications <claim-id>..., guide generate <spec.json> [--profile <profile-id>], guide list [--profile <profile-id>], guide publish <guide-id>");
  }
} finally {
  await runtime.close();
}