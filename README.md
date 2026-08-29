# GameIntel

**GameIntel is an open-source evidence and provenance engine for continuously
turning rapidly changing public and community information into structured
internal knowledge, then selectively publishing evidence-backed guides, facts,
articles, and data.**

GameIntel continuously ingests through explicitly configured sources and
methods. Ingestion does not imply truth or publication. Evidence and
provenance are evaluated downstream, and review controls what becomes public.

GameIntel is infrastructure-agnostic. The repository includes a free local
reference deployment used by the maintainers. Persistence, job execution,
controlled network retrieval, object storage, and identity can be replaced
through adapters.

The repository's GTA VI profile is the primary showcase. It is configuration
and example data under `profiles/gta-vi/`, not a requirement of the reusable
pipeline.

## The domain model

```text
WHITELISTED INPUTS -> Continuous Ingestion -> Source Revisions
  -> Observations -> Claims -> Evidence + Provenance
  -> Confidence / Contradiction Analysis -> INTERNAL KNOWLEDGE BASE
  -> PUBLICATION BOUNDARY (evidence review, publication approval)
  -> guides, articles, APIs/data
```

- **Continuous ingestion** is the default model. Whitelisted sources are
  revisited on configured schedules; collection never requires editorial
  approval.
- **Observations** are what GameIntel received. **Claims** are propositions
  inferred from observations. **Evidence** supports or contradicts claims.
  **Publications** are what GameIntel intentionally exposes externally. These
  never collapse into one "fact" object.
- **Source revisions are immutable**; evidence points to the exact revision it
  came from, so a changed source can invalidate exactly the evidence it
  affects.
- **Provenance families** stop echo-count inflation: 100 copies of one report
  are one lineage, and independent evidence matters more than repetition.
- **Uncertainty is first-class**: claims are `unverified`, `supported`,
  `contested`, `confirmed`, `superseded`, or `retracted`, and public output
  says so.
- **The publication boundary** is where approval belongs. A conservative rule:
  required evidence threshold met, required reviewer approval met, no
  unresolved rejection, no unresolved dispute. Whitelists control collection;
  evidence review controls public use.
- **AI stays downstream of provenance.** It may extract, summarize, group, and
  draft — it never invents evidence.

See `docs/DOMAIN.md` for the complete domain model and editorial rules.

## Capabilities

GameIntel Core depends on small capability contracts
(`@gameintel/contracts`, `ADAPTER_API_VERSION = 1`), not on any product:

```text
Persistence   SourceRepository .. MediaRepository, GameIntelPersistence
Jobs          JobQueue, SourceScheduler, SourcePacingStore
Fetch         ControlledFetchTransport
Storage       ObjectStore
Identity      OperatorIdentityProvider, AbuseProtection
Infra         Clock, IdGenerator
```

Adapter conformance suites (`@gameintel/adapter-contract-tests`) give
replaceability a concrete definition:

```ts
runPersistenceContract(factory)
runQueueContract(factory)
runFetchTransportContract(factory)
runObjectStoreContract(factory)
```

Implemented adapters:

| Adapter | Package | Notes |
| --- | --- | --- |
| In-memory persistence/queue/pacing/object store | `@gameintel/in-memory` | Zero-dependency development and tests; single-process only |
| PostgreSQL reference persistence/jobs/pacing | `@gameintel/postgres` | Advisory locks, SKIP LOCKED, roles stay inside the adapter |
| SQLite portability persistence/jobs/pacing | `@gameintel/sqlite` | `bun:sqlite` portability proof; single-process only |
| Local filesystem object store | `@gameintel/local-filesystem` | Zero-cost local storage |
| Controlled-fetch transport | `@gameintel/controlled-fetch` | SSRF hardening, redirects, limits, pacing (Squid is only the reference egress proxy) |
| Cloudflare R2 object store | `@gameintel/r2` | S3-compatible SigV4 client + ObjectStore adapter |
| Static operator identity / local abuse protection | `@gameintel/newsroom` | Constant-time token auth; HMAC submission identity hashing |

See `docs/CAPABILITIES.md` for the full capability description.

## Basic Development

No Docker or database needed for domain and capability work:

```bash
bun install
bun test                 # runs entirely in memory
bun run typecheck
bun run build
```

## Reference Local Deployment

This is the free local deployment used by the maintainers:
`deployments/local/compose.yaml` (PostgreSQL, migration service, runtime-role
bootstrap, API, scheduler, isolated ingestion worker, and a Squid egress
proxy).

