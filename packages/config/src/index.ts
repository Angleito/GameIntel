import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  // Discovery turns a feed source into a queue of items: the scheduler runs
  // the adapter's discover() on the poll_url and enqueues each discovered
  // reference as its own ingestion job.
  discovery: z.object({
    adapter: z.literal("rss"),
    enabled: z.boolean(),
  }).optional(),
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
  if (entry.discovery !== undefined && entry.access !== "rss") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery"], message: "Discovery currently supports only rss sources" });
  }
  if (entry.access === "rss" && entry.discovery === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery"], message: "RSS sources require discovery configuration" });
  }
  if (entry.discovery !== undefined && entry.poll_interval_seconds === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["discovery"], message: "Discovery sources require a poll cadence" });
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

const MediaSlideSchema = z.object({
  url: z.string().min(1),
  caption: z.string().min(1),
  collection: z.string().min(1),
  attribution: z.string().min(1),
  focalPoint: z.string().optional().default("center center"),
  accent: z.string().regex(/^#[0-9a-f]{3,8}$/i),
  sourceUrl: PublicHttpUrlSchema,
});
export const MediaShowcaseSchema = z.object({
  profileId: z.string().min(1),
  label: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: PublicHttpUrlSchema,
  slides: z.array(MediaSlideSchema).min(1),
});
export type MediaShowcase = z.infer<typeof MediaShowcaseSchema>;

export async function loadMediaShowcase(path: string | URL): Promise<MediaShowcase> {
  return MediaShowcaseSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadProjectConfig(path: string | URL): Promise<ProjectConfig> {
  return ProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadCollectionProfile(path: string | URL): Promise<CollectionProfile> {
  return CollectionProfileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function loadSourceRegistry(path: string | URL): Promise<SourceRegistryEntry[]> {
  return SourceRegistrySchema.parse(parseYaml(await readFile(path, "utf8"))).sources;
}

const PROJECT_FILE = "config/project.json";
const PROFILE_ID_PATTERN = /^[a-z0-9-]+$/;

// The repository root is discovered once: first relative to this module
// (unbundled packages), then by walking up from the working directory (bundled
// output such as an Astro build). Profiles live under profiles/<profile-id>/;
// the default profile comes from configuration (GAMEINTEL_PROFILE or the
// project's defaultProfileId), never from a hard-coded game name.
let repoRoot: string | null = null;

function discoverRepoRoot(): string {
  if (repoRoot) return repoRoot;
  const moduleCandidate = fileURLToPath(new URL(`../../../${PROJECT_FILE}`, import.meta.url));
  if (existsSync(moduleCandidate)) {
    repoRoot = dirname(dirname(moduleCandidate));
    return repoRoot;
  }
  let current = process.cwd();
  while (true) {
    if (existsSync(join(current, PROJECT_FILE))) {
      repoRoot = current;
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate the repository root (config/project.json)");
}

function defaultProfileId(): string {
  const fromEnv = process.env.GAMEINTEL_PROFILE;
  if (fromEnv) return fromEnv;
  return ProjectConfigSchema.parse(JSON.parse(readFileSync(join(discoverRepoRoot(), PROJECT_FILE), "utf8"))).defaultProfileId;
}

function resolvedProfileId(profileId?: string): string {
  const resolved = profileId ?? defaultProfileId();
  if (!PROFILE_ID_PATTERN.test(resolved)) {
    throw new Error("Profile id must contain only lowercase letters, numbers, and hyphens");
  }
  return resolved;
}

function profileFile(profileId: string, name: string): URL {
  return new URL(`file://${join(discoverRepoRoot(), "profiles", profileId, name)}`);
}

export function profilePath(profileId?: string): URL {
  return profileFile(resolvedProfileId(profileId), "profile.json");
}

export function sourceRegistryPath(profileId?: string): URL {
  return profileFile(resolvedProfileId(profileId), "source-registry.yaml");
}

export function mediaSourcePath(profileId?: string): URL {
  return profileFile(resolvedProfileId(profileId), "media-source.json");
}
export function mediaShowcasePath(profileId?: string): URL {
  return profileFile(resolvedProfileId(profileId), "media-showcase.json");
}
