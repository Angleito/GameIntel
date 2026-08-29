import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runObjectStoreContract } from "@gameintel/adapter-contract-tests";
import { LocalFilesystemObjectStore } from "./index.ts";

runObjectStoreContract(() => {
  const root = join(tmpdir(), `gameintel-object-store-${crypto.randomUUID()}`);
  const store = new LocalFilesystemObjectStore(root);
  return {
    store,
    close: () => rm(root, { recursive: true, force: true }),
  };
});