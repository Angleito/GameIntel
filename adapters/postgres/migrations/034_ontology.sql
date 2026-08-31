-- Ontology: entities, guides, and the semantic claim model (plan section 5).
-- Entities are first-class domain objects with stable ids and aliases; claims
-- gain entity links and build validity ranges; guides project canonical
-- knowledge and are demoted to draft whenever a referenced claim changes.
CREATE TABLE IF NOT EXISTS entities (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES games(id),
  type text NOT NULL,
  canonical_name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]',
  properties jsonb NOT NULL DEFAULT '{}',
  coordinates jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, canonical_name)
);
CREATE INDEX IF NOT EXISTS entities_aliases_idx ON entities USING GIN (aliases);
CREATE INDEX IF NOT EXISTS entities_collection_type_idx ON entities (collection_id, type);

ALTER TABLE claims ADD COLUMN IF NOT EXISTS subject_entity_id text REFERENCES entities(id);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS object_entity_id text REFERENCES entities(id);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_build_from text;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_build_to text;
CREATE INDEX IF NOT EXISTS claims_subject_entity_idx ON claims (subject_entity_id);
CREATE INDEX IF NOT EXISTS claims_object_entity_idx ON claims (object_entity_id);

ALTER TABLE canonical_claims ADD COLUMN IF NOT EXISTS subject_entity_id text REFERENCES entities(id);
ALTER TABLE canonical_claims ADD COLUMN IF NOT EXISTS object_entity_id text REFERENCES entities(id);
ALTER TABLE canonical_claims ADD COLUMN IF NOT EXISTS valid_build_from text;
ALTER TABLE canonical_claims ADD COLUMN IF NOT EXISTS valid_build_to text;

CREATE TABLE IF NOT EXISTS guides (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES games(id),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL,
  spec jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guide_claims (
  guide_id text NOT NULL REFERENCES guides(id) ON DELETE CASCADE,
  claim_id text NOT NULL REFERENCES claims(id),
  canonical_claim_id text REFERENCES canonical_claims(id),
  PRIMARY KEY (guide_id, claim_id)
);
CREATE INDEX IF NOT EXISTS guide_claims_guide_idx ON guide_claims (guide_id);
