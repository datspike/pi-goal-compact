import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, chmod, writeFile, unlink, realpath, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { artifactEntry, reconstructGoalArtifactRevisions } from "./state.js";
import { CUSTOM_ENTRY_TYPE, GOAL_ARTIFACT_NAMES, GOAL_MANAGED_ARTIFACT_NAMES, type GoalArtifactName, type GoalArtifactRef, type GoalManagedArtifactName, type SessionEntryLike, type ThreadGoal } from "./types.js";

const files: Record<GoalArtifactName, string> = {
  GOAL: "GOAL.md", CURRENT: "CURRENT.md", TIMELINE: "TIMELINE.md", DECISIONS: "DECISIONS.md", "CONTEXT-MAP": "CONTEXT-MAP.md", "PAPER-CUTS": "PAPER-CUTS.md",
};
const goalFileName = "GOAL.md";
/** Каталог документов цели внутри `.pi` проекта (решение 0007). */
const ARTIFACT_ROOT = "goal-compact";
/** Каталог `pi-codex-goal`: начатые в нём цели дописывают документ на прежнем месте, чтобы ссылки не ломались. */
const LEGACY_ARTIFACT_ROOT = "pohuy-goal";

function validGoalId(goalId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(goalId);
}

/** Корень документов цели: прежний каталог, если цель начата прежним расширением, иначе новый. */
function artifactRoot(cwd: string, goalId: string): string {
  const legacy = resolve(cwd, ".pi", LEGACY_ARTIFACT_ROOT);
  return existsSync(join(legacy, goalId)) ? LEGACY_ARTIFACT_ROOT : ARTIFACT_ROOT;
}

export function artifactDir(cwd: string, goalId: string): string {
  if (!validGoalId(goalId)) throw new Error("Invalid persisted goal id.");
  const root = resolve(cwd, ".pi", artifactRoot(cwd, goalId));
  const dir = resolve(root, goalId);
  const escaped = relative(root, dir);
  if (escaped.startsWith("..") || isAbsolute(escaped)) throw new Error("Goal artifact path escapes artifact root.");
  return dir;
}

export function artifactFilePath(cwd: string, goalId: string, artifact: GoalArtifactName): string {
  return join(artifactDir(cwd, goalId), files[artifact]);
}

export function goalFilePath(cwd: string, goalId: string): string {
  return join(artifactDir(cwd, goalId), goalFileName);
}

