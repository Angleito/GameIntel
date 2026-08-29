-- Capability roles for the local reference deployment.
--
-- gameintel_runtime (011): broad data role used by the ingestion worker,
-- scheduler, publisher, and the operator CLI. It is not used by any
-- public-facing process.
--
-- gameintel_public: the public-facing API surface. SELECT on the data public
-- endpoints read, plus the minimal INSERT surface of community submission
-- intake. It has no UPDATE anywhere: it cannot approve evidence, moderate
-- submissions, or publish content.
--
-- gameintel_operator: the token-protected operator API surface (job
-- inspection/enqueue, submission moderation and promotion, and the pipeline
-- writes promotion performs). It can never create evidence reviews, article
-- reviews, source policy reviews, media approvals, or a published article.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gameintel_public') THEN
    CREATE ROLE gameintel_public NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gameintel_operator') THEN
    CREATE ROLE gameintel_operator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gameintel_public', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO gameintel_operator', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO gameintel_public;
GRANT USAGE ON SCHEMA public TO gameintel_operator;

-- Public role: safe reads over domain data, plus the submission intake
-- surface (public_submissions, its moderation trail, and system audit rows).
GRANT SELECT ON games, sources, source_items, source_item_revisions, events, claims, evidence, evidence_reviews,
  articles, article_revisions, article_sources, media_assets, article_media,
  provenance_families, provenance_relationships, source_item_provenance,
  public_submissions, submission_moderation_actions
  TO gameintel_public;
GRANT INSERT ON public_submissions, submission_moderation_actions, audit_log TO gameintel_public;

-- Operator role: SELECT everywhere its token-protected endpoints need.
GRANT SELECT ON games, sources, source_items, source_item_revisions, events, claims, evidence, evidence_reviews,
  articles, article_revisions, article_sources, media_assets, article_media,
  provenance_families, provenance_relationships, source_item_provenance,
  public_submissions, submission_moderation_actions, audit_log,
  jobs, ingestion_worker_heartbeats
  TO gameintel_operator;
-- ...and the exact write surface of job enqueueing, submission moderation,
-- promotion, and the promotion pipeline. There is no write access to
-- evidence_reviews, reviews, source_policy_reviews, or media_assets:
-- approving evidence and publishing content remain outside the public
-- process even with a valid operator token.
GRANT INSERT ON sources, source_items, source_item_revisions, events, claims, evidence,
  articles, article_revisions, article_sources, provenance_families,
  provenance_relationships, source_item_provenance, jobs,
  submission_moderation_actions, audit_log
  TO gameintel_operator;
GRANT UPDATE ON sources, source_items, source_item_revisions, claims, articles,
  article_media, public_submissions
  TO gameintel_operator;

-- Future tables default to readable for both capability roles; write grants
-- remain explicit per capability.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gameintel_public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO gameintel_operator;