import { Database } from "bun:sqlite";

// SQLite portability proof: the same capability contracts as the PostgreSQL
// reference adapter, running entirely on bun:sqlite. It exposes assumptions
// hidden by PostgreSQL (advisory locks, SKIP LOCKED, partial indexes, JSON
// features) and proves GameIntel is not secretly a PostgreSQL application.
// Like the in-memory backend it is single-process only: schema versioning uses
// PRAGMA user_version, timestamps are ISO-8601 strings, JSON columns are TEXT.

const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, aliases TEXT NOT NULL, profile TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, canonical_url TEXT NOT NULL, public_citation_url TEXT,
  source_strength TEXT NOT NULL, publication_mode TEXT NOT NULL, policy TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS source_items (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), game_id TEXT NOT NULL,
  external_id TEXT NOT NULL, url TEXT NOT NULL, canonical_url TEXT, title TEXT NOT NULL,
  text_excerpt TEXT NOT NULL, raw_hash TEXT NOT NULL, lineage_id TEXT NOT NULL,
  source_strength TEXT NOT NULL, publication_mode TEXT NOT NULL, discovered_at TEXT NOT NULL,
  published_at TEXT, input_kind TEXT NOT NULL, content_type TEXT, language TEXT,
  retention_until INTEGER NOT NULL, provenance_status TEXT NOT NULL, content_purged_at INTEGER,
  submitted_by TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS source_items_identity ON source_items(source_id, external_id);
