CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS games (
  id text PRIMARY KEY,
  canonical_name text NOT NULL,
  aliases jsonb NOT NULL DEFAULT '[]',
  profile jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sources (
  id text PRIMARY KEY,
  type text NOT NULL,
  canonical_url text NOT NULL UNIQUE,
  public_citation_url text,
  source_strength text NOT NULL,
  publication_mode text NOT NULL DEFAULT 'normal',
  policy jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_items (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES sources(id),
  game_id text NOT NULL REFERENCES games(id),
  external_id text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  text_excerpt text NOT NULL DEFAULT '',
  raw_hash text NOT NULL,
  lineage_id text NOT NULL,
  source_strength text NOT NULL,
  publication_mode text NOT NULL,
  public_visibility boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  newsworthiness numeric NOT NULL,
  disposition text NOT NULL,
  existing_article_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS claims (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  subject text NOT NULL,
  predicate text NOT NULL,
  value text NOT NULL,
  qualifiers jsonb NOT NULL DEFAULT '{}',
  spoiler_tags jsonb NOT NULL DEFAULT '[]',
  exploit_class text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_item_id, subject, predicate, value)
);

CREATE TABLE IF NOT EXISTS evidence (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES claims(id),
  source_item_id text NOT NULL REFERENCES source_items(id),
  stance text NOT NULL,
  evidence_type text NOT NULL,
  excerpt text NOT NULL,
  start_ms integer,
  end_ms integer,
  lineage_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS articles (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  seo_title text NOT NULL,
  description text NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  newsworthiness numeric NOT NULL DEFAULT 0,
  confidence numeric NOT NULL DEFAULT 0,
  source_review_completed boolean NOT NULL DEFAULT false,
  editor_review_completed boolean NOT NULL DEFAULT false,
  article_sources_complete boolean NOT NULL DEFAULT false,
  approved_by text,
  approved_at timestamptz,
  published_at timestamptz,
  updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS article_revisions (
  id text PRIMARY KEY,
  article_id text NOT NULL REFERENCES articles(id),
  revision_number integer NOT NULL,
  body jsonb NOT NULL,
  editor_id text,
  change_summary text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, revision_number)
);

CREATE TABLE IF NOT EXISTS article_sources (
  article_id text NOT NULL REFERENCES articles(id),
  source_id text NOT NULL REFERENCES sources(id),
  claim_id text REFERENCES claims(id),
  citation_label text NOT NULL,
  public_citation_url text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending',
  PRIMARY KEY (article_id, source_id, claim_id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id text PRIMARY KEY,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reviewer_id text NOT NULL,
  decision text NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  previous_state jsonb,
  new_state jsonb,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  job_key text PRIMARY KEY,
  job_type text NOT NULL,
  status text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_items_game_idx ON source_items(game_id, created_at DESC);
CREATE INDEX IF NOT EXISTS articles_game_status_idx ON articles(game_id, status, published_at DESC);
