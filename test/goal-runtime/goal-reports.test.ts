import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";

import {
  GOAL_PROGRESS_ENTRY_TYPE,
  createGoalProgressEntryComponent,
  createGoalReportState,
  formatGoalProgressReport,
  isGoalReportEntry,
  reconstructGoalReportState,
  reportDueReasons,
  type GoalReportAction,
  type GoalReportEntry,
} from "../../src/goal/goal-reports.js";
import { truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { createThreadGoal, updateGoalStatus } from "../../src/goal/state.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import {
  assistantMessage,
  createExpandedRuntimeHarness as createRuntimeHarness,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
  goalTickets,
  settleRun,
} from "../support/runtime-harness.js";
import { compactContinuationPrompt } from "../../src/goal/prompts.js";
import { progressReportParams } from "../../src/goal/tools.js";

/** Первая причина, по которой отчёт должен быть опубликован, или `null`. */
function reportDueReason(...args: Parameters<typeof reportDueReasons>) {
  return reportDueReasons(...args)[0] ?? null;
}

function reportParams() {
  return {
    action: "publish",
    status: "working",
    phase: "implementation",
    changed: "Added durable progress entries.",
    verification: "Typecheck is green.",
    nextStep: "Add focused tests.",
  };
}

function dueEntry(goalId: string): GoalReportEntry {
  return {
    version: 1,
    kind: "due",
    goalId,
    createdAt: 1,
    turnIndex: 7,
    activeSeconds: 0,
    tokensUsed: 0,
    dueReason: "periodic_turns",
  };
}

async function completeAssistantRun(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  const message = assistantMessage("stop", { input: 1, output: 1 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  await harness.emit("agent_end", { type: "agent_end", messages: [message] });
}

function toolUseMessage(name: string, stopReason: "toolUse" | "aborted" = "toolUse") {
  return {
    ...assistantMessage(stopReason, { input: 1, output: 1 }),
    content: [{ type: "toolCall" as const, id: "tool-call", name, arguments: {} }],
  };
}

async function completeReportActionTurn(
  harness: ReturnType<typeof createRuntimeHarness>,
  action: GoalReportAction,
  stopReason: "toolUse" | "aborted" = "toolUse",
  toolName = "report_goal_progress",
): Promise<void> {
  const message = toolUseMessage(toolName, stopReason);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runTool("report_goal_progress", action === "publish" ? reportParams() : { action });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  await harness.emit("agent_end", { type: "agent_end", messages: [message] });
}

async function completeUnrelatedToolUseTurn(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  const message = toolUseMessage("bash");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  await harness.emit("agent_end", { type: "agent_end", messages: [message] });
}

function dueEntryCount(harness: ReturnType<typeof createRuntimeHarness>): number {
  return harness.entries.filter(
    (entry) => entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE && (entry.data as GoalReportEntry).kind === "due",
  ).length;
}

function assertFitsDisplayWidth(value: string, width: number): void {
  assert.equal(truncateToVisualLines(value, 1, width).skippedCount, 0);
}

function assertNoUnpairedSurrogate(value: string): void {
  assert.doesNotMatch(value, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
}

test("report_goal_progress publishes a durable entry without starting a message or continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const messageCount = harness.sentMessages.length;
  const userMessageCount = harness.sentUserMessages.length;

  const result = (await harness.runTool("report_goal_progress", reportParams())) as {
    details: { reportId: string; state: { dueReason: string | null } };
  };

  assert.match(result.details.reportId, /^[0-9a-f-]{36}$/);
  assert.equal(result.details.state.dueReason, null);
  const events = harness.entries.filter((candidate) => candidate.type === "custom" && candidate.customType === GOAL_PROJECTION_ENTRY_TYPE && (candidate.data as { kind?: string }).kind === "progress_reported");
  assert.equal(events.length, 1);
  assert.equal(((events[0]! as { data: { report: { summary: string } } }).data).report.summary, "Проверил состояние цели. Продолжаю следующий шаг.");
  assert.equal(harness.entries.filter((candidate) => candidate.type === "custom" && candidate.customType === GOAL_PROGRESS_ENTRY_TYPE && (candidate.data as { kind?: string }).kind === "publish").length, 0);
  assert.equal(harness.sentMessages.length, messageCount);
  assert.equal(harness.sentUserMessages.length, userMessageCount);
});

test("only the model narrative is visible and repair events never become chat entries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить историю отчётов");
  const summary = "Проверил исходное состояние и зафиксировал границы. Теперь проверяю следующий шаг.";
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { ...reportParams(), summary, changed: "Controlled flow validated, блокеры отсутствуют." }),
    /language repair required/,
  );
  const repair = harness.entries.find((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "language_repair_required");
  assert.ok(repair && repair.type === "custom");
  assert.equal(harness.renderEntry(GOAL_PROJECTION_ENTRY_TYPE, repair.data), null);
  await harness.runTool("report_goal_progress", { ...reportParams(), summary });
  const published = harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "progress_reported");
  assert.equal(published.length, 1);
  const visible = harness.renderEntry(GOAL_PROJECTION_ENTRY_TYPE, (published[0]! as { data: unknown }).data);
  assert.equal(visible?.map((line) => line.trim()).join(" ").trim(), summary);
  assert.doesNotMatch(visible?.join("\n") ?? "", /Статус:|Следующий шаг:|Артефакты:|reportId/);
  await harness.reloadSession("reload");
  assert.equal(reconstructGoalReportState(harness.entries, harness.snapshot().goal!.goalId).lastReport?.summary, summary);
});

test("first rejected report blocks completion until a clean retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const bad = { ...reportParams(), changed: "Controlled flow validated, блокеры отсутствуют." };
  await assert.rejects(() => harness.runTool("report_goal_progress", bad), /language repair required/);
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying progress report/);
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Проверка завершена." });
  const completed = await harness.runTool("update_goal", { status: "complete" });
  assert.equal((completed as { details: { status: string } }).details.status, "complete");
});

test("semantic checkpoint dedup does not clear a pending language repair", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying" });
  const bad = { ...reportParams(), changed: "Controlled flow validated, блокеры отсутствуют." };
  await assert.rejects(() => harness.runTool("report_goal_progress", bad), /language repair required/);
  const duplicate = await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", eventKind: "progress_checkpoint" }) as { details: { reportId: string | null } };
  assert.equal(duplicate.details.reportId, null);
  assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "language_repair_cleared").length, 0);
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying progress report/);
});

