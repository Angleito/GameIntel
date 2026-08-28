import postgres, { type Sql } from "postgres";
import {
  ArticleBodySchema,
  ArticleSchema,
  type Article,
  type ArticleBody,
  ArticleCoverMediaSchema,
  type GameProfile,
  type NormalizedSourceItem,
  type SourcePolicy,
  toSafeArticle,
} from "@gameintel/core";

export {
  approveCoverMedia,
  approveMediaAsset,
  approveMediaCollection,
  clearCoverMedia,
  importMediaCatalog,
  listCoverCandidates,
  recommendArticleCover,
  rejectCoverMedia,
  setCoverMedia,
  type CoverMediaCandidate,
} from "./media.ts";

export type Db = Sql<{}>;

type TransactionRunner = {
  begin?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
  savepoint?: (callback: (transaction: unknown) => Promise<unknown>) => Promise<unknown>;
};

export async function inTransaction<T>(db: Db, callback: (transaction: Db) => Promise<T>): Promise<T> {
  const runner = db as unknown as TransactionRunner;
  const run = async (transaction: unknown): Promise<unknown> => callback(transaction as Db);
  // postgres.js exposes savepoints on transaction handles; use one rather than
  // attempting to start a nested top-level transaction.
  if (typeof runner.savepoint === "function") return await runner.savepoint(run) as T;
  if (typeof runner.begin === "function") return await runner.begin(run) as T;
  throw new Error("Database handle does not support transactions");
}

export function createDb(url = process.env.DATABASE_URL): Db {
  if (!url) throw new Error("DATABASE_URL is required");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!(["postgres:", "postgresql:"].includes(parsed.protocol)) || !parsed.username || !parsed.password) {
    throw new Error("DATABASE_URL must include PostgreSQL credentials");
  }
  return postgres(url, { max: 5, idle_timeout: 20 });
}

const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export async function ensureGame(db: Db, profile: GameProfile): Promise<void> {
  await db`
    INSERT INTO games (id, canonical_name, aliases, profile)
    VALUES (${profile.id}, ${profile.canonicalName}, ${JSON.stringify(profile.aliases)}, ${JSON.stringify(profile)})
    ON CONFLICT (id) DO UPDATE SET canonical_name = EXCLUDED.canonical_name, aliases = EXCLUDED.aliases, profile = EXCLUDED.profile
  `;
}

export async function ensureSource(db: Db, source: {
  id: string; type: string; canonicalUrl: string; publicCitationUrl: string | null;
  sourceStrength: string; publicationMode: string; policy: unknown; enabled?: boolean;
}): Promise<void> {
  await db`
    INSERT INTO sources (id, type, canonical_url, public_citation_url, source_strength, publication_mode, policy, enabled)
    VALUES (${source.id}, ${source.type}, ${source.canonicalUrl}, ${source.publicCitationUrl}, ${source.sourceStrength}, ${source.publicationMode}, ${JSON.stringify(source.policy)}, ${source.enabled ?? true})
    ON CONFLICT (id) DO UPDATE SET public_citation_url = EXCLUDED.public_citation_url, policy = EXCLUDED.policy, enabled = EXCLUDED.enabled
  `;
}

function retainedExcerpt(text: string, policy: SourcePolicy): string {
  if (policy.retainRawTextDays === 0) return "";
  return text.slice(0, policy.mayStoreFullText ? 4_000 : 1_000);
}

function retentionUntil(policy: SourcePolicy): Date {
  return new Date(Date.now() + policy.retainRawTextDays * 86_400_000);
}

