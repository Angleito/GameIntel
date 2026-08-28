export interface SlideshowItem {
  id: string;
  url: string;
  caption: string;
  collection: string;
  attribution: string;
  sourceUrl: string;
}

export interface MediaCatalog {
  version: string;
  collectionId: string;
  generatedAt: string;
  media: SlideshowItem[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPublicHttpUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseMediaItem(value: unknown, collectionId: string): SlideshowItem | null {
  if (!isRecord(value)) return null;

  // Validate every catalog-contract field, including fields intentionally omitted
  // from the public response, before accepting an item.
  if (
    !isNonEmptyString(value.id) ||
    value.collectionId !== collectionId ||
    !isString(value.collection) ||
    !isString(value.caption) ||
    !isString(value.altText) ||
    !isStringArray(value.tags) ||
    !isStringArray(value.spoilerTags) ||
    !isString(value.attribution) ||
    !isPublicHttpUrl(value.sourceUrl) ||
    !isPublicHttpUrl(value.sourcePageUrl) ||
    !isString(value.originalKey) ||
    !isString(value.displayKey) ||
    !isPublicHttpUrl(value.publicUrl) ||
    !isString(value.contentType) ||
    !isPositiveInteger(value.width) ||
    !isPositiveInteger(value.height) ||
    !isNonEmptyString(value.checksum)
  ) {
    return null;
  }

  return {
    id: value.id,
    url: value.publicUrl,
    caption: value.caption,
    collection: value.collection,
    attribution: value.attribution,
    sourceUrl: value.sourceUrl,
  };
}

export function parseMediaCatalog(value: unknown): MediaCatalog | null {
  if (!isRecord(value)) return null;

  const version = value.version;
  const collectionId = value.collectionId;
  const generatedAt = value.generatedAt;
  const catalogMedia = value.media;

  if (
    !isNonEmptyString(version) ||
    !isNonEmptyString(collectionId) ||
    !isNonEmptyString(generatedAt) ||
    Number.isNaN(Date.parse(generatedAt)) ||
    !Array.isArray(catalogMedia)
  ) {
    return null;
  }

  const media = catalogMedia.map((item) => parseMediaItem(item, collectionId));
  if (media.some((item) => item === null)) return null;

  return {
    version,
    collectionId,
    generatedAt,
    media: media as SlideshowItem[],
  };
}

export function isSafeR2Key(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !value.startsWith("/")
    && value.split("/").every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part) && part !== "." && part !== "..");
}
