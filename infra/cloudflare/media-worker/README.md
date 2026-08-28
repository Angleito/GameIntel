# GameIntel media slideshow Worker

Serves `GET /api/media/gta-vi/slideshow` from a private R2 catalog. The response is a JSON array whose objects contain only:

```json
{
  "id": "media-id",
  "url": "https://media.example.com/gta-vi/image.webp",
  "caption": "Caption",
  "collection": "Official screenshots",
  "attribution": "Rockstar Games",
  "sourceUrl": "https://www.rockstargames.com/"
}
```

The immutable catalog is the approval boundary: publish only approved items to the R2 object configured by `MEDIA_CATALOG_KEY`. The Worker validates the complete catalog contract, but immediately discards private metadata such as R2 keys, checksums, tags, spoiler tags, alt text, and source-page URLs. It never fetches the catalog through a public URL.

Each UTC day, it computes `HMAC-SHA-256(DAILY_SHUFFLE_SECRET, "YYYY-MM-DD\\nCATALOG_VERSION\\ngta-vi")` and uses the signature as the seed for Fisher-Yates. The result is stable for every request that day, changes when the date or catalog version changes, and is cached through the next UTC midnight. Unsupported games, malformed catalogs, missing R2 objects, and missing configuration return a safe error response without catalog details.

## Setup

1. Replace the `MEDIA_BUCKET` bucket name and `MEDIA_CATALOG_KEY` placeholder in `wrangler.jsonc`. The key must be a non-empty, relative R2 key without `..` segments.
2. Install the package dependencies with `npm install` from this directory.
3. Set the production secret with `npx wrangler secret put DAILY_SHUFFLE_SECRET`.
4. Run `bun run test`, `bun run typecheck`, then deploy with `bun run deploy`.

The `publicUrl` values in the catalog must point at the separately configured custom media domain. This Worker does not create the custom domain, create the R2 bucket, upload the immutable catalog, or set the secret; those Cloudflare account resources must exist before deployment.
