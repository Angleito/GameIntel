import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CollectionProfileSchema, PublicHttpUrlSchema, SourcePolicySchema, SourceStrengthSchema, PublicationModeSchema, type CollectionProfile } from "@gameintel/core";

const RegisteredDomainSchema = z.string().regex(
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
  "Expected a registrable hostname",
);

export const ProjectConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultProfileId: z.string().min(1),
  namespace: z.string().min(1),
  disclaimer: z.string().min(1),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const SourceRegistryEntrySchema = z.object({
  id: z.string(),
  domains: z.array(RegisteredDomainSchema),
  access: z.enum(["rss", "permitted_scrape", "official_api", "manual"]),
  rpm: z.number().nonnegative(),
  userAgent: z.string().optional(),
  source_strength: SourceStrengthSchema,
  publication_mode: PublicationModeSchema,
  public_citation_base: PublicHttpUrlSchema.optional(),
  enabled: z.boolean(),
}).superRefine((entry, context) => {
  if (entry.access !== "manual" && entry.domains.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["domains"], message: "Network sources require at least one registered domain" });
  }
});
export type SourceRegistryEntry = z.infer<typeof SourceRegistryEntrySchema>;

export const SourceRegistrySchema = z.object({ sources: z.array(SourceRegistryEntrySchema) });
export type SourceRegistry = z.infer<typeof SourceRegistrySchema>;

export async function loadProjectConfig(path: string | URL): Promise<ProjectConfig> {
  return ProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadCollectionProfile(path: string | URL): Promise<CollectionProfile> {
  return CollectionProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadSourceRegistry(path: string | URL): Promise<SourceRegistryEntry[]> {
  return SourceRegistrySchema.parse(parseYaml(await readFile(path, "utf8"))).sources;
}

export function profilePath(profileId = process.env.GAMEINTEL_PROFILE ?? "gta-vi"): URL {
  if (!/^[a-z0-9-]+$/.test(profileId)) throw new Error("Profile id must contain only lowercase letters, numbers, and hyphens");
  return new URL(`../../../config/games/${profileId}/profile.json`, import.meta.url);
}

export function sourceRegistryPath(profileId = process.env.GAMEINTEL_PROFILE ?? "gta-vi"): URL {
  if (!/^[a-z0-9-]+$/.test(profileId)) throw new Error("Profile id must contain only lowercase letters, numbers, and hyphens");
  return new URL(`../../../config/games/${profileId}/source-registry.yaml`, import.meta.url);
}

export function validateSourcePolicy(policy: unknown) {
  return SourcePolicySchema.parse(policy);
}
