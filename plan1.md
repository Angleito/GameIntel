# GameIntel — Unified Local-First, Continuous-Ingestion, Open-Source Architecture & Security Plan

## 1. Operating principles

GameIntel is an early open-source project.

The priorities right now are:

```text
correctness
continuous ingestion
provenance
evidence quality
review integrity
local simplicity
free development
portable architecture
```

The priorities are not:

```text
enterprise infrastructure
paid CI
paid security products
managed cloud services
Kubernetes
high availability
multi-region deployment
complex authentication
hosted observability
premature scale
```

For now:

**Everything practical should run locally and for free.**

GitHub is used for:

```text
source hosting
issues
pull requests
collaboration
releases
```

Verification, testing, security scanning, databases, workers, ingestion and editorial operations run locally.

Hosted or paid infrastructure should only be introduced when actual users, traffic, contributors or operational requirements create a concrete need.

---

# 2. The most important architectural rule

GameIntel must make a hard distinction between:

```text
INGESTION AUTHORIZATION
```

and:

```text
PUBLICATION APPROVAL
```

They solve completely different problems.

## Ingestion authorization

Answers:

> Is GameIntel configured and permitted to collect through this source or method?

Examples:

```text
registered website
RSS feed
public API
community submission endpoint
operator input
webhook
filesystem fixture
future telemetry adapter
future platform adapter
```

Once a method is registered, enabled and whitelisted, GameIntel may ingest from it continuously according to its configured schedule, trigger and rate limits.

**No editorial approval is required before collection.**

## Publication approval

Answers:

> Is this particular evidence trustworthy enough to influence what GameIntel tells the public?

Approval therefore happens after ingestion.

The rule is:

```text
WHITELIST
controls collection

EVIDENCE REVIEW
controls public use
```

Another useful formulation is:

```text
TRUST THE INGESTION ROUTE ENOUGH TO COLLECT FROM IT

DO NOT AUTOMATICALLY TRUST THE CLAIMS IT CONTAINS
```

---

# 3. Core GameIntel pipeline

The conceptual pipeline should be:

```text
                   WHITELISTED INPUTS

 Websites       APIs       Community       Operator
    │            │         submissions       input
    └────────────┴──────────────┬──────────────┘
                                │
                                ↓
                    Continuous Ingestion
                                │
                                ↓
                        Source Material
                                │
                                ↓
                        Source Revisions
                                │
                                ↓
                         Observations
                                │
                                ↓
                            Claims
                                │
                                ↓
                    Evidence + Provenance
                                │
                                ↓
              Confidence / Contradiction Analysis
                                │
                                ↓
                    INTERNAL KNOWLEDGE BASE
                                │
                   ─────────────┴────────────
                       PUBLICATION BOUNDARY
                                │
                      Evidence Review
                                │
                                ↓
                    Publication Eligibility
                                │
                ┌───────────────┼──────────────┐
                │               │              │
              Guides         Articles       APIs/Data
                │
             Map facts
             timelines
             live updates
```

The critical invariant is:

```text
COLLECTION != PUBLICATION
```

Something entering GameIntel internally does not make it public.

---

# 4. Continuous ingestion is the default model

Whitelisted sources should be continuously revisited.

For a network source:

```text
registered source
      ↓
scheduler determines source is due
      ↓
ingestion job created
      ↓
controlled fetch
      ↓
compare with current revision
      ↓
store meaningful revision if changed
      ↓
normalize observations
      ↓
update claims/evidence/provenance
      ↓
repeat forever
```

Different sources may have different schedules.

For example:

```text
official release/news page      every few minutes
RSS feed                        every few minutes
trusted publication             periodically
slow reference page             hourly
public API                      provider-defined cadence
community submissions           event-driven
operator input                  event-driven
webhook                         event-driven
```

The schedule is configuration.

It is not editorial approval.

---

# ~~5. Fix the URL refresh bug first~~

The current ingestion-job design must allow a source URL to be processed repeatedly.

Separate:

```text
dedupeKey
```

from:

```text
jobId
```

For example:

```text
dedupeKey =
collection + source + canonical URL

jobId =
unique execution identifier
```

The dedupe key should prevent simultaneous duplicate work.

It must not permanently prevent future ingestion.

Correct behavior:

```text
12:00
URL scheduled
URL fetched
revision 1 stored
job completed

12:05
URL scheduled again
URL fetched
nothing changed
job completed

12:10
URL scheduled again
URL changed
revision 2 stored
evidence recalculated

12:15
URL scheduled again
...
```

Only one active queued/running execution should normally exist for a particular dedupe key.

Once that execution becomes terminal, another execution must be permitted.

Required behavior includes:

```text
completed URL can be scheduled again

dead URL can later be retried

only one active execution exists per dedupe key

unchanged fetch does not create meaningless revision churn

material change creates a new source revision

new revision propagates through affected evidence/publication state
```

This is the highest-priority correctness fix.

---

# 6. Separate scheduling from rate limiting

Scheduling and source pacing are different concepts.

For example:

```text
check source every 30 seconds
```

does not necessarily mean:

```text
make a request every 30 seconds
```

A configuration might say:

```text
pollInterval: 30s
rateLimit: 2/minute
```

The scheduler determines:

```text
this source should be checked
```

The pacing layer determines:

```text
when a request is actually allowed
```

This distinction becomes important as continuous ingestion grows.

---

# ~~7. Source registration is operational policy, not editorial approval~~

The code and documentation should stop using ambiguous terminology such as:

```text
source approval
```

when it really means ingestion configuration.

Prefer concepts such as:

```text
source registration
source enablement
ingestion whitelist
access policy
source configuration
ingestion authorization
```

A source configuration may include:

```text
source ID
adapter type
enabled state
allowed domains
poll cadence
rate limits
retention rules
citation rules
trust classification
publication restrictions
access metadata
```

Example:

```yaml
id: rockstar-official
method: web
enabled: true

domains:
  - rockstargames.com

pollInterval: 5m
trustClass: primary
publicationMode: normal
```

A community source could look like:

```yaml
id: community-submission
method: public_submission
enabled: true
trustClass: community
publicationMode: evidence_only
```

Changing:

```text
enabled: false
```

stops future collection.

It does not delete previously collected history.

---

# ~~8. Correct the existing source-policy concept~~

Do not make a human `source_policy_reviews` approval record a prerequisite for every fetch.

That would incorrectly turn an editorial workflow into an ingestion gate.

Instead, distinguish two ideas.

### Ingestion/access configuration

Machine-enforced configuration determining whether a source is registered and enabled.

This controls ingestion.

### Terms/access metadata

Information such as:

```text
terms reviewed date
allowed retrieval method
retention requirements
citation restrictions
robots/provider rules
operator notes
```

This can be maintained as operational metadata.

It should not masquerade as evidence approval.

Remove hardcoded values such as:

```text
termsReviewedAt: "2026-08-27"
```

and derive them from actual configuration/metadata when relevant.

If a maintainer disables or blocks a source because terms or access conditions change, continuous ingestion stops from that point forward.

But evidence/publication approval remains a separate system.

---

# 9. Preserve immutable source revisions

GameIntel should preserve meaningful source history rather than overwriting it.

Conceptually:

```text
Source
  ├── Revision 1
  ├── Revision 2
  ├── Revision 3
  └── Revision 4 ← current
```

Evidence should point to the exact source revision it came from.

Example:

```text
Claim:
Vehicle X can appear at location Y.

Evidence:
sourceRevisionId = rev_17
```

If revision 18 later contradicts revision 17, GameIntel can precisely identify affected evidence.

This is essential for rapidly changing information.

---

# 10. Preserve raw/source ingestion separately from interpretation

The original retrieved material and derived knowledge should be distinct.

Conceptually:

```text
Source Revision
      ↓
Parser / Normalizer
      ↓
Observations
      ↓
Claims
```

This allows a future parser improvement to reprocess already-collected data.

Example:

```text
source revision 12
      ↓
normalizer v1
      ↓
old observations

later

same source revision 12
      ↓
normalizer v2
      ↓
improved observations
```

GameIntel should not need to refetch the internet merely because its interpretation logic improved.

---

# 11. Track processing versions

Important transformations should eventually record their implementation/schema versions.

Examples:

```text
adapter version
parser version
normalization version
claim extraction version
confidence-model version
publication-schema version
```

This helps answer:

```text
Why does GameIntel currently believe this?
```

and:

```text
Would reprocessing with the current pipeline produce a different result?
```

---

# 12. Observation, claim, evidence and publication are distinct objects

These concepts should never collapse into a single "fact" object.

## Observation

Something GameIntel received or observed.

Example:

```text
"I found this vehicle here at 02:14."
```

## Claim

A proposition inferred from one or more observations.

Example:

```text
"Vehicle X can spawn at location Y at night."
```

## Evidence

Material supporting or contradicting the claim.

Example:

```text
community report
video observation
official page revision
trusted article
direct capture
```

## Publication

Something GameIntel intentionally exposes externally.

Example:

```text
guide entry
article
map marker
API fact
timeline item
live update
structured dataset
```

An observation does not automatically become a claim.

A claim does not automatically become truth.

Evidence does not automatically become public.

---

# 13. Community submissions ingest immediately

Community information should not wait for editorial approval before entering the system.

The flow should be:

```text
community submission
      ↓
quarantine
      ↓
normalize
      ↓
observation
      ↓
duplicate analysis
      ↓
provenance analysis
      ↓
possible candidate evidence
```

Quarantine means:

```text
internal only
```

It does not mean:

```text
not ingested
```

GameIntel should still analyze quarantined information.

For example:

```text
50 users report the same vehicle

35 reports appear copied from one original source

10 appear independently observed

5 contradict the others
```

That analysis can happen automatically before any publication decision.

---

# 14. Community popularity must never equal truth

A large number of reports does not automatically create strong evidence.

Example:

```text
1 Reddit post
   ↓
20 reposts
   ↓
50 TikToks
   ↓
100 Discord messages
```

That may represent:

```text
171 observations
```

but only:

```text
1 provenance family
```

GameIntel needs provenance-family detection so copies and echoes do not artificially inflate confidence.

Independent evidence should matter more than repeated copies.

---

# 15. Trust classification affects evidence weight, not whether ingestion occurs

Sources may have classifications such as:

```text
PRIMARY
DIRECT_EVIDENCE
TRUSTED_SECONDARY
COMMUNITY
UNVERIFIED
```

