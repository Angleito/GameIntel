import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { PublicHttpUrlSchema, toSafeArticle } from "@gameintel/core";
import { loadCollectionProfile, loadProjectConfig, profilePath } from "@gameintel/config";
import { createDb, getArticle, listArticles, publicArticles, closeDb } from "@gameintel/db";
import { ingestText, ingestUrl } from "@gameintel/newsroom";
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

function operatorToken(): string {
  const value = process.env.LOCAL_OPERATOR_TOKEN;
  if (!value || value.length < 32 || /^(?:change[-_ ]?me|replace|placeholder|example|test)$/i.test(value)) {
    throw new Error("LOCAL_OPERATOR_TOKEN must be a unique token of at least 32 characters");
  }
  return value;
}

const expectedOperatorToken = operatorToken();

class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413, message: string) {
    super(message);
  }
}

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
    return c.json(await ingestUrl(db, { collectionId: body.gameId, sourceId: body.sourceId, url: body.url, profileId: profile.id }));
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
    return c.json(await ingestText(db, { collectionId: body.gameId, sourceId: body.sourceId ?? "operator-note", title: body.title, text: body.text, citationUrl: body.publicCitationUrl, inputKind: "pasted_text", profileId: profile.id }));
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
