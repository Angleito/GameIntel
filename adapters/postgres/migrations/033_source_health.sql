CREATE TABLE IF NOT EXISTS source_health (
  source_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('ok','down')),
  checked_at timestamptz NOT NULL,
  message text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
