import type { ControlledFetchTransport, GameIntelRuntime, ObjectStore, SchedulableSource } from "@gameintel/contracts";
import { HttpControlledFetchTransport } from "@gameintel/controlled-fetch";
import { createPostgresRuntime } from "@gameintel/postgres";
import { createInMemoryRuntime } from "@gameintel/in-memory";
import { createSqliteRuntime } from "@gameintel/sqlite";
import { LocalFilesystemObjectStore } from "@gameintel/local-filesystem";

export type StorageBackend = "postgres" | "memory" | "sqlite";

export function storageBackend(value: string | undefined): StorageBackend {
  const backend = value ?? "postgres";
  if (backend !== "postgres" && backend !== "memory" && backend !== "sqlite") {
    throw new Error(`Unknown GAMEINTEL_STORAGE '${backend}'`);
  }
  return backend;
}

export type RuntimeOptions = {
  url?: string;
  schedulerSources?: SchedulableSource[];
  fetchTransport?: ControlledFetchTransport;
  objectStore?: ObjectStore | null;
};

// Single-process runtime assembly (CLI tools, local experiments). The memory
// and sqlite backends are single-process/test-only: each runtime owns its own
// store, queue, and lease registry, so API/worker/scheduler processes can
// never share state through them.
export function createRuntime(backend: StorageBackend = storageBackend(process.env.GAMEINTEL_STORAGE), options: RuntimeOptions = {}): GameIntelRuntime {
  const fetchTransport = options.fetchTransport ?? new HttpControlledFetchTransport();
  const objectStore = options.objectStore ?? new LocalFilesystemObjectStore(process.env.GAMEINTEL_OBJECT_STORE_PATH ?? "tmp/object-store");
  if (backend === "memory") {
    return createInMemoryRuntime({ fetchTransport, objectStore, schedulerSources: options.schedulerSources });
  }
  if (backend === "sqlite") {
    return createSqliteRuntime({ fetchTransport, objectStore, schedulerSources: options.schedulerSources });
  }
  return createPostgresRuntime({ url: options.url, fetchTransport, objectStore, schedulerSources: options.schedulerSources });
}

// Runtime assembly for multi-process services (API, worker, scheduler,
// publisher). These always require the shared PostgreSQL backend.
export function createServiceRuntime(options: RuntimeOptions = {}): GameIntelRuntime {
  const backend = storageBackend(process.env.GAMEINTEL_STORAGE);
  if (backend === "memory" || backend === "sqlite") {
    throw new Error("GAMEINTEL_STORAGE=memory|sqlite is single-process/test-only; the API, worker, scheduler, and publisher require the PostgreSQL backend");
  }
  return createRuntime("postgres", options);
}