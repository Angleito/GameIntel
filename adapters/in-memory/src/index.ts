import {
  cryptoIdGenerator,
  schedulerForSources,
  systemClock,
  UnconfiguredFetchTransport,
  type GameIntelRuntime,
  type ObjectStore,
  type SchedulableSource,
} from "@gameintel/contracts";
import { InMemoryJobQueue, MemoryLeaseRegistry } from "./job-queue.ts";
import { InMemoryPacingStore } from "./pacing.ts";
import { InMemoryPersistence } from "./persistence.ts";
import { InMemorySourceHealthStore } from "./source-health.ts";
import { createMemoryStore, type MemoryStore } from "./store.ts";

export { InMemoryJobQueue, MemoryLeaseRegistry } from "./job-queue.ts";
export { InMemoryPacingStore } from "./pacing.ts";
export { InMemoryPersistence } from "./persistence.ts";
export { InMemorySourceHealthStore } from "./source-health.ts";
export { createMemoryStore, type MemoryStore } from "./store.ts";

export type InMemoryRuntime = GameIntelRuntime & { memory: MemoryStore };

export function createInMemoryRuntime(options: {
  fetchTransport?: GameIntelRuntime["fetchTransport"];
  objectStore?: ObjectStore | null;
  schedulerSources?: SchedulableSource[];
} = {}): InMemoryRuntime {
  const clock = systemClock;
  const ids = cryptoIdGenerator;
  const store = createMemoryStore();
  const leases = new MemoryLeaseRegistry();
  const persistence = new InMemoryPersistence(store, ids, clock, leases);
  const jobQueue = new InMemoryJobQueue(ids, clock, leases);
  const scheduler = schedulerForSources(options.schedulerSources, clock);
  return {
    persistence,
    jobQueue,
    pacing: new InMemoryPacingStore(clock),
    sourceHealth: new InMemorySourceHealthStore(clock),
    fetchTransport: options.fetchTransport ?? new UnconfiguredFetchTransport(),
    scheduler,
    objectStore: options.objectStore ?? null,
    clock,
    ids,
    memory: store,
    close: async () => undefined,
  };
}