All of them can exist internally.

Their evidence value differs.

For example:

```text
official source
     ↓
PRIMARY

direct independently captured material
     ↓
DIRECT_EVIDENCE

established reporting
     ↓
TRUSTED_SECONDARY

community report
     ↓
COMMUNITY

anonymous rumor
     ↓
UNVERIFIED
```

Collection should normally continue for registered sources regardless of whether their content is currently strong enough for publication.

---

# 16. The publication boundary is where approval belongs

Evidence is continuously accumulated internally.

Publication eligibility is evaluated afterward.

Conceptually:

```text
Claim
  ↓
Evidence collected continuously
  ↓
Provenance calculated
  ↓
Contradictions detected
  ↓
Confidence calculated
  ↓
Evidence review
  ↓
Publication eligibility
```

A conservative initial publication rule can be:

```text
required evidence threshold met
AND
required reviewer approval met
AND
no unresolved rejection
AND
no unresolved dispute
```

Only then may the evidence influence public output.

---

# ~~17. Fix evidence disagreement semantics~~

An evidence item should not remain publication-eligible simply because enough people approved it while another current reviewer explicitly disputes it.

Initial rule:

```text
current REJECTED review exists
        ↓
blocked from publication

current DISPUTED review exists
        ↓
blocked from publication

required approvals reached
AND
no unresolved objection
        ↓
publication eligible
```

Later profiles can support more sophisticated rules:

```text
two independent reviewers

senior reviewer resolves disputes

primary-source requirement

two independent provenance families

temporary/provisional publication rules
```

But the initial behavior should strongly favor correctness.

---

# 18. Contradictory information must remain stored

Do not suppress evidence merely because it conflicts with previously accepted material.

Example:

```text
Evidence A:
vehicle appears every night

Evidence B:
vehicle appears only after mission 12

Evidence C:
vehicle appears randomly

Evidence D:
vehicle stopped appearing after patch 1.02
```

GameIntel should preserve all four.

The claim may then become:

```text
contested
```

or:

```text
superseded
```

Continuous ingestion should improve knowledge, not merely reinforce what was previously believed.

---

# 19. Make uncertainty first-class

Claims should support states such as:

```text
unverified
supported
contested
confirmed
superseded
retracted
```

Useful metadata includes:

```text
first observed
last observed
last evidence received
last reviewed
current source revision
supporting evidence count
independent provenance count
contradicting evidence count
confidence
public status
```

GameIntel can then publish nuanced states such as:

```text
Confirmed
```

```text
Strong community evidence
```

```text
Reports conflict — verification ongoing
```

```text
Previously confirmed, may have changed after update X
```

rather than pretending every claim is permanently true or false.

---

# ~~20. Continuous ingestion should invalidate stale public evidence automatically~~

Suppose a public guide uses evidence tied to source revision 7.

Continuous ingestion discovers revision 8.

If revision 8 materially affects the evidence:

```text
revision 8 arrives
      ↓
material change detected
      ↓
evidence tied to revision 7 becomes stale
      ↓
publication eligibility recalculated
      ↓
public item may require rereview
```

Possible states include:

```text
needs_review
possibly_stale
contested
```

The public item does not necessarily need to disappear automatically, but the system must know that its evidence status changed.

---

# 21. AI must remain downstream of provenance

AI may assist with:

```text
claim extraction
summarization
grouping
duplicate detection
possible provenance relationships
draft writing
article organization
```

AI must not invent evidence or become the source of provenance.

Correct:

```text
source revision
      ↓
provenance recorded
      ↓
AI analysis
      ↓
candidate claim
```

Incorrect:

```text
AI says something
      ↓
store as established evidence
```

Any AI-derived statement must remain traceable back to actual ingested material.

---

# 22. Abstract infrastructure behind capabilities

GameIntel Core should not depend directly on PostgreSQL, Squid, Cloudflare, R2 or any similar product.

Define small capability contracts such as:

```ts
SourceRepository
ObservationRepository
ClaimRepository
EvidenceRepository
ReviewRepository
PublicationRepository
SubmissionRepository
AuditRepository

JobQueue
SourceScheduler
SourcePacingStore

IngestionAdapter
FetchTransport
ObjectStore

OperatorIdentityProvider
AbuseProtection

Clock
IdGenerator
```

Avoid one enormous:

```ts
DatabaseAdapter
```

Small capability interfaces allow infrastructure to be mixed and replaced independently.

---

# 23. Make PostgreSQL a reference adapter

There is no reason to stop using PostgreSQL locally.

It is a strong fit for the current relational, transactional, evidence, provenance and revision model.

The architectural change is:

```text
OLD MENTAL MODEL

GameIntel
   ↓
PostgreSQL
```

becomes:

```text
TARGET

GameIntel Domain
      ↓
Persistence Contracts
      ↓
PostgreSQL Reference Adapter
```

PostgreSQL-specific concerns such as:

```text
SQL migrations
advisory locks
SKIP LOCKED
partial indexes
roles
specific transaction behavior
```

belong inside the reference adapter.

They should not define GameIntel Core.

---

# 24. Build an in-memory implementation first

Do not immediately build:

```text
MySQL
Redis
SQS
S3
Kafka
other cloud adapters
```

First implement:

```text
InMemoryPersistence
InMemoryJobQueue
InMemoryObjectStore
```

