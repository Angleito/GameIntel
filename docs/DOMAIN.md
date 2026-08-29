# GameIntel Domain

This is Layer 1 of the documentation: the domain model and editorial rules.
It does not depend on any infrastructure choice. PostgreSQL, containers, and
the egress proxy are implementation details described in the Reference Local
Deployment layer.

## The core model

GameIntel continuously ingests everything it is explicitly configured and
permitted to ingest. Ingested information is internal knowledge, not
automatically public truth. Evidence, contradiction, and provenance determine
which claims are sufficiently supported. Approval controls public publication
of evidence — never routine ingestion.

```text
WHITELISTED INPUTS -> Continuous Ingestion -> Source Material
  -> Source Revisions -> Observations -> Claims
  -> Evidence + Provenance -> Confidence / Contradiction Analysis
  -> INTERNAL KNOWLEDGE BASE
  -> PUBLICATION BOUNDARY (evidence review, publication approval)
  -> guides, articles, APIs/data
```

The critical invariant: **collection is not publication.** Something entering
GameIntel internally does not make it public.

## Objects

These concepts never collapse into a single "fact" object:

| Object | Meaning | Example |
| --- | --- | --- |
| Observation | Something GameIntel received or observed | "I found this vehicle here at 02:14." |
| Claim | A proposition inferred from one or more observations | "Vehicle X can spawn at location Y at night." |
| Evidence | Material supporting or contradicting a claim | community report, video observation, official page revision, direct capture |
| Publication | Something GameIntel intentionally exposes externally | guide entry, article, map marker, API fact, timeline item, structured dataset |

An observation does not automatically become a claim. A claim does not
automatically become truth. Evidence does not automatically become public.

## Source revisions are immutable

GameIntel preserves meaningful source history rather than overwriting it:

```text
Source
  ├── Revision 1
  ├── Revision 2
  ├── Revision 3
  └── Revision 4 <- current
```

Evidence points to the exact source revision it came from. If a later revision
contradicts an earlier one, GameIntel can identify exactly which evidence is
affected.

Raw/source material is stored separately from interpretation. A future parser
or normalizer improvement can reprocess already-collected data without
refetching the internet.

## Claims and uncertainty

Claims support states: `unverified`, `supported`, `contested`, `confirmed`,
`superseded`, `retracted`. Useful metadata includes first/last observed, last
evidence received, last reviewed, current source revision, supporting and
contradicting evidence counts, independent provenance count, confidence, and
public status.

GameIntel publishes nuanced states rather than pretending every claim is
permanently true or false:

```text
Confirmed
Strong community evidence
Reports conflict — verification ongoing
Previously confirmed, may have changed after update X
```

Contradictory information remains stored. Continuous ingestion improves
knowledge; it does not merely reinforce what was previously believed. A claim
may become `contested` or `superseded`.

## Provenance families

Repeated copies of one original report are one provenance family. Popularity
never equals truth:

```text
1 Reddit post -> 20 reposts -> 50 TikToks -> 100 Discord messages
```

That may represent 171 observations but only 1 provenance family. Independent
evidence matters more than repeated copies, so provenance-family detection
prevents echo-count inflation of confidence.

## Trust classification

Sources may be classified `PRIMARY`, `DIRECT_EVIDENCE`,
`TRUSTED_SECONDARY`, `COMMUNITY`, or `UNVERIFIED`. All of them can exist
internally; their evidence value differs. Collection normally continues for
registered sources regardless of whether their content is currently strong
enough for publication.

## Ingestion authorization vs publication approval

**Ingestion authorization** answers: is GameIntel configured and permitted to
collect through this source or method? Registration, enablement, whitelists,
schedules, and rate limits control collection. No editorial approval is
required before collection.

**Publication approval** answers: is this particular evidence trustworthy
enough to influence what GameIntel tells the public? Approval happens after
ingestion.

```text
WHITELIST controls collection
EVIDENCE REVIEW controls public use

TRUST THE INGESTION ROUTE ENOUGH TO COLLECT FROM IT
DO NOT AUTOMATICALLY TRUST THE CLAIMS IT CONTAINS
```

## The publication boundary

Evidence is continuously accumulated internally. Publication eligibility is
evaluated afterward through evidence review, provenance calculation,
contradiction detection, confidence calculation, and explicit review gates.

A conservative initial rule:

```text
required evidence threshold met
AND required reviewer approval met
AND no unresolved rejection
AND no unresolved dispute
```

Only then may the evidence influence public output. A current `rejected` or
`disputed` evidence review blocks publication regardless of how many other
approvals exist. Material source changes invalidate stale publication
eligibility: new revisions mark affected evidence stale, publication
eligibility is recalculated, and public items may require rereview.

## Community submissions

Community information does not wait for editorial approval before entering
the system: submission → quarantine → normalize → observation → duplicate
analysis → provenance analysis → possible candidate evidence. Quarantine means
"internal only", not "not ingested". GameIntel still analyzes quarantined
information (for example, 50 reports that turn out to be 1 provenance family).

## AI stays downstream of provenance

AI may assist with claim extraction, summarization, grouping, duplicate
detection, possible provenance relationships, draft writing, and article
organization. AI must never invent evidence or become the source of
provenance:

```text
Correct:   source revision -> provenance recorded -> AI analysis -> candidate claim
Incorrect: AI says something -> store as established evidence
```

Any AI-derived statement must remain traceable back to actual ingested
material.

## Editorial rules

- Articles are reviewed output projections of structured records, claims,
  evidence, and provenance — not the only supported output.
- A local human operator must review source evidence, the editorial revision,
  and the final publication decision. AI cannot approve sources, verify
  claims, approve articles, or publish.
- Official sources and independently reproducible evidence are preferred.
- Published facts carry their own evidence level: `confirmed`
  (human-reviewed authoritative evidence), `corroborated` (independent
  supporting lineages), `suspected` (insufficiently verified reporting), and
  `disputed` (credible evidence conflicts).
- Community and leak-related facts use explicit attribution language.
- Leaked assets, footage, and direct leak URLs are never public citations or
  public artifact content.
- Full article text is not retained by default; the parser retains a bounded
  excerpt, content hash, provenance, and derived claims. Expired research
  content is purged (`bun run db:purge`), with active drafts excluded.
- Pasted or local text is treated as untrusted research input with the same
  gates as fetched material; a public citation URL is required before an
  article can be drafted for publication.

## URL intake

URL and RSS intake are operator-only. Operator requests enqueue a durable
job; only the isolated ingestion worker may fetch it. Feed discovery is the
same model: the scheduler enqueues `source_discover` jobs, and the ingestion
worker fetches the feed through the controlled transport and enqueues each
item as its own ingestion job. The URL must match an enabled source in the
active profile's source registry. The fetcher checks
HTTP(S), registered domains, redirects, public DNS addresses, content type,
response size, timeouts, and globally coordinated per-source request pacing.
It does not bypass paywalls, authentication, CAPTCHAs, DRM, or rate limits,
and it does not execute source JavaScript.

Access metadata such as a terms review date, retention rules, and operator
notes may be recorded per source (`review-source`). That metadata is
operational documentation. It is not a prerequisite for fetching an enabled
source and never approves evidence.