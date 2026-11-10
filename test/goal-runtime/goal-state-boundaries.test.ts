import assert from "node:assert/strict";
import { test } from "node:test";

import { createGoalPersistence } from "../../src/goal/goal-persistence.js";
import { isGoalCustomEntry } from "../../src/goal/state.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "../../src/goal/types.js";
import {
  createExpandedRuntimeHarness as createRuntimeHarness,
  emitPersistentAssistantError,
} from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

/** Отметки «после переполнения нужна реплика пользователя» в журнале, по порядку. */
function capResets(harness: Harness): boolean[] {
  return harness.entries.flatMap((entry) =>
    entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE && isGoalCustomEntry(entry.data) &&
      entry.data.kind === "host_overflow_cap_reset"
      ? [entry.data.active]
      : []);
}

async function userMessage(harness: Harness, content: string): Promise<void> {
  await harness.emit("message_start", { type: "message_start", message: { role: "user", content, timestamp: 1 } });
}

test("снимок цели копируется на границе хранилища: чужие правки не меняют сохранённую цель", () => {
  const source: ThreadGoal = {
    goalId: "clone-boundary",
    objective: "ship it",
    status: "active",
    tokenBudget: null,
    usage: { tokensUsed: 1, activeSeconds: 2 },
    createdAt: 0,
    updatedAt: 0,
  };
  const persistence = createGoalPersistence({ pi: { appendEntry() {} } });
  persistence.setGoalSnapshot(source);

  source.objective = "mutated source";
  source.usage.tokensUsed = 999;
  const firstRead = persistence.getGoal();
  assert.ok(firstRead);
  assert.equal(firstRead.objective, "ship it");
  assert.equal(firstRead.usage.tokensUsed, 1);

  firstRead.objective = "mutated read";
  firstRead.usage.activeSeconds = 456;
  assert.equal(persistence.getGoal()?.objective, "ship it");
  assert.equal(persistence.getGoal()?.usage.activeSeconds, 2);
});

test("переполнение без цели пишет отметку один раз, повтор её не дублирует", async () => {
  const harness = createRuntimeHarness();
  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await emitPersistentAssistantError(harness, 1, "context_length_exceeded");
  assert.deepEqual(capResets(harness), [true]);
});

test("переполнение при цели на паузе пишет отметку и оставляет цель на паузе", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runSlashCommand("gp");
  assert.equal(harness.snapshot().goal?.status, "paused");
  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.deepEqual(capResets(harness), [true]);
  assert.equal(harness.snapshot().goal?.status, "paused");
});

test("переполнение при активной цели пишет отметку, не ставя цель на паузу", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.deepEqual(capResets(harness), [true]);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("реплика пользователя снимает отметку одной записью, и снятие переживает перезагрузку", async () => {
  const harness = createRuntimeHarness();
  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await userMessage(harness, "продолжаем");
  await userMessage(harness, "ещё реплика");
  assert.deepEqual(capResets(harness), [true, false]);

  // После перезагрузки отметка не возвращается: новое переполнение снова требует реплики.
  await harness.reloadSession("reload");
  await emitPersistentAssistantError(harness, 1, "context_length_exceeded");
  assert.deepEqual(capResets(harness), [true, false, true]);
});
