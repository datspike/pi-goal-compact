import { goalHistoryText } from "../support/goal-history.js";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { createThreadGoal } from "../../src/goal/state.js";
import { artifactDir, artifactFilePath, goalFilePath } from "../../src/goal/goal-artifacts.js";
import { GOAL_MANAGED_ARTIFACT_NAMES } from "../../src/goal/types.js";
import { reconstructGoalProjectionState } from "../../src/goal/goal-projections.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import { GOAL_PROGRESS_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import { createExpandedRuntimeHarness as createRuntimeHarness, runTurn } from "../support/runtime-harness.js";
import { harnessCwd } from "../support/runtime-harness.js";

async function latestPublishedArtifactNames(harness: ReturnType<typeof createRuntimeHarness>): Promise<string[]> {
  const result = await harness.runTool("get_goal", {}) as { details: { artifactRefs: Array<{ artifact: string }> } };
  return result.details.artifactRefs.map((ref) => ref.artifact);
}

test("managed artifact contract excludes CONTEXT-MAP while preserving legacy names", () => {
  assert.deepEqual(GOAL_MANAGED_ARTIFACT_NAMES, ["GOAL"]);
});

test("projection replay rejects malformed projection entries", () => {
  const goal = createThreadGoal("Проверить повреждение", null, 10);
  assert.throws(() => reconstructGoalProjectionState([
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "unknown", idempotencyKey: "bad", goalId: goal.goalId } },
  ], goal), /Malformed goal projection event/);
});

test("projection state reconstructs only branch-local durable projection events", () => {
  const goal = createThreadGoal("Проверить восстановление", null, 10);
  const other = createThreadGoal("Чужая цель", null, 10);
  const entries = [
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "goal_created", idempotencyKey: `init:${goal.goalId}`, goalId: goal.goalId, goal } },
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "progress_reported", idempotencyKey: "report:1", goalId: goal.goalId, reportId: "1", report: { status: "verifying", phase: "проверка", verification: "Тесты проходят.", nextStep: "Завершить." } } },
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "goal_created", idempotencyKey: `init:${other.goalId}`, goalId: other.goalId, goal: other } },
  ];
  const state = reconstructGoalProjectionState(entries, goal);
  assert.equal(state.goalId, goal.goalId);
  assert.equal(state.stateSeq, 2);
  assert.equal(state.latestReportId, "1");
  assert.equal(state.latestProgress?.status, "verifying");
});

test("terminal projection keeps the final verifying report", () => {
  const goal = createThreadGoal("Проверить завершение", null, 10);
  const verifying = { status: "verifying" as const, phase: "проверка", verification: "Тесты проходят.", nextStep: "Завершить." };
  const completed = { ...goal, status: "complete" as const, updatedAt: goal.updatedAt + 1 };
  const state = reconstructGoalProjectionState([
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "goal_created", idempotencyKey: `init:${goal.goalId}`, goalId: goal.goalId, goal } },
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "progress_reported", idempotencyKey: "report:1", goalId: goal.goalId, reportId: "1", report: verifying } },
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "goal_completed", idempotencyKey: "complete:1", goalId: goal.goalId, goal: completed } },
  ], goal);
  assert.equal(state.status, "complete");
  assert.deepEqual(state.latestProgress, verifying);
  assert.equal(state.latestReportId, "1");
});

test("immediate completion waits for bootstrap and leaves terminal CURRENT", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Завершить сразу", token_budget: null });
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal(harness.snapshot().goal?.status, "complete");
  const current = await readFile(goalFilePath(harnessCwd, goal.goalId), "utf8");
  assert.match(current, /Завершить сразу/);
  assert.match(current, /Завершена/);
  assert.doesNotMatch(current, /Цель создана\\. Статус: Активна/);
});

