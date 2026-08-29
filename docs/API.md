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
- `POST /v1/submissions` accepts a small community report only when
  `PUBLIC_SUBMISSIONS_ENABLED=true` and trusted session/IP identity hashing is
  configured. It returns a quarantined submission ID, never a public claim.

## Operator Routes

Requests under `/internal/operator/*` require:

```text
Authorization: Bearer $LOCAL_OPERATOR_TOKEN
```

Operator ingestion accepts registered URLs or supplied text. It never bypasses
source policy, public citation requirements, or human publication gates.

- `GET /internal/operator/jobs` returns source-ingestion queue counts,
  current/stale worker heartbeats, and recent jobs including retry errors.
- `GET /internal/operator/jobs/:jobKey` returns one durable ingestion job.

Operator submission routes are separate from public output:

- `GET /internal/operator/submissions` lists retained quarantined reports
  without submitter identity hashes.
- `GET /internal/operator/submissions/:submissionId` includes moderation
  history.
- `POST /internal/operator/submissions/:submissionId/review` accepts only
  `under_review`, `rejected`, or `blocked` decisions.
- `POST /internal/operator/submissions/:submissionId/promote` requires an
  `under_review` submission and creates `COMMUNITY` discussion-only evidence.

Promotion does not fetch reporter URLs, does not use them as citations, and
cannot create an article candidate directly.
