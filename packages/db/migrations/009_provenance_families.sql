CREATE TABLE IF NOT EXISTS provenance_families (
  id text PRIMARY KEY,
  collection_id text NOT NULL REFERENCES games(id),
  family_key text NOT NULL,
  root_source_item_id text REFERENCES source_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, family_key)
);

CREATE TABLE IF NOT EXISTS source_item_provenance (
  source_item_id text PRIMARY KEY REFERENCES source_items(id),
  provenance_family_id text NOT NULL REFERENCES provenance_families(id),
  relationship text NOT NULL DEFAULT 'original' CHECK (relationship IN ('original', 'copied_from', 'quoted_from', 'derived_from', 'independent_reproduction', 'contradiction', 'same_media', 'same_source_family')),
  derived_from_source_item_id text REFERENCES source_items(id),
  clustering_method text NOT NULL DEFAULT 'lineage' CHECK (clustering_method IN ('lineage', 'automatic_exact', 'manual', 'declared')),
  reviewer_id text,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provenance_relationships (
  id text PRIMARY KEY,
  source_item_id text NOT NULL REFERENCES source_items(id),
  related_source_item_id text NOT NULL REFERENCES source_items(id),
  relationship text NOT NULL CHECK (relationship IN ('copied_from', 'quoted_from', 'derived_from', 'independent_reproduction', 'contradiction', 'same_media', 'same_source_family')),
  clustering_method text NOT NULL CHECK (clustering_method IN ('automatic_exact', 'manual', 'declared')),
  reviewer_id text,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_item_id, related_source_item_id, relationship)
);

ALTER TABLE evidence ADD COLUMN IF NOT EXISTS provenance_family_id text REFERENCES provenance_families(id);

INSERT INTO provenance_families (id, collection_id, family_key, root_source_item_id)
SELECT 'pf_' || md5(source_item.game_id || ':' || source_item.lineage_id), source_item.game_id, 'lineage:' || source_item.lineage_id, source_item.id
FROM source_items source_item
ON CONFLICT (collection_id, family_key) DO NOTHING;

INSERT INTO source_item_provenance (source_item_id, provenance_family_id, relationship, clustering_method)
SELECT source_item.id, family.id, 'original', 'lineage'
FROM source_items source_item
JOIN provenance_families family
  ON family.collection_id = source_item.game_id AND family.family_key = 'lineage:' || source_item.lineage_id
ON CONFLICT (source_item_id) DO NOTHING;

UPDATE evidence evidence_row
SET provenance_family_id = source_provenance.provenance_family_id
FROM source_item_provenance source_provenance
WHERE source_provenance.source_item_id = evidence_row.source_item_id
  AND evidence_row.provenance_family_id IS NULL;

CREATE INDEX IF NOT EXISTS provenance_families_collection_idx
  ON provenance_families (collection_id, created_at DESC);
CREATE INDEX IF NOT EXISTS source_item_provenance_family_idx
  ON source_item_provenance (provenance_family_id, source_item_id);
CREATE INDEX IF NOT EXISTS provenance_relationships_related_idx
  ON provenance_relationships (related_source_item_id, relationship);
CREATE INDEX IF NOT EXISTS evidence_provenance_family_idx
  ON evidence (provenance_family_id, claim_id);
