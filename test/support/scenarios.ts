import assert from "node:assert/strict";

import { createThreadGoal, setEntry } from "../../src/goal/state.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import {
  createExpandedRuntimeHarness as createRuntimeHarness,
  deliverTicket,
  emitPersistentAssistantError,
  goalTickets,
  type RuntimeHarness,
  sessionCompactEvent,
  sessionShutdownEvent,
} from "./runtime-harness.js";

/** Подменяет ветку сессии одной записью новой активной цели (смена ветки на другую цель). */
export function replaceHarnessBranchWithGoal(
  harness: RuntimeHarness,
  objective: string,
): ReturnType<typeof createThreadGoal> {
  const branchGoal = createThreadGoal(objective);
  harness.entries.length = 0;
  harness.entries.push({
    type: "custom",
    id: `entry-branch-${objective.replace(/\s+/g, "-")}`,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(branchGoal, "command"),
  });
  return branchGoal;
}

/** Цель на паузе после того, как Pi дважды не смог восстановиться после переполнения окна. */
export async function givenOverflowPausedGoal(
  objective = "ship it",
): Promise<{
  harness: RuntimeHarness;
  goal: NonNullable<ReturnType<RuntimeHarness["snapshot"]>["goal"]>;
}> {
  const harness = createRuntimeHarness();
  await harness.runCommand(objective);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    if (harness.snapshot().goal?.status === "active") {
      await harness.emit("agent_start", { type: "agent_start" });
    }
  }

  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "paused");
  assert.equal(harness.hostOverflowRecoveryAttempted, true);
  return { harness, goal };
}

export async function givenPendingTransientRecovery(
  objective = "ship it",
): Promise<RuntimeHarness> {
  const harness = createRuntimeHarness();
  await harness.runCommand(objective);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  return harness;
}

export async function givenPendingOverflowRecovery(
  objective = "ship it",
): Promise<RuntimeHarness> {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand(objective);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  return harness;
}

export async function emitPendingRecoveryShutdown(
  harness: RuntimeHarness,
  _kind: "overflow" | "transient",
): Promise<ReturnType<RuntimeHarness["snapshot"]>["goal"]> {
  await harness.emit("session_shutdown", sessionShutdownEvent());
  const pausedGoal = harness.snapshot().goal;
  assert.equal(pausedGoal?.status, "paused");
  assert.equal(harness.widgets.at(-1), undefined, "shutdown does not create a widget");
  assert.equal(harness.footerStatuses.at(-1), undefined, "shutdown clears transient footer state");
  return pausedGoal;
}

/**
 * Восстановление ждёт, а в очередь Pi уже попал билет продолжения, выданный до ошибки.
 * Доставка такого билета прерывает прогон расширением, а не владельцем, и цель не встаёт на ручную паузу.
 */
export async function givenPendingRecoveryWithStaleQueuedAbort(
  kind: "overflow" | "transient",
): Promise<{ harness: RuntimeHarness }> {
  const harness =
    kind === "overflow"
      ? createRuntimeHarness({ compactBehavior: "unavailable" })
      : createRuntimeHarness();

  await harness.runCommand("ship it");
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  const ticket = goalTickets(harness)[0];
  assert.ok(ticket, "активная цель на новой ветке ставит билет продолжения");
  const activeGoal = harness.snapshot().goal;
  assert.ok(activeGoal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  const errorMessage = kind === "overflow" ? "context_length_exceeded" : "websocket closed";
  await emitPersistentAssistantError(harness, 0, errorMessage);
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/gr/);

  await deliverTicket(harness, ticket);
  assert.equal(harness.abortCount, 1);

  const pausedGoal = await emitPendingRecoveryShutdown(harness, kind);
  assert.ok(pausedGoal);
  assert.equal(pausedGoal.goalId, activeGoal.goalId);

  return { harness };
}

export async function replaceGoalAfterOverflowPause(
  harness: RuntimeHarness,
  replacementObjective: string,
): Promise<{
  previousGoalId: string;
  goal: NonNullable<ReturnType<RuntimeHarness["snapshot"]>["goal"]>;
}> {
  const previousGoal = harness.snapshot().goal;
  assert.ok(previousGoal);

  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runCommand(replacementObjective);
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  assert.equal(goal.status, "active");
  assert.equal(goal.objective, replacementObjective);
  assert.notEqual(goal.goalId, previousGoal.goalId);

  return { previousGoalId: previousGoal.goalId, goal };
}
