import { closeDb, createDb, purgeExpiredSourceContent } from "@gameintel/db";

const args = new Set(process.argv.slice(2));
if ([...args].some((argument) => argument !== "--execute")) {
  throw new Error("Usage: bun run db:purge [--execute]");
}

const db = createDb();
try {
  const result = await purgeExpiredSourceContent(db, { execute: args.has("--execute") });
  console.log(JSON.stringify(result));
} finally {
  await closeDb(db);
}
