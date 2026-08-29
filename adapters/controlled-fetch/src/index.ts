// Controlled-fetch adapter: the GameIntel behavioral contract for retrieving
// registered network sources. Squid is only the reference egress proxy; this
// transport enforces registered sources, allowed domains, private-IP blocking,
// redirect revalidation, size/type/time limits, and source pacing itself.
export * from "./http-policy.ts";
export * from "./transport.ts";
export type { ControlledFetchTransport, DnsResolver, FetchPolicy, FetchedResource, RegisteredSource } from "@gameintel/contracts";