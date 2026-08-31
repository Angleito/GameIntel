# Ontology

Ontology is the GameIntel domain model. It is not a feature flag. Maps, guides, knowledge queries, and future answer surfaces are projections of canonical knowledge; entities and the controlled predicate vocabulary are the domain's identity layer.

## Entities

Entities are first-class domain objects with stable ids, a canonical name, aliases, optional key/value properties, and optional map coordinates. They are operator-managed (CLI/API upsert and alias commands); ingestion never auto-creates entities.

- Core entity types: `game`, `game_build`, `platform`, `character`, `vehicle`, `weapon`, `item`, `collectible`, `location`, `region`, `mission`, `activity`, `event`, `vendor`, `faction`, `mechanic`, `requirement`, `reward`, `patch`, `update`.
- Profile entity types extend the core set (for example `safehouse`, `heist`, `business`, `wanted_level` in the GTA VI profile).
- Entity id: `<type>:<slugified-canonical-name>` (`vehicle:turismo-omaggio`); explicit ids are allowed when the slug would collide or a stable id is desired.
- Uniqueness: one entity per exact canonical name per collection. A new canonical name or alias that normalizes equal to an existing entity's name or alias throws — the ambiguity guard. Duplicate entities are never created.

## Aliases & identity

Mentions resolve by exact match after normalization (`normalizeEntityName`: lowercase, non-alphanumeric runs collapse to single spaces). There is no fuzzy or substring matching. Resolution outcomes: `resolved` (one candidate), `ambiguous` (more than one — defensive, since upsert enforces uniqueness), `unresolved` (none). Unresolved mentions stay unlinked text claims; no guessing, no auto-creation.

## Predicates

The controlled vocabulary is the set of `PredicateDefinition`s: id, allowed subject types, allowed object types (`*` = any entity type, `literal` = the object is a literal value). Core predicates:

| Predicate | Subject | Object |
| --- | --- | --- |
| `SPAWNS_AT` | vehicle, weapon, item, character, collectible | location, region |
| `LOCATED_AT` / `LOCATED_IN` | * | location, region |
| `SOLD_AT` | item, vehicle, weapon | vendor, location |
| `UNLOCKS` | mission, activity, event, mechanic, requirement | * |
| `REQUIRES` | * | * |
| `REWARDS` | mission, activity, event | item, vehicle, weapon, collectible |
| `AVAILABLE_AFTER` / `AVAILABLE_BEFORE` | * | mission, activity, event |
| `OWNED_BY` | * | vendor, faction, character |
| `USED_BY` | item, vehicle, weapon | character, faction |
| `PART_OF` | * | * |
| `STARTS_AT` | mission, activity, event | location |
| `CHANGED_BY` / `ADDED_BY` / `REMOVED_BY` / `NERFED_BY` / `BUFFED_BY` | * | patch, update (`aspect` qualifier names what changed) |
| `REPORTS` | * | literal (deterministic fallback extractor) |

Extension rule: profiles may add predicates; a profile redefining a core predicate id replaces the core definition. Predicates normalize for matching (`normalizePredicate`: trim, collapse, `_`, uppercase), so `spawns at` and `SPAWNS_AT` are the same predicate.

## Qualifiers

Qualifier keys stay open `snake_case`; values normalize so semantically identical claims converge. Known keys include `platform`, `mode`, `build`, `region`, `time_of_day`, `weather`, `mission`, `progression`, `wanted_level`, `inventory`, `game`, `patch`, `game_mode`, `story_progress`, `mission_state`, `character`, `difficulty`, `online`, `singleplayer`, `multiplayer`. Boolean keys normalize `true/yes/1` → `true` and `false/no/0` → `false`; snake-case keys lowercase and underscore.

## Canonical claims

A canonical claim is a semantic triple — subject entity, predicate, object entity (or literal) — plus semantic qualifiers. Identity is the hash of `[subjectEntityId ?? normalized subject text, normalized predicate, objectEntityId ?? normalized object text, sorted normalized qualifier entries]`. When entity ids are present, display-text spelling stops mattering: "Grotti Turismo" and "Turismo Omaggio" converge on one canonical claim. Qualifiers that change the fact's meaning (time of day, build) split identities; transport details (URL, RSS, review state) never enter the identity.

Claims remain per-source-item observations; many observations converge on one canonical claim.

## Evidence & the AI boundary

Evidence always references a source revision. LLM output is interpretation that flows through resolution → predicate validation → canonical normalization → evidence linkage; it never writes evidence, claim state, or publication state directly. AI extraction applies to operator pasted-text/local-file intake without pre-extracted claims; URL/RSS ingestion and reprocessing stay deterministic (a versioned run must be reproducible). AI failures degrade to warnings and never block ingestion.

## Provenance families

Evidence groups into provenance families. Independent families (any non-`copied_report` evidence) drive corroboration; copied reports do not add independence.

## Patch/build semantics

Claims carry `validBuildFrom`/`validBuildTo` (set on the claim row and its canonical row). Applicability at a build: `current` (within range), `historical` (before range), `superseded` (after range), `unknown` (no range or no build given). Change claims (`CHANGED_BY`, `REMOVED_BY`, `NERFED_BY`, `BUFFED_BY`, `ADDED_BY`, with the `aspect` qualifier) answer "what changed in patch X". Builds compare as strings; a semver comparator replaces this when mixed-length builds appear.

## Contradictions

`claimsPotentiallyContradict` classifies pairs of claims sharing a triple: opposite stances → `contradiction`; opposite stances differing only on `build`/`patch` qualifiers → `build_change` (each true of its own build); same stance or different triple → `distinct`. `explainClaim` scans the collection triple-wide, so both kinds surface.

## Profiles

Profiles supply entity types and extra predicates under `"ontology"` in `profile.json`; the merged ontology is core ∪ profile. The `software-releases` profile has no ontology section — its free-form text predicates remain valid unlinked text claims.

## Projections

Articles, guides, maps, and API responses are projections of canonical knowledge, never raw SQL:

- Articles: existing publication surface; any claim-state change demotes referencing articles and guides.
- Guides: operator-authored specs (query over entity type/properties/predicate/min-state/build) materialized as claim sets. `publishGuide` requires every referenced claim's state ∈ {supported, confirmed}; any claim-state change demotes the guide to draft.
- Maps: `SPAWNS_AT`/`LOCATED_AT` markers with coordinates from `getMapProjection`.
- API: operator-protected `/internal/operator/knowledge/*` routes (entity CRUD, relationships, explain, claims-by-build, locations, map, guides). No public knowledge endpoints and no raw SQL exposure yet.

## AI extraction

`AI_PROVIDER` selects the provider: `pi` (default) or `openrouter`. `OPENROUTER_API_KEY` is required for openrouter; `OPENROUTER_MODEL`, `OPENROUTER_MAX_OUTPUT_TOKENS`, `OPENROUTER_MAX_RUNTIME_MS` configure it; `PI_MODEL`/`PI_ALLOWED_MODELS`/`PI_MAX_*` configure pi. Operator entry points (CLI `ingest`, `ingest-text`, `promote-submission`) wire AI; the ingestion worker and the API never do — isolation by construction, not by flag. AI failures degrade to warnings and never block ingestion.

## Validation

Claims link to entities only when resolution succeeds AND the predicate definition allows the resolved subject/object types. Unknown predicates never warn (claims stay valid unlinked text claims); ambiguous subjects warn with `Ambiguous entity mention '<mention>'`.

## Publication boundary

Human review remains the publication boundary. Ingestion is not truth, observation is not claim, claim is not fact, evidence is not publication, AI is not provenance, collection is not publication.
