# Data And Code Rights

The repository code is licensed under MIT as described in `LICENSE`.

Fixtures, citations, source excerpts, generated publication artifacts, game
names, logos, and trademarks may have separate rights. Contributors must have
permission to add fixture content and must preserve provider attribution and
citation restrictions.

The code must not be used to host, mirror, embed, or directly link to leaked
game assets or other restricted source material.

## GTA VI Official Screenshot Catalog

`config/games/gta-vi/media-source.json` authorizes only the official Rockstar
page `https://www.rockstargames.com/VI/media/screenshots` for this catalog. The
sync command derives captions, collection labels, image URLs, and dimensions
from that page; it does not contain a copied asset list. Its local downloads and
catalog are intentionally ignored at `tmp/gta-vi-media/`.

Run `R2_PUBLIC_BASE_URL=https://media.example.com bun run media:gta-vi:sync` to
download and validate the page's expected 133 screenshots. The command follows
the configured two-requests-per-minute source limit. Use `--dry-run` to only
verify source discovery. The catalog preserves Rockstar attribution and source
URLs; publication remains subject to Rockstar's applicable terms and any
separate permission held for this project.

`bun run media:gta-vi:publish` is a no-network dry run. Add `--publish` and set
the R2 variables in `.env.example` to upload. Originals are stored only in
`R2_PRIVATE_BUCKET`; display objects go to the distinct public bucket. No image
transcoder is installed, so the public display object is the validated original
file with `display-original` metadata rather than a claimed derivative.
