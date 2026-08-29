import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ObjectStore } from "@gameintel/contracts";

export type ObjectStoreFactory = () => { store: ObjectStore; close?: () => Promise<void> };

export function runObjectStoreContract(factory: ObjectStoreFactory): void {
  describe("object store contract", () => {
    let store: ObjectStore;
    let close: (() => Promise<void>) | undefined;

    beforeEach(() => {
      const created = factory();
      store = created.store;
      close = created.close;
    });

    afterEach(async () => {
      await close?.();
    });

    test("round-trips binary and text values and overwrites keys", async () => {
      const bytes = new TextEncoder().encode("object-store-bytes");
      await store.put("keys/binary.bin", bytes);
      await store.put("keys/text.txt", "object-store-text");
      expect(await store.get("keys/binary.bin")).toEqual(bytes);
      const text = await store.get("keys/text.txt");
      expect(text).not.toBeNull();
      expect(new TextDecoder().decode(text!)).toBe("object-store-text");
      await store.put("keys/text.txt", "overwritten");
      const overwritten = await store.get("keys/text.txt");
      expect(overwritten).not.toBeNull();
      expect(new TextDecoder().decode(overwritten!)).toBe("overwritten");
    });

    test("returns null for missing keys and deletes stored values", async () => {
      expect(await store.get("missing")).toBeNull();
      await store.put("keys/delete-me", "value");
      await store.delete("keys/delete-me");
      expect(await store.get("keys/delete-me")).toBeNull();
      await store.delete("keys/never-existed");
    });

    test("lists keys with prefix filtering", async () => {
      await store.put("a/one", "1");
      await store.put("a/two", "2");
      await store.put("b/one", "3");
      expect(await store.list()).toEqual(["a/one", "a/two", "b/one"]);
      expect(await store.list("a/")).toEqual(["a/one", "a/two"]);
    });

    test("rejects unsafe keys", async () => {
      await expect(store.put("../escape", "x")).rejects.toThrow();
      await expect(store.put("/absolute", "x")).rejects.toThrow();
      await expect(store.put("", "x")).rejects.toThrow();
    });
  });
}