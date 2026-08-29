CREATE TABLE IF NOT EXISTS media_assets (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES games(id),
  collection text NOT NULL,
  caption text NOT NULL,
  alt_text text NOT NULL,
  tags jsonb NOT NULL DEFAULT '[]',
  spoiler_tags jsonb NOT NULL DEFAULT '[]',
  attribution text NOT NULL,
  source_url text NOT NULL,
  source_page_url text NOT NULL,
  original_key text NOT NULL,
  display_key text NOT NULL,
  public_url text NOT NULL,
  content_type text NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  checksum text NOT NULL,
  review_status text NOT NULL DEFAULT 'pending',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, checksum),
  UNIQUE (game_id, display_key)
);

CREATE TABLE IF NOT EXISTS article_media (
  article_id text NOT NULL REFERENCES articles(id),
  media_id text NOT NULL REFERENCES media_assets(id),
  role text NOT NULL DEFAULT 'cover',
  selection_source text NOT NULL DEFAULT 'automatic',
  review_status text NOT NULL DEFAULT 'pending',
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, role)
);

CREATE INDEX IF NOT EXISTS media_assets_game_review_idx ON media_assets(game_id, review_status);
CREATE INDEX IF NOT EXISTS article_media_media_idx ON article_media(media_id);