async function acquireArtifactLock(cwd: string, goalId: string): Promise<() => Promise<void>> {
  const lockPath = join(artifactDir(cwd, goalId), ".artifacts.lock");
  const ownerToken = randomUUID();
  const ownerPayload = JSON.stringify({ pid: process.pid, token: ownerToken });
  for (let attempt = 0; attempt < 3_000; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(ownerPayload, "utf8");
      return async () => {
        try {
          await handle.close();
        } finally {
          const current = await readFile(lockPath, "utf8").catch(() => null);
          if (current?.includes(ownerToken)) await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = await readFile(lockPath, "utf8").catch(() => null);
      if (current) {
        try {
          const owner = JSON.parse(current) as { pid?: unknown };
          if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid !== process.pid) {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") await unlink(lockPath).catch(() => undefined);
            }
          }
        } catch { /* An owner may be between creating and writing the lock payload. */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out acquiring the goal artifact lock.");
}

async function ensureSafeDirectory(cwd: string, goalId: string): Promise<string> {
  const cwdPath = resolve(cwd);
  const components = [
    join(cwdPath, ".pi"),
    join(cwdPath, ".pi", artifactRoot(cwdPath, goalId)),
    artifactDir(cwdPath, goalId),
  ];
  for (const path of components) {
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Multiple lifecycle barriers may bootstrap the same goal concurrently;
      // recursive mkdir makes the create-if-absent step race-safe, after which
      // lstat still enforces the symlink/type checks below.
      await mkdir(path, { mode: 0o700, recursive: true });
      info = await lstat(path);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Goal artifact path contains an unsafe existing directory component.");
    }
  }
  return components.at(-1)!;
}

async function assertSafeArtifactFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Goal artifact path contains an unsafe symbolic link.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function artifactFileUrl(path: string): string { return pathToFileURL(resolve(path)).href; }

export interface GoalObjectiveRef {
  goalId: string;
  path: string;
}

export interface GoalArtifactContext extends GoalArtifactBootstrapContext {
  cwd: string;
  sessionManager: { getBranch(): Iterable<SessionEntryLike> };
  /** Internal terminal projection writes only; public artifact writes stay closed. */
  allowTerminal?: boolean;
  /** Captured file content, checked under the lock before a managed replacement. */
  expectedContent?: string | null;
}

export interface GoalArtifactBootstrapContext {
  readonly cwd: string;
  /** Reject queued writes when their session branch has been replaced. */
  assertCurrent?: () => void;
}
type ArtifactDeps = Pick<ExtensionAPI, "appendEntry"> & { getCurrentGoal: () => ThreadGoal | null };

export function createGoalArtifacts(pi: ArtifactDeps) {
  let tail = Promise.resolve();
  const exclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolveRelease) => { release = resolveRelease; });
    await previous;
    try { return await operation(); } finally { release(); }
  };

  const bootstrapUnlocked = async (goal: ThreadGoal, ctx: GoalArtifactBootstrapContext & { managed?: boolean }): Promise<void> => {
    ctx.assertCurrent?.();
    const dir = await ensureSafeDirectory(ctx.cwd, goal.goalId);
    ctx.assertCurrent?.();
    const names = ctx.managed ? GOAL_MANAGED_ARTIFACT_NAMES : GOAL_ARTIFACT_NAMES;
    for (const name of names) {
      const path = join(dir, files[name]);
      await assertSafeArtifactFile(path);
      try { await readFile(path); } catch { ctx.assertCurrent?.(); await writeFile(path, "", { mode: 0o600, flag: "wx" }).catch(() => undefined); }
      await assertSafeArtifactFile(path);
    }
    try {
      const cwdPath = resolve(ctx.cwd);
      const gitDir = join(cwdPath, ".git");
      const infoDir = join(gitDir, "info");
      const excludePath = join(infoDir, "exclude");
      const gitInfo = await lstat(gitDir);
      const info = await lstat(infoDir);
      if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory() || info.isSymbolicLink() || !info.isDirectory()) return;

      // Only the canonical metadata path for this worktree is writable. In
      // particular, do not follow .git links or linked-worktree metadata.
      const canonicalCwd = await realpath(cwdPath);
      const canonicalGitDir = await realpath(gitDir);
      const canonicalInfoDir = await realpath(infoDir);
      if (canonicalGitDir !== join(canonicalCwd, ".git") || canonicalInfoDir !== join(canonicalGitDir, "info")) return;
      try {
        const exclude = await lstat(excludePath);
        if (exclude.isSymbolicLink() || !exclude.isFile()) return;
        if (await realpath(excludePath) !== join(canonicalInfoDir, "exclude")) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      const line = `.pi/${ARTIFACT_ROOT}/`;
      const current = await readFile(excludePath, "utf8").catch(() => "");
      if (!current.split(/\r?\n/).includes(line)) await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
    } catch { /* Git exclusion is best effort and fail-closed. */ }
  };
  const withArtifactLock = async <T>(goal: ThreadGoal, ctx: GoalArtifactBootstrapContext, operation: () => Promise<T>): Promise<T> => {
    await ensureSafeDirectory(ctx.cwd, goal.goalId);
    const releaseLock = await acquireArtifactLock(ctx.cwd, goal.goalId);
    try {
      return await operation();
    } finally {
      await releaseLock();
    }
  };
  const bootstrap = (goal: ThreadGoal, ctx: GoalArtifactBootstrapContext): Promise<void> => exclusive(() => withArtifactLock(goal, ctx, () => bootstrapUnlocked(goal, ctx)));
  const bootstrapManaged = (goal: ThreadGoal, ctx: GoalArtifactBootstrapContext): Promise<void> => exclusive(() => withArtifactLock(goal, ctx, () => bootstrapUnlocked(goal, { ...ctx, managed: true })));
  const syncObjective = (goal: ThreadGoal, ctx: GoalArtifactBootstrapContext): Promise<void> => exclusive(async () => {
    const path = goalFilePath(ctx.cwd, goal.goalId);
    await ensureSafeDirectory(ctx.cwd, goal.goalId);
    await assertSafeArtifactFile(path);
    const releaseLock = await acquireArtifactLock(ctx.cwd, goal.goalId);
    const content = `# Цель\n\n${goal.objective}\n`;
    try {
      const previousContent = await readFile(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (previousContent?.toString("utf8") === content) return;
      const actual = pi.getCurrentGoal();
      if (!actual || actual.goalId !== goal.goalId || actual.objective !== goal.objective) {
        throw new Error("Goal objective is no longer current.");
      }
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, { mode: 0o600 });
        await chmod(temp, 0o600);
        await rename(temp, path);
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (previousContent === null) {
          await unlink(path).catch((rollbackError: unknown) => {
            if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") throw rollbackError;
          });
        } else {
          const rollbackTemp = `${path}.${randomUUID()}.rollback.tmp`;
          try {
            await writeFile(rollbackTemp, previousContent, { mode: 0o600 });
            await chmod(rollbackTemp, 0o600);
            await rename(rollbackTemp, path);
          } finally {
            await unlink(rollbackTemp).catch(() => undefined);
          }
        }
        throw error;
      }
    } finally {
      await releaseLock();
    }
  });
  const objectiveRef = (goal: ThreadGoal, ctx: GoalArtifactContext): GoalObjectiveRef => ({
    goalId: goal.goalId,
    path: artifactFileUrl(goalFilePath(ctx.cwd, goal.goalId)),
  });
  const refs = (goal: ThreadGoal, ctx: GoalArtifactContext, entries: Iterable<SessionEntryLike>): GoalArtifactRef[] => {
    const revisions = reconstructGoalArtifactRevisions(entries, goal.goalId);
    return GOAL_ARTIFACT_NAMES.map((artifact) => ({ goalId: goal.goalId, artifact, revision: revisions[artifact], path: artifactFileUrl(artifactFilePath(ctx.cwd, goal.goalId, artifact)) }));
  };
  const write = (goal: ThreadGoal, artifact: GoalArtifactName, content: string, expectedRevision: number, ctx: GoalArtifactContext): Promise<GoalArtifactRef> => exclusive(async () => {
    const currentGoal = pi.getCurrentGoal;
    const path = artifactFilePath(ctx.cwd, goal.goalId, artifact);
    await ensureSafeDirectory(ctx.cwd, goal.goalId);
    await assertSafeArtifactFile(path);
    const releaseLock = await acquireArtifactLock(ctx.cwd, goal.goalId);
    try {
    const assertCurrent = (): ThreadGoal => {
      ctx.assertCurrent?.();
      const actual = currentGoal();
      if (!actual || actual.goalId !== goal.goalId || (actual.status !== "active" && actual.status !== "paused" && actual.status !== "budgetLimited" && !(actual.status === "complete" && ctx.allowTerminal === true))) throw new Error("Goal is no longer current and writable.");
      return actual;
    };
    const acceptAlreadyWritten = async (): Promise<GoalArtifactRef | null> => {
      const revision = reconstructGoalArtifactRevisions(ctx.sessionManager.getBranch(), goal.goalId)[artifact];
      if (revision === expectedRevision && expectedRevision === 0) return null;
      await ensureSafeDirectory(ctx.cwd, goal.goalId);
      await assertSafeArtifactFile(path);
      const existing = await readFile(path, "utf8").catch(() => null);
      if (existing === content) return { goalId: goal.goalId, artifact, revision, path: artifactFileUrl(path) };
      if (revision === expectedRevision) return null;
      throw new Error(`Stale artifact revision: expected ${expectedRevision}, current ${revision}.`);
    };
    assertCurrent();
    const alreadyWritten = await acceptAlreadyWritten();
    if (alreadyWritten) return alreadyWritten;
    // Managed projections must not bootstrap the retired CONTEXT-MAP file;
    // the explicit compatibility writer still uses the legacy bootstrap.
    await bootstrapUnlocked(goal, { ...ctx, managed: artifact !== "CONTEXT-MAP" });
    assertCurrent();
    const alreadyWrittenAfterBootstrap = await acceptAlreadyWritten();
    if (alreadyWrittenAfterBootstrap) return alreadyWrittenAfterBootstrap;
    await ensureSafeDirectory(ctx.cwd, goal.goalId);
    await assertSafeArtifactFile(path);
    const temp = `${path}.${randomUUID()}.tmp`;
    let previousContent: Buffer | null = null;
    try {
      previousContent = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let replaced = false;
    try {
      await writeFile(temp, content, { mode: 0o600 });
      await chmod(temp, 0o600);
      assertCurrent();
      if ("expectedContent" in ctx) {
        const observed = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
        if (observed !== ctx.expectedContent) throw new Error("Artifact changed after capture; synchronize again before writing.");
      }
      assertCurrent();
      await rename(temp, path);
      replaced = true;
      // A synchronous host transition cannot interleave this callback, but the
      // post-rename check keeps stale refs from being published after a reload.
      assertCurrent();
      const revision = expectedRevision + 1;
      pi.appendEntry(CUSTOM_ENTRY_TYPE, artifactEntry(goal.goalId, artifact, revision));
      return { goalId: goal.goalId, artifact, revision, path: artifactFileUrl(path) };
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      if (!replaced) throw error;
      try {
        if (previousContent === null) {
          await unlink(path).catch((rollbackError: unknown) => {
            if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") throw rollbackError;
          });
        } else {
          const rollbackTemp = `${path}.${randomUUID()}.rollback.tmp`;
          try {
            await writeFile(rollbackTemp, previousContent, { mode: 0o600 });
            await chmod(rollbackTemp, 0o600);
            await rename(rollbackTemp, path);
          } finally {
            await unlink(rollbackTemp).catch(() => undefined);
          }
        }
      } catch (rollbackError) {
        throw new Error(
          `Artifact write failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          { cause: rollbackError },
        );
      }
      throw error;
    }
    } finally {
      await releaseLock();
    }
  });
  const readExisting = async (goal: ThreadGoal, artifact: GoalArtifactName, ctx: GoalArtifactBootstrapContext): Promise<string | null> => {
    const path = artifactFilePath(ctx.cwd, goal.goalId, artifact);
    await ensureSafeDirectory(ctx.cwd, goal.goalId);
    await assertSafeArtifactFile(path);
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const managedRefs = (goal: ThreadGoal, ctx: GoalArtifactContext, entries: Iterable<SessionEntryLike>): GoalArtifactRef[] => {
    const all = refs(goal, ctx, entries);
    return all.filter((ref): ref is GoalArtifactRef & { artifact: GoalManagedArtifactName } =>
      (GOAL_MANAGED_ARTIFACT_NAMES as readonly string[]).includes(ref.artifact),
    );
  };
  return { bootstrap, bootstrapManaged, objectiveRef, readExisting, refs, managedRefs, syncObjective, withArtifactLock, write };
}
export type GoalArtifacts = ReturnType<typeof createGoalArtifacts>;
