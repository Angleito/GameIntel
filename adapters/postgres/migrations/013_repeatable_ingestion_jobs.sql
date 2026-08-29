-- A job_key identifies one execution. A dedupe_key identifies the work to be
-- done. Only one active (queued or running) execution may exist per dedupe
-- key, but a terminal execution never blocks a later refresh of the same URL.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dedupe_key text;

-- Backfill existing rows from their legacy job keys, which already encode
-- collection:source:canonical-url-hash.
UPDATE jobs
SET dedupe_key = job_key
WHERE dedupe_key IS NULL
  AND job_type = 'source_ingest';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe_idx
  ON jobs (dedupe_key)
  WHERE status IN ('queued', 'running');