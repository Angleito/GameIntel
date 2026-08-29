# Release Checklist

This repository intentionally uses local verification rather than GitHub
Actions. One command performs every check required before a meaningful public
push, tag, or release:

```bash
bun run release:check
```

This runs, in order: the repository secret scan, a frozen lockfile check, the
full test suite (in-memory adapters and conformance), type checking, a
repository-cleanliness gate (no tracked modifications or untracked files), a
release-mode production build, and a second secret scan over the generated
output. The cleanliness gate is strict by design: commit or stash work before
running it.

To also run the PostgreSQL reference-adapter conformance and capability-role
privilege suites against a migrated reference deployment:

```bash
bun run release:check:postgres
```

This requires `GAMEINTEL_TEST_POSTGRES=true`, the migrated deployment, and the
three API logins (`PUBLIC_DATABASE_URL`, `OPERATOR_DATABASE_URL`,
`DATABASE_URL`, and `MIGRATION_DATABASE_URL` for cleanup).

Manual confirmations after the automated gate:

```bash
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
`APP_DATABASE_PASSWORD`, `APP_OPERATOR_DATABASE_PASSWORD`,
`APP_PUBLIC_DATABASE_PASSWORD`, and `LOCAL_OPERATOR_TOKEN` are required for
Compose. `POSTGRES_USER` is the DDL-capable migration principal. The API runs
two logins: `APP_PUBLIC_DATABASE_USER` (`gameintel_public` group) for public
routes and `APP_OPERATOR_DATABASE_USER` (`gameintel_operator` group) for
operator routes. The ingestion worker, scheduler, publisher, and operator CLI
use `APP_DATABASE_USER` (`gameintel_runtime` group). Host-side application
commands use `DATABASE_URL`; host-side migrations use `MIGRATION_DATABASE_URL`.
The API additionally requires `PUBLIC_DATABASE_URL` and
`OPERATOR_DATABASE_URL`. Use URL-safe PostgreSQL passwords because Compose
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
