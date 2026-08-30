-- Canonical claim identity (plan section 1): claims from many source items
-- that describe the same real-world fact converge on one canonical claim.
-- The canonical key is derived from the normalized subject/predicate/value
-- and semantic qualifiers; transport details (URL, RSS, pasted text, review
-- status) belong to the source item and evidence provenance, never to the
-- semantic identity. Legacy claims resolve lazily on their next touch via
-- the canonical-key computation shared with the claim extractor.
CREATE TABLE IF NOT EXISTS canonical_claims (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  subject text NOT NULL,
  predicate text NOT NULL,
  value text NOT NULL,
  qualifiers jsonb NOT NULL DEFAULT '{}',
  canonical_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, canonical_key)
);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS canonical_claim_id text REFERENCES canonical_claims(id);
CREATE INDEX IF NOT EXISTS claims_canonical_idx ON claims (canonical_claim_id);