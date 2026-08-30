-- Analysis runs (plan section 2): a source revision is content history; an
-- analysis run is an interpretation of that history by a specific
-- parser/normalization/claim-extractor/confidence-model version. Reprocessing
-- a revision creates a new run and supersedes prior runs, so evidence and
-- review surfaces can answer "why does GameIntel currently believe this?"
-- and "would reprocessing produce a different result?". A completed run with
-- identical versions is idempotent; any version mismatch triggers a rerun.
CREATE TABLE IF NOT EXISTS analysis_runs (
  id text PRIMARY KEY,
  source_item_revision_id text NOT NULL REFERENCES source_item_revisions(id),
  processing_version text,
  claim_extractor_version text,
  confidence_model_version text,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'superseded')),
  triggered_by text,
  trigger_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS analysis_runs_revision_idx
  ON analysis_runs (source_item_revision_id, status, completed_at DESC);

-- At most one completed run per (revision, versions) tuple; superseded runs
-- keep their rows for audit but are excluded from state derivation.
CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_identity_idx
  ON analysis_runs (source_item_revision_id, processing_version, claim_extractor_version, confidence_model_version)
  WHERE status = 'completed';