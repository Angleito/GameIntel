// R2 object-storage adapter for the reference deployment. The S3-compatible
// client is generic; the profile media tooling uses it directly for its
// checksum-verified upload flow.
export * from "./client.ts";
export type { ObjectStore } from "@gameintel/contracts";