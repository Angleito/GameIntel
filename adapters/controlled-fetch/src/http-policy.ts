import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { SourcePolicy } from "@gameintel/core";
import type { DnsResolver, FetchPolicy, RegisteredSource } from "@gameintel/contracts";

// Typed source-availability failures. `source_unavailable` counts against
// source health: source-DNS resolution failure and HTTP >= 500 (origin
// unreachable through the proxy). `transport_unavailable` is any fetch()
// rejection through the configured egress proxy — proxy outage, proxy
// connection failure, TLS, abort/timeout — never a proven origin outage, and
// never counted. `url_not_found` (4xx) is a bad URL, `response` (redirect/
// content-type/size violations) is a malformed response — neither counts.
// Policy errors stay plain `Error`.
export type SourceFetchErrorKind = "source_unavailable" | "transport_unavailable" | "url_not_found" | "response";

export class SourceFetchError extends Error {
  readonly kind: SourceFetchErrorKind;
  readonly status: number | null;
  constructor(kind: SourceFetchErrorKind, message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "SourceFetchError";
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

const privateV4 = (ip: string): boolean => {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168))
    || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51))
    || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
    || parts[0] >= 224;
};

function embeddedIpv4(ip: string): string | undefined {
  const dotted = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)?.slice(1);
  if (!hexadecimal) return undefined;
  const first = Number.parseInt(hexadecimal[0], 16);
  const second = Number.parseInt(hexadecimal[1], 16);
  return `${first >> 8}.${first & 255}.${second >> 8}.${second & 255}`;
}

export function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const normalized = ip.toLowerCase();
  const mappedV4 = embeddedIpv4(normalized);
  return normalized === "::1"
    || normalized === "::"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8:")
    || (mappedV4 !== undefined && privateV4(mappedV4));
}

const defaultResolver: DnsResolver = (hostname) => lookup(hostname, { all: true });

export async function assertPublicHost(hostname: string, resolver: DnsResolver = defaultResolver): Promise<void> {
  if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) throw new Error("Private hostnames are not permitted");
  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver(hostname);
  } catch (error) {
    // DNS resolution failure: the source hostname cannot be resolved, so the
    // source itself is unavailable.
    throw new SourceFetchError("source_unavailable", `Source DNS resolution failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!records.length || records.some((record) => privateIp(record.address))) throw new Error("Private or link-local address is not permitted");
}

export function assertRegisteredUrl(value: string, source: RegisteredSource): URL {
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error("Only HTTP(S) URLs are permitted");
  if (url.username || url.password) throw new Error("Credentialed URLs are not permitted");
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new Error("Non-standard ports are not permitted");
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = source.domains.some((domain) => {
    const registered = domain.toLowerCase();
    return registered.includes(".") && (hostname === registered || hostname.endsWith(`.${registered}`));
  });
  if (!allowed) throw new Error(`Domain ${hostname} is not registered for source ${source.id}`);
  return url;
}

class RateLimiter {
  private nextRequest = 0;
  async wait(rpm: number): Promise<void> {
    if (!rpm) throw new Error("Network access is disabled by source policy");
    const interval = 60_000 / rpm;
    const scheduled = Math.max(Date.now(), this.nextRequest);
    this.nextRequest = scheduled + interval;
    const delay = Math.max(0, scheduled - Date.now());
    if (delay) await Bun.sleep(delay);
  }
}

const limiters = new Map<string, RateLimiter>();
function limiterFor(sourceId: string): RateLimiter {
  const current = limiters.get(sourceId) ?? new RateLimiter();
  limiters.set(sourceId, current);
  return current;
}

export async function fetchPermittedUrl(value: string, policy: FetchPolicy, resolver: DnsResolver = defaultResolver): Promise<{ url: string; contentType: string; status: number; text: string }> {
  if (!policy.source.enabled) throw new Error(`Source ${policy.source.id} is disabled`);
  if (policy.sourcePolicy.accessMode !== "rss" && policy.sourcePolicy.accessMode !== "permitted_scrape" && policy.sourcePolicy.accessMode !== "official_api") throw new Error("Source policy does not permit network fetching");
  const proxyUrl = policy.proxyUrl ?? process.env.SOURCE_FETCH_PROXY_URL;
  if (!proxyUrl) throw new Error("SOURCE_FETCH_PROXY_URL is required for source fetching");
  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch {
    throw new Error("SOURCE_FETCH_PROXY_URL must be a valid HTTP proxy URL");
  }
  if (proxy.protocol !== "http:" || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) {
    throw new Error("SOURCE_FETCH_PROXY_URL must be an unauthenticated HTTP proxy origin");
  }
  let url = assertRegisteredUrl(value, policy.source);
  let redirects = 0;
  while (true) {
    await assertPublicHost(url.hostname, resolver);
    await limiterFor(policy.source.id).wait(policy.sourcePolicy.requestsPerMinute);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: { accept: "text/html, application/xhtml+xml, application/rss+xml, application/atom+xml, text/xml", "user-agent": policy.userAgent ?? policy.source.userAgent ?? "gameintelgg/0.1" },
        signal: AbortSignal.timeout(policy.timeoutMs ?? 15_000),
        proxy: proxy.toString(),
      } as RequestInit & { proxy: string });
    } catch (error) {
      // Every request goes through the configured egress proxy; a rejection
      // here is proxy/infrastructure/local transport failure (proxy
      // unreachable or refused, TLS, abort/timeout) — never a proven origin
      // outage. Origin failures surface as proxy HTTP responses and are
      // classified by status above. Transport failures never count against
      // source health.
      throw new SourceFetchError("transport_unavailable", `Source fetch failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (response.status >= 300 && response.status < 400) {
      if (++redirects > (policy.maxRedirects ?? 3)) throw new SourceFetchError("response", "Too many redirects");
      const location = response.headers.get("location");
      if (!location) throw new SourceFetchError("response", "Redirect has no location");
      url = assertRegisteredUrl(new URL(location, url).toString(), policy.source);
      continue;
    }
    if (!response.ok) throw new SourceFetchError(response.status >= 500 ? "source_unavailable" : "url_not_found", `Source fetch failed with HTTP ${response.status}`, { status: response.status });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    const accepted = ["text/html", "application/xhtml+xml", "application/rss+xml", "application/atom+xml", "text/xml"].includes(contentType);
    if (!accepted) throw new SourceFetchError("response", `Unsupported source content type: ${contentType || "unknown"}`);
    const maxBytes = policy.maxBytes ?? 1_500_000;
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > maxBytes) throw new SourceFetchError("response", "Source response exceeds size limit");
    const reader = response.body?.getReader();
    if (!reader) return { url: url.toString(), contentType, status: response.status, text: "" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new SourceFetchError("response", "Source response exceeds size limit"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { url: url.toString(), contentType, status: response.status, text: new TextDecoder().decode(bytes) };
  }
}
