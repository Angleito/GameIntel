import { assertSafeObjectStoreKey, type ObjectStore } from "@gameintel/contracts";
import { R2Client } from "./client.ts";

// ObjectStore capability adapter backed by Cloudflare R2. Single-bucket:
// keys map directly to objects in the configured bucket.
export type R2ObjectStoreOptions = {
  bucket: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
};

export class R2ObjectStore implements ObjectStore {
  private readonly client: R2Client;
  private readonly bucket: string;

  constructor(options: R2ObjectStoreOptions) {
    this.client = new R2Client({
      accountId: options.accountId,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      endpoint: options.endpoint,
    });
    this.bucket = options.bucket;
  }

  async put(key: string, value: Uint8Array | string): Promise<void> {
    assertSafeObjectStoreKey(key);
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    await this.client.putObject(this.bucket, key, bytes, { contentType: "application/octet-stream" });
  }

  async get(key: string): Promise<Uint8Array | null> {
    assertSafeObjectStoreKey(key);
    const object = await this.client.getObject(this.bucket, key);
    return object?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    assertSafeObjectStoreKey(key);
    await this.client.deleteObject(this.bucket, key);
  }

  async list(prefix?: string): Promise<string[]> {
    if (prefix) assertSafeObjectStoreKey(prefix);
    return this.client.listObjects(this.bucket, prefix ?? "");
  }
}