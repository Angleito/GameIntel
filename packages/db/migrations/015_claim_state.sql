-- Claim state describes what GameIntel currently believes about a claim and
-- is refreshed when continuous ingestion invalidates evidence or a material
-- source revision arrives.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS state text
  CHECK (state IS NULL OR state IN ('unverified', 'supported', 'contested', 'confirmed', 'superseded', 'retracted'));

CREATE INDEX IF NOT EXISTS claims_state_idx ON claims (game_id, state);