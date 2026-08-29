# Release Checklist

Run the following from a Git worktree before making a public repository,
release archive, or deployment image:

```bash
bun run security:scan
bun test
bun run typecheck
bun run build
git status --short
git ls-files
```

Confirm that `.env` and every `.env.*` file other than `.env.example` are
absent from `git ls-files`. Also confirm that `tmp/`, dependencies, generated
build output, local databases, backups, certificates, `.dev.vars`, and
`.wrangler/` state are absent.

## Configuration And Secrets

Before a deployment, replace all relevant template blanks with non-placeholder
values in the deployment secret store. `POSTGRES_PASSWORD`,
`APP_DATABASE_PASSWORD`, and `LOCAL_OPERATOR_TOKEN` are required for Compose.
`POSTGRES_USER` is the DDL-capable migration principal; the API and ingestion
worker use the separate `APP_DATABASE_USER` runtime principal. Host-side
application commands use `DATABASE_URL`; host-side migrations use
`MIGRATION_DATABASE_URL`. Use URL-safe PostgreSQL passwords because Compose
constructs its internal database URLs from those values.

R2 publishing additionally requires `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_BUCKET`, and
`R2_PUBLIC_BASE_URL`. These values are host-only and must not be injected into
the API container. Set the Worker `DAILY_SHUFFLE_SECRET` with Wrangler's
secret command; do not place it in `wrangler.jsonc`, `.dev.vars`, Git, or a
Docker build context.

## Source-Only Policy

GitHub releases contain source only, not publishable workspace packages or
generated deployment artifacts. Confirm the root `package.json` and every
workspace `package.json` have `"private": true`, and do not run npm package
publishing as part of a GitHub release. Use Git to create the source archive.

Review every fixture and example for source rights, direct leak URLs, private
URLs, personal data, and internal operator notes. The scanner detects common
credential formats but cannot determine whether third-party prose is licensed
for redistribution.

Use a Git-created source archive rather than archiving the whole working
directory.
