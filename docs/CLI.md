# CLI

The root commands are:

- `bun run example` runs the dependency-light generic ingestion example.
- `bun run seed` loads the showcase profile fixture into PostgreSQL.
- `bun run operator ingest <fixture.json>` processes a fixture (`--allow-fixtures` required).
- `bun run operator ingest-url --collection <id> --source <id> --url <url>` queues a registered source URL for the isolated worker.
- `bun run operator ingest-text --collection <id> --source <id> --title <title> --text-file <path>` processes local text.
- `bun run operator list-submissions [--profile <id>]` lists retained public reports for moderation.
- `bun run operator review-submission <id> --decision under_review|rejected|blocked` changes a quarantined report's moderation state.
- `bun run operator promote-submission <id> [--profile <id>]` promotes a reviewed report as discussion-only community evidence.
- `bun run operator review-source <id>` records source access metadata; it is not required for collection and does not approve evidence.
- `bun run operator list [--profile <id>]` lists drafts and published records.
- `bun run operator list-evidence <article-id>` / `review-evidence <id> [--decision approved|rejected|disputed]` runs the evidence review gate.
- `bun run operator list-analysis-runs <source-revision-id>` lists the analysis runs that interpreted a revision.
- `bun run operator reprocess-revision <source-revision-id> [--reason <text>]` re-interprets a retained source revision with the current parser/extractor/confidence versions, without refetching.
- `bun run operator review-article <id>` / `approve <id>` / `publish <id>` runs the editorial and publication gates.
- `bun run operator import-media <catalog.json>` and the cover/media approval commands manage the media catalog.
- `bun run operator public-snapshot [--profile <id>]` prints approved output.
- `bun run publish` writes the configured static publication artifact.
- `bun run media:sync` / `media:publish` run the profile's media tooling (see `profiles/gta-vi/README.md`).

Use `--profile` to select the profile. The default comes from
`GAMEINTEL_PROFILE` or `config/project.json`. The CLI uses the editor-only
runtime database login (`DATABASE_URL`).

Public report promotion never creates a normal article. It retains community
attribution and must be corroborated through the regular evidence workflow.