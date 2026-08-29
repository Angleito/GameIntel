-- Evidence review rows created inside one transaction share now() as
-- created_at, and id values are random. The latest-review-per-reviewer
-- selection therefore needs a monotonic sequence for a deterministic
-- tie-break; otherwise a dispute or rejection may be selected out of order.
ALTER TABLE evidence_reviews ADD COLUMN IF NOT EXISTS seq bigserial;

CREATE INDEX IF NOT EXISTS evidence_reviews_reviewer_seq_idx
  ON evidence_reviews (evidence_id, source_item_revision_id, reviewer_id, seq DESC);