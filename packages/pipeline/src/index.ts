import {
  CLAIM_EXTRACTOR_VERSION,
  NormalizedSourceItemSchema,
  dispositionFor,
  hashText,
  lineageFor,
  scoreNewsworthiness,
  type NormalizedSourceItem,
  type ScoreInput,
} from "@gameintel/core";
import { extractClaims } from "./extract.ts";

export type PreparedIngestion = {
  item: NormalizedSourceItem;
  rawHash: string;
  lineageId: string;
  newsworthiness: number;
  disposition: ReturnType<typeof dispositionFor>;
};

export function prepareIngestion(
  input: unknown,
  scoring: ScoreInput,
  existingArticleId: string | null = null,
): PreparedIngestion {
  const item = NormalizedSourceItemSchema.parse(input);
  const rawHash = hashText(`${item.title}\n${item.text}`);
  const lineageId = lineageFor(item);
  const newsworthiness = scoreNewsworthiness(scoring);
  return { item, rawHash, lineageId, newsworthiness, disposition: dispositionFor(newsworthiness, existingArticleId) };
}

export { CLAIM_EXTRACTOR_VERSION, extractClaims };