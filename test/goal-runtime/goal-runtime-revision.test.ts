import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { captureGoalRuntimeRevision, loadedGoalRuntimeRevision } from "../../src/goal/goal-runtime-revision.js";
import { createGoalPersistence } from "../../src/goal/goal-persistence.js";
import { reconstructGoal } from "../../src/goal/state.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t: TestContext): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "goal-revision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  writeFileSync(join(root, "source.txt"), "initial\n");
  git(root, "add", "source.txt");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial");
  return { root, commit: git(root, "rev-parse", "HEAD") };
}

test("revision identifies its own clean checkout and stays immutable after edits", (t) => {
  const { root, commit } = fixture(t);
  const revision = captureGoalRuntimeRevision(root);
  assert.equal(revision.gitCommit, commit);
  assert.equal(revision.gitDirty, false);
  assert.ok(Number.isFinite(Date.parse(revision.capturedAt)));
  assert.equal(Object.isFrozen(revision), true);
  writeFileSync(join(root, "source.txt"), "changed\n");
  assert.equal(captureGoalRuntimeRevision(root).gitDirty, true);
  assert.equal(revision.gitDirty, false);
  assert.deepEqual(Object.keys(revision).sort(), ["capturedAt", "gitCommit", "gitDirty"]);
});

test("an untracked source file marks the checkout dirty", (t) => {
  const { root } = fixture(t);
  writeFileSync(join(root, "new-source.txt"), "new\n");
  assert.equal(captureGoalRuntimeRevision(root).gitDirty, true);
});

test("a packaged install cannot inherit a surrounding user repository", (t) => {
  const { root } = fixture(t);
  const installed = join(root, "node_modules", "extension");
  mkdirSync(installed, { recursive: true });
  const revision = captureGoalRuntimeRevision(installed);
  assert.equal(revision.gitCommit, null);
  assert.equal(revision.gitDirty, null);
});

test("a broken Git checkout is diagnostic unknown, not a load failure", (t) => {
  const { root } = fixture(t);
  const broken = join(root, "broken");
  mkdirSync(join(broken, ".git"), { recursive: true });
  const revision = captureGoalRuntimeRevision(broken);
  assert.equal(revision.gitCommit, null);
  assert.equal(revision.gitDirty, null);
});

test("worktree Git files and inherited Git variables resolve the extension, not another checkout", (t) => {
  const { root, commit } = fixture(t);
  const other = fixture(t);
  writeFileSync(join(other.root, "source.txt"), "different repository\n");
  git(other.root, "add", "source.txt");
  git(other.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "different");
  const worktree = join(root, "checkout");
  git(root, "worktree", "add", "-q", "--detach", worktree, commit);
  const original = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other.root, ".git");
  try {
    const revision = captureGoalRuntimeRevision(worktree);
    assert.equal(revision.gitCommit, commit);
    assert.equal(revision.gitDirty, false);
  } finally {
    if (original === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = original;
  }
});

test("create_goal persists the loaded revision once per new goal, without exposing it to the model DTO", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "First diagnostic goal" });
  const firstId = harness.snapshot().goal!.goalId;
  const revisions = () => harness.entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE && "extensionRevision" in (entry.data as object));
  assert.equal(revisions().length, 1);
  const first = revisions()[0]!;
  const data = first.type === "custom" ? first.data as { goal: { goalId: string }; extensionRevision: unknown } : null;
  assert.equal(data?.goal.goalId, firstId);
  assert.deepEqual(data?.extensionRevision, loadedGoalRuntimeRevision);
  await harness.runCommand("pause");
  await harness.reloadSession("reload");
  await harness.runCommand("resume");
  await harness.runTool("amend_goal", { amendment: "Retain the same objective and diagnostic identity." });
  assert.equal(revisions().length, 1);
  const state = await harness.runTool("get_goal", {}) as { details: Record<string, unknown> };
  assert.equal("extensionRevision" in state.details, false);
  await harness.runTool("create_goal", { objective: "Replacement diagnostic goal", replace_existing: true });
  assert.equal(revisions().length, 2);
  assert.notEqual(harness.snapshot().goal!.goalId, firstId);
  assert.equal(reconstructGoal(harness.entries).goal!.goalId, harness.snapshot().goal!.goalId);
});

test("legacy restored goals are not relabelled with today's revision", () => {
  const saved = { goalId: "legacy", objective: "Old goal", status: "active" as const, tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 0 }, createdAt: 1, updatedAt: 1 };
  const entries: unknown[] = [];
  const persistence = createGoalPersistence({ pi: { appendEntry: (_type, data) => { entries.push(data); } } });
  persistence.setGoalSnapshot(saved);
  persistence.syncPersistedSnapshot(saved);
  persistence.setGoalSnapshot({ ...saved, updatedAt: 2 });
  persistence.flushGoalPersistence("tool");
  assert.equal(entries.length, 1);
  assert.equal("extensionRevision" in (entries[0] as object), false);
});
