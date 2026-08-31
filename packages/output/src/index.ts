import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AttributionTypeSchema, EvidenceLevelSchema, PublicHttpUrlSchema } from "@gameintel/core";
import { z } from "zod";

export const PublicArticleSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Expected a URL-safe article slug");

export const PublicFactSchema = z.object({
  text: z.string(),
  evidenceLevel: EvidenceLevelSchema,
  attributionType: AttributionTypeSchema,
  editorialAssessment: z.string().nullable(),
  citations: z.array(z.number().int().positive()),
}).strict();

export const PublicArticleSectionSchema = z.object({
  heading: z.string(),
  paragraphs: z.array(PublicFactSchema),
  publicSafe: z.literal(true),
  spoilerTags: z.array(z.string()).max(0),
}).strict();

export const PublicArticleBodySchema = z.object({
  summary: z.string(),
  sections: z.array(PublicArticleSectionSchema),
  unknowns: z.array(z.string()),
}).strict();

export const PublicCoverMediaSchema = z.object({
  id: z.string().min(1),
  caption: z.string(),
  altText: z.string(),
  collection: z.string(),
  attribution: z.string(),
  sourceUrl: PublicHttpUrlSchema,
  publicUrl: PublicHttpUrlSchema,
}).strict();

export const PublicCitationSchema = z.object({
  number: z.number().int().positive(),
  label: z.string(),
  url: PublicHttpUrlSchema,
}).strict();

export const PublicArticleSchema = z.object({
  id: z.string().min(1),
  collectionId: z.string().min(1),
  slug: PublicArticleSlugSchema,
  title: z.string().min(1),
  seoTitle: z.string().min(1),
  description: z.string().min(1),
  body: PublicArticleBodySchema,
  status: z.enum(["published", "updated"]),
  publishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime().nullable(),
  citations: z.array(PublicCitationSchema),
  coverMedia: PublicCoverMediaSchema.nullable().default(null),
}).strict().superRefine((article, context) => {
  const citationNumbers = new Set<number>();
  for (const citation of article.citations) {
    if (citationNumbers.has(citation.number)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["citations"], message: "Citation numbers must be unique" });
    }
    citationNumbers.add(citation.number);
  }
  for (const [sectionIndex, section] of article.body.sections.entries()) {
    for (const [factIndex, fact] of section.paragraphs.entries()) {
      for (const citationNumber of fact.citations) {
        if (!citationNumbers.has(citationNumber)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["body", "sections", sectionIndex, "paragraphs", factIndex, "citations"],
            message: "Facts may only reference declared citations",
          });
        }
      }
    }
  }
});
export type PublicArticle = z.infer<typeof PublicArticleSchema>;

export const OutputArtifactSchema = z.object({
  schemaVersion: z.string().min(1),
  generatedAt: z.string().datetime(),
  projectId: z.string().min(1),
  profileId: z.string().min(1),
  records: z.array(z.unknown()),
}).strict();
export type OutputArtifact = z.infer<typeof OutputArtifactSchema>;
export const PublicOutputArtifactSchema = OutputArtifactSchema.extend({
  records: z.array(PublicArticleSchema),
}).strict();
export type PublicOutputArtifact = z.infer<typeof PublicOutputArtifactSchema>;

export type OutputArtifactInput = Omit<OutputArtifact, "generatedAt" | "records"> & {
  generatedAt?: string;
  records: unknown[];
};
export type PublicOutputArtifactInput = Omit<PublicOutputArtifact, "generatedAt" | "records"> & {
  generatedAt?: string;
  records: unknown[];
};

export function createOutputArtifact(input: OutputArtifactInput): OutputArtifact {
  return OutputArtifactSchema.parse({ ...input, generatedAt: input.generatedAt ?? new Date().toISOString() });
}

export function createPublicOutputArtifact(input: PublicOutputArtifactInput): PublicOutputArtifact {
  return PublicOutputArtifactSchema.parse({ ...input, generatedAt: input.generatedAt ?? new Date().toISOString() });
}

export async function writeJsonArtifact(path: string | URL, artifact: OutputArtifact): Promise<void> {
  const filePath = path instanceof URL ? fileURLToPath(path) : path;
  const publicArtifact = OutputArtifactSchema.parse(artifact);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(publicArtifact, null, 2)}\n`);
}
