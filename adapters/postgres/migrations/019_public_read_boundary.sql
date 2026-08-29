-- The public role reads only the published article surface. Internal
-- knowledge-base tables (source material, claims, evidence, evidence reviews,
-- provenance, moderation trails) are never readable by a public process, and
-- public_submissions itself is not directly readable at all: community intake
-- accesses it only through SECURITY DEFINER functions that expose the
-- duplicate check and rate counts. The functions run with the migration
-- role's privileges, so the public role needs no table or column grants on
-- submission data. (PostgreSQL checks privilege on every column referenced in
-- a query, including WHERE clauses, so column-level grants could not support
-- the deduplication queries without exposing identity hashes.)
REVOKE SELECT ON source_items, source_item_revisions, events, claims, evidence, evidence_reviews,
  article_revisions, provenance_families, provenance_relationships, source_item_provenance,
  submission_moderation_actions, audit_log, public_submissions
  FROM gameintel_public;

-- Future tables are not readable by default; public reads must be granted
-- explicitly per capability. (Residual: articles remain table-level SELECT,
-- so unpublished drafts are row-readable by the public role; the public API
-- functions always filter published status. Row-level security is deferred.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM gameintel_public;

CREATE FUNCTION public_submission_duplicate_id(
  p_collection_id text,
  p_session_hash text,
  p_content_hash text
) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT id FROM public.public_submissions
  WHERE collection_id = p_collection_id
    AND submitter_session_hash = p_session_hash
    AND content_hash = p_content_hash
    AND created_at >= now() - interval '24 hours'
  LIMIT 1
$$;

CREATE FUNCTION public_submission_count(condition text, identity_hash text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN condition = 'ip' THEN (SELECT COUNT(*)::int FROM public.public_submissions WHERE submitter_ip_hash = identity_hash AND created_at >= now() - interval '1 minute')
    WHEN condition = 'session' THEN (SELECT COUNT(*)::int FROM public.public_submissions WHERE submitter_session_hash = identity_hash AND created_at >= now() - interval '1 minute')
    WHEN condition = 'account' THEN (SELECT COUNT(*)::int FROM public.public_submissions WHERE submitter_account_id = identity_hash AND created_at >= now() - interval '1 day')
    ELSE (SELECT COUNT(*)::int FROM public.public_submissions WHERE created_at >= now() - interval '1 minute')
  END
$$;

REVOKE ALL ON FUNCTION public_submission_duplicate_id(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_submission_count(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_submission_duplicate_id(text, text, text) TO gameintel_public;
GRANT EXECUTE ON FUNCTION public_submission_count(text, text) TO gameintel_public;