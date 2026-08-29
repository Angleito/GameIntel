// The transport contract runner injects DNS resolvers per test; no global
// module mocking is needed.
import { runFetchTransportContract } from "@gameintel/adapter-contract-tests";
import { HttpControlledFetchTransport } from "./transport.ts";

runFetchTransportContract((options) => ({ transport: new HttpControlledFetchTransport(options?.resolver) }));