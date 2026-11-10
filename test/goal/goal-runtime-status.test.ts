import assert from "node:assert/strict";
import test from "node:test";

import { createGoalRuntimeStatus, formatGoalProgressWidget } from "../../src/goal/goal-runtime-status.js";
import { createGoalReportState, type GoalProgressHistoryEntry } from "../../src/goal/goal-reports.js";
import { createThreadGoal } from "../../src/goal/state.js";

function historyEntry(reportId: string, phase: string, completed: string): GoalProgressHistoryEntry {
  return {
    reportId,
    createdAt: 1,
    eventKind: "progress_checkpoint",
    report: { status: "working", phase, completed, nextStep: "Продолжить." },
  };
}

test("pure progress formatter keeps the compact lifecycle shape", () => {
  const goal = createThreadGoal("Проверить статус");
  goal.usage.activeSeconds = 720;
  const state = createGoalReportState();
  state.recentReports = [
    historyEntry("one", "Подготовка", "Подготовил входные данные."),
    historyEntry("two", "Проверка", "Проверил результат."),
    historyEntry("three", "Формулирую вывод", "Собрал вывод."),
  ];
  assert.deepEqual(formatGoalProgressWidget(goal, state), [
    "Работаю · 12m",
    "✓ Подготовил входные данные.",
    "✓ Проверил результат.",
    "→ Формулирую вывод",
  ]);
});

test("refreshUi writes only the current live state to setStatus", () => {
  const goal = createThreadGoal("Проверить footer");
  const state = createGoalReportState();
  state.lastReport = { status: "verifying", phase: "Проверяю TUI", nextStep: "Продолжить." };
  const statuses: Array<string | undefined> = [];
  let widgetCalls = 0;
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal.status,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
    getReportState: () => state,
    setActivity: () => undefined,
  });
  const ctx = { ui: {
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
    setWidget() { widgetCalls++; },
  } };

  status.refreshUi(ctx);

  assert.match(statuses.at(-1) ?? "", /^Проверяю · 0s$/);
  assert.equal(widgetCalls, 0);
  status.stopStatusRefresh(true);
  assert.equal(statuses.at(-1), undefined);
});

test("awaiting and blocker states are visible in the footer and stale blocker clears after a new run", () => {
  const goal = createThreadGoal("Проверить блокер");
  const state = createGoalReportState();
  state.lastReportId = "blocked-1";
  state.lastReport = { status: "blocked", phase: "Нет доступа", nextStep: "Повторить" };
  let sequence = 0;
  let current = "";
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal.status,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
    getReportState: () => state,
    getAgentRunSequence: () => sequence,
    setActivity: () => undefined,
  });
  const ctx = { ui: { setStatus(_key: string, value: string | undefined) { current = value ?? ""; } } };

  status.refreshUi(ctx);
  assert.match(current, /^Заблокировано ·/);
  sequence++;
  status.refreshUi(ctx);
  assert.match(current, /^Работаю ·/);
  state.awaitingUser = true;
  state.hasUserDecisionSinceAwaiting = false;
  status.refreshUi(ctx);
  // blocked держит продолжение, но заголовок не выдаёт его за вопрос пользователю.
  assert.match(current, /^Работаю ·/);
  state.lastReportId = "awaiting-1";
  state.lastReport = { status: "awaiting_user", phase: "Выбор адреса", nextStep: "Получить ответ", needUser: "Выбрать адрес" };
  state.requiresUserDecision = true;
  status.refreshUi(ctx);
  assert.match(current, /^Жду ответа ·/);
  status.stopStatusRefresh(true);
});

test("paused and completed goals remain visible until explicit dismissal", () => {
  const goal = createThreadGoal("Проверить завершение");
  let current: string | undefined;
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal.status,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
    getReportState: createGoalReportState,
    setActivity: () => undefined,
  });
  const ctx = { ui: { setStatus(_key: string, value: string | undefined) { current = value; } } };

  goal.status = "paused";
  status.refreshUi(ctx);
  assert.match(current ?? "", /^На паузе ·/);
  goal.status = "complete";
  status.refreshUi(ctx);
  assert.match(current ?? "", /^✓ Завершена ·/);
  status.dismissCompletedGoal(ctx);
  assert.equal(current, undefined);
});

test("legacy toggle compatibility never mounts a widget", () => {
  const goal = createThreadGoal("Проверить alias");
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal.status,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
    getReportState: createGoalReportState,
    setActivity: () => undefined,
  });
  status.toggleWidget({ ui: { setStatus() {} } });
  status.stopStatusRefresh(true);
});
