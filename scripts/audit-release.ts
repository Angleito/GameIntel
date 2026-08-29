import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PublicOutputArtifactSchema } from "@gameintel/output";

type Finding = { path: string; rule: string };
const decoder = new TextDecoder();
const maxTextFileBytes = 10 * 1024 * 1024;

function git(args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Git command failed");
  return decoder.decode(result.stdout);
}

function isLockfile(path: string): boolean {
  return /(?:^|\/)(?:bun\.lock(?:b)?|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path);
}

function isText(path: string): boolean {
  return isLockfile(path)
    || /\.(?:cjs|css|csv|env|example|html|ini|js|json|jsonc|lock|md|mjs|mts|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i.test(path)
    || !path.includes(".");
}

function isEnvironmentTemplate(path: string): boolean {
  return path.endsWith(".env.example") || path.endsWith(".dev.vars.example");
}

function pathFinding(path: string): Finding | null {
  if (/(^|\/)\.env(?:\.|$)/.test(path) && !isEnvironmentTemplate(path)) return { path, rule: "environment file is release-visible" };
  if (/(^|\/)\.dev\.vars(?:\.|$)/.test(path) && !isEnvironmentTemplate(path)) return { path, rule: "Wrangler development secret file is release-visible" };
  if (/(^|\/)\.wrangler(?:\/|$)/.test(path)) return { path, rule: "Wrangler local state is release-visible" };
  if (/(^|\/)(?:node_modules|\.astro|\.next|\.svelte-kit|dist|build|out|coverage|tmp)(\/|$)/.test(path)) return { path, rule: "generated or dependency directory is release-visible" };
  if (path === "apps/web/src/data/publication.json") return { path, rule: "generated publication artifact is release-visible" };
  if (/\.(?:sqlite3?|db|dump|bak|sql\.gz|pem|key|p12|pfx)$/i.test(path)) return { path, rule: "database, backup, or certificate file is release-visible" };
  return null;
}

const patterns: Array<{ rule: string; expression: RegExp }> = [
  { rule: "private key material", expression: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { rule: "GitHub access token", expression: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { rule: "OpenAI-style API key", expression: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { rule: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "literal bearer token", expression: /\bBearer\s+[A-Za-z0-9._~-]{20,}/gi },
  { rule: "credentialed database URL", expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s]+@[^\s/]+/gi },
  { rule: "credentialed URL", expression: /\bhttps?:\/\/[^:\s/]+:[^@\s]+@[^\s/]+/gi },
];

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().replace(/^["'`]+|["'`,;]+$/g, "").toLowerCase();
  return !normalized
    || normalized === "..."
    || normalized.includes("${")
    || /^<[^>]+>$/.test(normalized)
    || /(?:^|[^a-z0-9])(?:change(?:[-_ ]?me)?|replace|placeholder|redacted|example|dummy|sample|your)(?:[^a-z0-9]|$)/i.test(normalized);
}

const namedSecretAssignment = /(?:^|[\n,])[ \t]*["']?(?:APP_DATABASE_PASSWORD|AWS_SECRET_ACCESS_KEY|CF_API_TOKEN|CLOUDFLARE_API_KEY|CLOUDFLARE_API_TOKEN|DAILY_SHUFFLE_SECRET|DATABASE_PASSWORD|GITHUB_TOKEN|LOCAL_OPERATOR_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|OPENCODE_PASSWORD|POSTGRES_PASSWORD|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|SUBMISSION_IDENTITY_SECRET|SUPADATA_API_KEY)["']?[ \t]*(?:=|:)[ \t]*(?:["']([^"'\r\n]*)["']|([^\s,#}\r\n]+))/gim;

function isConfigurationText(path: string): boolean {
  return /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:json|jsonc|yaml|yml))$/i.test(path);
}

function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const { rule, expression } of patterns) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      if (isPlaceholder(match[0])) continue;
      findings.push({ path, rule });
    }
  }
  if (isConfigurationText(path)) {
    namedSecretAssignment.lastIndex = 0;
    for (const match of text.matchAll(namedSecretAssignment)) {
      const value = match[1] ?? match[2] ?? "";
      if (!isPlaceholder(value)) findings.push({ path, rule: "named secret assignment" });
    }
  }
  return findings;
}

