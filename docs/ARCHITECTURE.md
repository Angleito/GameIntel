# Architecture

## Core Principle

Ingestion is the primary system. Article publication is one output projection
of structured source records, claims, evidence, and provenance.

```text
adapter -> source item -> claim/evidence graph -> policy decision -> output
```

`@gameintel/core` contains pure contracts and deterministic functions. It does
not fetch URLs, access PostgreSQL, render Astro, or use GameIntel editorial
copy.

`@gameintel/pipeline` validates source items, computes content hashes and
lineage, scores a configured item, and returns an ingestion disposition. It is
safe to use without a database or article renderer.

`services/newsroom` supplies GameIntel behavior: profile selection, source
registry use, editorial wording, human review, and article construction.

`@gameintel/output` defines the versioned artifact boundary. Consumers may
render the records as JSON, JSONL, API responses, articles, or static pages.

## Runtime Boundaries

Compose runs the API and ingestion worker with a separate PostgreSQL runtime
role. The migration service uses the DDL-capable PostgreSQL principal, creates
the `gameintel_runtime` group role, and the one-shot bootstrap service grants
that group role to the configured application login. Application containers do
not receive migration credentials.

The source ingestion worker writes a heartbeat to PostgreSQL while polling and
processing work. Operators can inspect queue counts, dead jobs, and stale
worker heartbeats through the protected jobs endpoint. Set a distinct
`INGESTION_WORKER_ID` for every replica; Compose defaults a single worker to
`source-ingest-1` so restarts update the same heartbeat record.

## Extension Rule

New domain behavior should enter through configuration, an adapter, a policy,
or an output implementation. It should not add a new hard-coded profile ID to
core or the generic pipeline.
