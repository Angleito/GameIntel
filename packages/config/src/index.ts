import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  CollectionProfileSchema,
  EvidenceReviewPolicySchema,
  PublicHttpUrlSchema,
  SourcePolicySchema,
  SourceStrengthSchema,
  PublicationModeSchema,
  type CollectionProfile,
} from "@gameintel/core";

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
  // The scheduler revisits enabled network sources on this cadence. Pacing
  // (how often a request is actually allowed) is separate and governed by rpm.
  poll_interval_seconds: z.number().int().positive().optional(),
  // The exact endpoint the scheduler polls. Distinct from
  // public_citation_base, which is what readers may cite. Must belong to a
  // registered domain; network sources without this field cannot be polled.
  poll_url: PublicHttpUrlSchema.optional(),
  source_strength: SourceStrengthSchema,
  publication_mode: PublicationModeSchema,
  evidence_review: EvidenceReviewPolicySchema.optional(),
  public_citation_base: PublicHttpUrlSchema.optional(),
  terms_reviewed_at: z.string().nullable().optional(),
  retain_raw_text_days: z.number().nonnegative().optional(),
  may_store_full_text: z.boolean().optional(),
  enabled: z.boolean(),
}).superRefine((entry, context) => {
  if (entry.access !== "manual" && entry.domains.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["domains"], message: "Network sources require at least one registered domain" });
  }
  if (entry.access === "manual" && entry.poll_interval_seconds !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["poll_interval_seconds"], message: "Manual sources are event-driven and cannot be polled" });
  }
  if (entry.access === "manual" && entry.poll_url !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["poll_url"], message: "Manual sources are event-driven and cannot be polled" });
  }
  if (entry.poll_interval_seconds !== undefined && entry.poll_url === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["poll_url"], message: "Pollable sources require an explicit poll_url" });
  }
  if (entry.poll_url !== undefined && entry.access !== "manual") {
    let hostname: string;
    try {
      hostname = new URL(entry.poll_url).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    const allowed = entry.domains.some((domain) => {
      const registered = domain.toLowerCase();
      return registered.includes(".") && (hostname === registered || hostname.endsWith(`.${registered}`));
    });
    if (!allowed) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["poll_url"], message: "poll_url must belong to a registered domain" });
    }
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
