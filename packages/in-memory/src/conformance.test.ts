import { runObjectStoreContract, runPersistenceContract, runQueueContract } from "@gameintel/adapter-contract-tests";
import { createInMemoryRuntime, InMemoryJobQueue } from "./index.ts";
import { InMemoryObjectStore } from "./object-store.ts";

runPersistenceContract(async () => {
  const runtime = createInMemoryRuntime();
  return { persistence: runtime.persistence, close: runtime.close };
});

runQueueContract(async () => {
  const runtime = createInMemoryRuntime();
  return {
    queue: runtime.jobQueue,
    expireLease: (jobKey: string) => (runtime.jobQueue as InMemoryJobQueue).expireLeaseForTest(jobKey),
    close: runtime.close,
  };
});

runObjectStoreContract(() => ({ store: new InMemoryObjectStore() }));