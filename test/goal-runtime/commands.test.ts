import assert from "node:assert/strict";
import test from "node:test";

import { createThreadGoal, setEntry } from "../../src/goal/state.js";
import { CUSTOM_ENTRY_TYPE, type GoalStatus } from "../../src/goal/types.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";
import { registerGoalCommand, type CommandHost, type GoalCommandContext } from "../../src/goal/commands.js";

function harnessWithStatus(status: GoalStatus) {
  const goal = createThreadGoal("ship the feature", status === "budgetLimited" ? 10 : null);
  goal.status = status;
  goal.usage.tokensUsed = status === "budgetLimited" ? 10 : 5;
  const harness = createRuntimeHarness();
  harness.entries.push({
    type: "custom", id: "goal-fixture", parentId: null, timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE, data: setEntry(goal, "tool"),
  });
  return { harness, goal };
}

async function loadFixture(harness: ReturnType<typeof createRuntimeHarness>) {
  await harness.reloadSession();
  // Session startup may queue work; measure only effects of the tested controls.
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
}

const noTurn = (harness: ReturnType<typeof createRuntimeHarness>) => {
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);
};

test("goal lifecycle and observability commands are registered, including after reload", () => {
  const harness = createRuntimeHarness();
  assert.deepEqual(harness.commandNames().sort(), ["context", "gc", "gp", "gr", "gs", "gw"]);
  harness.reloadExtension();
  assert.deepEqual(harness.commandNames().sort(), ["context", "gc", "gp", "gr", "gs", "gw"]);
});

test("/gp pauses active work without sending a prompt", async () => {
  const { harness, goal } = harnessWithStatus("active");
  await loadFixture(harness);
  await harness.runSlashCommand("gp");
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.goalId, goal.goalId);
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 5);
  assert.equal(harness.abortCount, 0);
  noTurn(harness);
});

test("/gr silently resumes paused work without sending a prompt", async () => {
  const { harness, goal } = harnessWithStatus("paused");
  await loadFixture(harness);
  await harness.runSlashCommand("gr");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.snapshot().goal?.goalId, goal.goalId);
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 5);
  noTurn(harness);
});

test("/gp and /gr reject absent, terminal and inappropriate states", async () => {
  for (const command of ["gp", "gr"]) {
    for (const status of [null, "active", "paused", "complete", "budgetLimited"] as const) {
      if ((command === "gp" && status === "active") || (command === "gr" && status === "paused")) continue;
      const harness = status ? harnessWithStatus(status).harness : createRuntimeHarness();
      await loadFixture(harness);
      const before = harness.snapshot().goal;
      const entryCount = harness.entries.length;
      await harness.runSlashCommand(command);
      assert.deepEqual(harness.snapshot().goal, before, `${command}: ${status}`);
      assert.equal(harness.entries.length, entryCount);
      assert.ok(harness.notifications.length > 0);
      noTurn(harness);
    }
  }
});

test("/gc clears every existing goal state without confirmation or a new turn", async () => {
  for (const status of ["active", "paused", "complete", "budgetLimited"] as const) {
    const { harness } = harnessWithStatus(status);
    await loadFixture(harness);
    await harness.runSlashCommand("gc");
    assert.equal(harness.snapshot().goal, null);
    assert.equal(harness.widgets.at(-1), undefined);
    assert.equal(harness.notifications.at(-1), "Goal cleared.");
    noTurn(harness);
    await loadFixture(harness);
    assert.equal(harness.snapshot().goal, null);
  }
});

test("/gc with no goal only reports that no goal is set", async () => {
  const harness = createRuntimeHarness();
  await harness.runSlashCommand("gc");
  assert.equal(harness.entries.length, 0);
  assert.equal(harness.notifications.at(-1), "No goal is set.");
  noTurn(harness);
});

test("all controls reject arguments before changing state, especially the former /gc comment", async () => {
  for (const command of ["gp", "gr", "gc", "gw"]) {
    for (const args of ["continue after review", "\nclear\n", "resume cancel"]) {
      const { harness } = harnessWithStatus(command === "gr" ? "paused" : "active");
      await loadFixture(harness);
      const before = harness.snapshot().goal;
      const entryCount = harness.entries.length;
      await harness.runSlashCommand(command, args);
      assert.deepEqual(harness.snapshot().goal, before);
      assert.equal(harness.entries.length, entryCount);
      assert.match(harness.notifications.at(-1) ?? "", new RegExp(`Usage: /${command}`));
      noTurn(harness);
    }
  }
});

test("argument-free controls accept surrounding whitespace", async () => {
  const { harness } = harnessWithStatus("active");
  await loadFixture(harness);
  await harness.runSlashCommand("gp", " \n\t ");
  assert.equal(harness.snapshot().goal?.status, "paused");
  await harness.runSlashCommand("gr", " \t ");
  assert.equal(harness.snapshot().goal?.status, "active");
  await harness.runSlashCommand("gc", " \n ");
  assert.equal(harness.snapshot().goal, null);
  noTurn(harness);
});


