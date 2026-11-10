import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGoalArtifacts, artifactDir, artifactFilePath, artifactFileUrl, goalFilePath, type GoalArtifactContext } from "../../src/goal/goal-artifacts.js";
import { createGoalProgressEntryComponent, formatGoalProgressReport } from "../../src/goal/goal-reports.js";
import { createThreadGoal } from "../../src/goal/state.js";

function ctx(cwd: string, branch: Array<import("../../src/goal/types.js").SessionEntryLike>) {
  return { cwd, sessionManager: { getBranch: () => branch } } satisfies GoalArtifactContext;
}

test("goal artifacts serialize concurrent compare-and-swap writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    const goal = createThreadGoal("test");
    const artifacts = createGoalArtifacts({ appendEntry: (_type, data) => entries.push({ type: "custom", customType: "goal-compact-goal", data }), getCurrentGoal: () => goal });
    const result = await Promise.allSettled([
      artifacts.write(goal, "CURRENT", "one", 0, ctx(cwd, entries)),
      artifacts.write(goal, "CURRENT", "two", 0, ctx(cwd, entries)),
    ]);
    assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(result.filter((item) => item.status === "rejected").length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("legacy artifact writes bootstrap only the unified managed projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    const goal = createThreadGoal("managed");
    const artifacts = createGoalArtifacts({ appendEntry: (_type, data) => entries.push({ type: "custom", customType: "goal-compact-goal", data }), getCurrentGoal: () => goal });
    await artifacts.write(goal, "CURRENT", "текущее состояние", 0, ctx(cwd, entries));
    assert.deepEqual(await readdir(artifactDir(cwd, goal.goalId)), ["CURRENT.md", "GOAL.md"]);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("legacy objective synchronization uses the unified artifact path", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    let current = createThreadGoal("Первая цель");
    const artifacts = createGoalArtifacts({ appendEntry: (_type, data) => entries.push({ type: "custom", customType: "goal-compact-goal", data }), getCurrentGoal: () => current });
    await artifacts.syncObjective(current, { cwd });
    assert.equal(await readFile(goalFilePath(cwd, current.goalId), "utf8"), "# Цель\n\nПервая цель\n");
    current = { ...current, objective: "Обновлённая цель" };
    await artifacts.syncObjective(current, { cwd });
    assert.equal(await readFile(goalFilePath(cwd, current.goalId), "utf8"), "# Цель\n\nОбновлённая цель\n");
    assert.equal(artifacts.refs(current, ctx(cwd, entries), entries).some((ref) => ref.path.endsWith("/GOAL.md")), true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("append failure rolls an artifact file back without advancing its revision", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const goal = createThreadGoal("test");
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [{
      type: "custom",
      customType: "goal-compact-goal",
      data: { kind: "artifact", version: 1, goalId: goal.goalId, artifact: "CURRENT", revision: 1, at: 1 },
    }];
    const path = artifactFilePath(cwd, goal.goalId, "CURRENT");
    const artifacts = createGoalArtifacts({
      appendEntry() { throw new Error("append failed"); },
      getCurrentGoal: () => goal,
    });
    await artifacts.bootstrap(goal, { cwd });
    await writeFile(path, "old content", { encoding: "utf8" });

    await assert.rejects(artifacts.write(goal, "CURRENT", "new content", 1, ctx(cwd, entries)), /append failed/);
    assert.equal(await readFile(path, "utf8"), "old content");
    assert.equal(artifacts.refs(goal, ctx(cwd, entries), entries).find((ref) => ref.artifact === "CURRENT")?.revision, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("stale artifact writer is rejected after replacement or completion", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    const goal = createThreadGoal("test");
    let calls = 0;
    const artifacts = createGoalArtifacts({
      appendEntry() { entries.push({ type: "custom", customType: "goal-compact-goal", data: { kind: "artifact", version: 1, goalId: goal.goalId, artifact: "CURRENT", revision: 1, at: 1 } }); },
      getCurrentGoal: () => calls++ === 0 ? goal : { ...goal, status: "complete" },
    });
    await assert.rejects(artifacts.write(goal, "CURRENT", "stale", 0, ctx(cwd, entries)));
    assert.equal(entries.length, 0);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("legacy report artifacts stay out of the collapsed chat entry", () => {
  const entry = { version: 1, kind: "publish", goalId: "g", createdAt: 1, turnIndex: 1, activeSeconds: 0, tokensUsed: 0, reportId: "r", triggerReason: "manual", report: { status: "working", phase: "x", nextStep: "y" }, artifactRefs: [{ goalId: "g", artifact: "CURRENT", revision: 1, path: pathToFileURL("/tmp/a b.md").href }] };
  const typedEntry = entry as import("../../src/goal/goal-reports.js").GoalReportEntry;
  const lines = formatGoalProgressReport(typedEntry, false)!;
  const component = createGoalProgressEntryComponent(lines);
  const rendered = component.render(200).join("\\n");
  assert.doesNotMatch(rendered, /\[CURRENT\].*\(file:/);
  assert.doesNotMatch(rendered, /CURRENT r1|file:\/\//);
  assert.match(createGoalProgressEntryComponent(formatGoalProgressReport(typedEntry, true)!).render(200).join("\n"), /CURRENT r1/);
});

test("goal artifact ids stay contained and URLs encode reserved characters", () => {
  assert.throws(() => artifactDir("/tmp", "../escape"));
  assert.throws(() => artifactDir("/tmp", "a/b"));
  const url = artifactFileUrl("/tmp/a b/#q?.md");
  assert.match(url, /^file:\/\/\/tmp\/a%20b\/%23q%3F\.md$/);
});

test("pre-existing artifact root and goal symlinks fail closed without touching outside", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "goal-artifacts-outside-"));
  try {
    const goal = createThreadGoal("test");
    const artifacts = createGoalArtifacts({ appendEntry() {}, getCurrentGoal: () => goal });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await symlink(outside, join(cwd, ".pi", "goal-compact"));
    await assert.rejects(artifacts.bootstrap(goal, { cwd }), /unsafe existing directory component/);
    await assert.rejects(artifacts.write(goal, "CURRENT", "SECRET", 0, ctx(cwd, [])), /unsafe existing directory component/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  const cwd2 = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  const outside2 = await mkdtemp(join(tmpdir(), "goal-artifacts-outside-"));
  try {
    const goal = createThreadGoal("test");
    const artifacts = createGoalArtifacts({ appendEntry() {}, getCurrentGoal: () => goal });
    await mkdir(join(cwd2, ".pi", "pohuy-goal"), { recursive: true });
    await symlink(outside2, join(cwd2, ".pi", "pohuy-goal", goal.goalId));
    await assert.rejects(artifacts.bootstrap(goal, { cwd: cwd2 }), /unsafe existing directory component/);
    await assert.rejects(artifacts.write(goal, "CURRENT", "SECRET", 0, ctx(cwd2, [])), /unsafe existing directory component/);
    assert.deepEqual(await readdir(outside2), []);
  } finally {
    await rm(cwd2, { recursive: true, force: true });
    await rm(outside2, { recursive: true, force: true });
  }
});

test("bootstrap creates artifacts but does not follow an external .git symlink", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  const outside = await mkdtemp(join(tmpdir(), "goal-artifacts-git-outside-"));
  try {
    const goal = createThreadGoal("test");
    const externalGit = join(outside, ".git");
    const excludePath = join(externalGit, "info", "exclude");
    await mkdir(join(externalGit, "info"), { recursive: true });
    await writeFile(excludePath, "# existing\n", "utf8");
    const before = await readFile(excludePath, "utf8");
    await symlink(externalGit, join(cwd, ".git"));

    const artifacts = createGoalArtifacts({ appendEntry() {}, getCurrentGoal: () => goal });
    await artifacts.bootstrap(goal, { cwd });

    assert.deepEqual(await readdir(artifactDir(cwd, goal.goalId)), [
      "CONTEXT-MAP.md",
      "CURRENT.md",
      "DECISIONS.md",
      "GOAL.md",
      "PAPER-CUTS.md",
      "TIMELINE.md",
    ]);
    assert.equal(await readFile(excludePath, "utf8"), before);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("bootstrap rejection is observable without an unhandled rejection", async () => {
  const goal = createThreadGoal("test");
  const artifacts = createGoalArtifacts({ appendEntry() {}, getCurrentGoal: () => goal });
  const bad = ctx("/dev/null/impossible", []);
  await assert.rejects(artifacts.bootstrap(goal, bad));
  await readFile;
});

test("GOAL revisions survive reconstruction and reject independent stale writers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-revisions-"));
  try {
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    const goal = createThreadGoal("Проверить ревизии сводки");
    const deps = { appendEntry: (_type: string, data: unknown) => { entries.push({ type: "custom", customType: "goal-compact-goal", data }); }, getCurrentGoal: () => goal };
    const first = createGoalArtifacts(deps);
    const second = createGoalArtifacts(deps);
    await first.write(goal, "GOAL", "Первый снимок", 0, ctx(cwd, entries));
    assert.equal(second.managedRefs(goal, ctx(cwd, entries), entries)[0]!.revision, 1);
    await second.write(goal, "GOAL", "Второй снимок", 1, ctx(cwd, entries));
    assert.equal(first.managedRefs(goal, ctx(cwd, entries), entries)[0]!.revision, 2);
    await assert.rejects(() => first.write(goal, "GOAL", "Устаревший снимок", 1, ctx(cwd, entries)), /Stale artifact revision/);
    assert.equal(await readFile(goalFilePath(cwd, goal.goalId), "utf8"), "Второй снимок");
    const competing = await Promise.allSettled([
      first.write(goal, "GOAL", "Третий снимок", 2, ctx(cwd, entries)),
      second.write(goal, "GOAL", "Конкурирующий снимок", 2, ctx(cwd, entries)),
    ]);
    assert.equal(competing.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(competing.filter((result) => result.status === "rejected").length, 1);
    assert.equal(second.managedRefs(goal, ctx(cwd, entries), entries)[0]!.revision, 3);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("цель с каталогом прежнего расширения пишет документ на прежнее место, новая — в goal-compact", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    const legacyGoal = createThreadGoal("прежняя");
    const freshGoal = createThreadGoal("новая");
    await mkdir(join(cwd, ".pi", "pohuy-goal", legacyGoal.goalId), { recursive: true });
    assert.equal(goalFilePath(cwd, legacyGoal.goalId), join(cwd, ".pi", "pohuy-goal", legacyGoal.goalId, "GOAL.md"));
    assert.equal(goalFilePath(cwd, freshGoal.goalId), join(cwd, ".pi", "goal-compact", freshGoal.goalId, "GOAL.md"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bootstrap цели прежнего расширения скрывает от Git прежний каталог, новой цели — новый", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-artifacts-"));
  try {
    await mkdir(join(cwd, ".git", "info"), { recursive: true });
    const excludePath = join(cwd, ".git", "info", "exclude");
    await writeFile(excludePath, "# existing\n", "utf8");
    const legacyGoal = createThreadGoal("прежняя");
    await mkdir(join(cwd, ".pi", "pohuy-goal", legacyGoal.goalId), { recursive: true });
    const entries: Array<import("../../src/goal/types.js").SessionEntryLike> = [];
    const artifacts = createGoalArtifacts({ appendEntry: (_type, data) => entries.push({ type: "custom", customType: "goal-compact-goal", data }), getCurrentGoal: () => legacyGoal });
    await artifacts.bootstrap(legacyGoal, ctx(cwd, entries));
    assert.equal(await readFile(excludePath, "utf8"), "# existing\n.pi/pohuy-goal/\n");
    const freshGoal = createThreadGoal("новая");
    await artifacts.bootstrap(freshGoal, ctx(cwd, entries));
    assert.equal(await readFile(excludePath, "utf8"), "# existing\n.pi/pohuy-goal/\n.pi/goal-compact/\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
