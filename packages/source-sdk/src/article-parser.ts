import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export type ParsedArticle = { title: string; text: string; excerpt: string; language: string | null };

export function parseArticleHtml(html: string): ParsedArticle {
  const { document } = parseHTML(html);
  for (const selector of ["script", "style", "noscript", "iframe", "object", "embed", "form"]) {
    for (const node of document.querySelectorAll(selector)) node.remove();
  }
  const parsed = new Readability(document as unknown as Document).parse();
  const text = (parsed?.textContent ?? document.body?.textContent ?? "").replaceAll(/\s+/g, " ").trim();
  if (!text) throw new Error("No readable article text found");
  const title = (parsed?.title ?? document.title ?? "Untitled source").replaceAll(/\s+/g, " ").trim().slice(0, 300);
  return { title, text: text.slice(0, 100_000), excerpt: text.slice(0, 4_000), language: document.documentElement.getAttribute("lang") };
}