test("completion retains the final entry through reload until goal clear", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Показать итог наблюдаемости", token_budget: null });
  await harness.runTool("report_goal_progress", {
    action: "publish", eventKind: "verification", status: "verifying", phase: "Проверил результат",
    summary: "Проверил результат и сохранил итог. Теперь можно завершить цель.",
    verification: "Проверка завершена успешно.", nextStep: "Завершить цель.",
  });
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal(harness.snapshot().goal?.status, "complete");
  assert.equal(harness.widgetText(), "✓ Завершена · 0s");
  assert.equal(harness.widgets.at(-1), undefined);
  assert.ok(harness.entries.some((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "goal_completed"));
  const projectionEntries = harness.entries.filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE);
  const created = projectionEntries.find((entry) => (entry.data as { kind?: string }).kind === "goal_created");
  const completed = projectionEntries.find((entry) => (entry.data as { kind?: string }).kind === "goal_completed");
  assert.match((harness.renderEntry(GOAL_PROJECTION_ENTRY_TYPE, created?.data) ?? []).join("\n"), /Цель создана/);
  assert.match((harness.renderEntry(GOAL_PROJECTION_ENTRY_TYPE, completed?.data) ?? []).join("\n"), /Цель завершена/);
  await rm(goalFilePath(harnessCwd, harness.snapshot().goal!.goalId), { force: true });
  await harness.reloadSession("reload");
  const goalPath = goalFilePath(harnessCwd, harness.snapshot().goal!.goalId);
  const expectedGoal = /Показать итог наблюдаемости/;
  const deadline = Date.now() + 4_000;
  let goalFile = "";
  while (Date.now() < deadline) {
    goalFile = await readFile(goalPath, "utf8").catch(() => "");
    if (expectedGoal.test(goalFile)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(goalFile, expectedGoal);
  assert.equal(harness.widgetText(), "✓ Завершена · 0s");
  await harness.runCommand("clear");
  assert.equal(harness.snapshot().goal, null);
  assert.equal(harness.widgets.at(-1), undefined);
  assert.equal(harness.footerStatuses.at(-1), undefined);
});

test("completed widget hides after external input but not extension continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Скрыть итоговый виджет", token_budget: null });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    eventKind: "verification",
    status: "verifying",
    phase: "Проверил результат",
    summary: "Проверил результат и сохранил итог.",
    verification: "Проверка завершена успешно.",
    nextStep: "Завершить цель.",
  });
  await harness.runTool("update_goal", { status: "complete" });
  assert.match(harness.widgetText(), /✓ Завершена/);
  await harness.emit("input", { type: "input", text: "Продолжение от расширения", source: "extension" });
  assert.match(harness.widgetText(), /✓ Завершена/);
  await harness.emit("input", { type: "input", text: "Новое сообщение пользователя", source: "interactive" });
  assert.equal(harness.widgets.at(-1), undefined);
  await harness.runCommand("Новая цель после завершения");
  assert.match(harness.widgetText(), /^Работаю ·/);
});

test("canonical completion persistence failure is retryable after reload", async () => {
  const harness = createRuntimeHarness({ failCanonicalCompletePersists: 1 });
  await harness.runTool("create_goal", { objective: "Повторить завершение", token_budget: null });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "verifying",
    phase: "проверка",
    verification: "Тесты проходят.",
    nextStep: "Завершить.",
  });
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /canonical completion persistence failure/);
  assert.equal(harness.snapshot().goal?.status, "active");
  await harness.reloadSession("reload");
  assert.equal(harness.snapshot().goal?.status, "active");
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal(harness.snapshot().goal?.status, "complete");
  const current = await readFile(goalFilePath(harnessCwd, harness.snapshot().goal!.goalId), "utf8");
  assert.match(current, /Завершена/);
});

