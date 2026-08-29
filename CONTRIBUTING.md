# Contributing

## Basic development (recommended)

Domain and capability work needs no Docker and no database:

```bash
bun install
bun test          # runs entirely in memory; in-memory adapters
bun run typecheck
bun run build
```

The in-memory adapter implements the same capability contracts as the
PostgreSQL reference adapter and runs the same conformance suites
(`@gameintel/adapter-contract-tests`).

## Full local reference deployment

Maintainers who exercise the real pipeline use the reference deployment:

```bash
cp .env.example .env        # set all required non-placeholder values
docker compose -f deployments/local/compose.yaml up -d
docker compose -f deployments/local/compose.yaml wait migrate
bun run seed
bun run publish
```

The PostgreSQL conformance and privilege suites run against the migrated
deployment with `GAMEINTEL_TEST_POSTGRES=true` (see the README Development
section).

## Workflow

1. Read `docs/DOMAIN.md` (domain model and editorial rules), then
   `docs/CAPABILITIES.md` (capability contracts and adapters).
2. Keep reusable behavior in packages and GameIntel behavior in services or
   configuration. Game-specific data and tooling live under
   `profiles/<profile-id>/`; never hard-code a profile ID in core or the
   generic pipeline.
3. Infrastructure choices stay behind capability contracts: adapters live
   under `adapters/` and must pass the conformance suites.
4. Add or update tests for schema, policy, and output changes.
5. Run `bun test`, `bun run typecheck`, and `bun run build`. Before any
   meaningful public push, tag, or release, run `bun run release:check` (see
   `docs/RELEASE_CHECKLIST.md`).

Do not add provider credentials, raw restricted material, or generated secrets
to the repository.

## Pull Requests

Describe the affected data contract, migration needs, policy implications, and
verification commands. Changes to public output schemas require a schema
version decision and fixture coverage.