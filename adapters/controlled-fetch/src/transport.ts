import type { ControlledFetchTransport, DnsResolver, FetchPolicy, FetchedResource } from "@gameintel/contracts";
import { fetchPermittedUrl } from "./http-policy.ts";

// HTTP implementation of the ControlledFetchTransport capability. It enforces
// the GameIntel controlled-fetch requirements (registered sources, allowed
// domains, private-IP blocking, redirect revalidation, size/type/time limits,
// source pacing). Squid is only the reference egress proxy; this transport is
// the behavioral contract. A DNS resolver may be injected for testing.
export class HttpControlledFetchTransport implements ControlledFetchTransport {
  constructor(private readonly resolver?: DnsResolver) {}

  async fetch(url: string, policy: FetchPolicy): Promise<FetchedResource> {
    return fetchPermittedUrl(url, policy, this.resolver);
  }
}