test("rejected first report keeps a durable repair gate across reload before clean completion", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Восстановить языковую блокировку", token_budget: null });
  const badReport = {
    action: "publish" as const,
    status: "working" as const,
    phase: "проверка",
    changed: "Controlled flow validated, блокеры отсутствуют.",
    nextStep: "Controlled flow validated, блокеры отсутствуют.",
  };

  await assert.rejects(
    () => harness.runTool("report_goal_progress", badReport),
    (error: unknown) => {
      assert.match(String(error), /language repair required/);
      assert.match(String(error), /diagnostics=/);
      assert.doesNotMatch(String(error), /Controlled flow validated/);
      return true;
    },
  );
  const guide = await harness.runTool("load_goal_language_guide", {});
  const guideResult = (guide as { details: { result: { diagnostics: Array<{ artifact: string; code: string; field: string | null; length: number | null; limit: number | null; repair: string }>; guide: string[] } } }).details.result;
  const mixedDiagnostics = guideResult.diagnostics.filter((diagnostic) => diagnostic.artifact === "CURRENT" && diagnostic.code === "mixed-language");
  assert.deepEqual(mixedDiagnostics.map((diagnostic) => diagnostic.field), ["changed", "nextStep"]);
  assert.ok(mixedDiagnostics.every((diagnostic) => diagnostic.field && !diagnostic.field.includes(",")));
  assert.ok(guideResult.diagnostics.every((diagnostic) => !Object.prototype.hasOwnProperty.call(diagnostic, "excerpt")));
  assert.ok(guideResult.guide.some((line) => line.includes("Markdown")));
  await harness.reloadSession("reload");
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying progress report/);

  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "verifying",
    phase: "проверка",
    verification: "Проверка завершена.",
    nextStep: "Завершить цель.",
  });
  await harness.reloadSession("reload");
  const completed = await harness.runTool("update_goal", { status: "complete" });
  assert.equal((completed as { details: { status: string } }).details.status, "complete");
});

test("projection diagnostics attribute renderer-sanitized headings to the source field", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить привязку поля", token_budget: null });
  const nextStep = `# Заголовок\n${"слово ".repeat(116).trim()}`;
  await assert.rejects(() => harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "работа",
    changed: "Изменение подготовлено.",
    nextStep,
  }), /long-paragraph/);
  const guide = await harness.runTool("load_goal_language_guide", {}) as { details: { result: { diagnostics: Array<{ code: string; field: string | null }> } } };
  const diagnostic = guide.details.result.diagnostics.find((item) => item.code === "long-paragraph");
  assert.equal(diagnostic?.field, "nextStep");
});

test("projection-wide diagnostics remain replayable across reload", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить общую диагностику", token_budget: null });
  await assert.rejects(() => harness.runTool("report_goal_progress", {
    action: "publish",
    status: "verifying",
    phase: "проверка",
    changed: "Важно отметить факт.",
    completed: "Ключевой результат подтверждён.",
    verification: "По сути проверка работает.",
    nextStep: "Завершить проверку после исправления.",
  }), /ai-cluster/);
  const guide = await harness.runTool("load_goal_language_guide", {}) as { details: { result: { diagnostics: Array<{ code: string; field: string | null }> } } };
  assert.ok(guide.details.result.diagnostics.some((item) => item.code === "ai-cluster" && item.field === "projection"));
  await harness.reloadSession("reload");
  const reloadedGuide = await harness.runTool("load_goal_language_guide", {}) as { details: { result: { diagnostics: Array<{ code: string; field: string | null }> } } };
  assert.ok(reloadedGuide.details.result.diagnostics.some((item) => item.code === "ai-cluster" && item.field === "projection"));
});

test("historical TIMELINE language warnings do not block later progress reports", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Сохранить возможность продолжать отчёты", token_budget: null });

  for (const [phase, changed] of [
    ["Собираю результаты", "Проверка обеспечивает сохранение данных."],
    ["Проверяю журнал", "Важно отметить состояние журнала."],
    ["Готовлю вывод", "По сути проверка завершена."],
  ] as const) {
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "working",
      phase,
      changed,
      nextStep: "Продолжить проверку.",
    });
  }

  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "Фиксирую результат",
    changed: "Собрал результаты проверки.",
    nextStep: "Продолжить работу.",
  });
});