test("language repair clears after a clean retry and does not leak into a replacement goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const bad = { ...reportParams(), changed: "Controlled flow validated, блокеры отсутствуют." };
  await assert.rejects(() => harness.runTool("report_goal_progress", bad), /language repair required/);
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Проверка завершена." });
  const completed = await harness.runTool("update_goal", { status: "complete" });
  assert.equal((completed as { details: { status: string } }).details.status, "complete");

  await harness.runCommand("new replacement");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new replacement");
  const replacementReport = { ...reportParams(), status: "verifying", changed: "Добавлен новый этап проверки.", verification: "Проверка завершена." };
  await harness.runTool("report_goal_progress", replacementReport);
  const replacementCompleted = await harness.runTool("update_goal", { status: "complete" });
  assert.equal((replacementCompleted as { details: { status: string } }).details.status, "complete");
});

test("amendment repair_required outcome is retryable and does not resume a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить amendment repair");
  const bad = { ...reportParams(), changed: "Controlled flow validated, блокеры отсутствуют." };
  await harness.runTool("report_goal_progress", reportParams());
  await assert.rejects(() => harness.runTool("report_goal_progress", bad), /language repair required/);
  await harness.runSlashCommand("gp");
  assert.equal(harness.snapshot().goal?.status, "paused");
  await assert.rejects(
    () => harness.runTool("amend_goal", { amendment: "Исправить проекцию." }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const payload = JSON.parse(error.message) as { applied: boolean; stage: string; retryable: boolean; remediation: string };
      assert.equal(payload.applied, true);
      assert.equal(payload.stage, "projection");
      assert.equal(payload.retryable, true);
      assert.match(payload.remediation, /load_goal_language_guide/);
      return true;
    },
  );
  assert.equal(harness.snapshot().goal?.status, "paused");
  await harness.runSlashCommand("gr");
  assert.equal(harness.snapshot().goal?.status, "paused");
  await harness.runTool("record_goal_note", { kind: "decision", title: "Проверка ремонта", decision: "Проверка завершена, исходный договор сохранён.", rationale: "Исправляем проекции до активации." });
  await harness.runSlashCommand("gr");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.snapshot().goal?.objective.includes("Исправить проекцию."), true);
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Проекция исправлена." });
  const retry = await harness.runTool("amend_goal", { amendment: "Исправить проекцию." }) as { details: { goal: { objective: string } } };
  assert.equal((retry.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 1);
});

test("repair_required amendment errors remain bounded after a long report history", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить bounded repair error");
  for (let index = 0; index < 100; index += 1) {
    await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Проверяю", summary: `Проверил шаг ${index}. Перехожу дальше.`, changed: `Изменил шаг ${index}.`, nextStep: "Продолжить." });
  }
  await assert.rejects(() => harness.runTool("report_goal_progress", { ...reportParams(), changed: "Controlled flow validated, блокеры отсутствуют." }), /language repair required/);
  await assert.rejects(
    () => harness.runTool("amend_goal", { amendment: "Ограниченное исправление." }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.length < 1200);
      assert.doesNotMatch(error.message, /progressEvents|decisions|paperCuts|appliedAmendments|Проверил шаг 99/);
      return true;
    },
  );
});

test("amendment blocks an immediate completion race and requires a new verifying report", async () => {


  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Проверка завершена." });
  await harness.runTool("amend_goal", { amendment: "Дополнительно проверить восстановление." });
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying progress report/);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying progress report/);
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Новая проверка завершена." });
  const completed = await harness.runTool("update_goal", { status: "complete" });
  assert.equal((completed as { details: { status: string } }).details.status, "complete");
});

test("report_goal_progress retries are idempotent for the same tool operation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const first = await harness.runTool("report_goal_progress", reportParams()) as { details: { reportId: string } };
  const second = await harness.runTool("report_goal_progress", reportParams()) as { details: { reportId: string } };
  assert.equal(second.details.reportId, first.details.reportId);
  assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "progress_reported").length, 1);
});

test("new publish requires a reader-facing summary", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить нарратив");
  const before = harness.entries.length;
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { ...reportParams(), summary: "" }),
    /publish requires status, phase, summary, and nextStep/,
  );
  assert.equal(harness.entries.length, before);
});

test("a report narrative rejects terminal controls before persistence and legacy display strips them", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить безопасность вывода");
  const before = harness.entries.length;
  const hostile = `Проверил состояние. \u001b]8;;${pathToFileURL("/etc/passwd").href}\u001b\\Открыть\u001b]8;;\u001b\\ Дальше проверю результат.`;
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { ...reportParams(), summary: hostile }),
    /summary must not contain terminal control characters/,
  );
  assert.equal(harness.entries.length, before);
  const rendered = createGoalProgressEntryComponent([hostile, "\u009b31mЦвет\u009b0m"]).render(120).join("\n");
  assert.doesNotMatch(rendered, /[\u001b\u009b]/);
});

test("report_goal_progress rejects missing, paused, and completed goals", async () => {
  const harness = createRuntimeHarness();
  await assert.rejects(() => harness.runTool("report_goal_progress", reportParams()), /active goal/);

  await harness.runCommand("ship reports");
  await harness.runCommand("pause");
  await assert.rejects(() => harness.runTool("report_goal_progress", reportParams()), /active goal/);

  await harness.runCommand("resume");
  await harness.runTool("update_goal", { status: "complete" });
  await assert.rejects(() => harness.runTool("report_goal_progress", reportParams()), /active goal/);
});

test("awaiting_user without needUser is rejected before it writes a report or hold", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const before = harness.entries.length;

  await assert.rejects(
    () => harness.runTool("report_goal_progress", { ...reportParams(), status: "awaiting_user" }),
    /needUser must be non-empty/,
  );

  assert.equal(harness.entries.length, before);
  const state = (await harness.runTool("report_goal_progress", reportParams())) as {
    details: { state: { awaitingUser: boolean } };
  };
  assert.equal(state.details.state.awaitingUser, false);
});

test("progress report schema has an object root and rejects unknown fields", () => {
  assert.equal(progressReportParams().type, "object");
  assert.equal(Check(progressReportParams(), { action: "suppress" }), true);
  assert.equal(Check(progressReportParams(), { action: "suppress", phase: "лишнее" }), true);
  assert.equal(Check(progressReportParams(), { action: "publish", status: "working", phase: "работа", nextStep: "Продолжить." }), true);
  assert.equal(Check(progressReportParams(), { action: "publish", status: "awaiting_user", phase: "решение", nextStep: "Дождаться ответа." }), true);
  assert.equal(Check(progressReportParams(), { action: "publish", status: "working", phase: "работа", nextStep: "Продолжить.", unknown: true }), false);
});