test("model tools create and replace goals without slash preparation", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "first work" });
  const firstGoalId = harness.snapshot().goal?.goalId;
  assert.ok(firstGoalId);
  await assert.rejects(() => harness.runTool("create_goal", { objective: "unauthorized duplicate" }), /non-complete goal/);
  await harness.runTool("create_goal", { objective: "approved replacement", replace_existing: true });
  assert.notEqual(harness.snapshot().goal?.goalId, firstGoalId);
  assert.equal(harness.snapshot().goal?.objective, "approved replacement");
  assert.ok(await harness.runTool("get_goal", {}));
  await loadFixture(harness);
  assert.equal(harness.snapshot().goal?.objective, "approved replacement");
  noTurn(harness);
});


test("/gs and /gw append visible snapshots without entering model context", async () => {
  const { harness } = harnessWithStatus("active");
  await loadFixture(harness);
  type SnapshotEntry = Extract<typeof harness.entries[number], { type: "custom" }> & { customType: string; data: unknown };
  const isSnapshot = (entry: typeof harness.entries[number]): entry is SnapshotEntry =>
    entry.type === "custom" && entry.customType === "goal-compact-observability";
  const initialCount = harness.entries.filter(isSnapshot).length;
  await harness.runSlashCommand("gs");
  const compact = harness.entries.filter(isSnapshot).at(-1);
  assert.equal((compact?.data as { mode: string }).mode, "status");
  assert.match((compact?.data as { lines: string[] }).lines[0] ?? "", /^Цель: Работаю/);
  const afterCompact = harness.entries.filter(isSnapshot).length;
  await harness.runSlashCommand("gs");
  assert.equal(harness.entries.filter(isSnapshot).length, afterCompact, "same snapshot is deduplicated");
  await harness.runSlashCommand("gw");
  const detailed = harness.entries.filter(isSnapshot).at(-1);
  assert.match((detailed?.data as { lines: string[] }).lines.join("\\n"), /\u001b]8;;file:\/\//);
  assert.equal((detailed?.data as { mode: string }).mode, "details");
  assert.match((detailed?.data as { lines: string[] }).lines.join("\\n"), /Замысел: ship the feature/);
  assert.match(harness.renderEntry("goal-compact-observability", detailed?.data)?.join("\\n") ?? "", /\u001b]8;;file:\/\//);
  await harness.runSlashCommand("gw");
  assert.equal(harness.entries.filter(isSnapshot).length, afterCompact + 1, "same overview is deduplicated");
  await harness.runSlashCommand("gs");
  assert.equal(harness.entries.filter(isSnapshot).length, afterCompact + 1, "status snapshot remains deduplicated after details");
  await harness.runTool("create_goal", { objective: "second goal", replace_existing: true });
  await harness.runSlashCommand("gs");
  assert.equal(harness.entries.filter(isSnapshot).length, afterCompact + 2, "new goal gets a distinct status snapshot");
  noTurn(harness);
  assert.equal(initialCount, 0);
});

test("/gs without a goal appends a compact empty-state snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runSlashCommand("gs");
  const entry = harness.entries.at(-1);
  assert.equal(entry?.type, "custom");
  if (entry?.type !== "custom") return;
  assert.equal(entry.customType, "goal-compact-observability");
  assert.deepEqual((entry.data as { lines: string[] }).lines, ["Цель: нет активной цели"]);
  noTurn(harness);
});

test("a silent resume waiting for projections cannot override a newer stop or input epoch", async () => {
  const goal = createThreadGoal("Command scope");
  goal.status = "paused";
  let epoch = 1;
  let writes = 0;
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let handler!: (args: string, ctx: GoalCommandContext) => void | Promise<void>;
  const harness = createRuntimeHarness();
  const host: CommandHost = {
    getGoal: () => goal, setGoal: () => { writes++; },
    waitForGoalProjection: () => barrier, clearGoal() {}, toggleGoalWidget() {},
    cancelProviderLimitAutoResume() {},
    getGoalResumeFailure: () => null, getGoalResumeEpoch: () => epoch,
    invalidateResumeInstructions: () => { epoch++; },
  };
  registerGoalCommand({ registerCommand(name, definition) { if (name === "gr") handler = definition.handler; } }, host);
  const ctx = harness.commandContext;
  const pending = handler("", ctx);
  host.invalidateResumeInstructions();
  release();
  await pending;
  assert.equal(writes, 0);
  assert.equal(goal.status, "paused");
  assert.ok(harness.notifications.some(message => message.includes("stale")));
});