test("progress reports hide empty decision and paper-cut artifacts until content exists", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Показывать непустые артефакты", token_budget: null });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "старт",
    changed: "Начата фиксация решения.",
    nextStep: "Зафиксировать решение.",
  });
  assert.deepEqual(await latestPublishedArtifactNames(harness), ["GOAL"]);

  await harness.runTool("record_goal_note", {
    kind: "decision",
    title: "Показывать решения",
    decision: "Показывать файл после первой записи.",
    rationale: "Пустая ссылка только засоряет отчёт.",
  });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "решение",
    changed: "Зафиксировано решение.",
    nextStep: "Зафиксировать отложенную проблему.",
  });
  assert.deepEqual(await latestPublishedArtifactNames(harness), ["GOAL"]);

  await harness.runTool("record_goal_note", {
    kind: "paper_cut",
    title: "Проверить перенос",
    impact: "Длинный путь может занимать несколько строк.",
    severity: "low",
  });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "заметки",
    changed: "Добавлены заметки.",
    nextStep: "Продолжить работу.",
  });
  assert.deepEqual(await latestPublishedArtifactNames(harness), ["GOAL"]);
});

test("reload reconciles note projections and blank preparation is absent for a new goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить заметки", token_budget: null });
  await harness.runTool("record_goal_note", {
    kind: "decision",
    title: "Выбрать проверку",
    decision: "Проверка обязательна.",
    rationale: "Нужно сохранить доказательство результата.",
  });
  await harness.runTool("record_goal_note", {
    kind: "paper_cut",
    title: "Сократить вывод",
    impact: "Длинный вывод хуже читается.",
    severity: "low",
  });
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  await harness.reloadSession("reload");
  const decisions = await readFile(goalFilePath(harnessCwd, goal.goalId), "utf8");
  const paperCuts = decisions;
  assert.match(goalHistoryText(harness.entries, goal.goalId), /Выбрать проверку/);
  assert.match(decisions, /Выбрать проверку/);
  assert.match(decisions, /Решения для сверки/);
  assert.match(paperCuts, /Сократить вывод/);

  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "verifying",
    phase: "проверка",
    verification: "Тесты проходят.",
    nextStep: "Завершить.",
  });
  await harness.runTool("update_goal", { status: "complete" });
  const finalCurrent = await readFile(goalFilePath(harnessCwd, goal.goalId), "utf8");
  assert.match(finalCurrent, /Завершена/);
  await harness.runTool("create_goal", { objective: "Новая цель", token_budget: null, preparation_id: " " });
  assert.equal(harness.snapshot().goal?.objective, "Новая цель");
});

test("same-goal lifecycle transitions update the managed CURRENT projection", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить статус", token_budget: null });
  await harness.runTool("record_goal_note", {
    kind: "decision",
    title: "Подготовка",
    decision: "Проверка перехода статуса.",
    rationale: "Нужен managed projection state.",
  });
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  await harness.runCommand("pause");
  assert.equal(harness.snapshot().goal?.status, "paused");
  const current = await readFile(goalFilePath(harnessCwd, goal.goalId), "utf8");
  assert.match(current, /Приостановлена/);
});


