# CLI

The root commands are:

- `bun run example` runs the dependency-light generic ingestion example.
- `bun run seed` loads the GTA VI showcase fixture into PostgreSQL.
- `bun run operator ingest <fixture.json>` processes a fixture.
- `bun run operator ingest-url --collection <id> --source <id> --url <url>` fetches a registered source.
- `bun run operator ingest-text --collection <id> --source <id> --title <title> --text-file <path>` processes local text.
- `bun run operator list [--profile <id>]` lists drafts and published records.
- `bun run operator public-snapshot [--profile <id>]` prints approved output.
- `bun run publish` writes the configured static publication artifact.

Use `--profile` to select the source registry. The current default is the GTA
VI showcase profile from `config/project.json`.