This provides:

```text
fast tests
free tests
easy contributor onboarding
no PostgreSQL requirement for core development
proof that infrastructure abstractions actually work
```

If the in-memory implementation requires rewriting core domain logic, the abstractions are leaking.

---

# 25. Use SQLite later as a portability proof

SQLite can be a useful second implementation.

It exposes assumptions hidden by PostgreSQL, such as reliance on:

```text
advisory locks
SKIP LOCKED
specific isolation behavior
partial indexes
JSON features
```

SQLite does not need to become the recommended large production backend.

It can simply prove that GameIntel is not secretly a PostgreSQL application.

---

# 26. Abstract the job queue and scheduler

Continuous ingestion should not conceptually depend on PostgreSQL's `jobs` table.

Define behavior such as:

```ts
interface JobQueue {
  enqueue(...)
  claim(...)
  renewLease(...)
  complete(...)
  fail(...)
}
```

and:

```ts
interface SourceScheduler {
  dueSources(...)
  markScheduled(...)
}
```

The local implementation may use PostgreSQL.

Future alternatives could include:

```text
SQLite
Redis
SQS
local filesystem/cron
another database
```

without modifying the ingestion domain.

---

# ~~27. Fix ingestion leases~~

Continuous workers need robust lease behavior.

Add:

```text
renewLease(jobId, leaseToken, duration)
```

The worker should renew ownership before expiry.

A stale worker must not complete a job that another worker has reclaimed.

Lease loss should result in:

```text
stop processing this execution
continue worker loop
```

not:

```text
terminate worker process
```

Required tests:

```text
long-running job renews lease

crashed worker's job becomes reclaimable

stale worker cannot complete reclaimed execution

lease loss does not kill worker
```

---

# 28. Abstract ingestion methods

Different inputs should feed the same downstream pipeline.

Conceptually:

```ts
interface IngestionAdapter {
  discover?(): Promise<Candidate[]>;
  fetch(candidate: Candidate): Promise<SourceMaterial>;
}
```

Possible adapters:

```text
HTTP page
RSS
REST API
community submission
operator input
filesystem
webhook
telemetry
platform API
```

Some adapters discover new items.

Others repeatedly poll a known source.

Both should be supported.

---

# 29. Support both polling and discovery

Two important ingestion patterns exist.

## Poll known target

```text
registered URL
      ↓
check repeatedly
```

## Discover new items

```text
RSS/API/index page
      ↓
discover new items
      ↓
queue each item
```

The ingestion abstraction should support both rather than assuming every source is one permanent URL.

---

# 30. Keep strong controlled-fetch protections

Continuous automatic fetching increases the importance of SSRF and network controls.

GameIntel's generic controlled-fetch requirements should include:

```text
registered ingestion source
allowed domain validation
HTTP/HTTPS restrictions
port restrictions
DNS validation
private-IP blocking
loopback blocking
link-local blocking
metadata-address blocking
redirect revalidation
response-size limits
content-type limits
timeouts
rate limiting
source pacing
```

These are GameIntel requirements.

Squid is only a reference implementation.

Introduce a conceptual:

```ts
ControlledFetchTransport
```

Another implementation may replace Squid only if it satisfies the same behavior.

---

# 31. Keep ingestion isolated from the public API

The public API should not arbitrarily fetch remote URLs itself.

Maintain the architectural boundary:

```text
Public/API process
       │
       ↓
enqueue / submit work
       │
       ↓
Ingestion Worker
       │
       ↓
Controlled Fetch Transport
       │
       ↓
Internet
```

This is worth preserving even in a completely local deployment.

---

# 32. Keep object storage abstract

GameIntel should depend on:

```ts
ObjectStore
```

not R2.

Reference implementations may include:

```text
LocalFilesystemObjectStore
R2ObjectStore
```

Possible future implementations:

```text
S3
MinIO
other compatible stores
```

For a zero-cost local environment, filesystem storage should be sufficient whenever practical.

---

# 33. Keep local PostgreSQL privilege separation

PostgreSQL is only an adapter, but the local reference adapter should still implement sensible security boundaries.

Conceptually separate:

```text
migration identity
public-intake identity
ingestion-worker identity
editorial/operator identity
publisher identity
```

This does not need to become excessively complex immediately.

The most important rule is:

**a public-facing process should not possess storage permissions that allow it to directly approve evidence or publish content.**

Alternative adapters may enforce the same capability separation differently.

---

# 34. Separate public intake from editorial authority

Public endpoints should primarily handle:

```text
safe reads
community submissions
quarantined intake
```

Editorial/operator capabilities handle:

```text
evidence review
dispute resolution
publication approval
publication actions
moderation
```

Locally, a strong static operator token remains perfectly acceptable.

Hide the implementation behind something such as:

```ts
OperatorIdentityProvider
```

Possible future providers can be added only if they become necessary.

No OAuth, SSO or paid identity system is needed now.

---

# 35. Keep abuse protection layered but simple

Community intake should maintain:

```text
quarantine
rate limiting
identity hashing
duplicate detection
retention controls
```

Expose an eventual capability such as:

```ts
AbuseProtection
```

so future deployments can add:

```text
edge limits
CAPTCHA
account quotas
IP reputation
other controls
```

without making those services GameIntel requirements.

