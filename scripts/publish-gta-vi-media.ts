/**
 * Publishes a validated local GTA VI media catalog to Cloudflare R2. It is a
 * dry run unless --publish is present; originals and display objects must use
 * separate buckets.
 */
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertPublicBaseUrl,
  assertSafeObjectKey,
  contentTypeFromBytes,
  extensionForContentType,
  MAX_IMAGE_BYTES,
  parseCatalog,
  parseSourceConfig,
  sha256,
  type Catalog,
  type CatalogMedia,
  type SourceConfig,
} from "./sync-gta-vi-media.ts";

const REQUEST_TIMEOUT_MS = 15_000;

function usage(): void {
  console.log("Usage: bun run media:gta-vi:publish [--publish]");
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

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for --publish.`);
  return value;
}

function assertBucket(value: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..") || /^\d+(?:\.\d+){3}$/.test(value)) {
    throw new Error(`${name} must be a valid DNS-compatible R2 bucket name.`);
  }
  return value;
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

function pathInside(root: string, path: string, label: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${label} must remain inside ${resolvedRoot}.`);
  return resolvedPath;
}

export function originalPath(config: SourceConfig, item: CatalogMedia): string {
  const extension = extensionForContentType(item.contentType);
  return pathInside(resolve(config.workingDirectory, "originals"), resolve(config.workingDirectory, "originals", `${item.id}.${extension}`), "Media original path");
}

function catalogPath(config: SourceConfig): string {
  const configured = process.env.GTA_VI_MEDIA_CATALOG_PATH;
  return pathInside(config.workingDirectory, resolve(configured ?? config.catalogPath), "Media catalog path");
}

function catalogKey(config: SourceConfig): string {
  const key = assertSafeObjectKey(process.env.R2_MEDIA_CATALOG_KEY ?? config.catalogKey, "R2 media catalog key");
  if (!key.startsWith("gta-vi/catalogs/") || !key.endsWith(".json")) throw new Error("R2 media catalog key must remain in the GTA VI catalog namespace.");
  return key;
}

async function signedRequest(
  method: "HEAD" | "PUT",
  endpoint: URL,
  bucket: string,
  key: string,
  body: Uint8Array | undefined,
  headers: Record<string, string>,
  accessKeyId: string,
  secretAccessKey: string,
): Promise<Response> {
  const now = timestamp(new Date());
  const payloadHash = await sha256(body ?? new Uint8Array());
  const requestHeaders: Record<string, string> = {
    host: endpoint.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": now.long,
    ...headers,
  };
  const headerNames = Object.keys(requestHeaders).sort();
  const canonicalHeaders = headerNames.map((name) => `${name}:${requestHeaders[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = headerNames.join(";");
  const scope = `${now.short}/auto/s3/aws4_request`;
  const canonicalRequest = [method, canonicalUri(bucket, key), "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", now.long, scope, await sha256(new TextEncoder().encode(canonicalRequest))].join("\n");
  const dateKey = await hmac(`AWS4${secretAccessKey}`, now.short);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hex((await hmac(signingKey, stringToSign)).buffer)}`;
  const url = new URL(endpoint);
  url.pathname = canonicalUri(bucket, key);
  return fetch(url, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { ...requestHeaders, authorization },
    body: body ? arrayBuffer(body) : undefined,
  });
}

async function objectMatches(endpoint: URL, bucket: string, key: string, checksum: string, accessKeyId: string, secretAccessKey: string): Promise<boolean> {
  const response = await signedRequest("HEAD", endpoint, bucket, key, undefined, {}, accessKeyId, secretAccessKey);
  if (response.status === 404) return false;
  if (response.status >= 300 && response.status < 400) throw new Error("R2 endpoint unexpectedly redirected a signed request.");
  if (!response.ok) throw new Error(`R2 HEAD ${bucket}/${key} returned HTTP ${response.status}.`);
  return response.headers.get("x-amz-meta-sha256") === checksum;
}

async function loadCatalog(config: SourceConfig, requirePublicBase = false): Promise<Catalog> {
  const path = catalogPath(config);
  if (!await Bun.file(path).exists()) throw new Error(`Catalog not found: ${path}. Run media:gta-vi:sync first.`);
  const configuredPublicBaseUrl = process.env.R2_PUBLIC_BASE_URL;
  if (requirePublicBase && !configuredPublicBaseUrl) throw new Error("R2_PUBLIC_BASE_URL is required for --publish.");
  const publicBaseUrl = configuredPublicBaseUrl ? assertPublicBaseUrl(configuredPublicBaseUrl) : undefined;
  return parseCatalog(await Bun.file(path).json(), config, publicBaseUrl);
}

