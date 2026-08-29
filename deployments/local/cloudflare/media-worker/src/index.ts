import { isSafeR2Key, parseMediaCatalog } from "./catalog";
import { dailyShuffleSeed, shuffleWithSeed, utcDate } from "./shuffle";

export interface Env {
  MEDIA_BUCKET: R2Bucket;
  DAILY_SHUFFLE_SECRET: string;
  MEDIA_CATALOG_KEY: string;
  // Profile-scoped worker route; defaults to the repository's showcase profile.
  MEDIA_GAME_ID?: string;
}

const PATH_PATTERN = /^\/api\/media\/([^/]+)\/slideshow\/?$/;

function json(body: unknown, status: number, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

function gameIdForPath(pathname: string): string | null {
  const match = PATH_PATTERN.exec(pathname);
  if (!match) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

function cacheHeaders(now: Date): HeadersInit {
  const expires = nextUtcMidnight(now);
  const seconds = Math.ceil((expires.getTime() - now.getTime()) / 1_000);
  return {
    "Cache-Control": `public, max-age=${seconds}, s-maxage=${seconds}, must-revalidate`,
    Expires: expires.toUTCString(),
  };
}

function cacheKey(requestUrl: string, gameId: string): Request {
  const url = new URL(requestUrl);
  url.pathname = `/api/media/${encodeURIComponent(gameId)}/slideshow`;
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

async function loadCatalog(env: Env) {
  if (!isSafeR2Key(env.MEDIA_CATALOG_KEY)) return null;

  const object = await env.MEDIA_BUCKET.get(env.MEDIA_CATALOG_KEY);
  if (!object) return null;

  try {
    return parseMediaCatalog(JSON.parse(await object.text()));
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    }

    const gameId = gameIdForPath(new URL(request.url).pathname);
    const allowedGameId = (env.MEDIA_GAME_ID ?? "gta-vi").trim().toLowerCase();
    if (!allowedGameId || gameId !== allowedGameId) return json({ error: "Not found" }, 404);

    const key = cacheKey(request.url, gameId);
    const cached = await caches.default.match(key);
    if (cached) return cached;

    if (!env.DAILY_SHUFFLE_SECRET || !env.MEDIA_CATALOG_KEY) {
      return json({ error: "Media catalog unavailable" }, 503);
    }

    try {
      const catalog = await loadCatalog(env);
      if (!catalog) return json({ error: "Media catalog unavailable" }, 503);
      if (catalog.collectionId !== gameId) return json({ error: "Media catalog unavailable" }, 503);

      const now = new Date();
      const seed = await dailyShuffleSeed(env.DAILY_SHUFFLE_SECRET, utcDate(now), catalog.version, gameId);
      const response = json(shuffleWithSeed(catalog.media, seed), 200, cacheHeaders(now));
      ctx.waitUntil(caches.default.put(key, response.clone()));
      return response;
    } catch {
      return json({ error: "Media catalog unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
