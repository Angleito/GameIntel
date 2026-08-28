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

## Extension Rule

New domain behavior should enter through configuration, an adapter, a policy,
or an output implementation. It should not add a new hard-coded profile ID to
core or the generic pipeline.