test("suppress rejects report fields before recording a side effect", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить ограниченный ответ");
  const before = harness.entries.length;
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { action: "suppress", phase: "лишнее" }),
    /suppress accepts only action/
  );
  assert.equal(harness.entries.length, before);
});


test("new publish reports require a meaningful status-specific delta", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "работа", nextStep: "Продолжить." }),
    /working requires at least one of changed, completed, problemOrDecision, riskAndComplexity, or verification/,
  );
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "проверка", nextStep: "Завершить." }),
    /verifying requires verification/,
  );
  await assert.rejects(
    () => harness.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "блокировка", nextStep: "Ждать решения." }),
    /blocked requires problemOrDecision/,
  );
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "blocked",
    phase: "блокировка",
    problemOrDecision: "Нужен доступ к тестовой среде.",
    nextStep: "Запросить доступ.",
  });
});

test("report_goal_progress suppresses a due report without a visible publish entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  harness.entries.push({
    type: "custom",
    id: "report-due",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: GOAL_PROGRESS_ENTRY_TYPE,
    data: dueEntry(goalId),
  });
  await harness.reloadSession();

  const result = (await harness.runTool("report_goal_progress", { action: "suppress" })) as {
    details: { reportId: string | null; state: { dueReason: string | null } };
  };
  assert.equal(result.details.reportId, null);
  assert.equal(result.details.state.dueReason, null);
  const entries = harness.entries.filter(
    (entry) => entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE,
  );
  const lastEntry = entries.at(-1);
  assert.ok(lastEntry && lastEntry.type === "custom");
  assert.equal((lastEntry.data as GoalReportEntry).kind, "suppress");
});

test("report state ignores legacy mode entries and duplicate report ids", () => {
  const goal = createThreadGoal("ship reports");
  const report: GoalReportEntry = {
    version: 1,
    kind: "publish",
    goalId: goal.goalId,
    reportId: "same-report",
    createdAt: 20,
    turnIndex: 3,
    activeSeconds: 12,
    tokensUsed: 30,
    triggerReason: "manual",
    report: { status: "working", phase: "implementation", nextStep: "test" },
  };
  const state = reconstructGoalReportState(
    [
      { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: { version: 1, kind: "mode", mode: "critical", createdAt: 1 } },
      { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: report },
      { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: { ...report, createdAt: 21, activeSeconds: 99 } },
      { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: dueEntry(goal.goalId) },
    ],
    goal.goalId,
  );

  assert.deepEqual(state.policy, { afterActiveSeconds: 500, afterAssistantTurns: 30 });
  assert.equal(state.lastReportId, "same-report");
  assert.equal(state.lastReportAt, 20);
  assert.equal(state.lastActionActiveSeconds, 12);
  assert.equal(state.dueReason, "periodic_turns");
});

test("legacy replay retains useful verification beyond the recent report window", () => {
  const goal = createThreadGoal("Проверить legacy verification");
  const entries = Array.from({ length: 12 }, (_, index) => ({
    type: "custom" as const,
    customType: GOAL_PROGRESS_ENTRY_TYPE,
    data: {
      version: 1 as const,
      kind: "publish" as const,
      goalId: goal.goalId,
      reportId: `legacy-${index}`,
      createdAt: index + 1,
      turnIndex: index,
      activeSeconds: index,
      tokensUsed: index,
      triggerReason: "manual" as const,
      report: index === 0
        ? { status: "working" as const, phase: "Проверка", verification: "Сохранённая legacy проверка.", nextStep: "Продолжить." }
        : { status: "working" as const, phase: `Шаг ${index}`, nextStep: `Следующий шаг ${index}.` },
    },
  }));
  const state = reconstructGoalReportState(entries, goal.goalId);
  assert.equal(state.lastReport?.phase, "Шаг 11");
  assert.equal(state.latestUsefulVerification, "Сохранённая legacy проверка.");
});

test("replay uses the canonical report once even when a legacy duplicate follows it", () => {
  const goal = createThreadGoal("Проверить совместимый replay");
  const report = { status: "working" as const, phase: "Проверяю", summary: "Проверил начальное состояние. Следом выполню проверку.", changed: "Уточнил исходные условия.", nextStep: "Выполнить проверку." };
  const anchor = { turnIndex: 3, activeSeconds: 12, tokensUsed: 30, assistantTurns: 4 };
  const entries = [
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { kind: "progress_reported", idempotencyKey: "report:same", goalId: goal.goalId, reportId: "same", createdAt: 20, report, reportAnchor: anchor } },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: { version: 1, kind: "publish", goalId: goal.goalId, reportId: "same", createdAt: 21, ...anchor, triggerReason: "manual", report } },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: dueEntry(goal.goalId) },
  ];
  const state = reconstructGoalReportState(entries, goal.goalId);
  assert.equal(state.lastReportAt, 20);
  assert.equal(state.lastActionActiveSeconds, 12);
  assert.equal(state.lastReport?.summary, report.summary);
  assert.equal(state.recentReports.length, 1);
  assert.equal(state.dueReason, "periodic_turns");
});

test("awaiting_user blocks hidden continuation after agent end and willRetry compaction but preserves normal input", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  harness.sentMessages.length = 0;
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "awaiting_user", needUser: "Choose the import path." });

  await harness.emit("input", { type: "input", text: "Use the documented path.", source: "interactive" });
  assert.ok(harness.entries.some((entry) => entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "user_input"));
  await harness.reloadSession();
  await harness.emit("message_start", {
    type: "message_start",
    message: { role: "user", content: "Use the documented path." },
  });
  await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })] });
  assert.equal((await settleRun(harness)).continued, false);
  await harness.emit("session_compact", sessionCompactEvent({ willRetry: true }));
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(harness.sentMessages.length, 0);
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "working" });
  await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })] });
  assert.equal((await settleRun(harness)).continued, true);
});

test("awaiting_user is a durable reducer-derived continuation hold released only after an ordinary user decision and working", () => {
  const goal = createThreadGoal("ship reports");
  const publish = (reportId: string, status: "working" | "verifying" | "blocked" | "awaiting_user"): GoalReportEntry => ({
    version: 1,
    kind: "publish",
    goalId: goal.goalId,
    reportId,
    createdAt: 1,
    turnIndex: 0,
    activeSeconds: 0,
    tokensUsed: 0,
    triggerReason: "manual",
    report: { status, phase: "implementation", nextStep: "next" },
  });
  const heldWithoutDecision = reconstructGoalReportState([
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: publish("waiting", "awaiting_user") },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: publish("working", "working") },
  ], goal.goalId);
  assert.equal(heldWithoutDecision.awaitingUser, true);

  const released = reconstructGoalReportState([
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: publish("waiting", "awaiting_user") },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: { version: 1, kind: "user_decision", goalId: goal.goalId, createdAt: 2 } },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: { version: 1, kind: "user_decision", goalId: goal.goalId, createdAt: 3 } },
    { type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: publish("working", "working") },
  ], goal.goalId);
  assert.equal(released.awaitingUser, false);
});

