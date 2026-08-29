// Repository cleanliness gate: a release-ready worktree must have no tracked
// modifications and no untracked files (ignored files such as .env, dist, and
// generated publication artifacts are fine). This is intentionally strict:
// the release gate is the point where a meaningful public push, tag, or
// release happens.
const decoder = new TextDecoder();

function git(args: string[]): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync({ cmd: ["git", ...args], stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode ?? 1, stdout: decoder.decode(result.stdout) };
}

const status = git(["status", "--porcelain", "--untracked-files=all"]);
if (status.exitCode !== 0) {
  console.error("Repository cleanliness check failed: Git could not report worktree status.");
  process.exit(1);
}

const lines = status.stdout.split("\n").filter(Boolean);
if (lines.length) {
  console.error("Repository cleanliness check failed. Commit or remove these changes before release:");
  for (const line of lines) console.error(`- ${line.trim()}`);
  process.exit(1);
}

console.log("Repository cleanliness check passed: no tracked modifications or untracked files.");