import { NormalizedSourceItemSchema, type InputKind, type NormalizedSourceItem } from "@gameintel/core";

export function createManualSourceItem(input: {
  sourceId: string;
  collectionId: string;
  title: string;
  text: string;
  citationUrl?: string | null;
  inputKind: Extract<InputKind, "pasted_text" | "local_file">;
}): NormalizedSourceItem {
  const text = input.text.replaceAll("\u0000", "").trim();
  if (!text) throw new Error("Manual source text cannot be empty");
  if (text.length > 100_000) throw new Error("Manual source text exceeds the 100 KB limit");
  const now = new Date().toISOString();
  return NormalizedSourceItemSchema.parse({
    sourceId: input.sourceId, collectionId: input.collectionId, externalId: `manual-${crypto.randomUUID()}`,
    url: `urn:gameintelgg:manual:${crypto.randomUUID()}`, title: input.title.slice(0, 300), text,
    sourceStrength: "UNVERIFIED", publicationMode: input.citationUrl ? "normal" : "discussion_only",
    discoveredAt: now, publishedAt: null, lineageId: null, inputKind: input.inputKind,
    contentType: "text/plain", language: null, claims: [],
  });
}