For now, the local/free implementation is sufficient.

---

# 36. Make GTA VI a first-party profile

GTA VI remains the first major profile and launch/test case.

Game-specific information should live conceptually under:

```text
profiles/gta-vi/
```

A profile may define:

```text
sources
polling schedules
trust classifications
content categories
evidence policy
publication formats
media rules
guide types
```

Generic GameIntel packages should not hardcode:

```text
Rockstar
GTA
cars
game spawn locations
specific releases
```

The reusable engine should care about:

```text
Collection
Source
SourceRevision
Observation
Claim
Evidence
EvidenceReview
ProvenanceFamily
Publication
```

This enables later non-game profiles without rewriting the trust architecture.

---

# 37. Keep public documentation infrastructure-agnostic

The README should lead with:

```text
continuous ingestion
observations
claims
evidence
provenance
review
publication
```

not:

```text
PostgreSQL
Squid
R2
Docker
```

Then explain capability interfaces.

Only afterward should there be a:

```text
Reference Local Deployment
```

section explaining what the maintainers currently use.

Suggested positioning:

> GameIntel is infrastructure-agnostic. The repository includes a free local reference deployment used by the maintainers. Persistence, job execution, controlled network retrieval, object storage and identity can be replaced through adapters.

The implementation is still public.

Someone determined to inspect it will know what the maintainers use.

That is fine.

Security should assume attackers know every implementation detail.

Secrets and privileged operational data remain private—not architectural concepts.

---

# 38. Everything remains local and free for now

There is currently no requirement for:

```text
GitHub Actions
paid CI
paid security scanners
hosted databases
hosted queues
hosted monitoring
cloud development environments
managed authentication
managed object storage
```

GitHub remains collaboration/source infrastructure only.

All verification happens locally.

---

# 39. Create one authoritative local verification command

Eventually provide:

```bash
bun run release:check
```

This should perform the checks required before a meaningful public push, tag or release.

It should include:

```text
repository secret scan
tests
type checking
adapter conformance tests
integration tests
production build
migration/reference-adapter checks
generated-file checks
repository cleanliness checks
```

The important property is:

```text
one local command
```

rather than a collection of undocumented manual steps.

---

# ~~40. Strengthen the local secret scanner~~

Continue improving the repository's free local security scanner.

It should detect common secret forms such as:

```text
private keys
credentialed URLs
Bearer tokens
GitHub tokens
API keys
database passwords
cloud credentials
```

Also explicitly recognize project-sensitive variables such as:

```text
LOCAL_OPERATOR_TOKEN
SUBMISSION_IDENTITY_SECRET
APP_DATABASE_PASSWORD
POSTGRES_PASSWORD
R2_SECRET_ACCESS_KEY
SUPADATA_API_KEY
OPENCODE_PASSWORD
```

`.env.example` is allowed only when secret values remain blank or explicit placeholders.

Real `.env` files remain ignored.

If a real secret is ever committed:

```text
rotate credential first
rewrite history second
```

Deleting the file alone is not enough.

---

# 41. Keep the contributor experience extremely easy

Basic domain development should eventually require only:

```bash
bun install
bun test
```

using in-memory adapters.

Full maintainer/reference operation may remain:

```bash
docker compose up
```

Documentation should clearly distinguish:

```text
Basic Development
```

from:

```text
Full Local Reference Deployment
```

This reduces contributor friction without removing the stronger maintainer environment.

---

# 42. Create adapter conformance tests

If GameIntel says its infrastructure is replaceable, compatibility must have a concrete definition.

Provide test helpers such as:

```ts
runPersistenceContract(factory)
runQueueContract(factory)
runFetchTransportContract(factory)
runObjectStoreContract(factory)
```

Persistence contract tests should cover:

```text
source revisions
transactions
duplicates
evidence relationships
publication invalidation
audit behavior
concurrency expectations
```

Queue contract tests should cover:

```text
repeat scheduling
active deduplication
execution after completion
retry after failure
lease ownership
lease renewal
crash recovery
terminal outcomes
```

Fetch transport tests should cover:

```text
allowlists
redirect behavior
private-IP denial
DNS behavior
size/type/time limits
```

These all run locally.

---

# 43. Version public contracts early

Add explicit versioning for important interoperability boundaries.

Examples:

```text
adapter API
source registry format
source revision schema
observation schema
claim schema
evidence schema
publication output
profile format
```

For example:

```json
{
  "adapterApiVersion": 1
}
```

This prevents future contributors from accidentally relying on unstable internal behavior.

---

# 44. Gradually reorganize the repository

Do not perform one giant rewrite.

Target structure can eventually resemble:

```text
packages/
  core/
  pipeline/
  editorial/
  source-sdk/
  adapter-contract-tests/

adapters/
  postgres/
  in-memory/
  controlled-fetch/
  local-filesystem/
  r2/

profiles/
  gta-vi/

deployments/
  local/

apps/
  api/
  web/

services/
  worker/
  publisher/
```

But reach it incrementally.

First introduce capability interfaces.

Then make the current implementation satisfy them.

Then inject dependencies.

Then build the in-memory implementation.

Then move files.

---

# 45. Documentation should have three conceptual layers

## Layer 1 — GameIntel Domain

```text
continuous ingestion
observations
claims
evidence
provenance
trust
review
publication
```

