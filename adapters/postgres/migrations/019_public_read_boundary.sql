-- The public role reads only the published article surface and the minimal
-- submission-intake projection. Internal knowledge-base tables (source
-- material, claims, evidence, evidence reviews, provenance, moderation
-- trails) are never readable by a public process.
REVOKE SELECT ON source_items, source_item_revisions, events, claims, evidence, evidence_reviews,
  article_revisions, provenance_families, provenance_relationships, source_item_provenance,
  submission_moderation_actions, audit_log
  FROM gameintel_public;

-- public_submissions carries submitter identity hashes, account IDs, and the
-- full report. The public intake path only needs duplicate detection and rate
-- counts, so the role may read the projection columns only; WHERE clauses may
-- still reference the identity hashes.
REVOKE SELECT ON public_submissions FROM gameintel_public;
GRANT SELECT (id, collection_id, content_hash, created_at) ON public_submissions TO gameintel_public;

-- Future tables are not readable by default; public reads must be granted
-- explicitly per capability. (Residual: articles remain table-level SELECT,
-- so unpublished drafts are row-readable by the public role; the public API
-- functions always filter published status. Row-level security is deferred.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM gameintel_public;