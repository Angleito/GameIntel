import { readdir, readFile } from "node:fs/promises";
import { createDb, closeDb } from "@gameintel/postgres";

function checksum(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

const db = createDb(process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL);
try {
  await db`SELECT pg_advisory_lock(hashtextextended('gameintelgg-schema-migrations', 0))`;
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), filename text, checksum text)`;
  await db`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS filename text`;
  await db`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;
  const directory = new URL("../adapters/postgres/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const versions = new Set<string>();
  for (const file of files) {
    const version = file.match(/^(\d+)_/)?.[1];
    if (!version) throw new Error(`Migration filename must begin with a numeric version: ${file}`);
    if (versions.has(version)) throw new Error(`Duplicate migration version: ${version}`);
    versions.add(version);
    const sql = await readFile(new URL(file, directory), "utf8");
    const digest = checksum(sql);
    const applied = await db`SELECT filename, checksum FROM schema_migrations WHERE version = ${version}`;
    if (applied.length) {
      const previous = applied[0] as { filename: string | null; checksum: string | null };
      if (previous.filename && previous.filename !== file) throw new Error(`Migration version ${version} was previously applied from ${previous.filename}`);
      if (previous.checksum && previous.checksum !== digest) throw new Error(`Migration ${file} differs from its recorded checksum`);
      if (!previous.filename || !previous.checksum) {
        await db`UPDATE schema_migrations SET filename = ${file}, checksum = ${digest} WHERE version = ${version}`;
      }
      continue;
    }
    await db.begin(async (transaction) => {
      await transaction.unsafe(sql);
      await transaction`INSERT INTO schema_migrations (version, filename, checksum) VALUES (${version}, ${file}, ${digest})`;
    });
    console.log(`Applied migration ${file}`);
  }
  console.log("Database migration complete.");
} finally {
  await db`SELECT pg_advisory_unlock(hashtextextended('gameintelgg-schema-migrations', 0))`.catch(() => undefined);
  await closeDb(db);
}
