import { readFile } from "node:fs/promises";
import { z } from "zod";
import { NormalizedSourceItemSchema, SourceSchema } from "@gameintel/core";
import type { Fixture } from "@gameintel/source-sdk";

export const FixtureSchema = z.object({
  source: SourceSchema,
  item: NormalizedSourceItemSchema.omit({ sourceId: true }),
}).strict();

export async function loadFixture(path: string): Promise<Fixture> {
  return FixtureSchema.parse(JSON.parse(await readFile(path, "utf8"))) as Fixture;
}
