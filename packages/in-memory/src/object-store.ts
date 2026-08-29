import { assertSafeObjectStoreKey, type ObjectStore } from "@gameintel/contracts";

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array | string): Promise<void> {
    assertSafeObjectStoreKey(key);
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertSafeObjectStoreKey(key);
    const value = this.objects.get(key);
    return value ? new Uint8Array(value) : null;
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectStoreKey(key);
    this.objects.delete(key);
  }

  async list(prefix = ""): Promise<string[]> {
    if (prefix) assertSafeObjectStoreKey(prefix);
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}