-- Analysis runs re-derive claims from the retained revision content, so each
-- immutable revision stores the full title and the retained text that
-- produced its claims. Retention purges clear these columns like any other
-- content; reprocessing is only possible while the content is retained.
ALTER TABLE source_item_revisions ADD COLUMN IF NOT EXISTS title text;
ALTER TABLE source_item_revisions ADD COLUMN IF NOT EXISTS content text;
ALTER TABLE source_item_revisions ADD COLUMN IF NOT EXISTS content_purged_at timestamptz;