export async function insertSourceItem(db: Db, item: NormalizedSourceItem, rawHash: string, lineageId: string, policy: SourcePolicy): Promise<{ id: string; duplicate: boolean }> {
  // processNormalizedItem holds this transaction-scoped lock across the duplicate check and insert.
  await db`SELECT pg_advisory_xact_lock(hashtextextended(${`${item.sourceId}:${rawHash}`}, 0))`;
  const existing = await db`SELECT id FROM source_items WHERE source_id = ${item.sourceId} AND (external_id = ${item.externalId} OR raw_hash = ${rawHash}) LIMIT 1`;
  if (existing.length) return { id: existing[0].id as string, duplicate: true };
  const itemId = id("src");
  const excerpt = retainedExcerpt(item.text, policy);
  const inserted = await db`
    INSERT INTO source_items (id, source_id, game_id, external_id, url, canonical_url, title, text_excerpt, raw_hash, lineage_id, source_strength, publication_mode, public_visibility, discovered_at, published_at, input_kind, content_type, language, retention_until, provenance_status)
    VALUES (${itemId}, ${item.sourceId}, ${item.collectionId}, ${item.externalId}, ${item.url}, ${item.url.startsWith("urn:") ? null : item.url}, ${item.title}, ${excerpt}, ${rawHash}, ${lineageId}, ${item.sourceStrength}, ${item.publicationMode}, false, ${item.discoveredAt}, ${item.publishedAt}, ${item.inputKind}, ${item.contentType}, ${item.language}, ${retentionUntil(policy)}, 'normalized')
    ON CONFLICT (source_id, external_id) DO NOTHING
    RETURNING id
  `;
  if (!inserted.length) {
    const concurrent = await db`SELECT id FROM source_items WHERE source_id = ${item.sourceId} AND external_id = ${item.externalId} LIMIT 1`;
    if (concurrent.length) return { id: concurrent[0].id as string, duplicate: true };
    throw new Error("Source item insert did not return a row");
  }
  await db`INSERT INTO source_item_revisions (id, source_item_id, raw_hash, excerpt, content_type, http_status) VALUES (${id("srcrev")}, ${itemId}, ${rawHash}, ${excerpt}, ${item.contentType}, ${item.inputKind === "url" || item.inputKind === "rss" ? 200 : null})`;
  return { id: itemId, duplicate: false };
}

export async function createEvent(db: Db, input: { collectionId: string; sourceItemId: string; newsworthiness: number; disposition: string; existingArticleId?: string | null }): Promise<string> {
  const eventId = id("evt");
  await db`
    INSERT INTO events (id, game_id, source_item_id, newsworthiness, disposition, existing_article_id)
    VALUES (${eventId}, ${input.collectionId}, ${input.sourceItemId}, ${input.newsworthiness}, ${input.disposition}, ${input.existingArticleId ?? null})
  `;
  return eventId;
}

export async function insertClaim(db: Db, item: NormalizedSourceItem, sourceItemId: string, claim: NormalizedSourceItem["claims"][number], lineageId: string): Promise<string> {
  const claimId = id("clm");
  const existing = await db`SELECT id FROM claims WHERE source_item_id = ${sourceItemId} AND subject = ${claim.subject} AND predicate = ${claim.predicate} AND value = ${claim.value}`;
  if (existing.length) return existing[0].id as string;
  await db`
    INSERT INTO claims (id, game_id, source_item_id, subject, predicate, value, qualifiers, spoiler_tags, exploit_class, evidence_level, attribution_type, statement, editorial_assessment)
    VALUES (${claimId}, ${item.collectionId}, ${sourceItemId}, ${claim.subject}, ${claim.predicate}, ${claim.value}, ${JSON.stringify(claim.qualifiers)}, ${JSON.stringify(claim.spoilerTags)}, ${claim.exploitClass}, ${claim.evidenceLevel}, ${claim.attributionType}, ${claim.statement}, ${claim.editorialAssessment})
  `;
  await db`
    INSERT INTO evidence (id, claim_id, source_item_id, stance, evidence_type, excerpt, start_ms, end_ms, lineage_id)
    VALUES (${id("evd")}, ${claimId}, ${sourceItemId}, 'supports', ${claim.evidenceType}, ${claim.excerpt}, ${claim.startMs}, ${claim.endMs}, ${lineageId})
  `;
  return claimId;
}

export async function createArticleDraft(db: Db, input: {
  collectionId: string; title: string; description: string; body: ArticleBody;
  newsworthiness: number; confidence: number;
  sourceRefs: Array<{ sourceId: string; claimId: string | null; citationLabel: string; publicCitationUrl: string }>;
}): Promise<string> {
  const articleId = id("art");
  const slug = `${input.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}-${articleId.slice(-8)}`;
  await db`
    INSERT INTO articles (id, game_id, slug, title, seo_title, description, body, newsworthiness, confidence, article_sources_complete)
    VALUES (${articleId}, ${input.collectionId}, ${slug}, ${input.title}, ${input.title}, ${input.description}, ${JSON.stringify(input.body)}, ${input.newsworthiness}, ${input.confidence}, false)
  `;
  await db`
    INSERT INTO article_revisions (id, article_id, revision_number, body, change_summary)
    VALUES (${id("rev")}, ${articleId}, 1, ${JSON.stringify(input.body)}, 'Initial AI-assisted draft')
  `;
  for (const source of input.sourceRefs) {
    await db`
    INSERT INTO article_sources (id, article_id, source_id, claim_id, citation_label, public_citation_url)
    VALUES (${id("arts")}, ${articleId}, ${source.sourceId}, ${source.claimId}, ${source.citationLabel}, ${source.publicCitationUrl})
    `;
  }
  return articleId;
}

