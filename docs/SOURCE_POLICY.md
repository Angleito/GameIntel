# Source Policy

Source intake produces reusable normalized records before any article or other
public output is generated. A source may be retained for research or data
processing without being eligible for public article output.

Only approved fixtures, official APIs, RSS feeds and registered web sources may
enter the ingestion pipeline. Registered web sources may be scraped when their
adapter is enabled. Adapters have a kill switch and are disabled by default
unless their policy is configured. Fixture ingestion additionally requires the
explicit `--allow-fixtures` local CLI flag and must only consume trusted test
data.

Leak reporting may be discussed only through legitimate public reporting or
official responses. Leaked assets, footage and direct leak URLs are never
stored in public publication artifacts.

## URL intake

URL and RSS intake are operator-only. The URL must match an enabled source in
the active game's source registry. The fetcher checks HTTP(S), registered
domains, redirects, public DNS addresses, content type, response size,
timeouts and per-source request pacing. It does not bypass paywalls,
authentication, CAPTCHAs, DRM or rate limits, and it does not execute source
JavaScript.

DNS checks are defense in depth, not an egress boundary: production deployments
must also block private, link-local, and metadata-address ranges at the network
layer. This protects against DNS rebinding between application-level validation
and the outbound connection.

The parser retains a bounded excerpt, content hash, provenance, and derived
claims. Full article text is not retained by default. Expired research content
can be reviewed with `bun run db:purge` and removed with
`bun run db:purge --execute`; active drafts are excluded from that purge.

## Local text intake

Pasted or local text is treated as untrusted research input. It receives a
manual URN, a hash, a retention window, and the same relevance, claim, source
review, editorial review, and publication gates as fetched material. A public
citation URL is required before an article can be drafted for publication.
