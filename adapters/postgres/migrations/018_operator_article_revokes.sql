-- The token-protected operator API surface creates source material, claims,
-- evidence, moderation actions, jobs, and submissions — but never articles.
-- Operator sources are capped at discussion_only publication mode by their
-- trust classification (COMMUNITY/UNVERIFIED), so the pipeline never creates
-- article drafts or invalidates article state on that path. Article draft
-- creation and mutation belong to the ingestion worker and the operator CLI
-- (gameintel_runtime), which apply the publication gates.
REVOKE INSERT ON articles, article_revisions, article_sources, article_media FROM gameintel_operator;
REVOKE UPDATE ON articles, article_media FROM gameintel_operator;