/**
 * Publishes a validated local GTA VI media catalog to Cloudflare R2. It is a
 * dry run unless --publish is present; originals and display objects must use
 * separate buckets. This tooling is profile-local: it lives under
 * profiles/gta-vi/ and its constants describe the GTA VI media source only.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { mediaSourcePath } from "@gameintel/config";
import { assertBucket, R2Client } from "@gameintel/r2";
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
} from "./sync-media.ts";

function usage(): void {
  console.log("Usage: bun run media:publish [--publish]");
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
  const configured = process.env.MEDIA_CATALOG_PATH;
  return pathInside(config.workingDirectory, resolve(configured ?? config.catalogPath), "Media catalog path");
}

function catalogKey(config: SourceConfig): string {
  const key = assertSafeObjectKey(process.env.R2_MEDIA_CATALOG_KEY ?? config.catalogKey, "R2 media catalog key");
  if (!key.startsWith("gta-vi/catalogs/") || !key.endsWith(".json")) throw new Error("R2 media catalog key must remain in the GTA VI catalog namespace.");
  return key;
}

async function loadCatalog(config: SourceConfig, requirePublicBase = false): Promise<Catalog> {
  const path = catalogPath(config);
  if (!await Bun.file(path).exists()) throw new Error(`Catalog not found: ${path}. Run media:sync first.`);
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

  const config = parseSourceConfig(await Bun.file(mediaSourcePath(process.env.GAMEINTEL_PROFILE ?? "gta-vi")).json());
  if (!args.has("--publish")) {
    const path = catalogPath(config);
    if (!await Bun.file(path).exists()) {
      console.log(`Dry run: catalog not found at ${path}; run media:sync before publishing.`);
      return;
    }
    const catalog = await loadCatalog(config);
    console.log(`Dry run: validated ${catalog.media.length} original/display object pairs from ${path}. Pass --publish to upload.`);
    return;
  }

  const catalog = await loadCatalog(config, true);
  const accountId = requiredEnvironment("R2_ACCOUNT_ID");
  const accessKeyId = requiredEnvironment("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnvironment("R2_SECRET_ACCESS_KEY");
  const privateBucket = assertBucket(requiredEnvironment("R2_PRIVATE_BUCKET"), "R2_PRIVATE_BUCKET");
  const publicBucket = assertBucket(requiredEnvironment("R2_PUBLIC_BUCKET"), "R2_PUBLIC_BUCKET");
  if (privateBucket === publicBucket) throw new Error("R2_PRIVATE_BUCKET and R2_PUBLIC_BUCKET must differ so originals remain private.");
  const client = new R2Client({ accountId, accessKeyId, secretAccessKey, endpoint: process.env.R2_ENDPOINT });

  const objectMatches = async (bucket: string, key: string, checksum: string): Promise<boolean> => {
    const head = await client.headObject(bucket, key);
    return head.exists && head.checksum === checksum;
  };

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
      { bucket: privateBucket, key: item.originalKey, variant: "original" as const },
      { bucket: publicBucket, key: item.displayKey, variant: "display-original" as const },
    ];
    for (const object of objects) {
      if (await objectMatches(object.bucket, object.key, item.checksum)) {
        skipped += 1;
        continue;
      }
      await client.putObject(object.bucket, object.key, bytes, {
        contentType: item.contentType,
        metadata: { sha256: item.checksum, variant: object.variant },
      });
      uploaded += 1;
    }
    console.log(`Published ${item.id}`);
  }

  const serializedCatalog = new TextEncoder().encode(`${JSON.stringify(catalog)}\n`);
  const catalogChecksum = await sha256(serializedCatalog);
  const key = catalogKey(config);
  if (await objectMatches(privateBucket, key, catalogChecksum)) {
    skipped += 1;
  } else {
    await client.putObject(privateBucket, key, serializedCatalog, {
      contentType: "application/json; charset=utf-8",
      metadata: { sha256: catalogChecksum, variant: "approved-media-catalog" },
    });
    uploaded += 1;
  }
  console.log(`R2 publish complete: ${uploaded} uploaded, ${skipped} already current.`);
}

if (import.meta.main) await main();
