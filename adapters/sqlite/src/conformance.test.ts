import { describe, test } from "bun:test";
import { runPersistenceContract, runQueueContract, runSourceHealthContract } from "@gameintel/adapter-contract-tests";
import { createSqliteRuntime } from "./index.ts";

// Conformance suite for the SQLite portability adapter. Always runs locally
// (bun:sqlite), proving the capability contracts are not secretly PostgreSQL.

describe("SQLite adapter conformance", () => {
  async function factory() {
    const runtime = createSqliteRuntime();
    return {
      persistence: runtime.persistence,
      queue: runtime.jobQueue,
      expireLease: (jobKey: string) => runtime.jobQueue.expireLeaseForTest(jobKey),
      close: async () => runtime.close(),
    };
  }

  runPersistenceContract(factory);
  runQueueContract(factory);
  runSourceHealthContract(async () => {
    const runtime = createSqliteRuntime();
    return { store: runtime.sourceHealth, close: async () => runtime.close() };
  });
});