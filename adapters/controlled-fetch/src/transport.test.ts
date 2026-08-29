// The transport contract runner injects DNS resolvers per test; no global
// module mocking is needed. The default resolver is stubbed so the suite runs
// offline.
import { mock } from "bun:test";
import { runFetchTransportContract } from "@gameintel/adapter-contract-tests";
import { HttpControlledFetchTransport } from "./transport.ts";

mock.module("node:dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
}));

runFetchTransportContract((options) => ({ transport: new HttpControlledFetchTransport(options?.resolver) }));