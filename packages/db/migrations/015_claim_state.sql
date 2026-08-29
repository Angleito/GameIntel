-- Claim state describes what GameIntel currently believes about a claim and
-- is refreshed when continuous ingestion invalidates evidence or a material
-- source revision arrives. Existing claims are backfilled with the same
-- derivation used at runtime: state is computed from current-revision
-- evidence only.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS state text;

UPDATE claims claim
SET state = CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM evidence e
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
    WHERE e.claim_id = claim.id
  ) THEN 'unverified'
  WHEN NOT EXISTS (
    SELECT 1 FROM evidence e
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
    WHERE e.claim_id = claim.id AND revision.is_current
  ) THEN 'superseded'
  WHEN EXISTS (
    SELECT 1 FROM evidence e
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
    WHERE e.claim_id = claim.id AND revision.is_current AND e.stance = 'contradicts'
  ) THEN 'contested'
  WHEN EXISTS (
    SELECT 1 FROM evidence e
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
    JOIN source_items item ON item.id = e.source_item_id
    WHERE e.claim_id = claim.id AND revision.is_current AND e.stance <> 'contradicts'
      AND item.source_strength IN ('PRIMARY', 'DIRECT_EVIDENCE')
  ) THEN 'confirmed'
  WHEN EXISTS (
    SELECT 1 FROM evidence e
    JOIN source_item_revisions revision ON revision.id = e.source_item_revision_id
    WHERE e.claim_id = claim.id AND revision.is_current AND e.stance <> 'contradicts'
  ) THEN 'supported'
  ELSE 'unverified'
END
WHERE claim.state IS NULL;

ALTER TABLE claims ALTER COLUMN state SET NOT NULL;

ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_state_check;
ALTER TABLE claims ADD CONSTRAINT claims_state_check
  CHECK (state IN ('unverified', 'supported', 'contested', 'confirmed', 'superseded', 'retracted'));

CREATE INDEX IF NOT EXISTS claims_state_idx ON claims (game_id, state);