## Layer 2 — Capabilities

```text
persistence
scheduling
jobs
controlled fetch
object storage
operator identity
abuse protection
```

## Layer 3 — Reference Local Deployment

```text
the actual tools used by maintainers
```

Most users should be able to understand and extend GameIntel without needing Layer 3.

---

# 46. Do not build infrastructure before usage requires it

Avoid premature work such as:

```text
Kubernetes
managed queues
hosted logging
distributed tracing
cloud databases
paid scanners
complex auth
autoscaling
multi-region systems
high-availability clusters
```

Introduce them only in response to a demonstrated problem.

Possible future triggers include:

```text
local ingestion cannot keep up

multiple remote editors need simultaneous access

continuous hosted ingestion becomes necessary

downtime begins affecting users

public API traffic becomes meaningful

contributors become numerous enough that local/manual release discipline no longer scales

operational backup/recovery becomes important

security-review workload exceeds what local tooling reasonably handles
```

Until then:

**simplicity is a feature.**

---

# 47. Recommended implementation order

The work should happen in this order:

```text
1. Fix URL refresh / repeat ingestion

2. Clarify registration/whitelist semantics
   and remove editorial approval from ingestion

3. Remove hardcoded source-access metadata

4. Fix evidence reject/dispute semantics

5. Fix ingestion lease renewal

6. Strengthen source revision + stale-evidence invalidation

7. Introduce capability interfaces

8. Wrap PostgreSQL as the reference persistence implementation

9. Abstract scheduler/job queue

10. Abstract controlled fetch

11. Build in-memory persistence + queue + object store

12. Add adapter conformance tests

13. Split public/editorial persistence privileges

14. Separate public intake from editorial capabilities

15. Move GTA VI assumptions into profile boundaries

16. Reorganize repository structure

17. Rewrite README/docs around domain → capabilities → reference deployment

18. Add optional SQLite portability implementation

19. Continue improving local release/security verification
```

Do not delay the known correctness fixes for the architectural refactor.

---

# 48. Initial v1 readiness bar

GameIntel does not require enterprise infrastructure to reach v1.

It requires a trustworthy core model.

The initial v1 bar should be:

```text
whitelisted sources continuously ingest automatically

ingestion never requires editorial evidence approval

same source can be refreshed indefinitely

active duplicate jobs are prevented without blocking future refreshes

meaningful source changes create immutable revisions

raw/source material is distinguishable from derived knowledge

observations are distinct from claims

claims are distinct from evidence

evidence is distinct from publication

community submissions ingest immediately into quarantine

public/community inputs cannot assign themselves trust

provenance families prevent echo-count inflation

contradictory evidence is preserved

unresolved rejected/disputed evidence cannot influence publication

publication approval is tied to specific evidence/source revisions

material source changes invalidate stale publication eligibility

workers safely renew leases

controlled network retrieval remains hardened

core packages do not require PostgreSQL

PostgreSQL is a reference adapter

at least one in-memory implementation proves portability

core development can run without Docker

full reference deployment remains available locally

all required tests/security/release verification can run locally for free

no real secrets exist in the public repository
```

---

# 49. Target infrastructure architecture

```text
                         GameIntel Domain

        ┌─────────────────────────────────────────┐
        │ Sources                                 │
        │ Source revisions                        │
        │ Observations                            │
        │ Claims                                  │
        │ Evidence                                │
        │ Provenance                              │
        │ Review / trust                          │
        │ Publications                            │
        └────────────────────┬────────────────────┘
                             │
                     Capability Contracts
                             │
       ┌─────────────────────┼─────────────────────┐
       │                     │                     │
  Persistence          Jobs / Scheduler      Controlled Fetch
       │                     │                     │
    Adapter                Adapter                Adapter
       │                     │                     │
 PostgreSQL*            PostgreSQL*             Proxy*
 In-memory              In-memory              alternatives
 SQLite later           others later           later

                             │
                        Object Store
                             │
                           Adapter
                             │
                    Local Filesystem*
                           R2*
                     alternatives later


* local/reference implementations, not GameIntel requirements
```

---

# 50. Local-first operating model

```text
GitHub
  =
source code
issues
pull requests
collaboration
releases


Local machine
  =
continuous ingestion
database
job workers
tests
type checking
secret scanning
release verification
editorial review
development deployment


Paid/hosted infrastructure
  =
none until demonstrated usage justifies it
```

---

# 51. Public positioning

GameIntel can eventually describe itself as:

**GameIntel is an open-source evidence and provenance engine for continuously turning rapidly changing public and community information into structured internal knowledge, then selectively publishing evidence-backed guides, facts, articles and data.**

And:

**GameIntel continuously ingests through explicitly configured sources and methods. Ingestion does not imply truth or publication. Evidence and provenance are evaluated downstream, and review controls what becomes public.**

And:

**GameIntel is infrastructure-agnostic. The maintainers provide a free local reference deployment, while persistence, scheduling, controlled network retrieval, object storage and identity can be replaced through adapters.**

---

# Final invariant

The entire architecture should be understandable through four statements:

```text
1. GameIntel continuously ingests everything
   it is explicitly configured and permitted to ingest.

2. Ingested information is internal knowledge,
   not automatically public truth.

3. Evidence, contradiction and provenance determine
   what claims are sufficiently supported.

4. Approval controls public publication of evidence,
   never routine ingestion.
```

