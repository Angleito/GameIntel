// R2 object-storage adapter for the reference deployment. The S3-compatible
// client is generic; the profile media tooling uses it directly for its
// checksum-verified upload flow, and R2ObjectStore satisfies the ObjectStore
// capability contract.
export * from "./client.ts";
export * from "./object-store.ts";
export type { ObjectStore } from "@gameintel/contracts";