test("legacy publish and suppress entries anchor cadence to the durable assistant counter across reload", () => {
  const goal = createThreadGoal("ship reports");
  for (const kind of ["publish", "suppress"] as const) {
    const legacy: GoalReportEntry = kind === "publish"
      ? {
          version: 1, kind, goalId: goal.goalId, reportId: `legacy-${kind}`, createdAt: 1,
          turnIndex: 100, activeSeconds: 0, tokensUsed: 0, triggerReason: "manual",
          report: { status: "working", phase: "implementation", nextStep: "next" },
        }
      : { version: 1, kind, goalId: goal.goalId, createdAt: 1, turnIndex: 100, activeSeconds: 0, tokensUsed: 0 };
    const entries = [
      { type: "custom" as const, customType: GOAL_PROGRESS_ENTRY_TYPE, data: legacy },
      ...Array.from({ length: 30 }, (_, index) => ({
        type: "custom" as const,
        customType: GOAL_PROGRESS_ENTRY_TYPE,
        data: { version: 1 as const, kind: "assistant_turn" as const, goalId: goal.goalId, createdAt: index + 2, turnIndex: index, activeSeconds: 0, tokensUsed: 0, assistantTurns: index + 1 },
      })),
    ];
    const state = reconstructGoalReportState(entries, goal.goalId);
    assert.equal(state.lastActionTurn, 0, kind);
    assert.equal(reportDueReason(state, goal, 200), "periodic_turns", kind);
  }
});

test("model-created objectives can start with reports", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("reports API latency");
  assert.equal(harness.snapshot().goal?.objective, "reports API latency");
});

test("report diagnostics do not add a slash command or persist a mode entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship reports" });
  assert.deepEqual(harness.commandNames().sort(), ["context", "gc", "gp", "gr", "gs", "gw"]);
  assert.equal(harness.entries.some((entry) => entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE && (entry.data as { kind?: string }).kind === "mode"), false);
});

test("configured due calculation uses durable completed assistant turns and reports simultaneous thresholds", () => {
  const goal = createThreadGoal("ship reports");
  const state = createGoalReportState({ afterActiveSeconds: 600, afterAssistantTurns: 30 });
  assert.equal(reportDueReason({ ...state, assistantTurns: 29 }, { ...goal, usage: { tokensUsed: 0, activeSeconds: 599 } }, 99), null);
  assert.equal(reportDueReason({ ...state, assistantTurns: 30 }, { ...goal, usage: { tokensUsed: 0, activeSeconds: 599 } }, 0), "periodic_turns");
  assert.equal(reportDueReason(state, { ...goal, usage: { tokensUsed: 0, activeSeconds: 600 } }, 0), "periodic_time");
  assert.deepEqual(reportDueReasons({ ...state, assistantTurns: 30 }, { ...goal, usage: { tokensUsed: 0, activeSeconds: 600 } }, 0), ["periodic_time", "periodic_turns"]);
});

test("thirty separate assistant runs create one durable turn-based due and action anchors restart the count", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");

  for (let index = 0; index < 30; index += 1) {
    await completeAssistantRun(harness);
    await harness.reloadSession();
  }

  const dueEntries = harness.entries.filter((entry) => {
    return entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE && (entry.data as GoalReportEntry).kind === "due";
  });
  assert.equal(dueEntries.length, 1);
  const firstDue = dueEntries[0];
  assert.ok(firstDue && firstDue.type === "custom");
  assert.equal((firstDue.data as Extract<GoalReportEntry, { kind: "due" }>).dueReason, "periodic_turns");

  await completeReportActionTurn(harness, "suppress");
  for (let index = 0; index < 29; index += 1) {
    await completeAssistantRun(harness);
  }
  assert.equal(dueEntryCount(harness), 1);
  await completeAssistantRun(harness);
  assert.equal(dueEntryCount(harness), 2);
});

test("report actions restart turn cadence after thirty subsequent turns across reload", async () => {
  for (const action of ["publish", "suppress"] as const) {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship reports");
    await completeReportActionTurn(harness, action);
    await harness.reloadSession();

    for (let index = 0; index < 29; index += 1) {
      await completeAssistantRun(harness);
      await harness.reloadSession();
    }
    assert.equal(dueEntryCount(harness), 0, `${action}: no due after twenty-nine subsequent turns`);

    await completeAssistantRun(harness);
    await harness.reloadSession();
    assert.equal(dueEntryCount(harness), 1, `${action}: one due after thirty subsequent turns`);
  }
});

test("namespaced report actions also exclude their own turn from cadence", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  await completeReportActionTurn(harness, "suppress", "toolUse", "pi__report_goal_progress");

  for (let index = 0; index < 29; index += 1) {
    await completeAssistantRun(harness);
  }
  assert.equal(dueEntryCount(harness), 0);
  await completeAssistantRun(harness);
  assert.equal(dueEntryCount(harness), 1);
});

test("aborted report actions also exclude their own turn from cadence across reload", async () => {
  for (const action of ["publish", "suppress"] as const) {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship reports");
    await completeReportActionTurn(harness, action, "aborted");
    await harness.runCommand("resume");
    await harness.reloadSession();

    for (let index = 0; index < 29; index += 1) {
      await completeAssistantRun(harness);
      await harness.reloadSession();
    }
    assert.equal(dueEntryCount(harness), 0, `${action}: no due after twenty-nine turns following an aborted action`);

    await completeAssistantRun(harness);
    await harness.reloadSession();
    assert.equal(dueEntryCount(harness), 1, `${action}: one due after thirty turns following an aborted action`);
  }
});

test("ordinary toolUse turns continue to count toward report cadence", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");

  for (let index = 0; index < 29; index += 1) {
    await completeAssistantRun(harness);
  }
  assert.equal(dueEntryCount(harness), 0);

  await completeUnrelatedToolUseTurn(harness);
  assert.equal(dueEntryCount(harness), 1);
});

