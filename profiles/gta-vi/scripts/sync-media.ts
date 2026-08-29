/**
 * Synchronizes Rockstar's official GTA VI screenshots page into local, ignored
 * assets and a catalog. Only the configured official page and static asset path
 * are accepted; downloads are bounded and are never uploaded by this command.
 *
 * This tooling is profile-local: it lives under profiles/gta-vi/ and its
 * constants describe the GTA VI media source only.
 *
 * Usage:
 *   R2_PUBLIC_BASE_URL=https://media.example.com bun run media:sync
 *   bun run media:sync --dry-run
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mediaSourcePath } from "@gameintel/config";

export type SourceConfig = {
  version: string;
  gameId: string;
  collectionId: string;
  sourcePageUrl: string;
  expectedMediaCount: number;
  assetPathPrefix: string;
  attribution: string;
  workingDirectory: string;
  catalogPath: string;
  originalPrefix: string;
  displayPrefix: string;
  catalogKey: string;
  requestsPerMinute: number;
};

export type Slide = { title: string; collection: string; sourceUrl: string; width: number; height: number };
export type ImageContentType = "image/jpeg" | "image/png" | "image/webp";
export type Dimensions = { width: number; height: number; contentType: ImageContentType; extension: string };

export type CatalogMedia = {
  id: string;
  collectionId: string;
  collection: string;
  caption: string;
  altText: string;
  tags: string[];
  spoilerTags: string[];
  attribution: string;
  sourceUrl: string;
  sourcePageUrl: string;
  originalKey: string;
  displayKey: string;
  publicUrl: string;
  contentType: ImageContentType;
  width: number;
  height: number;
  checksum: string;
};

export type Catalog = { version: string; collectionId: string; generatedAt: string; media: CatalogMedia[] };

const GAME_ID = "gta-vi";
const OFFICIAL_HOST = "www.rockstargames.com";
const OFFICIAL_PAGE_PATH = "/VI/media/screenshots";
const OFFICIAL_ASSET_PATH_PREFIX = "/VI/_next/static/media/";
const WORKING_DIRECTORY = "tmp/gta-vi-media";
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_WIDTH = 10_000;
export const MAX_IMAGE_HEIGHT = 10_000;
export const MAX_IMAGE_PIXELS = 50_000_000;

const CONTENT_TYPE_EXTENSIONS: Record<ImageContentType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const IDENTIFIER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OBJECT_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PAGE_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);

type JsonRecord = Record<string, unknown>;
type BoundedResponse = { url: URL; bytes: Uint8Array; contentType: string | null };

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as JsonRecord;
}

function requiredString(value: unknown, label: string, maxLength = 1_024): string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty, trimmed string no longer than ${maxLength} characters.`);
  }
  return value;
}

function displayText(value: unknown, label: string, maxLength = 512): string {
  const text = requiredString(value, label, maxLength);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain control characters.`);
  return text;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function canonicalHttpsUrl(value: unknown, label: string): URL {
  const raw = requiredString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  if (url.port) throw new Error(`${label} must not use a non-default port.`);
  if (url.hash) throw new Error(`${label} must not contain a fragment.`);
  return url;
}

function safePublicBasePath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return false;
  return pathname.slice(1).split("/").every((segment) => OBJECT_SEGMENT_PATTERN.test(segment));
}

function mediaObjectKey(prefix: string, id: string, checksum: string, extension: string): string {
  return assertSafeObjectKey(`${prefix}/${id}/${checksum}.${extension}`, "generated media object key");
}

function encodedKeyPath(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function normalizedContentType(response: Response): string | null {
  const header = response.headers.get("content-type");
  if (!header) return null;
  const value = header.split(";", 1)[0]?.trim().toLowerCase();
  return value || null;
}

function supportedImageContentType(value: unknown): ImageContentType {
  if (typeof value !== "string" || !(value in CONTENT_TYPE_EXTENSIONS)) {
    throw new Error(`Unsupported catalog content type: ${String(value)}`);
  }
  return value as ImageContentType;
}

function readStringArray(value: unknown, label: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must be an array with at most ${maximumItems} entries.`);
  return value.map((entry, index) => {
    const tag = requiredString(entry, `${label}[${index}]`, 64);
    if (!TAG_PATTERN.test(tag)) throw new Error(`${label}[${index}] must be a lowercase hyphenated tag.`);
    return tag;
  });
}

function readGeneratedAt(value: unknown): string {
  const generatedAt = requiredString(value, "catalog generatedAt", 32);
  const parsed = new Date(generatedAt);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== generatedAt) {
    throw new Error("catalog generatedAt must be an ISO-8601 timestamp.");
  }
  return generatedAt;
}

function releaseResponse(response: Response): Promise<void> {
  return response.body?.cancel().catch(() => undefined) ?? Promise.resolve();
}

async function readBoundedResponse(response: Response, maximumBytes: number, description: string): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error(`${description} returned an invalid Content-Length header.`);
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) throw new Error(`${description} returned an invalid Content-Length header.`);
    if (declaredLength > maximumBytes) throw new Error(`${description} exceeds the ${maximumBytes}-byte size limit.`);
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error(`${description} exceeds the ${maximumBytes}-byte size limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchBoundedOfficial(
  initialUrl: URL,
  validateUrl: (url: URL) => URL,
  maximumBytes: number,
  description: string,
  headers: Record<string, string>,
  validateResponse?: (response: Response) => void,
): Promise<BoundedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let currentUrl = validateUrl(initialUrl);
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const response = await fetch(currentUrl, { headers, redirect: "manual", signal: controller.signal });
      if (REDIRECT_STATUSES.has(response.status)) {
        await releaseResponse(response);
        if (redirectCount === MAX_REDIRECTS) throw new Error(`${description} exceeded the ${MAX_REDIRECTS}-redirect limit.`);
        const location = response.headers.get("location");
        if (!location) throw new Error(`${description} redirected without a Location header.`);
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new Error(`${description} redirected to an invalid URL.`);
        }
        currentUrl = validateUrl(nextUrl);
        continue;
      }
      if (!response.ok) {
        await releaseResponse(response);
        throw new Error(`${description} returned HTTP ${response.status}: ${currentUrl}`);
      }
      validateResponse?.(response);
      return { url: currentUrl, bytes: await readBoundedResponse(response, maximumBytes, description), contentType: normalizedContentType(response) };
    }
    throw new Error(`${description} exceeded the ${MAX_REDIRECTS}-redirect limit.`);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${description} timed out after ${FETCH_TIMEOUT_MS / 1_000} seconds.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function assertSafeId(value: unknown, label = "ID", maximumLength = 160): string {
  const id = requiredString(value, label, maximumLength);
  if (!IDENTIFIER_PATTERN.test(id)) throw new Error(`${label} must be a lowercase hyphenated identifier.`);
  return id;
}

export function assertSafeObjectKey(value: unknown, label = "R2 object key"): string {
  const key = requiredString(value, label, 512);
  const segments = key.split("/");
  if (segments.length === 0 || segments.some((segment) => !OBJECT_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..")) {
    throw new Error(`${label} must contain only safe lowercase path segments.`);
  }
  return key;
}

export function assertChecksum(value: unknown, label = "checksum"): string {
  const checksum = requiredString(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  return checksum;
}

export function extensionForContentType(value: unknown): string {
  return CONTENT_TYPE_EXTENSIONS[supportedImageContentType(value)];
}

export function assertImageDimensions(width: unknown, height: unknown, label = "image dimensions"): { width: number; height: number } {
  const safeWidth = boundedInteger(width, `${label} width`, 1, MAX_IMAGE_WIDTH);
  const safeHeight = boundedInteger(height, `${label} height`, 1, MAX_IMAGE_HEIGHT);
  if (safeWidth * safeHeight > MAX_IMAGE_PIXELS) {
    throw new Error(`${label} exceed the ${MAX_IMAGE_PIXELS}-pixel limit.`);
  }
  return { width: safeWidth, height: safeHeight };
}

export function assertOfficialPageUrl(value: unknown): URL {
  const url = canonicalHttpsUrl(value, "Rockstar source page URL");
  if (url.hostname !== OFFICIAL_HOST || (url.pathname !== OFFICIAL_PAGE_PATH && url.pathname !== `${OFFICIAL_PAGE_PATH}/`) || url.search) {
    throw new Error("Rockstar source page URL must be the configured official screenshots page.");
  }
  return url;
}

export function assertOfficialAssetUrl(value: unknown, config: SourceConfig): URL {
  const url = canonicalHttpsUrl(value, "Rockstar screenshot asset URL");
  const sourcePage = assertOfficialPageUrl(config.sourcePageUrl);
  if (url.origin !== sourcePage.origin || !url.pathname.startsWith(config.assetPathPrefix)) {
    throw new Error(`Refusing non-official screenshot asset URL: ${url}`);
  }
  const assetName = url.pathname.slice(config.assetPathPrefix.length);
  if (!assetName || !/^[A-Za-z0-9._-]+$/.test(assetName)) {
    throw new Error(`Refusing unsafe Rockstar screenshot asset path: ${url.pathname}`);
  }
  return url;
}

export function assertPublicBaseUrl(value: unknown): URL {
  const url = canonicalHttpsUrl(value, "R2_PUBLIC_BASE_URL");
  if (url.search || !safePublicBasePath(url.pathname)) {
    throw new Error("R2_PUBLIC_BASE_URL must not contain a query and may use only safe path segments.");
  }
  return url;
}

export function publicUrl(baseUrl: string | URL, key: string): string {
  const base = assertPublicBaseUrl(typeof baseUrl === "string" ? baseUrl : baseUrl.toString());
  const safeKey = assertSafeObjectKey(key, "public display object key");
  const url = new URL(base);
  const prefix = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${prefix}/${encodedKeyPath(safeKey)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function mediaId(gameId: string, collection: string, caption: string): string {
  const collectionSlug = slug(collection);
  const captionSlug = slug(caption);
  if (!collectionSlug || !captionSlug) throw new Error("Official collection and caption must produce a safe media ID.");
  return assertSafeId(`${gameId}-${collectionSlug}-${captionSlug}`, "media ID");
}

export function parseSourceConfig(value: unknown): SourceConfig {
  const config = asRecord(value, "media source config");
  const version = requiredString(config.version, "media source config version", 3);
  if (!/^[1-9][0-9]{0,2}$/.test(version)) throw new Error("media source config version must be a positive integer string.");
  const gameId = assertSafeId(config.gameId, "media source config gameId", 32);
  const collectionId = assertSafeId(config.collectionId, "media source config collectionId", 32);
  if (gameId !== GAME_ID || collectionId !== GAME_ID) throw new Error("This script only accepts the gta-vi game and collection IDs.");

  const sourcePageUrl = assertOfficialPageUrl(config.sourcePageUrl).toString();
  const assetPathPrefix = requiredString(config.assetPathPrefix, "media source config assetPathPrefix", 128);
  if (assetPathPrefix !== OFFICIAL_ASSET_PATH_PREFIX) throw new Error("media source config assetPathPrefix is not the approved Rockstar static media path.");
  const expectedMediaCount = boundedInteger(config.expectedMediaCount, "media source config expectedMediaCount", 1, 500);
  const attribution = displayText(config.attribution, "media source config attribution", 128);
  const workingDirectory = requiredString(config.workingDirectory, "media source config workingDirectory", 128);
  if (workingDirectory !== WORKING_DIRECTORY) throw new Error(`media source config workingDirectory must be ${WORKING_DIRECTORY}.`);
  const catalogPath = requiredString(config.catalogPath, "media source config catalogPath", 160);
  if (catalogPath !== `${WORKING_DIRECTORY}/catalog.json`) throw new Error("media source config catalogPath must remain inside the approved working directory.");
  const originalPrefix = assertSafeObjectKey(config.originalPrefix, "media source config originalPrefix");
  const displayPrefix = assertSafeObjectKey(config.displayPrefix, "media source config displayPrefix");
  if (originalPrefix !== `${GAME_ID}/originals` || displayPrefix !== `${GAME_ID}/display`) {
    throw new Error("media source config object prefixes must use the approved GTA VI namespaces.");
  }
  const catalogKey = assertSafeObjectKey(config.catalogKey, "media source config catalogKey");
  if (catalogKey !== `${GAME_ID}/catalogs/official-screenshots-v${version}.json`) {
    throw new Error("media source config catalogKey must use the approved immutable GTA VI catalog namespace.");
  }
  const requestsPerMinute = boundedInteger(config.requestsPerMinute, "media source config requestsPerMinute", 1, 60);

  return {
    version,
    gameId,
    collectionId,
    sourcePageUrl,
    expectedMediaCount,
    assetPathPrefix,
    attribution,
    workingDirectory,
    catalogPath,
    originalPrefix,
    displayPrefix,
    catalogKey,
    requestsPerMinute,
  };
}

function decodeFlightPayload(html: string): string {
  const parts: string[] = [];
  const scriptPattern = /self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g;
  for (const match of html.matchAll(scriptPattern)) {
    try {
      const frame: unknown = JSON.parse(match[1]);
      if (typeof frame === "string") parts.push(frame);
    } catch {
      // Ignore non-string Flight frames; screenshot records are string frames.
    }
  }
  return parts.join("");
}

function matchingBracket(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0) return index;
  }
  throw new Error("Could not locate the end of a Rockstar screenshot slide list.");
}

function officialCollectionHeading(flight: string, position: number): string {
  const context = flight.slice(Math.max(0, position - 20_000), position);
  const labels = [...context.matchAll(/"label":"([^"]*screenshots[^\"]*)"/gi)];
  const label = labels.at(-1)?.[1];
  if (!label) throw new Error("A screenshot slide list did not have an official collection heading.");
  return label.replace(/\s*\(as zip file\)\s*$/i, "").trim();
}

function absoluteAssetUrl(value: unknown, pageUrl: URL, config: SourceConfig): URL {
  const source = requiredString(value, "Rockstar screenshot slide URL", 2_048);
  let url: URL;
  try {
    url = new URL(source, pageUrl);
  } catch {
    throw new Error("A Rockstar screenshot slide had an invalid URL.");
  }
  return assertOfficialAssetUrl(url.toString(), config);
}

export function extractSlides(html: string, config: SourceConfig, pageUrl = assertOfficialPageUrl(config.sourcePageUrl)): Slide[] {
  const flight = decodeFlightPayload(html);
  if (!flight) throw new Error("Rockstar's page did not contain a readable Next.js Flight payload.");

  const slides: Slide[] = [];
  const marker = '"slides":[';
  let offset = 0;
  while (true) {
    const markerIndex = flight.indexOf(marker, offset);
    if (markerIndex === -1) break;
    const arrayStart = markerIndex + marker.length - 1;
    const arrayEnd = matchingBracket(flight, arrayStart);
    const collection = displayText(officialCollectionHeading(flight, markerIndex), "official screenshot collection", 160);
    let parsedSlides: unknown;
    try {
      parsedSlides = JSON.parse(flight.slice(arrayStart, arrayEnd + 1));
    } catch {
      throw new Error("A Rockstar screenshot slide list was not valid JSON.");
    }
    if (!Array.isArray(parsedSlides)) throw new Error("A Rockstar screenshot slide list was not an array.");
    for (const [index, value] of parsedSlides.entries()) {
      const slide = asRecord(value, `Rockstar screenshot slide ${index + 1}`);
      const thumbnail = asRecord(slide.thumbnail, `Rockstar screenshot slide ${index + 1} thumbnail`);
      const title = displayText(slide.title, `Rockstar screenshot slide ${index + 1} title`, 512);
      const dimensions = assertImageDimensions(thumbnail.width, thumbnail.height, `Rockstar screenshot slide ${index + 1}`);
      const sourceUrl = absoluteAssetUrl(thumbnail.src, pageUrl, config).toString();
      mediaId(config.gameId, collection, title);
      slides.push({ title, collection, sourceUrl, ...dimensions });
    }
    offset = arrayEnd + 1;
  }
  return slides;
}

function imageDimensions(width: number, height: number, contentType: ImageContentType, extension: string): Dimensions {
  return { ...assertImageDimensions(width, height, contentType), contentType, extension };
}

function equalBytes(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
}

function jpegDimensions(bytes: Uint8Array, view: DataView): Dimensions | null {
  let index = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (index < bytes.length) {
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    if (index >= bytes.length) break;
    const marker = bytes[index]!;
    index += 1;
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (index + 2 > bytes.length) break;
    const length = view.getUint16(index);
    if (length < 2 || index + length > bytes.length) throw new Error("Downloaded JPEG had an invalid segment length.");
    if (startOfFrameMarkers.has(marker)) {
      if (length < 8) throw new Error("Downloaded JPEG had an invalid frame header.");
      return imageDimensions(view.getUint16(index + 5), view.getUint16(index + 3), "image/jpeg", "jpg");
    }
    index += length;
  }
  return null;
}

export function contentTypeFromBytes(bytes: Uint8Array): Dimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && equalBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    && view.getUint32(8) === 13 && fourCC(bytes, 12) === "IHDR") {
    return imageDimensions(view.getUint32(16), view.getUint32(20), "image/png", "png");
  }
  if (bytes.length >= 20 && fourCC(bytes, 0) === "RIFF" && fourCC(bytes, 8) === "WEBP") {
    const riffSize = view.getUint32(4, true);
    if (riffSize + 8 > bytes.length) throw new Error("Downloaded WebP had an invalid RIFF length.");
    const chunkType = fourCC(bytes, 12);
    if (chunkType === "VP8X") {
      if (bytes.length < 30) throw new Error("Downloaded WebP had a truncated VP8X header.");
      return imageDimensions(1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16), "image/webp", "webp");
    }
    if (chunkType === "VP8L") {
      if (bytes.length < 25 || bytes[20] !== 0x2f) throw new Error("Downloaded WebP had an invalid VP8L header.");
      const packed = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
      return imageDimensions(1 + (packed & 0x3fff), 1 + ((packed >>> 14) & 0x3fff), "image/webp", "webp");
    }
    if (chunkType === "VP8 ") {
      if (bytes.length < 30 || !equalBytes(bytes, 23, [0x9d, 0x01, 0x2a])) throw new Error("Downloaded WebP had an invalid VP8 header.");
      return imageDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff, "image/webp", "webp");
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dimensions = jpegDimensions(bytes, view);
    if (dimensions) return dimensions;
  }
  throw new Error("Downloaded payload was not a supported JPEG, PNG, or WebP image with readable dimensions.");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function assertCatalogPublicUrl(value: unknown, displayKey: string, baseUrl?: string | URL): string {
  const raw = requiredString(value, "catalog publicUrl", 2_048);
  const url = canonicalHttpsUrl(raw, "catalog publicUrl");
  const expectedSuffix = `/${encodedKeyPath(displayKey)}`;
  if (!url.pathname.endsWith(expectedSuffix)) throw new Error("catalog publicUrl does not end with its encoded display key.");
  const basePath = url.pathname.slice(0, -expectedSuffix.length) || "/";
  if (url.search || !safePublicBasePath(basePath)) {
    throw new Error("catalog publicUrl must not contain a query and must use safe path segments.");
  }
  const expected = baseUrl ? publicUrl(baseUrl, displayKey) : undefined;
  if (expected && raw !== expected) throw new Error("catalog publicUrl does not match R2_PUBLIC_BASE_URL and displayKey.");
  if (raw !== url.toString()) throw new Error("catalog publicUrl must be canonical.");
  return raw;
}

export function parseCatalog(value: unknown, config: SourceConfig, baseUrl?: string | URL): Catalog {
  const catalog = asRecord(value, "media catalog");
  const version = requiredString(catalog.version, "catalog version", 3);
  if (version !== config.version) throw new Error("catalog version does not match media source config.");
  const collectionId = assertSafeId(catalog.collectionId, "catalog collectionId", 32);
  if (collectionId !== config.collectionId) throw new Error("catalog collectionId does not match media source config.");
  const generatedAt = readGeneratedAt(catalog.generatedAt);
  if (!Array.isArray(catalog.media) || catalog.media.length !== config.expectedMediaCount) {
    throw new Error(`catalog must contain exactly ${config.expectedMediaCount} media records.`);
  }

  const ids = new Set<string>();
  const sourceUrls = new Set<string>();
  const originalKeys = new Set<string>();
  const displayKeys = new Set<string>();
  const publicUrls = new Set<string>();
  const media = catalog.media.map((value, index): CatalogMedia => {
    const item = asRecord(value, `catalog media[${index}]`);
    const collection = displayText(item.collection, `catalog media[${index}].collection`, 160);
    const caption = displayText(item.caption, `catalog media[${index}].caption`, 512);
    const altText = displayText(item.altText, `catalog media[${index}].altText`, 512);
    if (altText !== caption) throw new Error(`catalog media[${index}].altText must match the source-derived caption.`);
    const id = assertSafeId(item.id, `catalog media[${index}].id`);
    if (id !== mediaId(config.gameId, collection, caption)) throw new Error(`catalog media[${index}].id does not match its collection and caption.`);
    const itemCollectionId = assertSafeId(item.collectionId, `catalog media[${index}].collectionId`, 32);
    if (itemCollectionId !== config.collectionId) throw new Error(`catalog media[${index}].collectionId does not match media source config.`);
    const attribution = displayText(item.attribution, `catalog media[${index}].attribution`, 128);
    if (attribution !== config.attribution) throw new Error(`catalog media[${index}].attribution does not match media source config.`);
    const sourceUrlRaw = requiredString(item.sourceUrl, `catalog media[${index}].sourceUrl`, 2_048);
    const sourceUrl = assertOfficialAssetUrl(sourceUrlRaw, config).toString();
    if (sourceUrlRaw !== sourceUrl) throw new Error(`catalog media[${index}].sourceUrl must be canonical.`);
    const sourcePageUrlRaw = requiredString(item.sourcePageUrl, `catalog media[${index}].sourcePageUrl`, 2_048);
    const sourcePageUrl = assertOfficialPageUrl(sourcePageUrlRaw).toString();
    if (sourcePageUrlRaw !== sourcePageUrl || sourcePageUrl !== config.sourcePageUrl) {
      throw new Error(`catalog media[${index}].sourcePageUrl does not match media source config.`);
    }
    const contentType = supportedImageContentType(item.contentType);
    const extension = extensionForContentType(contentType);
    const dimensions = assertImageDimensions(item.width, item.height, `catalog media[${index}]`);
    const checksum = assertChecksum(item.checksum, `catalog media[${index}].checksum`);
    const originalKey = assertSafeObjectKey(item.originalKey, `catalog media[${index}].originalKey`);
    const displayKey = assertSafeObjectKey(item.displayKey, `catalog media[${index}].displayKey`);
    if (originalKey !== mediaObjectKey(config.originalPrefix, id, checksum, extension) || displayKey !== mediaObjectKey(config.displayPrefix, id, checksum, extension)) {
      throw new Error(`catalog media[${index}] object keys do not match the approved media namespace.`);
    }
    const publicUrl = assertCatalogPublicUrl(item.publicUrl, displayKey, baseUrl);
    const tags = readStringArray(item.tags, `catalog media[${index}].tags`, 64);
    const spoilerTags = readStringArray(item.spoilerTags, `catalog media[${index}].spoilerTags`, 32);

    for (const [set, candidate, label] of [
      [ids, id, "id"],
      [sourceUrls, sourceUrl, "sourceUrl"],
      [originalKeys, originalKey, "originalKey"],
      [displayKeys, displayKey, "displayKey"],
      [publicUrls, publicUrl, "publicUrl"],
    ] as const) {
      if (set.has(candidate)) throw new Error(`catalog media[${index}] duplicates ${label}.`);
      set.add(candidate);
    }
    return {
      id,
      collectionId: itemCollectionId,
      collection,
      caption,
      altText,
      tags,
      spoilerTags,
      attribution,
      sourceUrl,
      sourcePageUrl,
      originalKey,
      displayKey,
      publicUrl,
      contentType,
      ...dimensions,
      checksum,
    };
  });

  return { version, collectionId, generatedAt, media };
}

function usage(): void {
  console.log("Usage: R2_PUBLIC_BASE_URL=https://media.example.com bun run media:sync [--dry-run]");
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return await Bun.file(path).json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${label}: ${message}`);
  }
}

function assertAssetResponseContentType(declared: string | null, dimensions: Dimensions, description: string): void {
  if (!declared || !(declared in CONTENT_TYPE_EXTENSIONS)) {
    throw new Error(`${description} did not declare a supported image Content-Type.`);
  }
  if (declared !== dimensions.contentType) {
    throw new Error(`${description} Content-Type ${declared} did not match its detected ${dimensions.contentType} bytes.`);
  }
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help")) {
    usage();
    return;
  }
  if ([...args].some((argument) => argument !== "--dry-run")) {
    usage();
    throw new Error("Unknown argument.");
  }

  const config = parseSourceConfig(await readJson(mediaSourcePath(process.env.GAMEINTEL_PROFILE ?? "gta-vi"), "media source config"));
  const page = await fetchBoundedOfficial(
    assertOfficialPageUrl(config.sourcePageUrl),
    (url) => assertOfficialPageUrl(url.toString()),
    MAX_PAGE_BYTES,
    "Rockstar screenshot page",
    { "user-agent": "gameintelgg/0.1 media catalog sync" },
    (response) => {
      if (!PAGE_CONTENT_TYPES.has(normalizedContentType(response) ?? "")) {
        throw new Error("Rockstar screenshot page did not declare an HTML Content-Type.");
      }
    },
  );
  const slides = extractSlides(new TextDecoder().decode(page.bytes), config, page.url);
  const uniqueSourceUrls = new Set(slides.map((slide) => slide.sourceUrl));
  const uniqueIds = new Set(slides.map((slide) => mediaId(config.gameId, slide.collection, slide.title)));
  if (slides.length !== config.expectedMediaCount || uniqueSourceUrls.size !== slides.length || uniqueIds.size !== slides.length) {
    throw new Error(`Expected ${config.expectedMediaCount} unique official screenshots; found ${slides.length} slide records, ${uniqueSourceUrls.size} unique URLs, and ${uniqueIds.size} unique IDs.`);
  }
  if (args.has("--dry-run")) {
    console.log(`Dry run: discovered and validated ${slides.length} official GTA VI screenshots. No files were written.`);
    return;
  }

  const publicBaseUrl = assertPublicBaseUrl(process.env.R2_PUBLIC_BASE_URL);
  const workingDirectory = resolve(config.workingDirectory);
  const originalsDirectory = resolve(workingDirectory, "originals");
  await mkdir(originalsDirectory, { recursive: true });
  const delayMs = Math.ceil(60_000 / config.requestsPerMinute);
  const media: CatalogMedia[] = [];
  for (const [index, slide] of slides.entries()) {
    if (index > 0) await Bun.sleep(delayMs);
    const asset = await fetchBoundedOfficial(
      assertOfficialAssetUrl(slide.sourceUrl, config),
      (url) => assertOfficialAssetUrl(url.toString(), config),
      MAX_IMAGE_BYTES,
      `Rockstar screenshot asset ${index + 1}/${slides.length}`,
      { "user-agent": "gameintelgg/0.1 media catalog sync", referer: page.url.toString() },
    );
    const dimensions = contentTypeFromBytes(asset.bytes);
    assertAssetResponseContentType(asset.contentType, dimensions, `Rockstar screenshot asset ${index + 1}/${slides.length}`);
    if (dimensions.width !== slide.width || dimensions.height !== slide.height) {
      throw new Error(`Asset dimensions did not match Rockstar's slide metadata for ${slide.title}: expected ${slide.width}x${slide.height}, got ${dimensions.width}x${dimensions.height}.`);
    }
    const checksum = await sha256(asset.bytes);
    const id = mediaId(config.gameId, slide.collection, slide.title);
    const originalKey = mediaObjectKey(config.originalPrefix, id, checksum, dimensions.extension);
    const displayKey = mediaObjectKey(config.displayPrefix, id, checksum, dimensions.extension);
    await Bun.write(resolve(originalsDirectory, `${id}.${dimensions.extension}`), asset.bytes);
    media.push({
      id,
      collectionId: config.collectionId,
      collection: slide.collection,
      caption: slide.title,
      altText: slide.title,
      tags: [
        "official",
        "screenshot",
        ...slug(slide.collection).split("-").filter(Boolean),
        ...slug(slide.title).split("-").filter((tag) => tag.length > 1 && !/^\d+$/.test(tag)),
      ],
      spoilerTags: [],
      attribution: config.attribution,
      sourceUrl: slide.sourceUrl,
      sourcePageUrl: config.sourcePageUrl,
      originalKey,
      displayKey,
      publicUrl: publicUrl(publicBaseUrl, displayKey),
      contentType: dimensions.contentType,
      width: dimensions.width,
      height: dimensions.height,
      checksum,
    });
    console.log(`Downloaded ${index + 1}/${slides.length}: ${slide.title}`);
  }

  const catalog = parseCatalog({
    version: config.version,
    collectionId: config.collectionId,
    generatedAt: new Date().toISOString(),
    media,
  }, config, publicBaseUrl);
  await Bun.write(resolve(config.catalogPath), `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${catalog.media.length} validated records to ${config.catalogPath}.`);
}

if (import.meta.main) await main();
