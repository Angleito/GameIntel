import { closeDb, createDb, purgeExpiredPublicSubmissions, purgeExpiredSourceContent } from "@gameintel/db";

const args = new Set(process.argv.slice(2));
if ([...args].some((argument) => argument !== "--execute")) {
  throw new Error("Usage: bun run db:purge [--execute]");
}

const db = createDb();
try {
  const options = { execute: args.has("--execute") };
  const [sourceContent, publicSubmissions] = await Promise.all([
    purgeExpiredSourceContent(db, options),
    purgeExpiredPublicSubmissions(db, options),
  ]);
  console.log(JSON.stringify({ sourceContent, publicSubmissions }));
} finally {
  await closeDb(db);
}
