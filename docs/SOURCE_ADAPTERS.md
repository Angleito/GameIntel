# Source Adapters

Implement `SourceAdapter` from `@gameintel/source-sdk` for a new provider.
Adapters should:

- Declare an identifier and supported collection profiles.
- Respect the supplied source policy.
- Return validated normalized source items.
- Preserve external IDs, canonical URLs, and lineage inputs.
- Avoid storing or exposing restricted source material.
- Return a health result that explains disabled or degraded sources.

Use `FixtureAdapter` for deterministic tests and development. Use the HTTP
policy helpers for registered network sources. Provider credentials, rate
limits, retention, and public citation rules belong in configuration rather
than adapter-specific constants.

Every adapter should include tests for disabled sources, malformed input,
duplicate references, policy violations, and representative normalization.
