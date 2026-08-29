-- Previous releases recorded approval state without reviewer/timestamp fields.
-- Backfill that legacy state before the stricter all-source review checks run.
UPDATE article_sources
SET reviewed_at = COALESCE(updated_at, now()),
    reviewed_by = COALESCE(reviewed_by, 'legacy-review')
WHERE review_status = 'approved' AND reviewed_at IS NULL;
