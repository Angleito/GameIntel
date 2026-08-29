CREATE TABLE IF NOT EXISTS ingestion_worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_type text NOT NULL CHECK (worker_type IN ('source_ingest')),
  current_job_key text REFERENCES jobs(job_key) ON DELETE SET NULL,
  last_error text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingestion_worker_heartbeats_seen_idx
  ON ingestion_worker_heartbeats (worker_type, last_seen_at DESC);
