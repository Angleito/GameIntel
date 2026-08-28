# Contributing

## Workflow

1. Read the architecture and data model docs.
2. Keep reusable behavior in packages and GameIntel behavior in services or
   configuration.
3. Add or update tests for schema, policy, and output changes.
4. Run `bun test`, `bun run typecheck`, and `bun run build`.

Do not add provider credentials, raw restricted material, or generated secrets
to the repository.

## Pull Requests

Describe the affected data contract, migration needs, policy implications, and
verification commands. Changes to public output schemas require a schema
version decision and fixture coverage.
