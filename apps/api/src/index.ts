import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  PublicHttpUrlSchema,
  PublicSubmissionReviewDecisionSchema,
  PublicSubmissionSchema,
  PublicSubmissionStateSchema,
  toSafeArticle,
} from "@gameintel/core";
import { loadCollectionProfile, loadProjectConfig, profilePath } from "@gameintel/config";
import {
  closeDb,
  createDb,
  createQuarantinedSubmission,
  enqueueSourceIngestJob,
  getArticle,
  getIngestionJob,
  getIngestionQueueStatus,
  getPublicSubmissionForModeration,
  listArticles,
  listIngestionWorkerHeartbeats,
  listRecentIngestionJobs,
  listPublicSubmissionModerationActions,
  listPublicSubmissionsForModeration,
  publicArticles,
  reviewPublicSubmission,
  SubmissionRateLimitError,
} from "@gameintel/db";
import { ingestText, promotePublicSubmission } from "@gameintel/newsroom";
import { createPublicOutputArtifact } from "@gameintel/output";
import { z } from "zod";

const project = await loadProjectConfig(new URL("../../../config/project.json", import.meta.url));
const profile = await loadCollectionProfile(profilePath());
const db = createDb();
const app = new Hono();
const UrlIngestSchema = z.object({ gameId: z.string().min(1).max(64), sourceId: z.string().min(1).max(128), url: PublicHttpUrlSchema });
const TextIngestSchema = z.object({
  gameId: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(128).optional(),
  title: z.string().min(1).max(500),
  text: z.string().min(1).max(100_000),
  publicCitationUrl: PublicHttpUrlSchema.nullable().optional(),
});
const SubmissionReviewSchema = z.object({
  decision: PublicSubmissionReviewDecisionSchema,
  notes: z.string().trim().max(2_000).optional(),
}).strict();
const SubmissionPromotionSchema = z.object({
  notes: z.string().trim().max(2_000).optional(),
}).strict();

function operatorToken(): string {
  const value = process.env.LOCAL_OPERATOR_TOKEN;
  if (!value || value.length < 32 || /^(?:change[-_ ]?me|replace|placeholder|example|test)$/i.test(value)) {
    throw new Error("LOCAL_OPERATOR_TOKEN must be a unique token of at least 32 characters");
  }
  return value;
}

const expectedOperatorToken = operatorToken();

function operatorActorId(): string {
  const value = process.env.OPERATOR_ID ?? "local-operator";
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error("OPERATOR_ID must be a valid operator identifier");
  return value;
}

const currentOperatorId = operatorActorId();

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

class SubmissionIdentityError extends Error {}

async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new RequestBodyError(400, "Content-Type must be application/json");
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > maxBytes)) {
    throw new RequestBodyError(413, "Request body exceeds limit");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError(400, "Request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestBodyError(413, "Request body exceeds limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new RequestBodyError(400, "Request body must contain valid JSON");
  }
}

function publicSubmissionsEnabled(): boolean {
  return process.env.PUBLIC_SUBMISSIONS_ENABLED === "true";
}

function submissionIdentitySecret(): string {
  const secret = process.env.SUBMISSION_IDENTITY_SECRET;
  if (!secret || secret.length < 32) throw new SubmissionIdentityError("Submission identity hashing is not configured");
  return secret;
}

function submissionIdentity(request: Request): { sessionHash: string; ipHash: string } {
  if (process.env.SUBMISSION_TRUST_PROXY !== "true") {
    throw new SubmissionIdentityError("A trusted submission proxy is required");
  }
  const session = request.headers.get("x-submission-session") ?? "";
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(session)) {
    throw new SubmissionIdentityError("A valid submission session is required");
  }
  const ipHeader = process.env.SUBMISSION_TRUSTED_IP_HEADER ?? "cf-connecting-ip";
  const ip = request.headers.get(ipHeader) ?? "";
  if (!isIP(ip)) throw new SubmissionIdentityError("A trusted client IP is required");
  const secret = submissionIdentitySecret();
  const hash = (kind: string, value: string) => createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
  return { sessionHash: hash("session", session), ipHash: hash("ip", ip) };
}

