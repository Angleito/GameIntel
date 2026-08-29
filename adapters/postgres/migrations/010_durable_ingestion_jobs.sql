ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS leased_by text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS jobs_ready_idx
  ON jobs (status, priority DESC, available_at, created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON jobs (status, lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS source_fetch_pacing (
  source_id text PRIMARY KEY REFERENCES sources(id),
  next_allowed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
