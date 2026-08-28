# Data Model

## Source Item

A normalized source item is the durable input record. It contains source
identity, a collection identifier, bounded text, timestamps, input kind,
policy mode, and optional extracted claims.

## Claim

A claim stores a subject, predicate, value, qualifiers, spoiler tags, evidence
level, attribution, and optional rendered wording. Claims may be connected to
one or more evidence records.

## Evidence

Evidence records preserve the source item, stance, evidence type, excerpt,
timestamps, and lineage identifier. Repeated reporting should not be treated
as independent evidence merely because it appears in multiple sources.

## Outputs

`OutputArtifact` is the versioned interchange format:

```json
{
  "schemaVersion": "1.0",
  "generatedAt": "...",
  "projectId": "gameintelgg",
  "profileId": "gta-vi",
  "records": []
}
```

Articles are derived records. The structured claims and evidence remain the
source for data exports, APIs, and article renderers.