app.use("*", cors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:4321" }));

app.get("/health", (c) => c.json({ ok: true, service: "gameintelgg-api", project: project.id, profileId: profile.id }));
app.get("/v1/games", (c) => c.json([{ id: profile.id, canonicalName: profile.canonicalName, aliases: profile.aliases }]));
app.get("/v1/games/:gameId", (c) => c.json(c.req.param("gameId") === profile.id ? profile : { error: "Game not found" }, c.req.param("gameId") === profile.id ? 200 : 404));
app.get("/v1/games/:gameId/articles", async (c) => {
  if (c.req.param("gameId") !== profile.id) return c.json({ error: "Game not found" }, 404);
  return c.json(await publicArticles(db, profile.id));
});
app.get("/v1/data/:profileId", async (c) => {
  if (c.req.param("profileId") !== profile.id) return c.json({ error: "Profile not found" }, 404);
  return c.json(createPublicOutputArtifact({ schemaVersion: "1.0", projectId: project.id, profileId: profile.id, records: await publicArticles(db, profile.id) }));
});
app.get("/v1/articles/:id", async (c) => {
  const article = await getArticle(db, c.req.param("id"), true);
  const safe = article ? toSafeArticle(article) : null;
  return safe ? c.json(safe) : c.json({ error: "Article not found" }, 404);
});
app.get("/v1/search", async (c) => {
  const query = (c.req.query("q") ?? "").slice(0, 200).toLowerCase().trim();
  const gameId = c.req.query("game_id") ?? profile.id;
  if (gameId !== profile.id) return c.json({ error: "Game not found" }, 404);
  const articles = await listArticles(db, profile.id, true);
  return c.json(articles.map(toSafeArticle).filter((article) => article && (!query || `${article.title} ${article.description}`.toLowerCase().includes(query))).slice(0, 100));
});

app.post("/v1/submissions", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!publicSubmissionsEnabled()) return c.json({ error: "Public submissions are not enabled" }, 503);
  let payload: unknown;
  try {
    payload = await readJsonBody(c.req.raw, 16_384);
  } catch (error) {
    if (error instanceof RequestBodyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Unable to read request body" }, 400);
  }
  const parsed = PublicSubmissionSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "A valid community report is required" }, 400);
  if (parsed.data.collectionId !== profile.id) return c.json({ error: "Collection not found" }, 404);
  try {
    const identity = submissionIdentity(c.req.raw);
    const result = await createQuarantinedSubmission(db, {
      submission: parsed.data,
      submitterSessionHash: identity.sessionHash,
      submitterIpHash: identity.ipHash,
    });
    return c.json({ id: result.id, status: "quarantined" }, result.duplicate ? 200 : 202);
  } catch (error) {
    if (error instanceof SubmissionRateLimitError) return c.json({ error: error.message }, 429);
    if (error instanceof SubmissionIdentityError) return c.json({ error: "Public submission identity is unavailable" }, 503);
    return c.json({ error: error instanceof Error ? error.message : "Unable to create submission" }, 400);
  }
});