function isSafeCandidatePath(path: string): boolean {
  return Boolean(path)
    && !isAbsolute(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..");
}

async function scanCandidate(path: string): Promise<Finding[]> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return [{ path, rule: "symbolic link cannot be scanned safely" }];
    if (!metadata.isFile()) return [{ path, rule: "release candidate is not a regular file" }];
    if (!isText(path)) return [];
    if (metadata.size > maxTextFileBytes) return [{ path, rule: "text release candidate exceeds scan size limit" }];
    const text = await readFile(path, "utf8");
    if (text.includes("\0")) return [{ path, rule: "expected text release candidate contains binary data" }];
    return scanText(path, text);
  } catch {
    return [{ path, rule: "release candidate could not be scanned safely" }];
  }
}

async function scanPublicationArtifact(path: string): Promise<Finding[]> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return [{ path, rule: "publication artifact is not a regular file" }];
    if (metadata.size > maxTextFileBytes) return [{ path, rule: "publication artifact exceeds scan size limit" }];
    const text = await readFile(path, "utf8");
    const findings = scanText(path, text);
    try {
      PublicOutputArtifactSchema.parse(JSON.parse(text));
    } catch {
      findings.push({ path, rule: "publication artifact is not valid strict public output" });
    }
    return findings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ path, rule: "publication artifact could not be scanned safely" }];
  }
}

async function scanGeneratedDirectory(path: string): Promise<Finding[]> {
  try {
    const findings: Finding[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const entryPath = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        findings.push({ path: entryPath, rule: "generated output contains a symbolic link" });
      } else if (entry.isDirectory()) {
        findings.push(...await scanGeneratedDirectory(entryPath));
      } else if (entry.isFile() && isText(entryPath)) {
        const metadata = await lstat(entryPath);
        if (metadata.size > maxTextFileBytes) {
          findings.push({ path: entryPath, rule: "generated text output exceeds scan size limit" });
          continue;
        }
        const text = await readFile(entryPath, "utf8");
        findings.push(...scanText(entryPath, text));
        if (/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(text)) {
          findings.push({ path: entryPath, rule: "generated public output references a local URL" });
        }
      }
    }
    return findings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ path, rule: "generated output could not be scanned safely" }];
  }
}

function isIgnored(path: string): boolean {
  return Bun.spawnSync({ cmd: ["git", "check-ignore", "--no-index", "-q", "--", path], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

async function main(): Promise<void> {
  try {
    git(["rev-parse", "--is-inside-work-tree"]);
  } catch {
    console.error("Release audit requires a Git worktree. Initialize Git before preparing a public release.");
    process.exit(1);
  }

  const expectedIgnored = [
    ".env",
    ".env.local",
    ".env.production",
    ".dev.vars",
    ".dev.vars.local",
    ".wrangler/state/v3",
    "infra/cloudflare/media-worker/.dev.vars",
    "infra/cloudflare/media-worker/.wrangler/state/v3",
    "tmp/release-check.json",
    "apps/web/dist/index.html",
    "apps/web/src/data/publication.json",
  ];
  const findings: Finding[] = [];
  for (const path of expectedIgnored) {
    if (!isIgnored(path)) findings.push({ path, rule: "expected local file is not ignored" });
  }
  if (isIgnored(".env.example")) findings.push({ path: ".env.example", rule: "environment template must remain release-visible" });

  let paths: string[];
  try {
    paths = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean))];
  } catch {
    console.error("Release audit failed: Git release candidates could not be inspected safely.");
    process.exit(1);
  }

  for (const path of paths) {
    if (!isSafeCandidatePath(path)) {
      findings.push({ path, rule: "unsafe Git release candidate path" });
      continue;
    }
    const finding = pathFinding(path);
    if (finding) {
      findings.push(finding);
      continue;
    }
    findings.push(...await scanCandidate(path));
  }
  findings.push(...await scanPublicationArtifact("apps/web/src/data/publication.json"));
  if (process.env.GAMEINTEL_RELEASE === "true") {
    findings.push(...await scanGeneratedDirectory("apps/web/dist"));
  }

  const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.path}\0${finding.rule}`, finding])).values()];
  if (uniqueFindings.length) {
    console.error("Release audit failed. Findings report paths and rules only:");
    for (const finding of uniqueFindings) console.error(`- ${finding.path}: ${finding.rule}`);
    process.exit(1);
  }

  console.log(`Release audit passed for ${paths.length} Git release candidate file(s).`);
}

void main().catch(() => {
  console.error("Release audit failed: Git release candidates could not be inspected safely.");
  process.exit(1);
});