test("runtime heading releases an old blocker on a new run and waiting on an actual user answer", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить переходы заголовка", token_budget: null });
  await harness.runTool("report_goal_progress", {
    action: "publish", eventKind: "blocker_opened", status: "blocked", phase: "Жду доступ",
    summary: "Для проверки нужен доступ. Продолжу после его получения.",
    problemOrDecision: "Сервис недоступен.", nextStep: "Проверить доступ повторно.",
  });
  await harness.emit("tool_execution_end", { type: "tool_execution_end", toolName: "report_goal_progress", toolCallId: "blocked", result: {}, isError: false });
  assert.match(harness.widgetText(), /^Заблокировано ·/);
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  assert.match(harness.widgetText(), /^Работаю ·/);
  await harness.runTool("report_goal_progress", {
    action: "publish", status: "awaiting_user", phase: "Уточняю адрес",
    summary: "Для проверки нужно выбрать адрес сервиса. Продолжу после ответа.",
    needUser: "Выбрать адрес сервиса.", nextStep: "Получить ответ.",
  });
  await harness.emit("tool_execution_end", { type: "tool_execution_end", toolName: "report_goal_progress", toolCallId: "waiting", result: {}, isError: false });
  assert.match(harness.widgetText(), /^Жду ответа ·/);
  await harness.emit("input", { type: "input", text: "Используй тестовый адрес", source: "interactive" });
  assert.match(harness.widgetText(), /^Жду ответа ·/);
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Проверяю адрес", changed: "Выбран тестовый адрес.", nextStep: "Проверить доступ." });
  await harness.emit("tool_execution_end", { type: "tool_execution_end", toolName: "report_goal_progress", toolCallId: "answered", result: {}, isError: false });
  assert.match(harness.widgetText(), /^Работаю ·/);
  await harness.runCommand("clear");
});

test("get_goal returns the compact working snapshot while durable history remains available", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить компактное состояние", token_budget: null });
  for (let index = 0; index < 3; index += 1) {
    await harness.runTool("report_goal_progress", {
      action: "publish", status: "working", phase: `этап ${index + 1}`,
      summary: `Проверен этап ${index + 1}. Продолжаю следующий шаг.`,
      changed: `Сохранён результат этапа ${index + 1}.`, nextStep: "Проверить следующий этап.",
    });
  }
  const result = await harness.runTool("get_goal", {});
  const details = (result as { details: Record<string, unknown> }).details;
  assert.equal(details.currentStep, "этап 3");
  assert.equal(details.nextStep, "Проверить следующий этап.");
  assert.equal(details.lifecycle, "active");
  assert.equal("objective" in details, false);
  assert.equal("recentReports" in details, false);
  assert.deepEqual(details.history, { source: "session-events" });
  assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "progress_reported").length, 3);
});

test("bounded responses stay compact at 1, 10, and 100 reports while history replays", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить границу контекста", token_budget: null });
  for (let index = 0; index < 100; index += 1) {
    const response = await harness.runTool("report_goal_progress", {
      action: "publish", status: "working", phase: `шаг ${index + 1}`,
      summary: `Проверен шаг ${index + 1}. Продолжаю следующий.`, changed: "Сохранён один факт.", nextStep: "Продолжить.",
    }) as { content: Array<{ text: string }> };
    assert.ok(response.content[0]!.text.length < 3_000);
  }
  const beforeReload = harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "progress_reported").length;
  assert.equal(beforeReload, 100);
  await harness.reloadSession("reload");
  const goal = await harness.runTool("get_goal", {});
  const text = (goal as { content: Array<{ text: string }> }).content[0]!.text;
  assert.ok(text.length < 3_000);
  assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "progress_reported").length, 100);
});

