# Security

Report security issues privately to the repository maintainers rather than
opening a public issue with exploit details or credentials.

Source ingestion must continue to enforce registered domains, public-host
checks, redirect limits, content-type limits, response-size limits, timeouts,
rate limits, and source enablement.

Never commit API keys, database credentials, operator tokens, raw leaked game
assets, or private source material.

If a real secret is ever committed, deleting the file is not enough: rotate the
credential first, then rewrite repository history to remove the secret from
every past commit.
