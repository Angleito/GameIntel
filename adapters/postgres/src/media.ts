import { readFile } from "node:fs/promises";
import { assertUniqueMedia, MediaCatalogSchema, mediaCoverScore, type CatalogMedia } from "@gameintel/core";
import type { CoverMediaCandidate } from "@gameintel/contracts";
import { inTransaction, refreshPublicArticleRecord, type Db } from "./index.ts";

export type { CoverMediaCandidate };

function jsonArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function candidateScore(candidate: CoverMediaCandidate, articleText: string): number {
  return mediaCoverScore(candidate, articleText);
}

function normalized(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
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
  assertUniqueMedia(catalog.data.media);

  return inTransaction(db, async (transaction) => {
    for (const item of catalog.data.media) {
      await transaction`
        INSERT INTO media_assets (id, game_id, collection, caption, alt_text, tags, spoiler_tags, attribution, source_url, source_page_url, original_key, display_key, public_url, content_type, width, height, checksum, review_status)
        VALUES (${item.id}, ${item.collectionId}, ${item.collection}, ${item.caption}, ${item.altText}, ${transaction.json(item.tags)}, ${transaction.json(item.spoilerTags)}, ${item.attribution}, ${item.sourceUrl}, ${item.sourcePageUrl}, ${item.originalKey}, ${item.displayKey}, ${item.publicUrl}, ${item.contentType}, ${item.width}, ${item.height}, ${item.checksum}, 'pending')
        ON CONFLICT (id) DO UPDATE SET
          game_id = EXCLUDED.game_id, collection = EXCLUDED.collection, caption = EXCLUDED.caption, alt_text = EXCLUDED.alt_text,
          tags = EXCLUDED.tags, spoiler_tags = EXCLUDED.spoiler_tags, attribution = EXCLUDED.attribution,
          source_url = EXCLUDED.source_url, source_page_url = EXCLUDED.source_page_url, original_key = EXCLUDED.original_key,
          display_key = EXCLUDED.display_key, public_url = EXCLUDED.public_url, content_type = EXCLUDED.content_type,
          width = EXCLUDED.width, height = EXCLUDED.height, checksum = EXCLUDED.checksum,
          review_status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = now()
      `;
    }
    // Importing resets affected assets to pending; published articles using
    // them as covers lose their public cover until re-approved.
    const affected = catalog.data.media.map((item) => item.id);
    const coverArticles = await transaction`
      SELECT DISTINCT article_id
      FROM article_media
      WHERE role = 'cover' AND media_id = ANY(${transaction.array(affected)})
    `;
    for (const article of coverArticles) await refreshPublicArticleRecord(transaction, article.article_id as string);
    return { imported: catalog.data.media.length, collectionIds: [...new Set(catalog.data.media.map((item) => item.collectionId))].sort() };
  });
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
  await inTransaction(db, async (transaction) => {
    const rows = await transaction`
      SELECT a.game_id AS article_game_id, ma.game_id AS media_game_id, ma.spoiler_tags
      FROM articles a CROSS JOIN media_assets ma
      WHERE a.id = ${articleId} AND ma.id = ${mediaId}
    `;
    if (!rows.length) throw new Error("Article or media asset not found");
    if (rows[0].article_game_id !== rows[0].media_game_id) throw new Error("Cover media must belong to the article collection");
    if (jsonArray(rows[0].spoiler_tags).length) throw new Error("Spoiler-tagged media cannot be a cover");
    await transaction`
      INSERT INTO article_media (article_id, media_id, role, selection_source, review_status)
      VALUES (${articleId}, ${mediaId}, 'cover', ${selectionSource}, 'pending')
      ON CONFLICT (article_id, role) DO UPDATE SET
        media_id = EXCLUDED.media_id, selection_source = EXCLUDED.selection_source, review_status = 'pending', reviewed_by = NULL, reviewed_at = NULL, created_at = now()
    `;
    // A pending or replaced cover must not remain in the public surface; a
    // published article's materialized record is refreshed (drafts have no
    // record and the refresh is a no-op). The mutation and refresh commit
    // together so the media state can never outlive a failed refresh.
    await refreshPublicArticleRecord(transaction, articleId);
  });
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
  await inTransaction(db, async (transaction) => {
    const rows = await transaction`UPDATE media_assets SET review_status = 'approved', approved_by = ${reviewer}, approved_at = now(), updated_at = now() WHERE id = ${mediaId} RETURNING id`;
    if (!rows.length) throw new Error("Media asset not found");
    await refreshCoverArticlesForAssets(transaction, [mediaId]);
  });
}

export async function approveMediaCollection(db: Db, collectionId: string, reviewer: string): Promise<number> {
  return inTransaction(db, async (transaction) => {
    const rows = await transaction`
      UPDATE media_assets
      SET review_status = 'approved', approved_by = ${reviewer}, approved_at = now(), updated_at = now()
      WHERE game_id = ${collectionId} AND review_status = 'pending' AND jsonb_array_length(spoiler_tags) = 0
      RETURNING id
    `;
    await refreshCoverArticlesForAssets(transaction, rows.map((row) => row.id as string));
    return rows.length;
  });
}

// Refreshes the materialized public record of every published article whose
// cover references one of the affected media assets.
async function refreshCoverArticlesForAssets(db: Db, mediaIds: string[]): Promise<void> {
  if (!mediaIds.length) return;
  const articles = await db`
    SELECT DISTINCT article_id
    FROM article_media
    WHERE role = 'cover' AND media_id = ANY(${db.array(mediaIds)})
  `;
  for (const article of articles) await refreshPublicArticleRecord(db, article.article_id as string);
}

export async function approveCoverMedia(db: Db, articleId: string, reviewer: string): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const rows = await transaction`
      SELECT am.media_id, ma.review_status AS asset_review_status
      FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
      WHERE am.article_id = ${articleId} AND am.role = 'cover'
    `;
    if (!rows.length) throw new Error("Article has no selected cover media");
    if (rows[0].asset_review_status !== "approved") throw new Error("Cover media asset must be approved before its assignment");
    await transaction`UPDATE article_media SET review_status = 'approved', reviewed_by = ${reviewer}, reviewed_at = now() WHERE article_id = ${articleId} AND role = 'cover'`;
    await refreshPublicArticleRecord(transaction, articleId);
  });
}

export async function rejectCoverMedia(db: Db, articleId: string, reviewer: string): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const rows = await transaction`UPDATE article_media SET review_status = 'rejected', reviewed_by = ${reviewer}, reviewed_at = now() WHERE article_id = ${articleId} AND role = 'cover' RETURNING media_id`;
    if (!rows.length) throw new Error("Article has no selected cover media");
    await refreshPublicArticleRecord(transaction, articleId);
  });
}

export async function clearCoverMedia(db: Db, articleId: string): Promise<void> {
  await inTransaction(db, async (transaction) => {
    await transaction`DELETE FROM article_media WHERE article_id = ${articleId} AND role = 'cover'`;
    await refreshPublicArticleRecord(transaction, articleId);
  });
}
