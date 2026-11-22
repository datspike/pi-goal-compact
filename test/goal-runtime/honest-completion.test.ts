import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeHarness } from "../support/runtime-harness.js";
import type { GoalWorkState } from "../../src/goal/goal-work-state.js";
import type { GoalWorkingState } from "../../src/goal/format.js";

// Договор 0026: цель не закрывается с живым пунктом, препятствие объясняет себя,
// закрытый пункт называет наблюдение, а работа не исчезает из плана молча.

function plan(): GoalWorkState {
  return {
    outcome: "Проверить договор закрытия", doneWhen: "Отказы воспроизводятся", summary: "План записан", activeDecisionIds: [],
    items: [
      { id: "done", title: "Собрать наблюдения", status: "done", source: "agent", result: "Две трассы прочитаны" },
      { id: "work", title: "Проверить отказ", status: "active", source: "agent" },
      { id: "later", title: "Свести итог", status: "planned", source: "agent" },
    ],
  };
}

async function setup(state: GoalWorkState = plan()) {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить договор закрытия цели." });
  const goalId = harness.snapshot().goal!.goalId;
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state });
  return { harness, goalId };
}

async function current(harness: ReturnType<typeof createRuntimeHarness>): Promise<GoalWorkingState> {
  return (await harness.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
}

const stageOf = async (run: Promise<unknown>): Promise<string> => {
  try { await run; } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return (JSON.parse(text) as { stage?: string }).stage ?? "no-stage";
  }
  return "accepted";
};

test("цель не закрывается, пока в плане есть живой пункт", async () => {
  const { harness } = await setup();
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Проверяю", verification: "Пункт проверен", nextStep: "Закрыть цель" });
  assert.equal(await stageOf(harness.runTool("update_goal", { status: "complete" })), "open_items");
  assert.equal(harness.snapshot().goal?.status, "active");
  const state = await current(harness);
  assert.deepEqual(state.workState?.items.map((item) => item.status), ["done", "active", "planned"]);
});

test("препятствие без объяснения не принимается, а с объяснением не закрывает цель", async () => {
  const { harness, goalId } = await setup();
  const bare: GoalWorkState = { ...plan(), items: plan().items.map((item) => item.id === "work" ? { ...item, status: "blocked" } : item) };
  assert.equal(await stageOf(harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: bare })), "insufficient_attempts");
  const explained: GoalWorkState = { ...bare, items: bare.items.map((item) => item.id === "work" ? { ...item, result: "Пробовал двумя путями, нужен доступ к стенду" } : item) };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: explained });
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Проверяю", verification: "Проверено", nextStep: "Закрыть цель" });
  assert.equal(await stageOf(harness.runTool("update_goal", { status: "complete" })), "open_items");
});

test("закрытый пункт называет наблюдение в result или evidence", async () => {
  const { harness, goalId } = await setup();
  const silent: GoalWorkState = { ...plan(), items: plan().items.map((item) => item.id === "work" ? { ...item, status: "done" } : item) };
  assert.equal(await stageOf(harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: silent })), "done_without_result");
  const observed: GoalWorkState = { ...plan(), items: plan().items.map((item) => item.id === "work" ? { ...item, status: "done", evidence: "Отказ открытых пунктов воспроизведён" } : item) };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: observed });
  assert.equal((await current(harness)).workState?.items[1]?.status, "done");
});

test("незавершённый пункт агента не исчезает из плана молча", async () => {
  const { harness, goalId } = await setup();
  const trimmed: GoalWorkState = { ...plan(), items: plan().items.filter((item) => item.id !== "later") };
  assert.equal(await stageOf(harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: trimmed })), "dropped_item");
  const cancelled: GoalWorkState = { ...plan(), items: plan().items.map((item) => item.id === "later" ? { ...item, status: "cancelled", result: "Итог свела другая задача" } : item) };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: cancelled });
  const closed: GoalWorkState = { ...cancelled, items: cancelled.items.map((item) => item.status === "active" ? { ...item, status: "done", result: "Отказ проверен" } : item) };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 2, state: closed });
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Проверяю", verification: "Оба отказа проверены", nextStep: "Закрыть цель" });
  await harness.runTool("update_goal", { status: "complete" });
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal(harness.snapshot().goal?.status, "complete");
});

test("препятствие при доступной работе не удерживает продолжение", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), items: plan().items.map((item) => item.id === "work" ? { ...item, status: "blocked", result: "Нужен доступ к стенду" } : item) } });
  await harness.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "Упёрся в доступ", problemOrDecision: "Стенд недоступен", nextStep: "Продолжить остальные пункты", needUser: "Доступ к стенду" });
  assert.equal((await current(harness)).continuationHeld, false);

  const onlyBlocked: GoalWorkState = { ...plan(), items: plan().items.map((entry) => ({ ...entry, status: "blocked" as const, result: "Нужен доступ к стенду" })) };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 2, state: onlyBlocked });
  await harness.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "Все шаги упираются", problemOrDecision: "Без доступа дальше нельзя", nextStep: "Ждать доступа", needUser: "Доступ к стенду" });
  assert.equal((await current(harness)).continuationHeld, true);
});
