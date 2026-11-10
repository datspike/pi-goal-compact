import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Diagnostic identity of the extension checkout, not the goal's working directory. */
export interface GoalRuntimeRevision {
  readonly gitCommit: string | null;
  readonly gitDirty: boolean | null;
  readonly capturedAt: string;
}

/** Capture bounded, best-effort Git metadata; packaged installs may have no repository. */
export function captureGoalRuntimeRevision(
  extensionRoot = fileURLToPath(new URL("../", import.meta.url)),
): Readonly<GoalRuntimeRevision> {
  const capturedAt = new Date().toISOString();
  let gitCommit: string | null = null;
  let gitDirty: boolean | null = null;
  // Do not mistake an enclosing user repository for the installed extension's Git tree.
  if (existsSync(join(extensionRoot, ".git"))) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const options = {
      cwd: extensionRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 500,
      maxBuffer: 64 * 1024,
    };
    try {
      const top = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
      if (realpathSync(top) === realpathSync(extensionRoot)) {
        const head = execFileSync("git", ["rev-parse", "--verify", "HEAD"], options).trim();
        if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) gitCommit = head;
      }
    } catch {
      // Diagnostics must not prevent the extension from loading or a goal from starting.
    }
    if (gitCommit !== null) {
      try {
        gitDirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], options).length > 0;
      } catch {
        // A known commit does not imply that the working tree was clean.
      }
    }
  }
  return Object.freeze({ gitCommit, gitDirty, capturedAt });
}

// A later checkout must not relabel code that is already loaded into this process.
export const loadedGoalRuntimeRevision = captureGoalRuntimeRevision();
