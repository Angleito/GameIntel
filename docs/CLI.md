# CLI

The root commands are:

- `bun run example` runs the dependency-light generic ingestion example.
- `bun run seed` loads the GTA VI showcase fixture into PostgreSQL.
- `bun run operator ingest <fixture.json>` processes a fixture.
- `bun run operator ingest-url --collection <id> --source <id> --url <url>` queues a registered source URL for the isolated worker.
- `bun run operator ingest-text --collection <id> --source <id> --title <title> --text-file <path>` processes local text.
- `bun run operator list-submissions [--profile <id>]` lists retained public reports for moderation.
- `bun run operator review-submission <id> --decision under_review|rejected|blocked` changes a quarantined report's moderation state.
- `bun run operator promote-submission <id> [--profile <id>]` promotes a reviewed report as discussion-only community evidence.
- `bun run operator list [--profile <id>]` lists drafts and published records.
- `bun run operator public-snapshot [--profile <id>]` prints approved output.
- `bun run publish` writes the configured static publication artifact.

Use `--profile` to select the source registry. The current default is the GTA
VI showcase profile from `config/project.json`.

Public report promotion never creates a normal article. It retains community
attribution and must be corroborated through the regular evidence workflow.