test("legacy replay feeds get_goal and hidden continuation with the ordered working snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить legacy consumers", token_budget: null });
  const goal = harness.snapshot().goal!;
  harness.entries.push(
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-check", parentId: null, timestamp: new Date(100).toISOString(), data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy-check", createdAt: 100, turnIndex: 1, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual", report: { status: "verifying", phase: "Проверка", verification: "Legacy проверка сохранена.", nextStep: "Перейти дальше." } } },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-working", parentId: null, timestamp: new Date(101).toISOString(), data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy-working", createdAt: 1, turnIndex: 2, activeSeconds: 2, tokensUsed: 2, triggerReason: "manual", report: { status: "working", phase: "Legacy продолжение", nextStep: "Завершить legacy шаг." } } },
  );
  await harness.reloadSession("reload");
  const result = await harness.runTool("get_goal", {}) as { details: { currentStep: string; nextStep: string; latestUsefulVerification: string } };
  assert.equal(result.details.currentStep, "Legacy продолжение");
  assert.equal(result.details.nextStep, "Завершить legacy шаг.");
  assert.equal(result.details.latestUsefulVerification, "Legacy проверка сохранена.");
  const hidden = (await runTurn(harness, 0)).entries.map((entry) => String(entry.content)).join("\\n");
  assert.match(hidden, /Legacy продолжение/);
  assert.match(hidden, /Завершить legacy шаг/);
  assert.match(hidden, /Legacy проверка сохранена\./);
  harness.entries.push({ type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, id: "canonical-newer", parentId: null, timestamp: new Date(102).toISOString(), data: { kind: "progress_reported", idempotencyKey: "canonical-newer", goalId: goal.goalId, reportId: "canonical-newer", createdAt: 2, eventKind: "verification", reportAnchor: { turnIndex: 5, activeSeconds: 5, tokensUsed: 5, assistantTurns: 5 }, report: { status: "verifying", phase: "Canonical проверка", summary: "Провёл новую canonical проверку. Следом продолжу.", verification: "Новая canonical проверка.", nextStep: "Canonical next." } } });
  await harness.reloadSession("reload");
  const mixed = await harness.runTool("get_goal", {}) as { details: { currentStep: string; nextStep: string; latestUsefulVerification: string } };
  assert.equal(mixed.details.currentStep, "Canonical проверка");
  assert.equal(mixed.details.nextStep, "Canonical next.");
  assert.equal(mixed.details.latestUsefulVerification, "Новая canonical проверка.");
  harness.entries.push({ type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, id: "canonical-anchorless", parentId: null, timestamp: new Date(103).toISOString(), data: { kind: "progress_reported", idempotencyKey: "canonical-anchorless", goalId: goal.goalId, reportId: "canonical-anchorless", createdAt: 3, eventKind: "progress_checkpoint", report: { status: "working", phase: "Anchorless продолжение", summary: "Проверил anchorless путь. Продолжаю.", verification: "Anchorless новая проверка.", nextStep: "Anchorless next." } } });
  await harness.reloadSession("reload");
  const anchorless = await harness.runTool("get_goal", {}) as { details: { currentStep: string; nextStep: string; latestUsefulVerification: string } };
  assert.equal(anchorless.details.currentStep, "Anchorless продолжение");
  assert.equal(anchorless.details.nextStep, "Anchorless next.");
  assert.equal(anchorless.details.latestUsefulVerification, "Anchorless новая проверка.");

});

