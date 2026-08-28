import { defineConfig } from "astro/config";

const configuredSite = process.env.PUBLIC_BASE_URL;
const site = configuredSite ? new URL(configuredSite) : new URL("http://localhost:4321");
const releaseBuild = process.env.CI === "true" || process.env.GAMEINTEL_RELEASE === "true";

if (releaseBuild && (site.protocol !== "https:" || site.hostname === "localhost" || site.hostname === "127.0.0.1" || site.username || site.password)) {
  throw new Error("PUBLIC_BASE_URL must be a credential-free public HTTPS URL for CI and release builds");
}

export default defineConfig({
  site: site.toString(),
  output: "static",
});
