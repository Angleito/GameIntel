-- Analysis run identity covers the analysis stages only: normalization,
-- claim extraction, and the confidence model. The parser version belongs to
-- the immutable source-extraction stage: stored revision content is already
-- parser output, and reprocessing re-extracts from that content, so the
-- parser can never be part of a run's identity. (The recorded
-- processing_version column remains audit metadata on the run.)
-- Legacy runs backfilled by migration 026 carry NULL normalization_version;
-- they mismatch the current tuple and are reprocessed once on their next
-- touch, which is the intended legacy behavior.
ALTER TABLE analysis_runs ADD COLUMN IF NOT EXISTS normalization_version text;

DROP INDEX IF EXISTS analysis_runs_identity_idx;
CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_identity_idx
  ON analysis_runs (source_item_revision_id, normalization_version, claim_extractor_version, confidence_model_version)
  WHERE status = 'completed';