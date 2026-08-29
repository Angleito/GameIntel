# GTA VI profile

GameIntel's first showcase profile. All game-specific information lives in
this directory; the reusable packages (`@gameintel/core`, `@gameintel/pipeline`,
`@gameintel/source-sdk`, adapters) contain no GTA VI or Rockstar assumptions.

## Files

| File | Purpose |
| --- | --- |
| `profile.json` | Collection profile: id, names, platforms, categories, exploit mode, source queries |
| `source-registry.yaml` | Ingestion whitelist: sources, trust classes, poll cadence, rate limits, citation rules |
| `media-source.json` | Official media source rules: page URL, asset path prefix, expected count, object-key namespaces, pacing |
| `media-showcase.json` | Frontend showcase media (nav backdrop and home hero slides) |
| `scripts/sync-media.ts` | Downloads and validates Rockstar's official screenshot page into an ignored local catalog |
| `scripts/publish-media.ts` | Publishes a validated catalog to Cloudflare R2 (dry run unless `--publish`) |

## Sources

Registered sources are disabled by default until explicitly enabled. Enabling
a source is ingestion configuration, not evidence approval: collection may run
continuously without editorial review.

## Media rules

- Only the configured Rockstar page and static asset path are accepted.
- Downloads are bounded (size, dimensions, content type, pacing).
- Object keys must stay in the `gta-vi/originals`, `gta-vi/display`, and
  `gta-vi/catalogs/` namespaces.
- The sync command never uploads; publishing is a separate explicit command.

## Commands

```bash
bun run media:sync --dry-run
R2_PUBLIC_BASE_URL=https://media.example.com bun run media:sync
bun run media:publish        # dry run
bun run media:publish --publish
```

`MEDIA_CATALOG_PATH` optionally overrides the ignored catalog path. The
Cloudflare Worker serves `/api/media/gta-vi/slideshow` from the published
catalog; `MEDIA_GAME_ID` can scope it to another profile.