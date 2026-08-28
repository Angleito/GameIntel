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
  const items = publication.records.map((article) => `<item><title>${xml(article.title)}</title><link>${xml(new URL(`/articles/${article.slug}/`, base))}</link><description>${xml(article.description)}</description><guid>${xml(article.id)}</guid></item>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>GameIntel</title><link>${xml(base)}</link><description>Evidence-aware source ingestion and game intelligence.</description>${items}</channel></rss>`, {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
};