test("legacy mode entries do not cancel a pending due across reload", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  harness.entries.push({ type: "custom", id: "report-due", parentId: null, timestamp: new Date(0).toISOString(), customType: GOAL_PROGRESS_ENTRY_TYPE, data: dueEntry(goalId) });
  harness.entries.push({ type: "custom", id: "report-mode", parentId: null, timestamp: new Date(0).toISOString(), customType: GOAL_PROGRESS_ENTRY_TYPE, data: { version: 1, kind: "mode", mode: "off", createdAt: 2 } });
  await harness.reloadSession();
  const result = await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "ordinary user work", systemPrompt: "base" });
  assert.equal(result[0], undefined);
  assert.equal(reconstructGoalReportState(harness.entries, goalId).dueReason, "periodic_turns");
});

test("pending due blocks a compaction due entry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const goalId = harness.snapshot().goal?.goalId;
  assert.ok(goalId);
  harness.entries.push({ type: "custom", id: "report-due", parentId: null, timestamp: new Date(0).toISOString(), customType: GOAL_PROGRESS_ENTRY_TYPE, data: dueEntry(goalId) });
  await harness.reloadSession();
  await harness.emit("session_compact", sessionCompactEvent());

  const dueEntries = harness.entries.filter((entry) => entry.type === "custom" && entry.customType === GOAL_PROGRESS_ENTRY_TYPE && (entry.data as GoalReportEntry).kind === "due");
  assert.equal(dueEntries.length, 1);
});

test("session_compact marks an active balanced goal due with the compaction reason", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  await harness.emit("session_before_compact", sessionBeforeCompactEvent());
  await harness.emit("session_compact", sessionCompactEvent());

  const due = harness.entries.find((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === GOAL_PROGRESS_ENTRY_TYPE &&
      (entry.data as GoalReportEntry).kind === "due"
    );
  });
  assert.ok(due && due.type === "custom");
  assert.equal((due.data as Extract<GoalReportEntry, { kind: "due" }>).dueReason, "compaction");
});

async function startDueGoal(harness: ReturnType<typeof createRuntimeHarness>, dueReason: "periodic_turns" | "compaction" = "periodic_turns") {
  await harness.runCommand("ship reports");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.entries.push({
    type: "custom",
    id: "report-due",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: GOAL_PROGRESS_ENTRY_TYPE,
    data: { ...dueEntry(goal.goalId), dueReason },
  });
  await harness.reloadSession();
  harness.sentMessages.length = 0;
  return goal;
}

async function endToolUseTurn(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: toolUseMessage("bash"), toolResults: [] });
}

function dueNudges(harness: ReturnType<typeof createRuntimeHarness>) {
  return harness.sentMessages.filter((sent) => sent.message.customType === "goal-compact-progress-due");
}

test("a pending report never changes the system prompt, so the provider prompt cache stays valid", async () => {
  const harness = createRuntimeHarness();
  const goal = await startDueGoal(harness, "compaction");
  const ordinary = { type: "before_agent_start", prompt: "ordinary user work", systemPrompt: "base" };
  // Ни один обработчик не возвращает системный промпт.
  assert.ok((await harness.emit("before_agent_start", ordinary)).every((result) => result === undefined));
  assert.ok((await harness.emit("before_agent_start", { type: "before_agent_start", prompt: compactContinuationPrompt(goal), systemPrompt: "base" })).every((result) => result === undefined));
});

test("a pending report is steered into a running turn between tool calls, once per run", async () => {
  const harness = createRuntimeHarness();
  const goal = await startDueGoal(harness);

  await endToolUseTurn(harness);
  const nudges = dueNudges(harness);
  assert.equal(nudges.length, 1);
  assert.deepEqual(nudges[0]?.options, { deliverAs: "steer" });
  assert.equal(nudges[0]?.message.display, false);
  assert.deepEqual(nudges[0]?.message.details, { kind: "progress_due", goalId: goal.goalId, reason: "periodic_turns" });
  assert.match(String(nudges[0]?.message.content), /report_goal_progress/);

  await endToolUseTurn(harness);
  assert.equal(dueNudges(harness).length, 1);

  await harness.emit("agent_end", { type: "agent_end", messages: [] });
  await endToolUseTurn(harness);
  assert.equal(dueNudges(harness).length, 2);
});

test("a final answer turn is never nudged because a steer would force an extra turn", async () => {
  const harness = createRuntimeHarness();
  await startDueGoal(harness);
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 1, output: 1 }), toolResults: [] });
  assert.equal(dueNudges(harness).length, 0);
});

test("nothing is steered while the goal is paused", async () => {
  const harness = createRuntimeHarness();
  await startDueGoal(harness);
  await harness.runSlashCommand("gp");
  harness.sentMessages.length = 0;
  await endToolUseTurn(harness);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(dueNudges(harness).length, 0);
});

test("legacy progress instruction messages in old sessions stay neutralised", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship reports");
  const messages = [{ role: "custom", customType: "goal-compact-progress-instruction", content: "Call report_goal_progress", display: false, details: {}, timestamp: 1 }];
  const results = await harness.emit("context", { type: "context", messages }) as Array<{ messages?: unknown[] } | undefined>;
  const view = results.reduce<unknown[]>((current, result) => result?.messages ?? current, messages);
  assert.doesNotMatch(JSON.stringify(view), /report_goal_progress/);
});

test("short completed, paused, and budget-limited goals are never periodic-report due", () => {
  const goal = createThreadGoal("ship reports", 1);
  const state = createGoalReportState();
  const completed = updateGoalStatus(goal, "complete").goal;
  assert.ok(completed);
  assert.equal(reportDueReason(state, completed, 99), null);
  assert.equal(reportDueReason(state, { ...goal, status: "paused" }, 99), null);
  assert.equal(reportDueReason(state, { ...goal, status: "budgetLimited" }, 99), null);
});

test("progress renderer truncates emoji, CJK, and combining marks by display width", () => {
  for (const line of ["12345678😀tail", "12345678漢tail", "12345678e\u0301tail"]) {
    const [rendered] = createGoalProgressEntryComponent([line]).render(10);
    assert.ok(rendered);
    assertFitsDisplayWidth(rendered, 10);
    assertNoUnpairedSurrogate(rendered);
  }
});

