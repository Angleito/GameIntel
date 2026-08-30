-- Per-source claim identity is qualifier-aware: a source item can describe
-- the same subject/predicate/value under different semantic conditions
-- ({time: night} vs {time: day}), and those are distinct claims. The claim
-- key is the same canonical key derivation used for cross-source identity,
-- so one identity rule applies everywhere. Legacy rows backfill lazily on
-- their next touch (claim_key IS NULL rows remain addressable by the old
-- subject/predicate/value fallback).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS claim_key text;

-- The old uniqueness constraint conflated qualifier-differentiated claims.
-- It is replaced by a partial unique index on the claim key.
ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_source_item_id_subject_predicate_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS claims_source_item_key_idx
  ON claims (source_item_id, claim_key)
  WHERE claim_key IS NOT NULL;