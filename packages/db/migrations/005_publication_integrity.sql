-- Preserve existing rows while allowing source references without a claim.
ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS id text;
UPDATE article_sources
SET id = 'arts_' || md5(article_id || ':' || source_id || ':' || COALESCE(claim_id, ''))
WHERE id IS NULL;
ALTER TABLE article_sources ALTER COLUMN id SET NOT NULL;
ALTER TABLE article_sources DROP CONSTRAINT IF EXISTS article_sources_pkey;
ALTER TABLE article_sources ADD CONSTRAINT article_sources_pkey PRIMARY KEY (id);
CREATE UNIQUE INDEX IF NOT EXISTS article_sources_article_source_claim_idx
  ON article_sources (article_id, source_id, COALESCE(claim_id, ''));
ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE article_sources ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE source_items ADD COLUMN IF NOT EXISTS content_purged_at timestamptz;

CREATE INDEX IF NOT EXISTS article_sources_article_review_idx
  ON article_sources (article_id, review_status, updated_at);
CREATE INDEX IF NOT EXISTS source_items_retention_idx
  ON source_items (retention_until) WHERE content_purged_at IS NULL;