test("progress renderer shows complete artifact paths and wraps them without truncation", () => {
  const entry: GoalReportEntry = {
    version: 1, kind: "publish", goalId: "goal", reportId: "report", createdAt: 0, turnIndex: 0,
    activeSeconds: 0, tokensUsed: 0, triggerReason: "manual",
    report: { status: "working", phase: "x", nextStep: "y" },
    artifactRefs: [
      { goalId: "goal", artifact: "CURRENT", revision: 1, path: pathToFileURL("/tmp/a-very-long-artifact-directory/CURRENT.md").href },
      { goalId: "goal", artifact: "DECISIONS", revision: 2, path: pathToFileURL("/tmp/a-very-long-artifact-directory/DECISIONS.md").href },
      { goalId: "goal", artifact: "PAPER-CUTS", revision: 3, path: pathToFileURL("/tmp/a-very-long-artifact-directory/PAPER-CUTS.md").href },
    ],
  };
  assert.deepEqual(formatGoalProgressReport(entry, false), ["x"]);
  const lines = formatGoalProgressReport(entry, true)!;
  assert.deepEqual(lines.slice(-8, -1), [
    "Артефакты:",
    "  · CURRENT r1",
    "    /tmp/a-very-long-artifact-directory/CURRENT.md",
    "  · DECISIONS r2",
    "    /tmp/a-very-long-artifact-directory/DECISIONS.md",
    "  · PAPER-CUTS r3",
    "    /tmp/a-very-long-artifact-directory/PAPER-CUTS.md",
  ]);

  const pathLine = lines.at(-2)!;
  const narrow = createGoalProgressEntryComponent([pathLine]).render(18);
  const wideAgain = createGoalProgressEntryComponent([pathLine]).render(80);
  assert.equal(narrow.map((line) => line.trim()).join(""), pathLine.trim());
  assert.equal(wideAgain.map((line) => line.trim()).join(""), pathLine.trim());
  assert.doesNotMatch(narrow.join(""), /…/);
  for (const line of narrow) assertFitsDisplayWidth(line, 18);
});

test("progress renderer keeps semantic fields compact and shows metadata only expanded", () => {
  const entry: GoalReportEntry = {
    version: 1,
    kind: "publish",
    goalId: "goal",
    reportId: "report",
    createdAt: 0,
    turnIndex: 2,
    activeSeconds: 5,
    tokensUsed: 7,
    triggerReason: "manual",
    report: { status: "blocked", phase: "verification", problemOrDecision: "test failed", nextStep: "fix test" },
  };
  const compact = formatGoalProgressReport(entry, false)?.join("\n") ?? "";
  const expanded = formatGoalProgressReport(entry, true)?.join("\n") ?? "";
  assert.equal(compact, "test failed");
  assert.doesNotMatch(compact, /reportId=/);
  assert.match(expanded, /reportId=report/);
});

test("collapsed legacy awaiting_user still states the decision needed", () => {
  const goal = createThreadGoal("Восстановить старый отчёт");
  const entry: GoalReportEntry = {
    version: 1, kind: "publish", goalId: goal.goalId, reportId: "legacy", createdAt: 1,
    turnIndex: 1, activeSeconds: 1, tokensUsed: 1, triggerReason: "manual",
    report: { status: "awaiting_user", phase: "решение", needUser: "Выберите путь импорта.", nextStep: "Дождаться ответа." },
  };
  assert.deepEqual(formatGoalProgressReport(entry, false), ["Выберите путь импорта."]);
  assert.equal(reconstructGoalReportState([{ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: entry }], goal.goalId).awaitingUser, true);
  const withoutQuestion: GoalReportEntry = { ...entry, report: { status: "awaiting_user", phase: "decision", nextStep: "wait" } };
  assert.equal(isGoalReportEntry(withoutQuestion), true, "v1 entry without needUser remains replayable");
  assert.deepEqual(formatGoalProgressReport(withoutQuestion, false), ["Требуется решение пользователя."]);
  assert.equal(reconstructGoalReportState([{ type: "custom", customType: GOAL_PROGRESS_ENTRY_TYPE, data: withoutQuestion }], goal.goalId).awaitingUser, true);
});

test("duplicate legacy suppress does not reset the durable turn cadence after reload", () => {
  const goal = createThreadGoal("ship reports");
  const legacySuppress: GoalReportEntry = {
    version: 1,
    kind: "suppress",
    goalId: goal.goalId,
    createdAt: 1,
    turnIndex: 100,
    activeSeconds: 0,
    tokensUsed: 0,
  };
  const entries = [
    { type: "custom" as const, customType: GOAL_PROGRESS_ENTRY_TYPE, data: legacySuppress },
    ...Array.from({ length: 30 }, (_, index) => ({
      type: "custom" as const,
      customType: GOAL_PROGRESS_ENTRY_TYPE,
      data: { version: 1 as const, kind: "assistant_turn" as const, goalId: goal.goalId, createdAt: index + 2, turnIndex: index, activeSeconds: 0, tokensUsed: 0, assistantTurns: index + 1 },
    })),
    { type: "custom" as const, customType: GOAL_PROGRESS_ENTRY_TYPE, data: legacySuppress },
  ];
  const state = reconstructGoalReportState(entries, goal.goalId);
  assert.equal(state.lastActionTurn, 0);
  assert.equal(reportDueReason(state, goal, 200), "periodic_turns");
});

test("slash workflow recognition mirrors skill SDK parsing before recording an awaiting_user decision", async () => {
  const commands = [
    { name: "skill:plan", source: "skill" as const, sourceInfo: { path: "/skills/plan/SKILL.md", source: "skill" as const, scope: "user" as const, origin: "top-level" as const } },
  ];
  const recordsDecision = async (text: string): Promise<boolean> => {
    const harness = createRuntimeHarness({ commands });
    await harness.runCommand("ship reports");
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for a choice.",
      needUser: "Choose a path.",
    });
    await harness.emit("input", { type: "input", text, source: "interactive" });
    const released = await harness.runTool("report_goal_progress", {
      ...reportParams(),
      status: "working",
    }) as { details: { state: { awaitingUser: boolean } } };
    return !released.details.state.awaitingUser;
  };

  for (const text of [
    "/skill:plan",
    "/skill:plan space argument",
  ]) {
    assert.equal(await recordsDecision(text), false, `${JSON.stringify(text)} is an SDK workflow`);
  }
  for (const text of [
    "/skill:plan\ttab",
    "/skill:plan\nnewline",
    "/tmp/imports",
  ]) {
    assert.equal(await recordsDecision(text), true, `${JSON.stringify(text)} is ordinary input`);
  }
});

test("goal report entries reject non-finite and negative durable coordinates", () => {
  const valid = {
    version: 1,
    kind: "assistant_turn",
    goalId: "goal-1",
    createdAt: 1,
    turnIndex: 0,
    activeSeconds: 0,
    tokensUsed: 0,
    assistantTurns: 1,
  };
  assert.equal(isGoalReportEntry(valid), true);
  assert.equal(isGoalReportEntry({ ...valid, createdAt: -1 }), false);
  assert.equal(isGoalReportEntry({ ...valid, createdAt: Number.POSITIVE_INFINITY }), false);
  assert.equal(isGoalReportEntry({ ...valid, turnIndex: Number.POSITIVE_INFINITY }), false);
  assert.equal(isGoalReportEntry({ ...valid, turnIndex: -1 }), false);
});

