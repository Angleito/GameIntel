# API

The API exposes approved GameIntel output and a protected local ingestion
surface.

## Public Routes

- `GET /health` returns service, project, and active profile status.
- `GET /v1/games` lists the configured GameIntel profiles.
- `GET /v1/games/:gameId/articles` returns approved article projections.
- `GET /v1/articles/:id` returns one approved article projection.
- `GET /v1/data/:profileId` returns a versioned `OutputArtifact`.
- `GET /v1/search?q=...` searches approved article projections.

## Operator Routes

Requests under `/internal/operator/*` require:

```text
Authorization: Bearer $LOCAL_OPERATOR_TOKEN
```

Operator ingestion accepts registered URLs or supplied text. It never bypasses
source policy, public citation requirements, or human publication gates.
