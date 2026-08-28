import { readFile } from "node:fs/promises";
import { z } from "zod";
import { PublicHttpUrlSchema } from "@gameintel/core";
import type { Db } from "./index.ts";

const CatalogMediaSchema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  collection: z.string().min(1),
  caption: z.string().min(1),
  altText: z.string().min(1),
  tags: z.array(z.string().min(1)),
  spoilerTags: z.array(z.string().min(1)),
  attribution: z.string().min(1),
  sourceUrl: PublicHttpUrlSchema,
  sourcePageUrl: PublicHttpUrlSchema,
  originalKey: z.string().min(1),
  displayKey: z.string().min(1),
  publicUrl: PublicHttpUrlSchema,
  contentType: z.string().regex(/^image\/[a-z0-9.+-]+$/i, "Expected an image content type"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 checksum"),
});

const MediaCatalogSchema = z.object({ media: z.array(CatalogMediaSchema) }).passthrough();
type CatalogMedia = z.infer<typeof CatalogMediaSchema>;

export type CoverMediaCandidate = Pick<CatalogMedia, "id" | "collection" | "caption" | "altText" | "tags" | "spoilerTags" | "attribution" | "sourceUrl" | "publicUrl">;

function jsonArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function normalized(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
}

function candidateScore(candidate: CoverMediaCandidate, articleText: string): number {
  const phrases = [candidate.caption, candidate.collection];
  let score = 0;
  for (const tag of candidate.tags) {
    const phrase = normalized(tag);
    if (containsPhrase(articleText, phrase)) score += 10_000 + phrase.split(" ").length;
  }
  for (const phraseValue of phrases) {
    const phrase = normalized(phraseValue);
    if (phrase.split(" ").length > 1 && containsPhrase(articleText, phrase)) score += 100 + phrase.split(" ").length;
  }
  return score;
}

function assertUnique(media: CatalogMedia[]): void {
  for (const key of ["id", "checksum", "displayKey"] as const) {
    const values = new Set<string>();
    for (const item of media) {
      if (values.has(item[key])) throw new Error(`Invalid media catalog: duplicate ${key} '${item[key]}'`);
      values.add(item[key]);
    }
  }
}