test("report and note responses expose only the action snapshot, not durable report collections", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить DTO");
  const note = await harness.runTool("record_goal_note", { kind: "decision", title: "Выбор", decision: "Использовать DTO.", rationale: "Контекст должен быть ограничен." }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  const noteState = await harness.runTool("get_goal", {}) as { details: { artifactRefs: Array<{ artifact: string; revision: number }> } };
  const response = await harness.runTool("report_goal_progress", { ...reportParams(), summary: "Сохранил решение и текущий результат. Продолжаю проверку." }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert.equal("recentReports" in response.details, false);
  assert.ok(response.details.workingState);
  assert.equal((response.details.workingState as { currentStep: string }).currentStep, "implementation");
  assert.equal((response.details.workingState as { nextStep: string }).nextStep, "Add focused tests.");
  const responseWorkingState = response.details.workingState as Record<string, unknown>;
  assert.equal("goal" in responseWorkingState, false);
  assert.equal("history" in responseWorkingState, false);
  assert.equal("artifactRefs" in responseWorkingState, false);
  assert.equal("history" in (note.details.workingState as Record<string, unknown>), false);
  assert.equal("artifactRefs" in response.details, false);
  const noteRefs = note.details.artifactRefs as Array<{ artifact: string; revision: number }> | undefined;
  assert.deepEqual(noteRefs?.map((ref) => ref.artifact), ["GOAL"]);
  assert.deepEqual(noteRefs, noteState.details.artifactRefs);
  assert.ok((response.content[0]?.text.length ?? Infinity) < 1_500);
  assert.ok((note.content[0]?.text.length ?? Infinity) < 1_500);
});

test("artifact-changing progress returns the changed projection references", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить ссылки артефактов");
  const result = await harness.runTool("report_goal_progress", {
    action: "publish",
    eventKind: "artifact_updated",
    status: "working",
    phase: "Артефакт",
    summary: "Обновил управляемый артефакт.",
    changed: "Изменил документ.",
    nextStep: "Продолжить.",
  }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  const refs = result.details.artifactRefs as Array<{ artifact: string; revision: number }> | undefined;
  assert.deepEqual(refs?.map((ref) => ref.artifact), ["GOAL"]);
  const snapshot = await harness.runTool("get_goal", {}) as { details: { artifactRefs: Array<{ artifact: string; revision: number }> } };
  assert.deepEqual(refs, snapshot.details.artifactRefs);
  assert.ok((result.content[0]?.text.length ?? Infinity) < 1_500);
});

test("action snapshots preserve awaiting holds and release state without the goal contract", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить удержание");
  const waiting = await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "awaiting_user",
    phase: "Жду решение",
    summary: "Остановился до выбора пользователя.",
    needUser: "Выберите вариант.",
    nextStep: "Дождаться ответа.",
  }) as { content: Array<{ text: string }>; details: { state: Record<string, unknown>; workingState: Record<string, unknown> } };
  assert.equal(waiting.details.state.awaitingUser, true);
  assert.equal(waiting.details.workingState.awaitingUser, true);
  assert.equal(waiting.details.workingState.continuationHeld, true);
  assert.equal(waiting.details.workingState.needUser, "Выберите вариант.");
  assert.equal("goal" in waiting.details.workingState, false);
  assert.ok((waiting.content[0]?.text.length ?? Infinity) < 1_500);

  await harness.emit("input", { type: "input", text: "Выбираю первый вариант.", source: "interactive" });
  const released = await harness.runTool("report_goal_progress", { ...reportParams(), phase: "После ответа", nextStep: "Завершить." }) as { details: { state: Record<string, unknown>; workingState: Record<string, unknown> } };
  assert.equal(released.details.state.awaitingUser, false);
  assert.equal(released.details.workingState.awaitingUser, false);
  assert.equal(released.details.workingState.continuationHeld, false);
  assert.equal(released.details.workingState.userAnswerReceived, false);
});

test("update_goal confirms completion without repeating the objective", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить короткое завершение");
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", verification: "Финальная проверка завершена." });
  const result = await harness.runTool("update_goal", { status: "complete" }) as { content: Array<{ text: string }>; details: Record<string, unknown> };
  assert.equal(result.details.status, "complete");
  assert.equal("goal" in result.details, false);
  assert.equal("objective" in result.details, false);
  assert.ok((result.content[0]?.text.length ?? Infinity) < 1_500);
});

test("repeating the same amendment after reload does not append it twice", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить повтор amendment");
  await harness.runTool("amend_goal", { amendment: "Проверить восстановление." });
  await harness.reloadSession("reload");
  const result = await harness.runTool("amend_goal", { amendment: "Проверить восстановление." }) as { details: { goal: { objective: string } } };
  assert.equal((result.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 1);
});

test("uncertain amendment projection exposes its address and reload repairs without duplication", async () => {
  const harness = createRuntimeHarness({ failAmendmentProjectionPersists: 1 });
  await harness.runCommand("Проверить fault amendment");
  await harness.runTool("report_goal_progress", { ...reportParams(), eventKind: "progress_checkpoint", status: "working", phase: "Проверяю fault" });
  await assert.rejects(
    () => harness.runTool("amend_goal", { amendment: "Проверить восстановление проекции." }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const payload = JSON.parse(error.message) as { operation: string; applied: boolean; stage: string; retryable: boolean; remediation: string; message: string };
      assert.equal(payload.operation, "amend_goal");
      assert.equal(payload.applied, true);
      assert.equal(payload.stage, "projection");
      assert.equal(payload.retryable, false);
      assert.match(payload.remediation, /amendment_id/);
      assert.match(payload.remediation, /Reopen/);
      assert.match(payload.message, /persistence failure/);
      return true;
    },
  );
  const amendmentEntriesBefore = harness.entries.filter((entry) => entry.type === "custom" && JSON.stringify(entry.data).includes("Проверить восстановление проекции.")).length;
  await harness.reloadSession("reload");
  const result = await harness.runTool("amend_goal", { amendment: "Проверить восстановление проекции." }) as { details: { goal: { objective: string } } };
  assert.equal((result.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 1);
  const amendmentEntriesAfter = harness.entries.filter((entry) => entry.type === "custom" && JSON.stringify(entry.data).includes("Проверить восстановление проекции.")).length;
  assert.equal(amendmentEntriesAfter, amendmentEntriesBefore + 1);
});

test("note branches reject fields from the other branch before writing", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить ветви заметок");
  const before = harness.entries.length;
  await assert.rejects(() => harness.runTool("record_goal_note", { kind: "decision", title: "x", decision: "y", rationale: "z", severity: "high" }), /decision accepts only/);
  await assert.rejects(() => harness.runTool("record_goal_note", { kind: "paper_cut", title: "x", impact: "y", severity: "low", rationale: "z" }), /paper_cut accepts only/);
  assert.equal(harness.entries.length, before);
});

