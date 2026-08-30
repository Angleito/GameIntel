# Capabilities

This is Layer 2 of the documentation: the capability contracts GameIntel
depends on. GameIntel Core is infrastructure-agnostic — persistence, jobs,
scheduling, controlled fetch, object storage, identity, and abuse protection
are replaceable through adapters. `@gameintel/contracts` (types only) defines
`ADAPTER_API_VERSION = 1` and the small capability interfaces:

```text
Persistence:   SourceRepository, ObservationRepository, ClaimRepository,
               EvidenceRepository, ReviewRepository, PublicationRepository,
               SubmissionRepository, AuditRepository, MediaRepository,
               GameIntelPersistence
Jobs:          JobQueue, SourceScheduler, SourcePacingStore
Fetch:         ControlledFetchTransport
Storage:       ObjectStore
Identity:      OperatorIdentityProvider, AbuseProtection
Infra:         Clock, IdGenerator
```

Adapters implement these interfaces. PostgreSQL-specific concerns (advisory
locks, SKIP LOCKED, savepoints, partial indexes, roles) stay inside the
PostgreSQL adapter; they never define GameIntel Core. If an in-memory or
SQLite implementation requires rewriting core domain logic, the abstraction is
leaking.

## Adapter conformance

Replaceability has a concrete definition: shared conformance suites in
`@gameintel/adapter-contract-tests`.

```ts
runPersistenceContract(factory)    // revisions, transactions, duplicates,
                                   // evidence relationships, publication
                                   // invalidation, audit, concurrency
runQueueContract(factory)          // repeat scheduling, active deduplication,
                                   // execution after completion, retry after
                                   // failure, lease ownership/renewal,
                                   // crash recovery, terminal outcomes
runFetchTransportContract(factory) // allowlists, redirects, private-IP denial,
                                   // DNS behavior, size/type/time limits
runObjectStoreContract(factory)    // put/get/delete/list safety
```

The in-memory adapter runs all suites with `bun test` (no database needed).
The SQLite adapter (`@gameintel/sqlite`, built on `bun:sqlite`) runs the same
persistence and queue suites always-on as a portability proof, exposing
assumptions hidden by PostgreSQL (advisory locks, SKIP LOCKED, partial
indexes, JSON features). The PostgreSQL reference adapter runs the same
suites when `GAMEINTEL_TEST_POSTGRES=true` points at a migrated deployment.
SQLite is not recommended as a large production backend; it exists to prove
GameIntel is not secretly a PostgreSQL application.

## Scheduling, jobs, and pacing

Scheduling and source pacing are separate concepts. The scheduler determines
"this source should be checked" (registry `poll_interval_seconds`); the
pacing layer determines "when a request is actually allowed" (`rpm`). A
configuration can say `pollInterval: 30s` and `rateLimit: 2/minute`.

Continuous ingestion workers need robust leases: workers renew ownership
before expiry, stale workers cannot complete a reclaimed execution, and lease
loss stops the current execution without terminating the worker process.

The queue separates `dedupeKey` (collection + source + canonical URL) from
`jobKey` (unique execution). Active executions are deduplicated; terminal
executions never block future refreshes. Unchanged fetches create no revision
churn; material changes create new immutable source revisions that propagate
through affected evidence and publication state.

Discovery is a queue behavior too: the scheduler enqueues `source_discover`
jobs for feed sources, and the isolated ingestion worker fetches the feed,
parses items, and enqueues each item as its own ingestion job. The feed URL is
never ingested as an article, the scheduler never fetches, and discovery
failures use the same retry/lease machinery as URL ingestion.

## Controlled fetch

The `ControlledFetchTransport` capability enforces the GameIntel
controlled-fetch requirements: registered ingestion sources, allowed domain
validation, HTTP/HTTPS restrictions, port restrictions, DNS validation,
private/loopback/link-local/metadata-address blocking, redirect revalidation,
response-size limits, content-type limits, timeouts, rate limiting, and source
pacing.

