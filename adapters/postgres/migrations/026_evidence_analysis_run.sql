-- Evidence belongs to the analysis run that produced it, not to the revision
-- alone: a revision may be interpreted by many runs over time, and only the
-- latest completed run is current. The old (claim_id, revision_id) dedupe is
-- replaced by (claim_id, analysis_run_id).
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS analysis_run_id text REFERENCES analysis_runs(id);
DROP INDEX IF EXISTS evidence_claim_revision_idx;
CREATE UNIQUE INDEX IF NOT EXISTS evidence_claim_run_idx
  ON evidence (claim_id, analysis_run_id)
  WHERE analysis_run_id IS NOT NULL;

-- Backfill: one completed run per retained revision that already has
-- evidence, using the recorded processing version. Legacy runs carry NULL
-- extractor/confidence versions, so any future version mismatch triggers a
-- reprocessing run on the next touch of the revision.
INSERT INTO analysis_runs (id, source_item_revision_id, processing_version, status, triggered_by, trigger_reason, completed_at)
SELECT 'backfill_' || evidence_revisions.source_item_revision_id,
  evidence_revisions.source_item_revision_id,
  revision.processing_version,
  'completed',
  'migration-026',
  'backfill legacy evidence into an analysis run',
  now()
FROM (
  SELECT DISTINCT source_item_revision_id
  FROM evidence
  WHERE source_item_revision_id IS NOT NULL
) evidence_revisions
JOIN source_item_revisions revision ON revision.id = evidence_revisions.source_item_revision_id
WHERE NOT EXISTS (
  SELECT 1
  FROM analysis_runs existing
  WHERE existing.source_item_revision_id = evidence_revisions.source_item_revision_id
);

UPDATE evidence evidence_row
SET analysis_run_id = (
  SELECT run.id
  FROM analysis_runs run
  WHERE run.source_item_revision_id = evidence_row.source_item_revision_id
    AND run.status = 'completed'
  ORDER BY run.completed_at DESC, run.id DESC
  LIMIT 1
)
WHERE evidence_row.analysis_run_id IS NULL;