test("scheduler hidden continuation carries latest useful verification after a later working report", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить continuation snapshot");
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runTool("report_goal_progress", { ...reportParams(), eventKind: "verification", status: "verifying", phase: "Проверил", verification: "Проверка импорта прошла.", nextStep: "Продолжить." });
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Продолжаю", summary: "Продолжаю работу. Следом завершу.", changed: "Перешёл к следующему шагу.", nextStep: "Завершить." });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 1, output: 1 }), toolResults: [] });
  await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })] });
  const content = (await settleRun(harness)).entries.map((entry) => String(entry.content)).join("\\n");
  assert.match(content, /Проверка импорта прошла\./);
});

test("paused amendment retry resumes after projection recovery without immediate continuation", async () => {
  const harness = createRuntimeHarness({ failAmendmentProjectionPersists: 1 });
  await harness.runCommand("Проверить paused amendment");
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "verifying", phase: "Проверяю", verification: "Проверка прошла." });
  await harness.runSlashCommand("gp");
  await assert.rejects(() => harness.runTool("amend_goal", { amendment: "Восстановить paused цель." }));
  await harness.reloadSession("reload");
  const response = await harness.runTool("amend_goal", { amendment: "Восстановить paused цель." }) as { details: { goal: { status: string; objective: string } } };
  assert.equal(response.details.goal.status, "active");
  assert.equal((response.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 1);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("objective marker text is not treated as prior runtime amendment provenance", async () => {
  const harness = createRuntimeHarness();
  const initialObjective = ["Исходный текст.", "", "Approved amendment:", "Добавить логирование."].join(String.fromCharCode(10));
  await harness.runTool("create_goal", { objective: initialObjective, token_budget: null });
  const result = await harness.runTool("amend_goal", { amendment: "Добавить логирование." }) as { details: { goal: { objective: string } } };
  assert.equal((result.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 2);
  assert.equal("appliedAmendments" in result.details.goal, false);
});

test("canonical amendment provenance survives near-limit retry and delimiter text", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "x".repeat(7977), token_budget: null });
  await harness.runTool("amend_goal", { amendment: "x" });
  await harness.reloadSession("reload");
  const retry = await harness.runTool("amend_goal", { amendment: "x" }) as { details: { goal: { objective: string } } };
  assert.equal(retry.details.goal.objective.length, 8000);
  assert.equal((retry.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 1);
  const delimiterHarness = createRuntimeHarness();
  await delimiterHarness.runTool("create_goal", { objective: "Исходный текст.", token_budget: null });
  const delimiter = ["Текст", "", "Approved amendment:", "не provenance"].join(String.fromCharCode(10));
  const amended = await delimiterHarness.runTool("amend_goal", { amendment: delimiter }) as { details: { goal: { objective: string } } };
  assert.match(amended.details.goal.objective, /Текст/);
  assert.equal((amended.details.goal.objective.match(/Approved amendment:/g) ?? []).length, 2);

});
test("anchorless canonical awaiting_user survives reload and keeps hidden continuation held", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить anchorless hold");
  const goal = harness.snapshot().goal!;
  harness.entries.push({ type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, id: "anchorless", parentId: null, timestamp: new Date(0).toISOString(), data: { kind: "progress_reported", idempotencyKey: "anchorless:waiting", goalId: goal.goalId, reportId: "anchorless", eventKind: "progress_checkpoint", createdAt: 1, report: { status: "awaiting_user", phase: "Жду решение", summary: "Нужно решение пользователя.", needUser: "Выберите путь.", nextStep: "Дождаться ответа." } } });
  await harness.reloadSession("reload");
  const result = await harness.runTool("get_goal", {}) as { details: { awaitingUser: boolean; continuationHeld: boolean; progressStatus: string } };
  assert.equal(result.details.progressStatus, "awaiting_user");
  assert.equal(result.details.awaitingUser, true);
  assert.equal(result.details.continuationHeld, true);
  harness.sentMessages.length = 0;
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 1, output: 1 }), toolResults: [] });
  assert.equal((await settleRun(harness)).continued, false);
  assert.equal(goalTickets(harness).length, 0);
  await harness.emit("input", { type: "input", text: "Выбираю путь.", source: "interactive" });
  await harness.reloadSession("reload");
  const answered = await harness.runTool("get_goal", {}) as { details: { awaitingUser: boolean; continuationHeld: boolean; userAnswerReceived: boolean } };
  assert.equal(answered.details.awaitingUser, true);
  assert.equal(answered.details.continuationHeld, true);
  assert.equal(answered.details.userAnswerReceived, false);
  await harness.runTool("report_goal_progress", { ...reportParams(), status: "working", phase: "Продолжаю", nextStep: "Завершить." });
  const released = await harness.runTool("get_goal", {}) as { details: { awaitingUser: boolean; continuationHeld: boolean } };
  assert.equal(released.details.awaitingUser, false);
  assert.equal(released.details.continuationHeld, false);
});

test("successful amend response retains budget fields while hiding provenance", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Бюджетная цель", token_budget: 100 });
  const result = await harness.runTool("amend_goal", { amendment: "Добавить проверку." }) as { details: { remainingTokens: number | null; completionBudgetReport: string | null; goal: Record<string, unknown> } };
  assert.equal(result.details.remainingTokens, 100);
  assert.equal(result.details.completionBudgetReport, null);
  assert.equal("appliedAmendments" in result.details.goal, false);
});

test("clear resets the model-facing working snapshot without deleting durable history", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить clear snapshot");
  await harness.runTool("report_goal_progress", { ...reportParams(), phase: "Этап", nextStep: "Продолжить." });
  await harness.runSlashCommand("gc");
  await harness.reloadSession("reload");
  const result = await harness.runTool("get_goal", {}) as { details: { lifecycle: unknown; goal: unknown; currentStep: unknown; nextStep: unknown; projection: unknown } };
  assert.equal(result.details.lifecycle, null);
  assert.equal(result.details.goal, null);
  assert.equal(result.details.currentStep, null);
  assert.equal(result.details.nextStep, null);
  assert.equal(result.details.projection, null);
  assert.ok(harness.entries.some((entry) => entry.type === "custom" && entry.customType === "goal-compact-goal" && (entry.data as { kind?: string }).kind === "clear"));
});
