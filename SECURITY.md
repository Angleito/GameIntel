# Security

Report security issues privately to the repository maintainers rather than
opening a public issue with exploit details or credentials.

Source ingestion must continue to enforce registered domains, public-host
checks, redirect limits, content-type limits, response-size limits, timeouts,
rate limits, and source enablement.

Never commit API keys, database credentials, operator tokens, raw leaked game
assets, or private source material.

The reference deployment separates database capabilities by process: the
public API login (`gameintel_public`) can read public data and insert
quarantined submissions but has no UPDATE privileges; the operator API login
(`gameintel_operator`) cannot create evidence reviews, article reviews, source
policy reviews, media approvals, or published articles. Approving evidence and
publishing content require the editor-only runtime login used by the operator
CLI and publisher.

If a real secret is ever committed, deleting the file is not enough: rotate the
credential first, then rewrite repository history to remove the secret from
every past commit.
