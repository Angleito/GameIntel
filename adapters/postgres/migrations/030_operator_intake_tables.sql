-- Operator text intake writes claims, evidence, and now their canonical
-- anchors and analysis runs through the shared ingestion pipeline. These
-- grants are intake-scoped only (matching the operator's existing INSERT on
-- claims/evidence/source_items) and never touch article tables, the public
-- surface, or publication state, which remain explicitly revoked (018/021).
-- SELECT is needed to reuse an existing canonical/run identity; it does not
-- expose a public endpoint and is confined to the same operator process.
GRANT SELECT, INSERT ON canonical_claims, analysis_runs TO gameintel_operator;
