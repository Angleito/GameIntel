import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { assertSafeObjectStoreKey, type ObjectStore } from "@gameintel/contracts";

function pathFor(root: string, key: string): string {
  assertSafeObjectStoreKey(key);
  return resolve(root, key.replaceAll("/", sep));
}

export class LocalFilesystemObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(key: string): string {
    return pathFor(this.root, key);
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    const path = this.path(key);
    await mkdir(this.root, { recursive: true });
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, value);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = this.path(key);
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async list(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeObjectStoreKey(prefix);
    let entries: string[] = [];
    try {
      entries = await readdir(this.root, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const root = resolve(this.root);
    const files: string[] = [];
    for (const entry of entries) {
      const absolute = resolve(this.root, entry);
      if (!absolute.startsWith(root)) continue;
      const info = await stat(absolute).catch(() => null);
      if (info?.isFile() && entry.startsWith(prefix)) files.push(entry);
    }
    return files.sort();
  }
}