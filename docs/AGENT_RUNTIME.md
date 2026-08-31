# Pi Agent Runtime

GameIntel uses `@earendil-works/pi-agent-core` as an internal reasoning
runtime. Pi is not an authority boundary: the application owns persistence,
verification, review, and publication.

## Current role

`article-writer` is the only enabled role. It receives a validated research
packet and returns a Zod-validated draft. The runtime creates one ephemeral,
single-turn session per draft and gives it no tools. It has no shell,
filesystem, database, source-fetching, moderation, or publishing capability.

The newsroom persists the draft through its normal deterministic workflow;
model output never writes evidence, claim state, or publication state directly.

## Configuration

The AI provider is selected by `AI_PROVIDER` (`pi` default, `openrouter`
optional) and is wired only by operator entry points (the CLI commands
`ingest`, `ingest-text`, `promote-submission`). The ingestion worker and the
API never construct an AI runtime — isolation by construction, not by flag.
AI failures degrade to warnings and never block ingestion.

The configured `PI_MODEL` must be present in `PI_ALLOWED_MODELS`. The current
built-in provider allowlist is OpenAI, Anthropic, and Google, each requiring
its respective API key; the openrouter provider requires `OPENROUTER_API_KEY`.

`PI_MAX_OUTPUT_TOKENS`/`PI_MAX_RUNTIME_MS` (pi) and
`OPENROUTER_MAX_OUTPUT_TOKENS`/`OPENROUTER_MAX_RUNTIME_MS` (openrouter) bound
an individual run. A provider request has no automatic retries; durable retry
policy belongs to the job orchestrator.

## Next roles

Research roles will be introduced only with durable `agent_runs` audit records,
collection-scoped capability services, and a dedicated AI worker. Networked
roles must use the controlled source-fetch service, never arbitrary HTTP.