`@gameintel/controlled-fetch` provides the reference HTTP implementation with
an injectable DNS resolver for tests. A proxy (Squid in the reference
deployment) is only an egress implementation; another implementation may
replace it only if it satisfies the same behavior. The public API never
fetches remote URLs itself: it enqueues work, and the isolated ingestion
worker performs controlled fetches.

## Object storage

`@gameintel/local-filesystem` provides `LocalFilesystemObjectStore` for the
zero-cost local environment. `@gameintel/r2` provides a Cloudflare R2 adapter
(S3-compatible SigV4 client plus an `R2ObjectStore` satisfying the
`ObjectStore` contract). Future implementations may include S3, MinIO, or
other compatible stores.

## Identity and abuse protection

- `OperatorIdentityProvider` authenticates editorial/operator actions.
  `@gameintel/newsroom` provides `StaticOperatorIdentityProvider`, a
  constant-time local token provider. Future providers are added only if they
  become necessary; no OAuth, SSO, or paid identity system is needed now.
- `AbuseProtection` covers community intake: quarantine, rate limiting,
  identity hashing, duplicate detection, and retention controls.
  `@gameintel/newsroom` provides `LocalAbuseProtection` (HMAC identity
  hashing of the trusted-proxy IP and submission session). Future deployments
  can add edge limits, CAPTCHA, account quotas, IP reputation, and other
  controls without making those services GameIntel requirements.

## Storage identity separation

The reference deployment separates database capabilities by process. The
public API login (`gameintel_public`) holds no table privileges at all on
internal knowledge-base, article, moderation, or audit data. Public articles
are served from a materialized public-article surface that is sanitized at
publish time (`toSafeArticle`: publicSafe and spoiler-safe body sections
only, numbered citations instead of internal source/claim references, and
approved cover media only) and read through SECURITY DEFINER functions that
touch only that table; community intake is fenced in a submit function that
always forces the initial quarantined state and its fixed system trail, with
rate limits trusted as database configuration rather than caller parameters.
The operator API login (`gameintel_operator`) can enqueue jobs and moderate
or promote submissions but cannot create evidence reviews, article reviews,
source policy reviews, media approvals, or published articles. Approving
evidence and publishing content require the editor-only runtime login used by
the operator CLI and publisher. A public-facing process never possesses
storage permissions that allow it to approve evidence, publish content, read
unpublished or unsanitized material, or forge intake/moderation records.

## Versioning

Public interoperability boundaries are versioned early:

```text
adapter API          ADAPTER_API_VERSION = 1
source registry      config schema (zod-validated)
source revision      schema
observation/claim    schemas
evidence             schema
publication output   OutputArtifact schemaVersion
profile format       config schema (zod-validated)
```

This prevents future contributors from accidentally relying on unstable
internal behavior.

## Canonical claims and analysis runs

The knowledge layer is versioned and convergent across normalized lexical identities:

- `canonicalClaimKey` derives a canonical identity from the normalized
  subject/predicate/value plus semantic qualifiers. Transport details never
  enter the key, so a URL report and a community observation of the same fact
  resolve to one canonical claim. Confidence, claim state, and contradiction
  propagation operate on canonical identity rather than exact claim rows.
- `CLAIM_EXTRACTOR_VERSION`, `NORMALIZATION_VERSION`, and
  `CONFIDENCE_MODEL_VERSION` together key every `analysis_runs` row.
  Parser/source-extraction `processingVersion` is audit metadata, not run
  identity. A
  completed run with identical versions is idempotent; any version mismatch
  (automatic on the next fetch of unchanged content, or an explicit
  `reprocess-revision`) supersedes prior runs and re-interprets the retained
  revision content. Only the latest completed run of the current revision is
  current for review gates and confidence; new evidence always needs fresh
  review before it can support publication.
- The operator intake role may supersede analysis runs but cannot write article
  tables. Discussion-only intake is knowledge-only; publication refreshes are
  reserved for normal-source processing and privileged editorial review.

All adapters implement these as part of the shared persistence contract
(`runPersistenceContract`), so the in-memory, SQLite, and PostgreSQL
backends behave identically.