test("legacy active replay feeds the ordinary continue caller", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить ordinary legacy continue", token_budget: null });
  const goal = harness.snapshot().goal!;
  harness.entries.push({ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-ordinary", parentId: null, timestamp: new Date(500).toISOString(), data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy-ordinary", createdAt: 500, turnIndex: 1, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual", report: { status: "working", phase: "Legacy ordinary phase", verification: "Legacy ordinary verification.", nextStep: "Legacy ordinary next." } } });
  await harness.reloadSession("reload");
  await harness.runSlashCommand("gp");
  harness.sentMessages.length = 0;
  const continuationResult = (await harness.continueGoal(goal.goalId));
  assert.equal(continuationResult.ok, true);
  const content = harness.sentMessages.map((item) => JSON.stringify(item.message)).join("\\n") + harness.sentUserMessages.map((item) => JSON.stringify(item)).join("\\n");
  assert.match(content, /Legacy ordinary phase/);
  assert.match(content, /Legacy ordinary verification\./);
});

test("legacy awaiting and paused replay preserve holds and resume context", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить legacy hold", token_budget: null });
  const goal = harness.snapshot().goal!;
  harness.entries.push({ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-awaiting", parentId: null, timestamp: new Date(200).toISOString(), data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy-awaiting", createdAt: 200, turnIndex: 2, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual", report: { status: "awaiting_user", phase: "Legacy hold", problemOrDecision: "Нужен выбор.", needUser: "Выберите вариант.", nextStep: "Дождаться ответа." } } });
  await harness.reloadSession("reload");
  const held = await harness.runTool("get_goal", {}) as { details: { blocker: string; needUser: string; continuationHeld: boolean; awaitingUser: boolean } };
  assert.equal(held.details.blocker, "Нужен выбор.");
  assert.equal(held.details.needUser, "Выберите вариант.");
  assert.equal(held.details.awaitingUser, true);
  assert.equal(held.details.continuationHeld, true);
  await harness.emit("input", { type: "input", text: "Выбираю вариант.", source: "interactive" });
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "После ответа", summary: "Продолжаю после решения. Следом завершу.", changed: "Получил решение пользователя.", nextStep: "Завершить." });
  await harness.runSlashCommand("gp");
  harness.sentUserMessages.length = 0;
  (await harness.continueGoal(goal.goalId));
  const resumed = harness.sentUserMessages.map((item) => JSON.stringify(item)).join("\\n");
  assert.match(resumed, /После ответа/);
  assert.match(resumed, /Завершить/);
  await harness.runSlashCommand("gc");
  await harness.runTool("create_goal", { objective: "Проверить legacy resume", token_budget: null });
  const pausedGoal = harness.snapshot().goal!;
  harness.entries.push({ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-resume", parentId: null, timestamp: new Date(400).toISOString(), data: { version: 1, kind: "publish", goalId: pausedGoal.goalId, reportId: "legacy-resume", createdAt: 400, turnIndex: 4, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual", report: { status: "working", phase: "Legacy paused phase", verification: "Legacy paused verification.", nextStep: "Legacy paused next." } } });
  await harness.reloadSession("reload");
  await harness.runSlashCommand("gp");
  harness.sentUserMessages.length = 0;
  (await harness.resumeGoal(pausedGoal.goalId));
  const pausedResume = harness.sentUserMessages.map((item) => JSON.stringify(item)).join("\\n");
  assert.match(pausedResume, /Legacy paused phase/);
  assert.match(pausedResume, /Legacy paused verification\./);
});
test("legacy clear and replacement do not retain the old working snapshot", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Старая legacy цель", token_budget: null });
  const goal = harness.snapshot().goal!;
  harness.entries.push({ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, id: "legacy-old", parentId: null, timestamp: new Date(300).toISOString(), data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy-old", createdAt: 300, turnIndex: 3, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual", report: { status: "working", phase: "Старый шаг", nextStep: "Старое продолжение." } } });
  await harness.reloadSession("reload");
  await harness.runSlashCommand("gc");
  await harness.reloadSession("reload");
  const cleared = await harness.runTool("get_goal", {}) as { details: { goal: unknown; currentStep: unknown; nextStep: unknown; latestUsefulVerification: unknown } };
  assert.equal(cleared.details.goal, null);
  assert.equal(cleared.details.currentStep, null);
  assert.equal(cleared.details.nextStep, null);
  assert.equal(cleared.details.latestUsefulVerification, null);
  await harness.runTool("create_goal", { objective: "Новая цель", token_budget: null });
  const fresh = await harness.runTool("get_goal", {}) as { details: { currentStep: unknown; nextStep: unknown; latestUsefulVerification: unknown } };
  assert.equal(fresh.details.currentStep, null);
  assert.equal(fresh.details.nextStep, null);
  assert.equal(fresh.details.latestUsefulVerification, null);
});

test("working snapshots retain the latest useful verification", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить полезную проверку", token_budget: null });
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "проверка", verification: "Проверка сохранена.", nextStep: "Продолжить." });
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "продолжение", changed: "Продолжил работу.", nextStep: "Завершить." });
  const result = await harness.runTool("get_goal", {});
  assert.equal((result as { details: { latestUsefulVerification: string } }).details.latestUsefulVerification, "Проверка сохранена.");
});