function operatorAuthorized(request: Request): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const received = new TextEncoder().encode(authorization.slice("Bearer ".length));
  const expected = new TextEncoder().encode(expectedOperatorToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

app.use("/internal/operator/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  if (!operatorAuthorized(c.req.raw)) return c.json({ error: "Operator authentication required" }, 401);
  await next();
});
app.get("/internal/operator/articles", async (c) => c.json(await listArticles(db, profile.id, false)));
app.get("/internal/operator/jobs", async (c) => c.json({
  queue: await getIngestionQueueStatus(db),
  workers: await listIngestionWorkerHeartbeats(db),
  jobs: await listRecentIngestionJobs(db),
}));
app.get("/internal/operator/submissions", async (c) => {
  const rawState = c.req.query("state");
  const state = rawState === undefined ? undefined : PublicSubmissionStateSchema.safeParse(rawState);
  if (state && !state.success) return c.json({ error: "Invalid submission state" }, 400);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return c.json({ error: "limit must be an integer between 1 and 200" }, 400);
  }
  return c.json(await listPublicSubmissionsForModeration(db, profile.id, { state: state?.success ? state.data : undefined, limit }));
});
app.get("/internal/operator/submissions/:submissionId", async (c) => {
  const submission = await getPublicSubmissionForModeration(db, c.req.param("submissionId"));
  if (!submission || submission.collectionId !== profile.id) return c.json({ error: "Submission not found" }, 404);
  return c.json({
    submission,
    actions: await listPublicSubmissionModerationActions(db, submission.id),
  });
});
app.post("/internal/operator/submissions/:submissionId/review", async (c) => {
  let payload: unknown;
  try {
    payload = await readJsonBody(c.req.raw, 4_096);
  } catch (error) {
    if (error instanceof RequestBodyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Unable to read request body" }, 400);
  }
  const parsed = SubmissionReviewSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "A valid moderation decision is required" }, 400);
  try {
    const submission = await getPublicSubmissionForModeration(db, c.req.param("submissionId"));
    if (!submission || submission.collectionId !== profile.id) return c.json({ error: "Submission not found" }, 404);
    return c.json(await reviewPublicSubmission(db, {
      submissionId: submission.id,
      actorId: currentOperatorId,
      decision: parsed.data.decision,
      notes: parsed.data.notes,
    }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to review submission" }, 400);
  }
});
app.post("/internal/operator/submissions/:submissionId/promote", async (c) => {
  let payload: unknown;
  try {
    payload = await readJsonBody(c.req.raw, 4_096);
  } catch (error) {
    if (error instanceof RequestBodyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Unable to read request body" }, 400);
  }
  const parsed = SubmissionPromotionSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "Promotion notes must be valid" }, 400);
  try {
    const result = await promotePublicSubmission(db, {
      submissionId: c.req.param("submissionId"),
      actorId: currentOperatorId,
      notes: parsed.data.notes,
      profileId: profile.id,
    });
    return c.json({ ...result, state: "promoted" }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to promote submission" }, 400);
  }
});
app.get("/internal/operator/jobs/:jobKey", async (c) => {
  const job = await getIngestionJob(db, c.req.param("jobKey"));
  return job ? c.json(job) : c.json({ error: "Job not found" }, 404);
});
app.post("/internal/operator/ingest/url", async (c) => {
  let payload: unknown;
  try {
    payload = await readJsonBody(c.req.raw, 20_000);
  } catch (error) {
    if (error instanceof RequestBodyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Unable to read request body" }, 400);
  }
  const parsed = UrlIngestSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "gameId, sourceId, and a valid url are required" }, 400);
  const body = parsed.data;
  if (body.gameId !== profile.id) return c.json({ error: "Game not found" }, 404);
  try {
    const job = await enqueueSourceIngestJob(db, { collectionId: body.gameId, sourceId: body.sourceId, url: body.url, profileId: profile.id });
    return c.json({ jobId: job.jobKey, status: job.status, duplicate: job.duplicate }, job.duplicate ? 200 : 202);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Ingestion failed" }, 400);
  }
});
app.post("/internal/operator/ingest/text", async (c) => {
  let payload: unknown;
  try {
    payload = await readJsonBody(c.req.raw, 120_000);
  } catch (error) {
    if (error instanceof RequestBodyError) return c.json({ error: error.message }, error.status);
    return c.json({ error: "Unable to read request body" }, 400);
  }
  const parsed = TextIngestSchema.safeParse(payload);
  if (!parsed.success) return c.json({ error: "gameId, title, and text are required" }, 400);
  const body = parsed.data;
  if (body.gameId !== profile.id) return c.json({ error: "Game not found" }, 404);
  try {
    return c.json(await ingestText(db, {
      collectionId: body.gameId,
      sourceId: body.sourceId ?? "operator-note",
      title: body.title,
      text: body.text,
      citationUrl: body.publicCitationUrl,
      inputKind: "pasted_text",
      profileId: profile.id,
      submittedBy: currentOperatorId,
    }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Ingestion failed" }, 400);
  }
});

const port = Number(process.env.API_PORT ?? 3000);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`GameIntel API listening on http://localhost:${server.port}`);

process.on("SIGTERM", async () => {
  await closeDb(db);
  process.exit(0);
});