export async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    usage();
    return;
  }
  if ([...args].some((argument) => argument !== "--publish")) {
    usage();
    throw new Error("Unknown argument.");
  }

  const config = parseSourceConfig(await Bun.file(resolve("config/games/gta-vi/media-source.json")).json());
  if (!args.has("--publish")) {
    const path = catalogPath(config);
    if (!await Bun.file(path).exists()) {
      console.log(`Dry run: catalog not found at ${path}; run media:gta-vi:sync before publishing.`);
      return;
    }
    const catalog = await loadCatalog(config);
    console.log(`Dry run: validated ${catalog.media.length} original/display object pairs from ${path}. Pass --publish to upload.`);
    return;
  }

  const catalog = await loadCatalog(config, true);
  const accountId = requiredEnvironment("R2_ACCOUNT_ID");
  const endpoint = assertR2Endpoint(accountId, process.env.R2_ENDPOINT);
  const accessKeyId = requiredEnvironment("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnvironment("R2_SECRET_ACCESS_KEY");
  const privateBucket = assertBucket(requiredEnvironment("R2_PRIVATE_BUCKET"), "R2_PRIVATE_BUCKET");
  const publicBucket = assertBucket(requiredEnvironment("R2_PUBLIC_BUCKET"), "R2_PUBLIC_BUCKET");
  if (privateBucket === publicBucket) throw new Error("R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET must differ so originals remain private.");

  let uploaded = 0;
  let skipped = 0;
  for (const item of catalog.media) {
    const localPath = originalPath(config, item);
    const bytes = new Uint8Array(await Bun.file(localPath).arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`Local media file exceeds the ${MAX_IMAGE_BYTES}-byte limit: ${localPath}`);
    const dimensions = contentTypeFromBytes(bytes);
    if (dimensions.contentType !== item.contentType || dimensions.width !== item.width || dimensions.height !== item.height) {
      throw new Error(`Local media file no longer matches its validated catalog metadata: ${localPath}`);
    }
    if (await sha256(bytes) !== item.checksum) throw new Error(`Checksum mismatch for ${localPath}; re-run the sync before publishing.`);
    const objects = [
      { bucket: privateBucket, key: item.originalKey, publicObject: false },
      { bucket: publicBucket, key: item.displayKey, publicObject: true },
    ];
    for (const object of objects) {
      if (await objectMatches(endpoint, object.bucket, object.key, item.checksum, accessKeyId, secretAccessKey)) {
        skipped += 1;
        continue;
      }
      const response = await signedRequest("PUT", endpoint, object.bucket, object.key, bytes, {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": item.contentType,
        "x-amz-meta-sha256": item.checksum,
        "x-amz-meta-variant": object.publicObject ? "display-original" : "original",
      }, accessKeyId, secretAccessKey);
      if (response.status >= 300 && response.status < 400) throw new Error("R2 endpoint unexpectedly redirected a signed request.");
      if (!response.ok) throw new Error(`R2 PUT ${object.bucket}/${object.key} returned HTTP ${response.status}.`);
      uploaded += 1;
    }
    console.log(`Published ${item.id}`);
  }

  const serializedCatalog = new TextEncoder().encode(`${JSON.stringify(catalog)}\n`);
  const catalogChecksum = await sha256(serializedCatalog);
  const key = catalogKey(config);
  if (await objectMatches(endpoint, privateBucket, key, catalogChecksum, accessKeyId, secretAccessKey)) {
    skipped += 1;
  } else {
    const response = await signedRequest("PUT", endpoint, privateBucket, key, serializedCatalog, {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/json; charset=utf-8",
      "x-amz-meta-sha256": catalogChecksum,
      "x-amz-meta-variant": "approved-media-catalog",
    }, accessKeyId, secretAccessKey);
    if (response.status >= 300 && response.status < 400) throw new Error("R2 endpoint unexpectedly redirected a signed request.");
    if (!response.ok) throw new Error(`R2 PUT ${privateBucket}/${key} returned HTTP ${response.status}.`);
    uploaded += 1;
  }
  console.log(`R2 publish complete: ${uploaded} uploaded, ${skipped} already current.`);
}

if (import.meta.main) await main();
