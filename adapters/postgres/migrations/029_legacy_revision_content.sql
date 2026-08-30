-- Legacy source revisions (created before migration 024 stored per-revision
-- title/content) can only be reprocessed while retained content still
-- exists. Current, non-purged revisions are backfilled from their source
-- item's retained text, so unchanged re-fetches can rerun analysis instead
-- of being treated as non-reprocessable. Older revisions whose content was
-- never stored remain NULL and are reported as purged (non-reprocessable).
UPDATE source_item_revisions revision
SET title = source_item.title,
  content = source_item.text_excerpt,
  content_purged_at = source_item.content_purged_at
FROM source_items source_item
WHERE revision.source_item_id = source_item.id
  AND revision.is_current
  AND revision.title IS NULL
  AND revision.content IS NULL
  AND source_item.content_purged_at IS NULL;