function parseArticle(row: Record<string, unknown>): Article {
  const jsonValue = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
  return ArticleSchema.parse({
    id: row.id, collectionId: row.game_id, slug: row.slug, title: row.title, seoTitle: row.seo_title,
    description: row.description, body: ArticleBodySchema.parse(jsonValue(row.body)), status: row.status,
    newsworthiness: Number(row.newsworthiness), confidence: Number(row.confidence),
    sourceReviewCompleted: row.source_review_completed, editorReviewCompleted: row.editor_review_completed,
    articleSourcesComplete: row.article_sources_complete,
    sourceRefs: jsonValue(row.source_refs ?? []),
    coverMedia: row.cover_media ? ArticleCoverMediaSchema.parse(jsonValue(row.cover_media)) : null,
    approvedBy: row.approved_by,
    publishedAt: row.published_at ? new Date(row.published_at as string).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at as string).toISOString() : null,
  });
}

const articleSelect = (db: Db) => db`
  SELECT a.*, COALESCE(jsonb_agg(DISTINCT jsonb_build_object('sourceId', ass.source_id, 'claimId', ass.claim_id, 'citationLabel', ass.citation_label, 'publicCitationUrl', ass.public_citation_url)) FILTER (WHERE ass.article_id IS NOT NULL), '[]') AS source_refs,
    cover.cover_media
  FROM articles a
    LEFT JOIN article_sources ass ON ass.article_id = a.id
    LEFT JOIN LATERAL (
      SELECT jsonb_build_object(
        'id', ma.id,
        'caption', ma.caption,
        'altText', ma.alt_text,
        'collection', ma.collection,
        'tags', ma.tags,
        'spoilerTags', ma.spoiler_tags,
        'attribution', ma.attribution,
        'sourceUrl', ma.source_url,
        'publicUrl', ma.public_url,
        'selectionSource', am.selection_source,
        'reviewStatus', CASE
          WHEN am.review_status = 'approved' AND ma.review_status = 'approved' THEN 'approved'
          WHEN am.review_status = 'rejected' THEN 'rejected'
          ELSE 'pending'
        END
      ) AS cover_media
      FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
      WHERE am.article_id = a.id AND am.role = 'cover'
      LIMIT 1
    ) cover ON true
`;

export async function getArticle(db: Db, idOrSlug: string, publishedOnly = false): Promise<Article | null> {
  const rows = publishedOnly
    ? await db`${articleSelect(db)} WHERE (a.id = ${idOrSlug} OR a.slug = ${idOrSlug}) AND a.status IN ('published', 'updated') GROUP BY a.id, cover.cover_media ORDER BY a.created_at DESC LIMIT 1`
    : await db`${articleSelect(db)} WHERE (a.id = ${idOrSlug} OR a.slug = ${idOrSlug}) GROUP BY a.id, cover.cover_media LIMIT 1`;
  return rows.length ? parseArticle(rows[0] as Record<string, unknown>) : null;
}

export async function listArticles(db: Db, collectionId: string, publishedOnly = true): Promise<Article[]> {
  const rows = publishedOnly
    ? await db`${articleSelect(db)} WHERE a.game_id = ${collectionId} AND a.status IN ('published', 'updated') GROUP BY a.id, cover.cover_media ORDER BY COALESCE(a.published_at, a.created_at) DESC`
    : await db`${articleSelect(db)} WHERE a.game_id = ${collectionId} GROUP BY a.id, cover.cover_media ORDER BY a.created_at DESC`;
  return rows.map((row) => parseArticle(row as Record<string, unknown>));
}

type ArticleSourceState = {
  sourceCount: number;
  approvedCount: number;
  latestChangeAt: unknown;
};

async function lockArticle(db: Db, articleId: string): Promise<Record<string, unknown>> {
  const articles = await db`SELECT id, status FROM articles WHERE id = ${articleId} FOR UPDATE`;
  if (!articles.length) throw new Error("Article not found");
  await db`SELECT article_id FROM article_sources WHERE article_id = ${articleId} FOR UPDATE`;
  return articles[0] as Record<string, unknown>;
}

