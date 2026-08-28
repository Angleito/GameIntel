# gameintelgg

GameIntel is an open-source, evidence-aware source ingestion and publication
platform for game intelligence. The reusable packages normalize source
material, preserve claims and provenance, apply policy gates, and produce
structured data or human-readable articles.

The repository's GTA VI profile is the primary GameIntel showcase. It is
configuration and example data, not a requirement of the reusable pipeline.

## Architecture

```text
source adapters -> normalized source items -> claims/evidence/provenance
                -> policy and review gates
                -> structured data, articles, API responses, or static pages
```

| Package or app | Responsibility |
| --- | --- |
| `@gameintel/core` | Shared schemas, lineage, safety, scoring, and publication contracts |
| `@gameintel/config` | Project, profile, and source-registry loading |
| `@gameintel/pipeline` | Reusable ingestion preparation and disposition logic |
| `@gameintel/source-sdk` | Source adapters, parsing, and network safety policy |
| `@gameintel/db` | PostgreSQL persistence and GameIntel review workflow |
| `@gameintel/output` | Versioned JSON artifacts and output writers |
| `@gameintel/newsroom` | GameIntel ingestion, editorial policy, and article generation |
| `@gameintel/api` | GameIntel API and structured-data reference endpoints |
| `@gameintel/web` | Astro showcase consumer of generated output artifacts |

## Quick Start

```bash
cp .env.example .env
bun install
docker compose up -d
docker compose wait migrate
bun run seed
bun run publish
```

In another terminal:

```bash
bun run dev
```

The API is available at `http://localhost:3000` and the site at
`http://localhost:4321`.

Before running the commands, set non-placeholder values in `.env` for
`POSTGRES_PASSWORD`, `DATABASE_URL`, and `LOCAL_OPERATOR_TOKEN`.
`DATABASE_URL` is for Bun commands on the host and should use the same
database credentials as `POSTGRES_*`, with `localhost` as its host. Use a
URL-safe PostgreSQL password because Compose builds its internal connection
URL from that value. `docker compose up -d` runs the one-shot `migrate`
service before starting the API.

For API hot reload outside Docker, keep the existing database-only workflow:

```bash
docker compose up -d postgres
bun run db:migrate
bun run dev:api
```

The Compose API receives only its database, HTTP, profile, and optional
OpenCode settings. R2 credentials and other host-only integration values from
`.env` are never passed to it.

## Configuration

`.env` is local-only. The public template deliberately leaves credentials
blank. `POSTGRES_PASSWORD` and `LOCAL_OPERATOR_TOKEN` are required for the
Compose API; `DATABASE_URL` is required for host-side database commands.
`OPENCODE_*` is optional and remains disabled by default.

R2 values are required only for `bun run media:gta-vi:publish --publish` and
must remain in local secret storage. The Cloudflare Worker secret
`DAILY_SHUFFLE_SECRET` must be set with `wrangler secret put`, not placed in
`wrangler.jsonc`, `.dev.vars`, or a release archive.

## Generic Ingestion Example

The example does not require PostgreSQL, Astro, or GameIntel editorial
workflow. It validates a non-game source item and emits a structured artifact:

```bash
bun run example
```

Output is written to `tmp/software-release-output.json`.

## GameIntel Workflow

The seed command loads the GTA VI showcase profile and creates a draft. Human
review is required before publication:

```bash
bun run operator list
bun run operator review-source <source-id>
bun run operator review-article <article-id>
bun run operator approve <article-id>
bun run operator publish <article-id>
bun run publish
```

Registered URL intake is opt-in and profile-specific:

```bash
bun run operator ingest-url \
  --game gta-vi \
  --source rockstar-official \
  --url https://www.rockstargames.com/VI
```

For local text or an authorized excerpt:

```bash
bun run operator ingest-text \
  --game gta-vi \
  --source operator-note \
  --title "Operator note" \
  --citation-url https://example.com/approved-report \
  --text-file ./article.txt
```

Sources are disabled by default until their access terms are reviewed. Raw
source material and unapproved drafts are excluded from public artifacts.

## Development

```bash
bun test
bun run typecheck
bun run build
```

See `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, and
`docs/SOURCE_ADAPTERS.md` for extension guidance.

## Release Policy

GitHub releases are source-only. The root manifest and every workspace
manifest are private, so this repository does not publish npm packages. Build
output, local publication artifacts, generated Worker state, credentials, and
media catalogs remain outside source archives.

## Scope And Data Rights

The code is MIT licensed. Source content, fixtures, trademarks, and generated
publication data may have separate rights and provider terms. Do not host,
embed, reproduce, or directly link to leaked game data or footage.
