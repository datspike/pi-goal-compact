import assert from "node:assert/strict";
import { test } from "node:test";

import { RUNTIME_PERSIST_INTERVAL_MS } from "../../src/goal/runtime-config.js";
import { compactContinuationPrompt } from "../../src/goal/prompts.js";
import {
  isGoalCustomEntry,
  reconstructGoal,
  amendGoal,
  createThreadGoal,
  runtimeUsageEntry,
  setEntry,
} from "../../src/goal/state.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { RECORD } from "../../src/records.js";
import {
  assistantMessage,
  countGoalSetEntries,
  countGoalUsageEntries,
  createRuntimeHarness,
  emitToolExecutionEnd,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
  sessionShutdownEvent } from "../support/runtime-harness.js";

const COMPACTION_RECORDS = new Set<string>([RECORD.audit, RECORD.standard, RECORD.card]);

/** Число записей без журнала и карточек сжатия: их пишет часть сжатия того же расширения. */
function goalEntryCount(harness: ReturnType<typeof createRuntimeHarness>): number {
  return harness.entries.filter((entry) => !(entry.type === "custom" && COMPACTION_RECORDS.has(entry.customType))).length;
}

test("duplicate update_goal complete appends only one complete entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await harness.runTool("update_goal", { status: "complete" });
  await harness.runTool("update_goal", { status: "complete" });

  const completeSetEntries = harness.entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      entry.data.goal.status === "complete"
    );
  });
  assert.equal(completeSetEntries.length, 1);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("compaction after complete does not append duplicate runtime entries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runTool("update_goal", { status: "complete" });
  const entryCountAfterComplete = goalEntryCount(harness);

  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());

  assert.equal(goalEntryCount(harness), entryCountAfterComplete);
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("repeated tool_execution_end events coalesce runtime persistence when usage is unchanged", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    for (let index = 0; index < 5; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.match(harness.widgetText(), /Работаю ·/);
    assert.match(harness.footerStatuses.at(-1) ?? "", /^Работаю ·/);
  } finally {
    Date.now = originalNow;
  }
});

test("turn_end flushes coalesced runtime usage to session entries", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 5_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(goal?.usage.activeSeconds, 5);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown flushes pending runtime usage", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    now += 4_000;
    await emitToolExecutionEnd(harness);
    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);

    await harness.emit("session_shutdown", sessionShutdownEvent());

    assert.equal(countGoalSetEntries(harness.entries, goalId), 1);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.activeSeconds, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("runtime persistence interval flush appends one entry then coalesces until turn_end", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);
    const initialSetEntries = countGoalSetEntries(harness.entries, goalId);
    assert.equal(initialSetEntries, 1);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

    now += RUNTIME_PERSIST_INTERVAL_MS + 1_000;
    await emitToolExecutionEnd(harness);

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);
    const afterIntervalFlush = harness.snapshot().goal;
    assert.equal(
      afterIntervalFlush?.usage.activeSeconds,
      Math.floor((RUNTIME_PERSIST_INTERVAL_MS + 1_000) / 1_000),
    );

    for (let index = 0; index < 3; index += 1) {
      now += 2_000;
      await emitToolExecutionEnd(harness);
    }

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 1);

    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("toolUse", { input: 10, output: 2 }),
      toolResults: [],
    });

    assert.equal(countGoalSetEntries(harness.entries, goalId), initialSetEntries);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), 2);
    const goal = harness.snapshot().goal;
    assert.equal(goal?.usage.tokensUsed, 12);
    assert.equal(
      goal?.usage.activeSeconds,
      Math.floor((RUNTIME_PERSIST_INTERVAL_MS + 1_000 + 6_000) / 1_000),
    );
  } finally {
    Date.now = originalNow;
  }
});

test("reconstructGoal preserves append-only amendment history and legacy set entries", () => {
  const legacy = createThreadGoal("Original request: ship it", 100, 1);
  const withUsage = {
    ...legacy,
    usage: { tokensUsed: 12, activeSeconds: 3 },
    updatedAt: 2,
  };
  const amended = amendGoal(withUsage, "Add the approved import path.").goal;
  assert.ok(amended);

  const reconstructed = reconstructGoal([
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(legacy, "tool", 1) },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: runtimeUsageEntry(withUsage, 2) },
    { type: "custom", customType: CUSTOM_ENTRY_TYPE, data: setEntry(amended, "tool", 3) },
  ]).goal;

  assert.ok(reconstructed);
  assert.equal(reconstructed.goalId, legacy.goalId);
  assert.equal(reconstructed.tokenBudget, 100);
  assert.deepEqual(reconstructed.usage, { tokensUsed: 12, activeSeconds: 3 });
  assert.match(reconstructed.objective, /Original request: ship it/);
  assert.match(reconstructed.objective, /Approved amendment/);
});

