ALTER TABLE source_items ADD COLUMN IF NOT EXISTS input_kind text NOT NULL DEFAULT 'manual_fixture';
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS content_type text;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS language text;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS retention_until timestamptz;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS http_status integer;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS fetched_at timestamptz;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS etag text;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS last_modified text;
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS provenance_status text NOT NULL DEFAULT 'normalized';
ALTER TABLE source_items ADD COLUMN IF NOT EXISTS canonical_url text;

CREATE TABLE IF NOT EXISTS source_item_revisions (
  id text PRIMARY KEY,
  source_item_id text NOT NULL REFERENCES source_items(id),
  raw_hash text NOT NULL,
  excerpt text NOT NULL,
  content_type text,
  http_status integer,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS source_items_canonical_url_idx ON source_items(canonical_url);
CREATE INDEX IF NOT EXISTS source_items_raw_hash_idx ON source_items(raw_hash);