```bash
cp .env.example .env
bun install
docker compose -f deployments/local/compose.yaml up -d
docker compose -f deployments/local/compose.yaml wait migrate
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
`POSTGRES_PASSWORD`, `LOCAL_OPERATOR_TOKEN`, the three application database
passwords (`APP_DATABASE_PASSWORD`, `APP_OPERATOR_DATABASE_PASSWORD`,
`APP_PUBLIC_DATABASE_PASSWORD`), and `DATABASE_URL`. Use URL-safe PostgreSQL
passwords because Compose builds its internal connection URL from those
values. `docker compose -f deployments/local/compose.yaml up -d` runs the
one-shot `migrate` service before starting the API.

For API hot reload outside Docker, keep the existing database-only workflow:

```bash
docker compose -f deployments/local/compose.yaml up -d postgres
bun run db:migrate
bun run dev:api
```

The API runs two storage identities: public routes use the `gameintel_public`
database role (reads + quarantined submissions, no UPDATE privileges) and
operator routes use the `gameintel_operator` role (jobs and moderation, but no
evidence review or publication). Approving evidence and publishing content
require the operator CLI with the editor-only runtime login. Host-side API
development requires `PUBLIC_DATABASE_URL` and `OPERATOR_DATABASE_URL`.

The Compose API receives only its database, HTTP, profile, and optional
OpenCode settings. R2 credentials and other host-only integration values from
`.env` are never passed to it.

## Configuration

`.env` is local-only. The public template deliberately leaves credentials
blank. `OPENCODE_*` is optional and remains disabled by default. R2 values are
required only for `bun run media:publish --publish` and must remain in local
secret storage. The Cloudflare Worker secret `DAILY_SHUFFLE_SECRET` must be
set with `wrangler secret put`, not placed in `wrangler.jsonc`, `.dev.vars`,
or a release archive.

`GAMEINTEL_STORAGE` selects the storage backend (`postgres`, `memory`, or
`sqlite`). Multi-process services (API, worker, scheduler, publisher) require
the PostgreSQL backend; `memory` and `sqlite` fail fast with a clear error.
The SQLite adapter (`bun:sqlite`) is a portability proof: it runs the same
persistence and queue conformance suites as the PostgreSQL reference adapter
and needs no database server. To run the PostgreSQL conformance and privilege
suites against a migrated reference deployment:

```bash
GAMEINTEL_TEST_POSTGRES=true bun test adapters/postgres/src/adapter.test.ts

GAMEINTEL_TEST_POSTGRES=true \
PUBLIC_DATABASE_URL=... OPERATOR_DATABASE_URL=... \
DATABASE_URL=... MIGRATION_DATABASE_URL=... \
bun test adapters/postgres/src/privileges.test.ts
```

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
bun run operator list-evidence <article-id>
bun run operator review-evidence <evidence-id>
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

URL intake returns a durable job rather than fetching synchronously. Run the
Compose `ingest-worker` service and inspect a job with
`GET /internal/operator/jobs/:jobKey`. The worker is isolated from the API and
can reach registered source domains only through the configured egress proxy.
`GET /internal/operator/jobs` exposes queue depth, dead-job counts, and worker
heartbeats for operational alerting.

For local text or an authorized excerpt:

```bash
bun run operator ingest-text \
  --game gta-vi \
  --source operator-note \
  --title "Operator note" \
  --citation-url https://example.com/approved-report \
  --text-file ./article.txt
```

Sources are registered in the active profile's source registry and are
disabled by default until explicitly enabled. Enabling a source is ingestion
configuration, not evidence approval: collection may then run continuously
without any editorial review. Raw source material and unpublished drafts are
excluded from public artifacts.

`review-source` records source access metadata (for example terms review notes)
and is never required before collecting from an enabled source. Each evidence
record must be reviewed independently before editorial and publication approval
can proceed. Public community submissions remain disabled unless
`PUBLIC_SUBMISSIONS_ENABLED=true` is configured behind a trusted proxy and
submission identity hashing is configured.

## Profiles

Profiles are configuration and data, not code requirements. Each profile may
define sources, polling schedules, trust classifications, content categories,
evidence policy, publication formats, media rules, and guide types. The
reusable engine cares only about Collection, Source, SourceRevision,
Observation, Claim, Evidence, EvidenceReview, ProvenanceFamily, and
Publication. See `profiles/gta-vi/README.md` for the showcase profile.

## Continuous Scheduling and Discovery

The continuous scheduler (`services/worker/src/scheduler.ts`) enqueues due
registered sources. Source cadence is `poll_interval_seconds` and the exact
polling endpoint is `poll_url` in the profile registry (validated against the
registered domains; distinct from `public_citation_base`, which is what
readers may cite). The scheduler only enqueues; the isolated ingestion worker
performs controlled fetches through the injected fetch transport, and the
pacing layer (`rpm`) governs when requests are actually allowed.

RSS discovery sources (`discovery: { adapter: rss, enabled: true }`) are
discovered on each cadence: every feed item is enqueued as its own ingestion
job, deduplicated while active, and safely re-refreshable afterward.

## Release Policy

GitHub releases are source-only. The root manifest and every workspace
manifest are private, so this repository does not publish npm packages. Build
output, local publication artifacts, generated Worker state, credentials, and
media catalogs remain outside source archives. One local command performs the
checks required before a meaningful public push, tag, or release:

```bash
bun run release:check
```

See `docs/RELEASE_CHECKLIST.md`.

## Scope And Data Rights

The code is MIT licensed. Source content, fixtures, trademarks, and generated
publication data may have separate rights and provider terms. Do not host,
embed, reproduce, or directly link to leaked game data or footage.

## Further Reading

- `docs/DOMAIN.md` — Layer 1: domain model, evidence, provenance, publication
  boundary
- `docs/CAPABILITIES.md` — Layer 2: capability contracts and adapters
- `docs/SOURCE_ADAPTERS.md` — implementing source adapters, polling, discovery
- `docs/API.md`, `docs/CLI.md`, `docs/ARCHITECTURE.md`,
  `docs/RELEASE_CHECKLIST.md` — Layer 3: the reference local deployment