# Source Policy

Source intake produces reusable normalized records before any article or other
public output is generated. A source may be retained for research or data
processing without being eligible for public article output.

Only explicitly enabled fixtures, official APIs, RSS feeds and registered web
sources may enter the ingestion pipeline. Registered web sources may be scraped
when their adapter is enabled. Adapters have a kill switch and are disabled by
default unless their registry entry enables them. Enabling a source is
ingestion configuration, not evidence approval: collection may then run
continuously without any editorial review. Fixture ingestion additionally
requires the explicit `--allow-fixtures` local CLI flag and must only consume
trusted test data.

Access metadata such as a terms review date, retention rules and operator notes
may be recorded per source (see `review-source`). That metadata is operational
documentation. It is not a prerequisite for fetching an enabled source and it
never approves evidence.

Leak reporting may be discussed only through legitimate public reporting or
official responses. Leaked assets, footage and direct leak URLs are never
stored in public publication artifacts.

## URL intake

URL and RSS intake are operator-only. Operator requests enqueue a durable job;
only the isolated ingestion worker may fetch it. The URL must match an enabled
source in the active game's source registry. The fetcher checks HTTP(S),
registered domains, redirects, public DNS addresses, content type, response
size, timeouts and globally coordinated per-source request pacing. It does not
bypass paywalls, authentication, CAPTCHAs, DRM or rate limits, and it does not
execute source JavaScript.

DNS checks are defense in depth, not an egress boundary. The Compose worker is
on internal-only networks and must use the egress proxy. The proxy applies
destination-IP deny rules at connection time for loopback, private, link-local,
carrier-grade NAT, IPv6 local, documentation, multicast, and metadata ranges.
This protects against DNS rebinding between application-level validation and
the outbound connection. Production infrastructure must preserve this network
segmentation and apply equivalent VPC/firewall policy to the proxy itself.

## Community Reports

Public reports begin in `public_submissions` quarantine. A moderator must move
one to `under_review` before promotion. Promotion creates a manual
`community-submission` source item with `COMMUNITY` strength and
`discussion_only` publication mode; it does not fetch any reporter URL, use
reporter URLs as public citations, or create an article directly.

The parser retains a bounded excerpt, content hash, provenance, and derived
claims. Full article text is not retained by default. Expired research content
can be reviewed with `bun run db:purge` and removed with
`bun run db:purge --execute`; active drafts are excluded from that purge.

## Local text intake

Pasted or local text is treated as untrusted research input. It receives a
manual URN, a hash, a retention window, and the same relevance, claim, source
review, editorial review, and publication gates as fetched material. A public
citation URL is required before an article can be drafted for publication.

## Community submissions

The public submission endpoint is disabled by default. If enabled after launch
review, it accepts only a bounded report, public URLs, and previously staged
upload references. It rejects source strength, confidence, attribution,
evidence level, verification, and publication fields.

Every accepted submission is stored in quarantine with hashed session/IP
identifiers, a retention deadline, and a moderation event. It is not a source
item, claim, evidence record, article, search result, or public API record.
Promotion requires a separate editorial workflow. The deployment must provide
a trusted proxy that strips and sets the configured client-IP header before the
endpoint can be enabled.