test("reconstructGoal uses the latest snapshot across dense legacy and coalesced entries", () => {
  const goal = createThreadGoal("ship it", 100);
  const denseEntries = Array.from({ length: 20 }, (_, index) => ({
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...goal,
        usage: { tokensUsed: index + 1, activeSeconds: index },
        updatedAt: goal.updatedAt + index,
      },
      "runtime",
      goal.updatedAt + index,
    ),
  }));
  const coalescedEntry = {
    type: "custom" as const,
    customType: CUSTOM_ENTRY_TYPE,
    data: runtimeUsageEntry(
      {
        ...goal,
        usage: { tokensUsed: 99, activeSeconds: 42 },
        status: "active",
        updatedAt: goal.updatedAt + 100,
      },
      goal.updatedAt + 100,
    ),
  };

  const reconstructed = reconstructGoal([...denseEntries, coalescedEntry]).goal;
  assert.ok(reconstructed);
  assert.equal(reconstructed.usage.tokensUsed, 99);
  assert.equal(reconstructed.usage.activeSeconds, 42);
});

test("compaction with unchanged paused goal appends no new entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runCommand("pause");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  const entryCountAfterPause = goalEntryCount(harness);

  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());

  assert.equal(goalEntryCount(harness), entryCountAfterPause);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(countGoalSetEntries(harness.entries, goalId), 2);
});

test("compaction with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = goalEntryCount(harness);
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    const usageEntriesAfterBudgetLimit = countGoalUsageEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 1);
    assert.equal(usageEntriesAfterBudgetLimit, 1);

    now += 60_000;

    await harness.emit("session_before_compact", sessionBeforeCompactEvent());
    await harness.emit("session_compact", sessionCompactEvent());

    assert.equal(goalEntryCount(harness), entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), usageEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("session_shutdown with unchanged budgetLimited goal appends no new entry", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
    const goalId = harness.snapshot().goal?.goalId;
    assert.ok(goalId);

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: assistantMessage("stop", { input: 8, output: 3 }),
      toolResults: [],
    });

    const goal = harness.snapshot().goal;
    assert.equal(goal?.status, "budgetLimited");
    assert.equal(goal?.usage.tokensUsed, 11);
    const activeSecondsAtBudgetLimit = goal?.usage.activeSeconds ?? 0;
    const entryCountAfterBudgetLimit = harness.entries.length;
    const setEntriesAfterBudgetLimit = countGoalSetEntries(harness.entries, goalId);
    const usageEntriesAfterBudgetLimit = countGoalUsageEntries(harness.entries, goalId);
    assert.equal(setEntriesAfterBudgetLimit, 1);
    assert.equal(usageEntriesAfterBudgetLimit, 1);

    now += 60_000;

    await harness.emit("session_shutdown", sessionShutdownEvent());

    assert.equal(harness.entries.length, entryCountAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited");
    assert.equal(countGoalSetEntries(harness.entries, goalId), setEntriesAfterBudgetLimit);
    assert.equal(countGoalUsageEntries(harness.entries, goalId), usageEntriesAfterBudgetLimit);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 11);
    assert.equal(harness.snapshot().goal?.usage.activeSeconds, activeSecondsAtBudgetLimit);
  } finally {
    Date.now = originalNow;
  }
});

test("create_goal creates a new goal when explicit replacement is requested without an existing goal", async () => {
  const harness = createRuntimeHarness();

  const created = (await harness.runTool("create_goal", {
    objective: "new objective",
    replace_existing: true,
  })) as { details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "new objective");
  assert.equal(harness.snapshot().goal?.objective, "new objective");
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("create_goal replaces a completed goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const completedGoalId = harness.snapshot().goal?.goalId;
  await harness.runTool("update_goal", { status: "complete" });

  const created = (await harness.runTool("create_goal", { objective: "next objective" })) as {
    details: Record<string, unknown>;
  };

  assert.equal((created.details.goal as { objective?: string }).objective, "next objective");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.notEqual(harness.snapshot().goal?.goalId, completedGoalId);
});

test("create_goal accepts null budget and directly replaces a paused goal on an explicit request", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "old goal", token_budget: null });
  const oldGoalId = harness.snapshot().goal?.goalId;
  assert.ok(oldGoalId);
  await harness.runSlashCommand("gp");
  assert.equal(harness.snapshot().goal?.status, "paused");

  const created = (await harness.runTool("create_goal", {
    objective: "new goal",
    replace_existing: true,
    token_budget: null,
  })) as { details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "new goal");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.snapshot().goal?.tokenBudget, null);
  assert.notEqual(harness.snapshot().goal?.goalId, oldGoalId);
});

test("amend_goal resumes a paused goal without queueing a continuation message", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  await harness.runSlashCommand("gp");
  harness.sentUserMessages.length = 0;
  harness.sentMessages.length = 0;

  const amended = (await harness.runTool("amend_goal", {
    amendment: "Add the approved import path.",
  })) as { details: Record<string, unknown> };

  assert.equal((amended.details.goal as { status?: string }).status, "active");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.snapshot().goal?.goalId, goalId);
  assert.match(harness.snapshot().goal?.objective ?? "", /Approved amendment/);
  assert.equal(harness.sentUserMessages.length, 0);
  assert.equal(harness.sentMessages.length, 0);
});







test("failed create_goal throws so pi marks the tool result as an error", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");

  await assert.rejects(() => harness.runTool("create_goal", { objective: "duplicate" }), /уже есть незавершённая цель/);
});