async function articleSourceState(db: Db, articleId: string): Promise<ArticleSourceState> {
  const rows = await db`
    SELECT
      count(*)::int AS source_count,
      count(*) FILTER (WHERE review_status = 'approved' AND reviewed_at IS NOT NULL)::int AS approved_count,
      max(updated_at) AS latest_change_at
    FROM article_sources
    WHERE article_id = ${articleId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  return {
    sourceCount: Number(row?.source_count ?? 0),
    approvedCount: Number(row?.approved_count ?? 0),
    latestChangeAt: row?.latest_change_at ?? null,
  };
}

function timestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

async function assertPublicationRequirements(db: Db, articleId: string): Promise<void> {
  const sources = await articleSourceState(db, articleId);
  if (!sources.sourceCount || sources.approvedCount !== sources.sourceCount) {
    throw new Error("Publication approval requires source review for every source reference");
  }
  const reviews = await db`
    SELECT max(created_at) AS reviewed_at
    FROM reviews
    WHERE target_type = 'article' AND target_id = ${articleId} AND decision = 'approved'
  `;
  const reviewedAt = timestamp((reviews[0] as Record<string, unknown> | undefined)?.reviewed_at);
  const latestSourceChange = timestamp(sources.latestChangeAt);
  if (!Number.isFinite(reviewedAt) || (Number.isFinite(latestSourceChange) && reviewedAt < latestSourceChange)) {
    throw new Error("Publication approval requires a current editorial review");
  }
}

export async function reviewSource(db: Db, sourceId: string, reviewerId: string, notes = ""): Promise<void> {
  await inTransaction(db, async (transaction) => {
    const source = await transaction`SELECT id FROM sources WHERE id = ${sourceId} FOR UPDATE`;
    if (!source.length) throw new Error("Source not found");
    await transaction`
      SELECT a.id FROM articles a
      WHERE EXISTS (SELECT 1 FROM article_sources ass WHERE ass.article_id = a.id AND ass.source_id = ${sourceId})
      ORDER BY a.id
      FOR UPDATE
    `;
    await transaction`SELECT article_id FROM article_sources WHERE source_id = ${sourceId} FOR UPDATE`;
    await transaction`INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision, notes) VALUES (${id("revw")}, 'source', ${sourceId}, ${reviewerId}, 'approved', ${notes})`;
    await transaction`
      UPDATE article_sources
      SET review_status = 'approved', reviewed_by = ${reviewerId}, reviewed_at = now(), updated_at = now()
      WHERE source_id = ${sourceId} AND (review_status <> 'approved' OR reviewed_at IS NULL)
    `;
    await transaction`
      WITH affected AS (
        SELECT DISTINCT article_id FROM article_sources WHERE source_id = ${sourceId}
      ), state AS (
        SELECT ass.article_id,
          count(*) > 0 AS sources_complete,
          bool_and(ass.review_status = 'approved' AND ass.reviewed_at IS NOT NULL) AS source_review_complete
        FROM article_sources ass JOIN affected ON affected.article_id = ass.article_id
        GROUP BY ass.article_id
      )
      UPDATE articles a
      SET source_review_completed = state.source_review_complete,
        article_sources_complete = state.sources_complete,
        status = CASE
          WHEN state.source_review_complete AND a.status = 'draft' THEN 'source_review'
          WHEN NOT state.source_review_complete AND a.status <> 'retracted' THEN 'draft'
          ELSE a.status
        END
      FROM state
      WHERE a.id = state.article_id
    `;
    await audit(transaction, reviewerId, "source_review.approved", "source", sourceId, notes);
  });
}

export async function reviewArticle(db: Db, articleId: string, reviewerId: string, notes = ""): Promise<void> {
  await inTransaction(db, async (transaction) => {
    await lockArticle(transaction, articleId);
    const sources = await articleSourceState(transaction, articleId);
    if (!sources.sourceCount || sources.approvedCount !== sources.sourceCount) {
      throw new Error("Editorial review requires every source reference to be approved");
    }
    await transaction`INSERT INTO reviews (id, target_type, target_id, reviewer_id, decision, notes) VALUES (${id("revw")}, 'article', ${articleId}, ${reviewerId}, 'approved', ${notes})`;
    await transaction`
      UPDATE articles
      SET source_review_completed = true, editor_review_completed = true, article_sources_complete = true,
        status = CASE WHEN status IN ('draft', 'source_review') THEN 'editor_review' ELSE status END
      WHERE id = ${articleId}
    `;
    await audit(transaction, reviewerId, "article_review.approved", "article", articleId, notes);
  });
}

export async function approveArticle(db: Db, articleId: string, approver: string): Promise<void> {
  await inTransaction(db, async (transaction) => {
    await lockArticle(transaction, articleId);
    await assertPublicationRequirements(transaction, articleId);
    await transaction`
      UPDATE articles
      SET source_review_completed = true, editor_review_completed = true, article_sources_complete = true,
        status = 'approved', approved_by = ${approver}, approved_at = now()
      WHERE id = ${articleId}
    `;
    await audit(transaction, approver, "article.publication_approved", "article", articleId, "Human publication approval");
  });
}

export async function markPublished(db: Db, articleId: string, operator: string): Promise<Article> {
  await inTransaction(db, async (transaction) => {
    const article = await lockArticle(transaction, articleId);
    if (article.status !== "approved") throw new Error("Only approved articles can be published");
    await assertPublicationRequirements(transaction, articleId);
    const cover = await transaction`
      SELECT am.review_status AS assignment_review_status, ma.review_status AS asset_review_status
      FROM article_media am JOIN media_assets ma ON ma.id = am.media_id
      WHERE am.article_id = ${articleId} AND am.role = 'cover'
      FOR UPDATE
    `;
    if (cover.length && (cover[0].assignment_review_status !== "approved" || cover[0].asset_review_status !== "approved")) {
      throw new Error("Selected cover media must be approved before publication");
    }
    await transaction`UPDATE articles SET status = 'published', published_at = now(), updated_at = now() WHERE id = ${articleId}`;
    await audit(transaction, operator, "article.published", "article", articleId, "Published sanitized artifact");
  });
  return (await getArticle(db, articleId, true))!;
}

export type SourceContentPurgeResult = {
  eligibleSourceItems: number;
  purgedSourceItems: number;
  purgedRevisions: number;
  purgedEvidence: number;
  dryRun: boolean;
};

export async function purgeExpiredSourceContent(db: Db, options: { execute?: boolean } = {}): Promise<SourceContentPurgeResult> {
  return inTransaction(db, async (transaction) => {
    const candidates = await transaction`
      SELECT si.id
      FROM source_items si
      WHERE si.retention_until IS NOT NULL
        AND si.retention_until <= now()
        AND si.content_purged_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM articles a
          JOIN article_sources ass ON ass.article_id = a.id
          LEFT JOIN claims c ON c.id = ass.claim_id
          WHERE a.status IN ('draft', 'source_review', 'editor_review', 'approved', 'updated')
            AND (c.source_item_id = si.id OR (ass.claim_id IS NULL AND ass.source_id = si.source_id))
        )
      FOR UPDATE
    `;
    const ids = candidates.map((candidate) => candidate.id as string);
    if (!options.execute || !ids.length) {
      return { eligibleSourceItems: ids.length, purgedSourceItems: 0, purgedRevisions: 0, purgedEvidence: 0, dryRun: !options.execute };
    }
    const revisions = await transaction`UPDATE source_item_revisions SET excerpt = '' WHERE source_item_id = ANY(${transaction.array(ids)}) AND excerpt <> '' RETURNING id`;
    const evidence = await transaction`UPDATE evidence SET excerpt = '' WHERE source_item_id = ANY(${transaction.array(ids)}) AND excerpt <> '' RETURNING id`;
    const sourceItems = await transaction`UPDATE source_items SET text_excerpt = '', content_purged_at = now() WHERE id = ANY(${transaction.array(ids)}) RETURNING id`;
    return {
      eligibleSourceItems: ids.length,
      purgedSourceItems: sourceItems.length,
      purgedRevisions: revisions.length,
      purgedEvidence: evidence.length,
      dryRun: false,
    };
  });
}

export async function audit(db: Db, actor: string, action: string, targetType: string, targetId: string, reason: string): Promise<void> {
  await db`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, reason) VALUES (${id("audit")}, ${actor}, ${action}, ${targetType}, ${targetId}, ${reason})`;
}

export async function publicArticles(db: Db, collectionId: string): Promise<unknown[]> {
  return (await listArticles(db, collectionId, true)).map(toSafeArticle).filter(Boolean);
}

export async function closeDb(db: Db): Promise<void> {
  await db.end({ timeout: 2 });
}