The local reference deployment may continue using PostgreSQL, containers, the current controlled proxy and optional R2 integration.

Those are implementation choices.

**Continuous ingestion, provenance, evidence integrity and the publication boundary are the product.**

---

# Sign-off

Sections completed, verified locally with `bun run release:check` (secret scan,
tests, typecheck, production build) all green:

- [x] ~~5. Fix the URL refresh / repeat ingestion~~ — `dedupe_key` separated
  from `job_key`; a terminal execution never blocks future refreshes; active
  executions deduplicated (migration 013, `enqueueSourceIngestJob`).
- [x] ~~7. Clarify registration/whitelist semantics~~ — docs, CLI and registry
  wording now describe ingestion enablement, not editorial approval.
- [x] ~~8. Remove hardcoded source-access metadata~~ — hardcoded
  `termsReviewedAt: "2026-08-27"` removed; derived from registry metadata
  (`terms_reviewed_at`, `retain_raw_text_days`, `may_store_full_text`).
- [x] ~~17. Fix evidence reject/dispute semantics~~ — `evidenceReviewGate` in
  core; latest decision per reviewer; any current `rejected`/`disputed` review
  blocks publication; deterministic latest-review selection via `seq`
  (migration 014).
- [x] ~~20. Strengthen stale-evidence invalidation~~ — invalidation now also
  refreshes article confidence; claims carry a derived `state`
  (`unverified|supported|contested|confirmed|superseded|retracted`, migration
  015 + `deriveClaimState`).
- [x] ~~27. Fix ingestion lease renewal~~ — `renewIngestionJobLease`; worker
  loop extracted (`worker-loop.ts`) with periodic renewal, lease-loss handling
  that continues the loop instead of terminating the process.
- [x] ~~40. Strengthen the local secret scanner~~ — `APP_DATABASE_PASSWORD` and
  `SUBMISSION_IDENTITY_SECRET` added to named-secret detection; SECURITY.md
  documents rotate-first/rewrite-history response.

Architecture phase (implementation order items 7–12) completed:

- [x] ~~7. Introduce capability interfaces~~ — new `@gameintel/contracts`
  package (types-only) with small capability contracts: `SourceRepository`,
  `ObservationRepository`, `ClaimRepository`, `EvidenceRepository`,
  `ReviewRepository`, `PublicationRepository`, `SubmissionRepository`,
  `AuditRepository`, `MediaRepository`, `GameIntelPersistence`,
  `JobQueue`, `SourcePacingStore`, `SourceScheduler`,
  `ControlledFetchTransport`, `ObjectStore`, `OperatorIdentityProvider`,
  `AbuseProtection`, `Clock`, `IdGenerator`; `ADAPTER_API_VERSION = 1`;
  shared `IngestionJob`, purge, submission, and lease types.
- [x] ~~8. Wrap PostgreSQL as the reference persistence implementation~~ —
  `PostgresPersistence`, `PostgresJobQueue`, `PostgresPacingStore`,
  `createPostgresRuntime` in `@gameintel/db` (adapter.ts); PostgreSQL-specific
  concerns (advisory locks, SKIP LOCKED, savepoints) stay inside the adapter.
- [x] ~~9. Abstract the scheduler/job queue~~ — `JobQueue` + `SourceScheduler`
  contracts; registry-driven `RegistryPollingScheduler`; continuous scheduler
  service (`services/newsroom/src/scheduler.ts`) and Compose `scheduler`
  service; `poll_interval_seconds` source configuration; scheduling and
  pacing are separate (scheduler enqueues, pacing governs requests).
- [x] ~~10. Abstract controlled fetch~~ — `ControlledFetchTransport` contract;
  `HttpControlledFetchTransport` in `@gameintel/source-sdk`; injectable DNS
  resolver; Squid remains only the reference egress proxy.
- [x] ~~11. In-memory persistence + queue + object store~~ — new
  `@gameintel/in-memory` (`InMemoryPersistence`, `InMemoryJobQueue`,
  `InMemoryPacingStore`, `InMemoryObjectStore`, `RegistryPollingScheduler`,
  `createInMemoryRuntime`) and `@gameintel/local-filesystem`
  (`LocalFilesystemObjectStore`); snapshot-based transactions with full
  rollback; lease fencing shares a registry with the in-memory queue.
- [x] ~~12. Adapter conformance tests~~ — new
  `@gameintel/adapter-contract-tests`: `runPersistenceContract`,
  `runQueueContract`, `runFetchTransportContract`, `runObjectStoreContract`;
  green against both the PostgreSQL reference adapter (env-gated,
  `GAMEINTEL_TEST_POSTGRES=true`) and the in-memory adapter.
- [x] Dependency injection — `GameIntelRuntime` assembled by
  `createPostgresRuntime`/`createInMemoryRuntime`; worker, CLI, API,
  publisher, scheduler and scripts consume `persistence`/`jobQueue`/`pacing`
  instead of a `Db` handle; `GAMEINTEL_STORAGE=postgres|memory` selection.

Corresponding v1 readiness bar items (section 48) now satisfied:

- [x] ingestion never requires editorial evidence approval
- [x] same source can be refreshed indefinitely
- [x] active duplicate jobs are prevented without blocking future refreshes
- [x] meaningful source changes create immutable revisions
- [x] unresolved rejected/disputed evidence cannot influence publication
- [x] publication approval is tied to specific evidence/source revisions
- [x] material source changes invalidate stale publication eligibility
- [x] workers safely renew leases
- [x] controlled network retrieval remains hardened
- [x] core packages do not require PostgreSQL
- [x] PostgreSQL is a reference adapter
- [x] at least one in-memory implementation proves portability
- [x] core development can run without Docker (`bun test` passes offline)

Remaining for later phases: 13–16, 18–19, 25, 28–29 (additional adapters and
patterns), 33–35 (privilege separation, public intake/editorial separation,
abuse protection layering), 37/45 (docs restructure), 39/41 (release command
polish, contributor experience), 46 (avoid premature infrastructure), 49–51
(public positioning).

Remaining items now completed, verified with `bun test`, `bun run typecheck`,
`bun run release:check`, the env-gated PostgreSQL conformance and privilege
suites, and a full Compose stack smoke:

- [x] ~~13. Split public/editorial persistence privileges (33)~~ — migration
  016 creates `gameintel_public` (reads + submission intake, no UPDATE) and
  `gameintel_operator` (jobs/moderation/promotion, no evidence review or
  publication) group roles; migration 017 grants the operator provenance upsert;
  three logins bootstrapped per capability; the API runs two runtimes
  (public/operator); `privileges.test.ts` asserts the deny matrix. Review
  hardening: 018 revokes all article writes from the operator role, 019 narrows
  public reads to the published article surface with community intake routed
  through SECURITY DEFINER functions (no direct submission-table reads, no
  automatic future-table reads), 020 completes the boundary (public articles
  are readable only through published-only SECURITY DEFINER functions with no
  raw article-table SELECT; intake writes are fenced in the submit function so
  the public role holds no INSERT on intake, moderation, or audit tables;
  application logins cannot use capability group role names), the bootstrap revokes
  stray memberships before granting exactly one capability group per login,
  and the tests prove the operator cannot publish, the public role cannot read
  internal tables or submission identity columns, and each login belongs to
  exactly one group.
- [x] ~~14. Separate public intake from editorial capabilities (34–35)~~ —
  `StaticOperatorIdentityProvider` + `LocalAbuseProtection` implement the
  contracts (`@gameintel/newsroom/identity`); API middleware and submission
  identity hashing now use them.
- [x] ~~15. Move GTA VI assumptions into profile boundaries (36)~~ —
  `profiles/gta-vi/` holds profile, registry, media source/showcase data and
  the media scripts; `@gameintel/config` resolves `profiles/<id>/` with no
  hard-coded profile default; seed, Cloudflare Worker (`MEDIA_GAME_ID`), and
  the web app (nav, sitemap, home, about, article credits, dynamic
  `/games/[gameId]/`) are profile-driven.
- [x] ~~16. Reorganize repository structure (44)~~ — `adapters/` holds
  postgres (renamed `@gameintel/postgres`), in-memory, local-filesystem,
  controlled-fetch (extracted from source-sdk), and r2 (SigV4 client +
  `R2ObjectStore`) packages; `services/worker` owns the scheduler and
  ingestion worker; `deployments/local/` holds compose.yaml and infra
  (Dockerfile, Postgres bootstrap, Squid, Cloudflare Worker).
- [x] ~~17. Rewrite README/docs around domain → capabilities → reference
  deployment (37/45, 49–51)~~ — new `docs/DOMAIN.md` (Layer 1) and
  `docs/CAPABILITIES.md` (Layer 2); ARCHITECTURE/API/CLI/RELEASE_CHECKLIST/
  SOURCE_ADAPTERS refreshed as Layer 3; README leads with the domain model,
  positioning statements, and a Basic Development vs Full Local Reference
  Deployment split; CONTRIBUTING.md updated.
- [x] ~~18. SQLite portability implementation (25)~~ — `@gameintel/sqlite`
  (`SQLitePersistence`, `SQLiteJobQueue`, `SQLitePacingStore`,
  `createSqliteRuntime`) on `bun:sqlite`; persistence + queue conformance
  suites pass always-on; `GAMEINTEL_STORAGE=sqlite` single-process backend.
- [x] ~~19. Release polish and contributor experience (39/41)~~ —
  `release:check` now includes a frozen-lockfile check, migration numbering
  consistency check, and the `check:clean` repository-cleanliness gate; new
  `release:check:postgres` runs the env-gated reference-adapter suites.
- [x] ~~28–29. Polling and discovery patterns~~ — RSS discovery wired
  end-to-end through the queue boundary: the scheduler enqueues a
  `source_discover` job per due feed source (the feed URL is never ingested
  as an article), and the isolated ingestion worker fetches the feed through
  the controlled transport, parses items, and enqueues each one as its own
  ingestion job; discovery failures reuse the queue's retry/lease machinery.
- [x] ~~46. Avoid premature infrastructure~~ — unchanged; the reference
  deployment remains entirely local and free.

v1 readiness bar additions:

- [x] at least one SQLite implementation proves portability beyond PostgreSQL
- [x] one local release command performs all release checks
- [x] community submissions flow through public intake → quarantine →
  moderation → promotion with storage-level capability separation
