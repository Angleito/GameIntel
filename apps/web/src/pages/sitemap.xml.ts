import type { APIRoute } from "astro";
import publication from "../data/publication";

function xml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export const GET: APIRoute = ({ site }) => {
  const base = site ?? new URL("http://localhost:4321");
  const paths = ["/", "/games/gta-vi/", "/editorial-policy/", "/source-policy/", ...publication.records.map((article) => `/articles/${article.slug}/`)];
  const body = paths.map((path) => `<url><loc>${xml(new URL(path, base))}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
