import {
  ADAPTER_API_VERSION,
  cryptoIdGenerator,
  schedulerForSources,
  systemClock,
  UnconfiguredFetchTransport,
  type GameIntelRuntime,
  type ObjectStore,
  type SchedulableSource,
} from "@gameintel/contracts";
import { SQLitePersistence } from "./persistence.ts";
import { SQLiteJobQueue } from "./job-queue.ts";
import { SQLitePacingStore } from "./pacing.ts";
import { SQLiteSourceHealthStore } from "./source-health.ts";

export * from "./source-health.ts";

// SQLite portability runtime: single-process only, like the in-memory
// backend. It proves the capability contracts are not secretly PostgreSQL.
export function createSqliteRuntime(options: {
  path?: string;
  fetchTransport?: GameIntelRuntime["fetchTransport"];
  schedulerSources?: SchedulableSource[];
  objectStore?: ObjectStore | null;
} = {}): GameIntelRuntime & { persistence: SQLitePersistence; jobQueue: SQLiteJobQueue; pacing: SQLitePacingStore } {
  const path = options.path ?? ":memory:";
  const clock = systemClock;
  const ids = cryptoIdGenerator;
  const persistence = SQLitePersistence.open(path, ids, clock);
  const jobQueue = new SQLiteJobQueue(persistence.database, ids, clock);
  const pacing = new SQLitePacingStore(persistence.database);
  const sourceHealth = new SQLiteSourceHealthStore(persistence.database);
  const scheduler = schedulerForSources(options.schedulerSources, clock);
  return {
    adapterApiVersion: ADAPTER_API_VERSION,
    persistence,
    jobQueue,
    pacing,
    sourceHealth,
    fetchTransport: options.fetchTransport ?? new UnconfiguredFetchTransport(),
    scheduler,
    objectStore: options.objectStore ?? null,
    clock,
    ids,
    close: async () => persistence.close(),
  };
}