import { createRuntime } from "../services/newsroom/src/runtime.ts";

const args = new Set(process.argv.slice(2));
if ([...args].some((argument) => argument !== "--execute")) {
  throw new Error("Usage: bun run db:purge [--execute]");
}

const runtime = createRuntime();
try {
  const options = { execute: args.has("--execute") };
  const [sourceContent, publicSubmissions] = await Promise.all([
    runtime.persistence.purgeExpiredSourceContent(options),
    runtime.persistence.purgeExpiredPublicSubmissions(options),
  ]);
  console.log(JSON.stringify({ sourceContent, publicSubmissions }));
} finally {
  await runtime.close();
}