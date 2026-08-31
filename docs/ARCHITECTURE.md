# Reference Local Deployment

This is Layer 3 of the documentation: the tools the maintainers actually use.
The domain model and capability contracts are described in `DOMAIN.md` and
`CAPABILITIES.md`; most users can understand and extend GameIntel without this
file.

## Packages and layout

```text
packages/                  reusable domain and capabilities
  core/                    pure contracts, schemas, deterministic functions
  contracts/               capability interfaces (types only), adapter versioning
  config/                  project, profile, and source-registry loading
  pipeline/                reusable ingestion preparation and disposition
  source-sdk/              SourceAdapter implementations and parsing
  output/                  versioned JSON artifacts and output writers
  adapter-contract-tests/  portable conformance suites
adapters/                  replaceable infrastructure implementations
  postgres/                PostgreSQL reference persistence/job/pacing adapter
  in-memory/               in-memory persistence, queue, pacing, object store
  local-filesystem/        local filesystem object store
  controlled-fetch/        HTTP controlled-fetch transport and policy engine
  r2/                      Cloudflare R2 S3-compatible SigV4 client
profiles/                  game-specific data and tooling
  gta-vi/                  the first showcase profile (sources, media rules)
services/
  newsroom/                ingestion orchestration, editorial CLI, identity
  worker/                  continuous scheduler and isolated ingestion worker
  publisher/               static publication artifact generation
apps/
  api/                     GameIntel API (public + operator routes)
  web/                     Astro showcase consumer of generated artifacts
deployments/
  local/                   compose.yaml, Dockerfile, Postgres bootstrap, Squid,
                           Cloudflare Worker (the reference local deployment)
config/                    project.json, publication.json
```

## Services

Compose (`deployments/local/compose.yaml`) runs:

| Service | Role |
| --- | --- |
| `postgres` | Shared reference database (pgvector image, stock PostgreSQL) |
| `migrate` | One-shot DDL service using the DDL-capable principal |
| `bootstrap-runtime-role` | One-shot creation of the three application logins |
| `api` | Public routes + token-protected operator routes |
| `scheduler` | Continuous scheduler (enqueues due sources and discoveries) |
| `ingest-worker` | Isolated ingestion worker (controlled fetches only) |
| `egress-proxy` | Squid egress proxy with destination-IP deny rules |

The API never fetches remote URLs; it enqueues work for the isolated worker.
The worker is on internal-only networks and must use the egress proxy. The
scheduler and worker write heartbeats to PostgreSQL; operators inspect queue
counts, dead jobs, and stale worker heartbeats through the protected jobs
endpoint.

## Database capabilities

The migration service uses the DDL-capable PostgreSQL principal. The one-shot
bootstrap creates three logins, each a member of exactly one group role:

- `gameintel_runtime` — the ingestion worker, scheduler, publisher, and
  operator CLI. Broad data role; never used by a public process.
- `gameintel_operator` — the token-protected operator API surface (jobs,
  submission moderation and promotion). Cannot create evidence reviews,
  article reviews, source policy reviews, media approvals, or published
  articles.
- `gameintel_public` — the public API surface: a materialized sanitized
  public-article surface (publicSafe/spoiler-safe sections, numbered
  citations, approved cover media only) served through SECURITY DEFINER
  functions, and fenced community intake. No raw table reads or inserts, no
  UPDATE privileges at all.

The API process runs two runtimes: public routes use the `gameintel_public`
login and operator routes use the `gameintel_operator` login. A public request
path cannot approve evidence or publish content even if its handler
misbehaves. Application containers never receive migration credentials.

## Controlled retrieval

`@gameintel/controlled-fetch` is the behavioral contract: registered-domain
enforcement, public-host/SSRF checks, redirect limits, content-type limits,
response-size limits, timeouts, source enablement, and proxy/network policy.
Authoritative per-source request pacing lives in the `SourcePacingStore`,
applied immediately before each transport fetch; the transport does not pace.
DNS checks are defense
in depth, not an egress boundary: the Compose worker is on internal-only
networks and must use the egress proxy, which applies destination-IP deny
rules at connection time for loopback, private, link-local, carrier-grade NAT,
IPv6 local, documentation, multicast, and metadata ranges. This protects
against DNS rebinding between application-level validation and the outbound
connection. Production infrastructure must preserve this network segmentation
and apply equivalent VPC/firewall policy to the proxy itself.

## Extension rule

New domain behavior should enter through configuration, an adapter, a policy,
or an output implementation. It should not add a new hard-coded profile ID to
core or the generic pipeline. Game-specific data and tooling live under
`profiles/<profile-id>/`.