export async function importMediaCatalog(db: Db, catalogPath: string): Promise<{ imported: number; collectionIds: string[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read media catalog '${catalogPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const catalog = MediaCatalogSchema.safeParse(parsed);
  if (!catalog.success) throw new Error(`Invalid media catalog: ${catalog.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  assertUnique(catalog.data.media);

  for (const item of catalog.data.media) {
    await db`
      INSERT INTO media_assets (id, game_id, collection, caption, alt_text, tags, spoiler_tags, attribution, source_url, source_page_url, original_key, display_key, public_url, content_type, width, height, checksum, review_status)
      VALUES (${item.id}, ${item.collectionId}, ${item.collection}, ${item.caption}, ${item.altText}, ${db.json(item.tags)}, ${db.json(item.spoilerTags)}, ${item.attribution}, ${item.sourceUrl}, ${item.sourcePageUrl}, ${item.originalKey}, ${item.displayKey}, ${item.publicUrl}, ${item.contentType}, ${item.width}, ${item.height}, ${item.checksum}, 'pending')
      ON CONFLICT (id) DO UPDATE SET
        game_id = EXCLUDED.game_id, collection = EXCLUDED.collection, caption = EXCLUDED.caption, alt_text = EXCLUDED.alt_text,
        tags = EXCLUDED.tags, spoiler_tags = EXCLUDED.spoiler_tags, attribution = EXCLUDED.attribution,
        source_url = EXCLUDED.source_url, source_page_url = EXCLUDED.source_page_url, original_key = EXCLUDED.original_key,
        display_key = EXCLUDED.display_key, public_url = EXCLUDED.public_url, content_type = EXCLUDED.content_type,
        width = EXCLUDED.width, height = EXCLUDED.height, checksum = EXCLUDED.checksum,
        review_status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = now()
    `;
  }
  return { imported: catalog.data.media.length, collectionIds: [...new Set(catalog.data.media.map((item) => item.collectionId))].sort() };
}

export async function listCoverCandidates(db: Db, articleId: string): Promise<CoverMediaCandidate[]> {
  const rows = await db`
    SELECT ma.id, ma.collection, ma.caption, ma.alt_text, ma.tags, ma.spoiler_tags, ma.attribution, ma.source_url, ma.public_url
    FROM media_assets ma JOIN articles a ON a.game_id = ma.game_id
    WHERE a.id = ${articleId} AND ma.review_status = 'approved' AND jsonb_array_length(ma.spoiler_tags) = 0
    ORDER BY ma.id ASC
  `;
  return rows.map((row) => ({
    id: row.id as string, collection: row.collection as string, caption: row.caption as string, altText: row.alt_text as string,
    tags: jsonArray(row.tags), spoilerTags: jsonArray(row.spoiler_tags), attribution: row.attribution as string,
    sourceUrl: row.source_url as string, publicUrl: row.public_url as string,
  }));
}

export async function setCoverMedia(db: Db, articleId: string, mediaId: string, selectionSource: "automatic" | "editor" = "editor"): Promise<void> {
  const rows = await db`
    SELECT a.game_id AS article_game_id, ma.game_id AS media_game_id, ma.spoiler_tags
    FROM articles a CROSS JOIN media_assets ma
    WHERE a.id = ${articleId} AND ma.id = ${mediaId}
  `;
  if (!rows.length) throw new Error("Article or media asset not found");
  if (rows[0].article_game_id !== rows[0].media_game_id) throw new Error("Cover media must belong to the article collection");
  if (jsonArray(rows[0].spoiler_tags).length) throw new Error("Spoiler-tagged media cannot be a cover");
  await db`
    INSERT INTO article_media (article_id, media_id, role, selection_source, review_status)
    VALUES (${articleId}, ${mediaId}, 'cover', ${selectionSource}, 'pending')
    ON CONFLICT (article_id, role) DO UPDATE SET
      media_id = EXCLUDED.media_id, selection_source = EXCLUDED.selection_source, review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, created_at = now()
  `;
}

export async function recommendArticleCover(db: Db, input: { articleId: string; title: string; description: string; safeClaimText: string[] }): Promise<string | null> {
  const candidates = await listCoverCandidates(db, input.articleId);
  if (!candidates.length) return null;
  const articleText = normalized([input.title, input.description, ...input.safeClaimText].join(" "));
  const selected = candidates.map((candidate) => ({ candidate, score: candidateScore(candidate, articleText) }))
    .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))[0].candidate;
  await setCoverMedia(db, input.articleId, selected.id, "automatic");
  return selected.id;
}

export async function approveMediaAsset(db: Db, mediaId: string, reviewer: string): Promise<void> {
  const rows = await db`UPDATE media_assets SET review_status = 'approved', approved_by = ${reviewer}, approved_at = now(), updated_at = now() WHERE id = ${mediaId} RETURNING id`;
  if (!rows.length) throw new Error("Media asset not found");
}

export async function approveMediaCollection(db: Db, collectionId: string, reviewer: string): Promise<number> {
  const rows = await db`
    UPDATE media_assets
    SET review_status = 'approved', approved_by = ${reviewer}, approved_at = now(), updated_at = now()
    WHERE game_id = ${collectionId} AND review_status = 'pending' AND jsonb_array_length(spoiler_tags) = 0
    RETURNING id
  `;
  return rows.length;
}

export async function approveCoverMedia(db: Db, articleId: string, reviewer: string): Promise<void> {
  const rows = await db`
    SELECT am.media_id, ma.review_status AS asset_review_status
    FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
    WHERE am.article_id = ${articleId} AND am.role = 'cover'
  `;
  if (!rows.length) throw new Error("Article has no selected cover media");
  if (rows[0].asset_review_status !== "approved") throw new Error("Cover media asset must be approved before its assignment");
  await db`UPDATE article_media SET review_status = 'approved', reviewed_by = ${reviewer}, reviewed_at = now() WHERE article_id = ${articleId} AND role = 'cover'`;
}

export async function rejectCoverMedia(db: Db, articleId: string, reviewer: string): Promise<void> {
  const rows = await db`UPDATE article_media SET review_status = 'rejected', reviewed_by = ${reviewer}, reviewed_at = now() WHERE article_id = ${articleId} AND role = 'cover' RETURNING media_id`;
  if (!rows.length) throw new Error("Article has no selected cover media");
}

export async function clearCoverMedia(db: Db, articleId: string): Promise<void> {
  await db`DELETE FROM article_media WHERE article_id = ${articleId} AND role = 'cover'`;
}
