// S3-compatible client for Cloudflare R2. Generic SigV4 signing over HTTPS
// with no external dependencies; used by the profile media publish tooling and
// the R2ObjectStore adapter.

const REQUEST_TIMEOUT_MS = 15_000;

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodedPath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function canonicalUri(bucket: string, key: string): string {
  return `/${encodeURIComponent(bucket)}/${encodedPath(key)}`;
}

function hex(bytes: ArrayBufferLike): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: Uint8Array | string, value: string): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", arrayBuffer(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function timestamp(date: Date): { short: string; long: string } {
  const datePart = [date.getUTCFullYear().toString().padStart(4, "0"), (date.getUTCMonth() + 1).toString().padStart(2, "0"), date.getUTCDate().toString().padStart(2, "0")].join("");
  return { short: datePart, long: `${datePart}T${date.getUTCHours().toString().padStart(2, "0")}${date.getUTCMinutes().toString().padStart(2, "0")}${date.getUTCSeconds().toString().padStart(2, "0")}Z` };
}

function canonicalUriWithQuery(bucket: string, key: string, query: string): string {
  return query ? `${canonicalUri(bucket, key)}?${query}` : canonicalUri(bucket, key);
}

export function assertR2Endpoint(accountId: string, configured?: string): URL {
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("R2_ACCOUNT_ID must be a Cloudflare account ID.");
  const expectedHost = `${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
  let endpoint: URL;
  try {
    endpoint = new URL(configured ?? `https://${expectedHost}`);
  } catch {
    throw new Error("R2_ENDPOINT must be a valid URL.");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port || endpoint.hostname.toLowerCase() !== expectedHost || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("R2_ENDPOINT must be the credential-free HTTPS endpoint for R2_ACCOUNT_ID.");
  }
  return endpoint;
}

export function assertBucket(value: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..") || /^\d+(?:\.\d+){3}$/.test(value)) {
    throw new Error(`${name} must be a valid DNS-compatible R2 bucket name.`);
  }
  return value;
}

export type R2Credentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
};

export type R2PutOptions = {
  contentType: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
};

export class R2Client {
  readonly endpoint: URL;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(credentials: R2Credentials) {
    this.endpoint = assertR2Endpoint(credentials.accountId, credentials.endpoint);
    this.accessKeyId = credentials.accessKeyId;
    this.secretAccessKey = credentials.secretAccessKey;
  }

  private async signedRequest(
    method: "HEAD" | "GET" | "PUT" | "DELETE",
    bucket: string,
    key: string,
    query: string,
    body: Uint8Array | undefined,
    headers: Record<string, string>,
  ): Promise<Response> {
    const now = timestamp(new Date());
    const payloadHash = await sha256(body ?? new Uint8Array());
    const requestHeaders: Record<string, string> = {
      host: this.endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": now.long,
      ...headers,
    };
    const headerNames = Object.keys(requestHeaders).sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${requestHeaders[name].trim().replace(/\s+/g, " ")}\n`).join("");
    const signedHeaders = headerNames.join(";");
    const scope = `${now.short}/auto/s3/aws4_request`;
    const canonicalRequest = [method, canonicalUriWithQuery(bucket, key, query), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", now.long, scope, await sha256(new TextEncoder().encode(canonicalRequest))].join("\n");
    const dateKey = await hmac(`AWS4${this.secretAccessKey}`, now.short);
    const regionKey = await hmac(dateKey, "auto");
    const serviceKey = await hmac(regionKey, "s3");
    const signingKey = await hmac(serviceKey, "aws4_request");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hex((await hmac(signingKey, stringToSign)).buffer)}`;
    const url = new URL(this.endpoint);
    url.pathname = canonicalUri(bucket, key);
    url.search = query;
    return fetch(url, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { ...requestHeaders, authorization },
      body: body ? arrayBuffer(body) : undefined,
    });
  }

  private assertResponse(response: Response, bucket: string, key: string, method: string): void {
    if (response.status >= 300 && response.status < 400) throw new Error("R2 endpoint unexpectedly redirected a signed request.");
    if (!response.ok) throw new Error(`R2 ${method} ${bucket}/${key} returned HTTP ${response.status}.`);
  }

  async headObject(bucket: string, key: string): Promise<{ exists: boolean; checksum: string | null }> {
    const response = await this.signedRequest("HEAD", bucket, key, "", undefined, {});
    if (response.status === 404) return { exists: false, checksum: null };
    this.assertResponse(response, bucket, key, "HEAD");
    return { exists: true, checksum: response.headers.get("x-amz-meta-sha256") };
  }

  async putObject(bucket: string, key: string, bytes: Uint8Array, options: R2PutOptions): Promise<void> {
    const response = await this.signedRequest("PUT", bucket, key, "", bytes, {
      "cache-control": options.cacheControl ?? "public, max-age=31536000, immutable",
      "content-type": options.contentType,
      ...Object.fromEntries(Object.entries(options.metadata ?? {}).map(([name, value]) => [`x-amz-meta-${name}`, value])),
    });
    this.assertResponse(response, bucket, key, "PUT");
  }

  async getObject(bucket: string, key: string): Promise<{ bytes: Uint8Array; checksum: string | null } | null> {
    const response = await this.signedRequest("GET", bucket, key, "", undefined, {});
    if (response.status === 404) return null;
    this.assertResponse(response, bucket, key, "GET");
    return { bytes: new Uint8Array(await response.arrayBuffer()), checksum: response.headers.get("x-amz-meta-sha256") };
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const response = await this.signedRequest("DELETE", bucket, key, "", undefined, {});
    if (response.status === 404) return;
    this.assertResponse(response, bucket, key, "DELETE");
  }

  async listObjects(bucket: string, prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    let continuation: string | null = null;
    do {
      const query = `list-type=2&prefix=${encodeURIComponent(prefix)}${continuation ? `&continuation-token=${encodeURIComponent(continuation)}` : ""}`;
      const response = await this.signedRequest("GET", bucket, "", query, undefined, {});
      this.assertResponse(response, bucket, prefix || "(root)", "LIST");
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) keys.push(match[1]);
      continuation = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null;
    } while (continuation);
    return keys;
  }
}