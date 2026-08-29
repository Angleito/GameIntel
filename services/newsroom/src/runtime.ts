import type { ControlledFetchTransport, GameIntelRuntime, ObjectStore, SchedulableSource } from "@gameintel/contracts";
import { createPostgresRuntime } from "@gameintel/db";
import { createInMemoryRuntime } from "@gameintel/in-memory";
import { LocalFilesystemObjectStore } from "@gameintel/local-filesystem";
import { HttpControlledFetchTransport } from "@gameintel/source-sdk";

export type StorageBackend = "postgres" | "memory";

export function storageBackend(value: string | undefined): StorageBackend {
  const backend = value ?? "postgres";
  if (backend !== "postgres" && backend !== "memory") throw new Error(`Unknown GAMEINTEL_STORAGE '${backend}'`);
  return backend;
}

export type RuntimeOptions = {
  schedulerSources?: SchedulableSource[];
  fetchTransport?: ControlledFetchTransport;
  objectStore?: ObjectStore | null;
};

// Single-process runtime assembly (CLI tools, local experiments). The memory
// backend is single-process/test-only: each in-memory runtime owns its own
// store, queue, and lease registry, so API/worker/scheduler processes can
// never share state through it.
export function createRuntime(backend: StorageBackend = storageBackend(process.env.GAMEINTEL_STORAGE), options: RuntimeOptions = {}): GameIntelRuntime {
  const fetchTransport = options.fetchTransport ?? new HttpControlledFetchTransport();
  const objectStore = options.objectStore ?? new LocalFilesystemObjectStore(process.env.GAMEINTEL_OBJECT_STORE_PATH ?? "tmp/object-store");
  if (backend === "memory") {
    return createInMemoryRuntime({ fetchTransport, objectStore, schedulerSources: options.schedulerSources });
  }
  return createPostgresRuntime({ fetchTransport, objectStore, schedulerSources: options.schedulerSources });
}

// Runtime assembly for multi-process services (API, worker, scheduler,
// publisher). These always require the shared PostgreSQL backend.
export function createServiceRuntime(options: RuntimeOptions = {}): GameIntelRuntime {
  const backend = storageBackend(process.env.GAMEINTEL_STORAGE);
  if (backend === "memory") {
    throw new Error("GAMEINTEL_STORAGE=memory is single-process/test-only; the API, worker, scheduler, and publisher require the PostgreSQL backend");
  }
  return createRuntime("postgres", options);
}