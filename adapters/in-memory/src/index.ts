import {
  ADAPTER_API_VERSION,
  cryptoIdGenerator,
  schedulerForSources,
  systemClock,
  UnconfiguredFetchTransport,
  type Clock,
  type GameIntelRuntime,
  type IdGenerator,
  type ObjectStore,
  type SchedulableSource,
} from "@gameintel/contracts";
import { InMemoryJobQueue, MemoryLeaseRegistry } from "./job-queue.ts";
import { InMemoryObjectStore } from "./object-store.ts";
import { InMemoryPacingStore } from "./pacing.ts";
import { InMemoryPersistence } from "./persistence.ts";
import { InMemorySourceHealthStore } from "./source-health.ts";
import { createMemoryStore, type MemoryStore } from "./store.ts";

export * from "./job-queue.ts";
export * from "./object-store.ts";
export * from "./pacing.ts";
export * from "./persistence.ts";
export * from "./source-health.ts";
export * from "./store.ts";
export { RegistryPollingScheduler } from "@gameintel/contracts";

export type InMemoryRuntime = GameIntelRuntime & { memory: MemoryStore };

export function createInMemoryRuntime(options: {
  clock?: Clock;
  ids?: IdGenerator;
  fetchTransport?: GameIntelRuntime["fetchTransport"];
  objectStore?: ObjectStore | null;
  schedulerSources?: SchedulableSource[];
} = {}): InMemoryRuntime {
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? cryptoIdGenerator;
  const store = createMemoryStore();
  const leases = new MemoryLeaseRegistry();
  const persistence = new InMemoryPersistence(store, ids, clock, leases);
  const jobQueue = new InMemoryJobQueue(ids, clock, leases);
  const scheduler = schedulerForSources(options.schedulerSources, clock);
  return {
    adapterApiVersion: ADAPTER_API_VERSION,
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