import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL("sitemap.xml", site ?? "http://localhost:4321")}`, {
  headers: { "Content-Type": "text/plain; charset=utf-8" },
});
