-- Evidence approval belongs to the exact retained source revision, not to a
-- source-wide identity. A later material change therefore needs fresh review.
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS submitted_by text;

ALTER TABLE source_item_revisions ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true;
WITH latest_revision AS (
  SELECT DISTINCT ON (source_item_id) source_item_id, id
  FROM source_item_revisions
  ORDER BY source_item_id, created_at DESC, id DESC
)
UPDATE source_item_revisions revision
SET is_current = (revision.id = latest_revision.id)
FROM latest_revision
WHERE revision.source_item_id = latest_revision.source_item_id;

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS source_item_revision_id text REFERENCES source_item_revisions(id);
UPDATE evidence evidence_row
SET source_item_revision_id = (
  SELECT id
  FROM source_item_revisions
  WHERE source_item_id = evidence_row.source_item_id
  ORDER BY is_current DESC, created_at DESC, id DESC
  LIMIT 1
)
WHERE evidence_row.source_item_revision_id IS NULL;

CREATE TABLE IF NOT EXISTS source_policy_reviews (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id),
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence_reviews (
  id text PRIMARY KEY,
  evidence_id text NOT NULL REFERENCES evidence(id),
  source_item_revision_id text NOT NULL REFERENCES source_item_revisions(id),
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'disputed')),
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_claim_revision_idx
  ON evidence (claim_id, source_item_revision_id)
  WHERE source_item_revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_item_revisions_current_idx
  ON source_item_revisions (source_item_id, is_current, created_at DESC);
CREATE INDEX IF NOT EXISTS source_policy_reviews_source_idx
  ON source_policy_reviews (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS evidence_reviews_current_idx
  ON evidence_reviews (evidence_id, source_item_revision_id, reviewer_id, created_at DESC);