CREATE INDEX IF NOT EXISTS source_items_by_hash ON source_items(source_id, raw_hash);
CREATE TABLE IF NOT EXISTS source_item_revisions (
  id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL REFERENCES source_items(id),
  raw_hash TEXT NOT NULL, excerpt TEXT NOT NULL, content_type TEXT, http_status INTEGER,
  is_current INTEGER NOT NULL DEFAULT 0, processing_version TEXT, title TEXT, content TEXT,
  content_purged_at INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS revisions_by_item ON source_item_revisions(source_item_id, is_current);
CREATE TABLE IF NOT EXISTS provenance_families (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, family_key TEXT NOT NULL, root_source_item_id TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS provenance_families_key ON provenance_families(collection_id, family_key);
CREATE TABLE IF NOT EXISTS source_item_provenance (
  source_item_id TEXT PRIMARY KEY REFERENCES source_items(id),
  provenance_family_id TEXT NOT NULL REFERENCES provenance_families(id),
  relationship TEXT NOT NULL, derived_from_source_item_id TEXT,
  clustering_method TEXT NOT NULL, reviewer_id TEXT, notes TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provenance_relationships (
  id TEXT PRIMARY KEY, source_item_id TEXT NOT NULL, related_source_item_id TEXT NOT NULL,
  relationship TEXT NOT NULL, clustering_method TEXT NOT NULL, reviewer_id TEXT NOT NULL,
  notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, source_item_id TEXT NOT NULL,
  newsworthiness REAL NOT NULL, disposition TEXT NOT NULL, existing_article_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, source_item_id TEXT NOT NULL REFERENCES source_items(id),
  subject TEXT NOT NULL, predicate TEXT NOT NULL, value TEXT NOT NULL,
  qualifiers TEXT NOT NULL, claim_key TEXT, spoiler_tags TEXT NOT NULL, exploit_class TEXT,
  evidence_level TEXT NOT NULL, attribution_type TEXT NOT NULL, statement TEXT, editorial_assessment TEXT,
  state TEXT NOT NULL, canonical_claim_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_canonical_idx ON claims(canonical_claim_id);
CREATE TABLE IF NOT EXISTS canonical_claims (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, subject TEXT NOT NULL, predicate TEXT NOT NULL,
  value TEXT NOT NULL, qualifiers TEXT NOT NULL, canonical_key TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (game_id, canonical_key)
);
CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY, source_item_revision_id TEXT NOT NULL REFERENCES source_item_revisions(id),
  processing_version TEXT, normalization_version TEXT, claim_extractor_version TEXT, confidence_model_version TEXT,
  status TEXT NOT NULL DEFAULT 'completed', triggered_by TEXT, trigger_reason TEXT NOT NULL,
  created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX IF NOT EXISTS analysis_runs_revision_idx ON analysis_runs(source_item_revision_id, status, completed_at);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES claims(id),
  source_item_id TEXT NOT NULL, source_item_revision_id TEXT NOT NULL REFERENCES source_item_revisions(id),
  analysis_run_id TEXT REFERENCES analysis_runs(id),
  provenance_family_id TEXT NOT NULL, stance TEXT NOT NULL, evidence_type TEXT NOT NULL,
  excerpt TEXT NOT NULL, start_ms INTEGER, end_ms INTEGER, lineage_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS evidence_claim_run_idx ON evidence(claim_id, analysis_run_id) WHERE analysis_run_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS evidence_reviews (
  id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL REFERENCES evidence(id),
  source_item_revision_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL, notes TEXT NOT NULL, seq INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_reviews_lookup ON evidence_reviews(evidence_id, source_item_revision_id);
CREATE TABLE IF NOT EXISTS source_policy_reviews (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
  seo_title TEXT NOT NULL, description TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL,
  newsworthiness REAL NOT NULL, confidence REAL NOT NULL,
  source_review_completed INTEGER NOT NULL DEFAULT 0, editor_review_completed INTEGER NOT NULL DEFAULT 0,
  article_sources_complete INTEGER NOT NULL DEFAULT 0, approved_by TEXT, approved_at TEXT,
  published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_revisions (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id),
  revision_number INTEGER NOT NULL, body TEXT NOT NULL, change_summary TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_sources (
  id TEXT PRIMARY KEY, article_id TEXT NOT NULL REFERENCES articles(id), source_id TEXT NOT NULL,
  claim_id TEXT, citation_label TEXT NOT NULL, public_citation_url TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
  decision TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY, game_id TEXT NOT NULL, collection TEXT NOT NULL, caption TEXT NOT NULL,
  alt_text TEXT NOT NULL, tags TEXT NOT NULL, spoiler_tags TEXT NOT NULL, attribution TEXT NOT NULL,
  source_url TEXT NOT NULL, source_page_url TEXT NOT NULL, original_key TEXT NOT NULL,
  display_key TEXT NOT NULL, public_url TEXT NOT NULL, content_type TEXT NOT NULL,
  width INTEGER NOT NULL, height INTEGER NOT NULL, checksum TEXT NOT NULL,
  review_status TEXT NOT NULL, approved_by TEXT, approved_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS article_media (
  article_id TEXT NOT NULL REFERENCES articles(id), media_id TEXT NOT NULL REFERENCES media_assets(id),
  role TEXT NOT NULL, selection_source TEXT NOT NULL, review_status TEXT NOT NULL,
  reviewed_by TEXT, reviewed_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (article_id, role)
);
CREATE TABLE IF NOT EXISTS public_submissions (
  id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, submitter_account_id TEXT,
  submitter_session_hash TEXT NOT NULL, submitter_ip_hash TEXT NOT NULL, title TEXT, report TEXT NOT NULL,
  urls TEXT NOT NULL, media_refs TEXT NOT NULL, content_hash TEXT NOT NULL,
  retention_until INTEGER NOT NULL, state TEXT NOT NULL, promoted_source_item_id TEXT,
  content_purged_at INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS submissions_intake ON public_submissions(collection_id, submitter_session_hash, content_hash, created_at);
CREATE TABLE IF NOT EXISTS submission_moderation_actions (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES public_submissions(id),
  actor_id TEXT NOT NULL, action TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL,
  target_type TEXT NOT NULL, target_id TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
  dedupe_key TEXT NOT NULL, priority INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
  available_at INTEGER NOT NULL, leased_by TEXT, lease_token TEXT, lease_expires_at INTEGER,
  last_error TEXT, result TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_dedupe ON jobs(dedupe_key) WHERE status IN ('queued', 'running');
CREATE TABLE IF NOT EXISTS source_fetch_pacing (
  source_id TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ingestion_worker_heartbeats (
  worker_id TEXT PRIMARY KEY, worker_type TEXT NOT NULL, current_job_key TEXT,
  last_error TEXT, last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  message TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  disabled_at TEXT,
  disabled_reason TEXT
);
`;

export function openSqliteDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  // The SQLite portability backend is persistent too. Apply the v3 shape
  // after the base schema so databases created before claim keys and analysis
  // normalization can be upgraded without a destructive table rebuild.
  const columns = db.query("PRAGMA table_info(claims)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "claim_key")) db.exec("ALTER TABLE claims ADD COLUMN claim_key TEXT");
  const runColumns = db.query("PRAGMA table_info(analysis_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "normalization_version")) db.exec("ALTER TABLE analysis_runs ADD COLUMN normalization_version TEXT");
  db.exec("DROP INDEX IF EXISTS analysis_runs_identity_idx");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS claims_source_item_key_idx ON claims(source_item_id, claim_key) WHERE claim_key IS NOT NULL");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_identity_idx ON analysis_runs(source_item_revision_id, normalization_version, claim_extractor_version, confidence_model_version) WHERE status = 'completed'");
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true;
}
