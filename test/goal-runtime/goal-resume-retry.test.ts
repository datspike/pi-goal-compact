import { setLanguage } from "../../src/language.js";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { createExpandedRuntimeHarness, emitPersistentAssistantError, assistantMessage, fireProviderLimitAutoResume } from "../support/runtime-harness.js";

const streamError = "stream error: stream disconnected before completion: stream closed before response.completed";
const flagError = "This content was flagged for possible cybersecurity risk.";
const report = { action: "publish", status: "working", phase: "Проверяю восстановление", summary: "Модель продолжила работу. Проверяю состояние цели.", changed: "Ответ после ошибки получен.", nextStep: "Продолжить проверку." };
async function goal(mode: "rpc" | "tui" = "rpc") {
  const h = createExpandedRuntimeHarness({ mode, commands: [{ name: "retry", description: "PiRetry", source: "extension", sourceInfo: { path: "retry.ts", source: "retry.ts", scope: "temporary", origin: "top-level" } }] });
  await h.runCommand("Synthetic recovery contract");
  await h.emit("session_start", { type: "session_start", reason: "start" });
  h.sentMessages.length = 0;
  h.sentUserMessages.length = 0;
  return h;
}
async function retry(h: Awaited<ReturnType<typeof goal>>) {
  await h.emit("agent_start", { type: "agent_start" });
  const message = { role: "custom", customType: "pi-retry:retry", content: "Retry the previous request.", display: false, timestamp: Date.now() + 1 };
  await h.emit("message_start", { type: "message_start", message });
  return message;
}
async function success(h: Awaited<ReturnType<typeof goal>>, index = 1, admitRetry = true) {
  if (admitRetry) await retry(h);
  const message = assistantMessage("toolUse", { input: 10, output: 5 });
  await h.emit("turn_start", { type: "turn_start", turnIndex: index, timestamp: index + 1 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: index, message, toolResults: [] });
}

test("stream disconnect remains an active recovery, not a terminal pause", async () => {
  const h = await goal();
  await emitPersistentAssistantError(h, 0, streamError);
  assert.equal(h.snapshot().goal?.status, "active");
});

test("external retry owns unknown-error recovery and admits a report within its successful turn", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 1 });
  await emitPersistentAssistantError(h, 0, flagError);
  assert.equal(h.snapshot().goal?.status, "paused");
  await success(h);
  await h.runTool("report_goal_progress", report);
  assert.equal(h.sentMessages.length, 0);
  h.emitBusEvent("pi-retry:completed", { retryId: 1 });
  assert.equal(h.snapshot().goal?.status, "active");
});

test("retry start after technical pause restores only its own recovery", async () => {
  const h = await goal();
  await emitPersistentAssistantError(h, 0, flagError);
  assert.equal(h.snapshot().goal?.status, "paused");
  h.emitBusEvent("pi-retry:started", { retryId: 2 });
  await success(h);
  await h.runTool("report_goal_progress", report);
  assert.equal(h.snapshot().goal?.status, "active");
});

test("retry exhaustion pauses with durable reason and no duplicate continuation", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 3 });
  await emitPersistentAssistantError(h, 0, flagError);
  await retry(h);
  await emitPersistentAssistantError(h, 1, streamError);
  h.emitBusEvent("pi-retry:cancelled", { retryId: 3 });
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.sentMessages.length, 0);
  const result = await h.runTool("get_goal", {});
  assert.match(JSON.stringify(result), /retry.*(ended|exhausted)|recovery/i);
  await h.reloadSession("reload");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /retry.*(ended|exhausted)|recovery/i);
});

test("manual pause is not released by retry, status inquiry, or a report", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 4 });
  await h.runCommand("pause");
  h.emitBusEvent("pi-retry:completed", { retryId: 4 });
  await h.emit("input", { type: "input", source: "interactive", text: "Что уже сделано?" });
  assert.equal(h.snapshot().goal?.status, "paused");
  await assert.rejects(() => h.runTool("report_goal_progress", report), /paused|active goal/);
});

test("explicit continue reactivates without a second model request or amendment", async () => {
  const h = await goal();
  const original = h.snapshot().goal!;
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжи" });
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal(h.snapshot().goal?.objective, original.objective);
  assert.equal(h.sentUserMessages.length, 0);
});

test("resume_goal handles another user formulation and is idempotent", async () => {
  const h = await goal();
  const original = h.snapshot().goal!;
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Случайно остановил, возвращайся к работе по плану" });
  await h.runTool("resume_goal", {});
  await h.runTool("resume_goal", {});
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal(h.snapshot().goal?.objective, original.objective);
  assert.equal(h.snapshot().goal?.goalId, original.goalId);
  assert.equal(h.sentUserMessages.length, 0);
});

test("resume_goal cannot use a background retry as user approval", async () => {
  const h = await goal();
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "extension", text: "Retry the previous request." });
  await assert.rejects(() => h.runTool("resume_goal", {}), /user|instruction|decision/i);
  assert.equal(h.snapshot().goal?.status, "paused");
});

test("late retry completion cannot reopen a cleared or replacement goal", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 8 });
  await emitPersistentAssistantError(h, 0, flagError);
  await h.runCommand("clear");
  h.emitBusEvent("pi-retry:completed", { retryId: 8 });
  assert.equal(h.snapshot().goal, null);
  await h.runCommand("Replacement contract");
  await h.runCommand("pause");
  h.emitBusEvent("pi-retry:completed", { retryId: 8 });
  assert.equal(h.snapshot().goal?.status, "paused");
});

test("awaiting_user remains held across retry and reload", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", { ...report, status: "awaiting_user", needUser: "Выберите путь." });
  h.emitBusEvent("pi-retry:started", { retryId: 20 });
  await h.emit("message_start", { type: "message_start", message: { role: "custom", customType: "pi-retry:retry", content: "Retry the previous request.", display: false, timestamp: 1 } });
  assert.equal(h.abortCount, 1);
  await h.reloadSession("reload");
  const result = await h.runTool("get_goal", {});
  const snapshot = result as { details: { continuationHeld: boolean; userAnswerReceived: boolean } };
  assert.equal(snapshot.details.continuationHeld, true);
  assert.equal(snapshot.details.userAnswerReceived, false);
});

test("budget and cleared states are not reopened by resume_goal or retry", async () => {
  const h = await goal();
  await h.runCommand("clear");
  await h.runTool("create_goal", { objective: "Budget probe", token_budget: 1 });
  await success(h);
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжи" });
  await assert.rejects(() => h.runTool("resume_goal", {}), /budget/i);
  h.emitBusEvent("pi-retry:started", { retryId: 21 });
  h.emitBusEvent("pi-retry:completed", { retryId: 21 });
  assert.equal(h.snapshot().goal?.status, "budgetLimited");
  await h.runCommand("clear");
  await assert.rejects(() => h.runTool("resume_goal", {}), /окончательны|возобновить/i);
});

test("aborted turn during retry is a durable manual pause", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 22 });
  await emitPersistentAssistantError(h, 0, flagError);
  await retry(h);
  await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: 1, message: assistantMessage("aborted", { input: 1, output: 0 }), toolResults: [] });
  h.emitBusEvent("pi-retry:completed", { retryId: 22 });
  h.emitBusEvent("pi-retry:started", { retryId: 23 });
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
  assert.equal(h.snapshot().goal?.status, "paused");
  await h.reloadSession("reload");
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
});

test("late retry carriers do not execute against a replacement goal", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 24 });
  await h.runCommand("clear");
  await h.runCommand("Replacement contract");
  await h.emit("message_start", { type: "message_start", message: { role: "custom", customType: "pi-retry:retry", content: "Retry the previous request.", display: false, timestamp: 1 } });
  assert.equal(h.abortCount, 1);
});


test("compact preserves the external retry owner and its in-turn report", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 25 });
  await emitPersistentAssistantError(h, 0, flagError);
  await h.emit("session_compact", { type: "session_compact", compactionEntry: { type: "compaction", id: "compact", parentId: null, timestamp: new Date().toISOString(), summary: "Synthetic compact", firstKeptEntryId: "seed", tokensBefore: 100 }, fromExtension: false, willRetry: true });
  await h.emit("message_start", { type: "message_start", message: { role: "custom", customType: "pi-retry:retry", content: "Retry the previous request.", display: false, timestamp: Date.now() + 1 } });
  assert.equal(h.abortCount, 0);
  await success(h, 1, false);
  await h.runTool("report_goal_progress", report);
  assert.equal(h.snapshot().goal?.status, "active");
});

test("terminal completion is not reopened by resume or a delayed retry", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", { ...report, status: "verifying", verification: "Проверки завершены." });
  await h.runTool("update_goal", { status: "complete" });
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжи" });
  await assert.rejects(() => h.runTool("resume_goal", {}), /окончательны|возобновить/i);
  h.emitBusEvent("pi-retry:started", { retryId: 26 });
  h.emitBusEvent("pi-retry:completed", { retryId: 26 });
  assert.equal(h.snapshot().goal?.status, "complete");
});

test("projection repair blocks resume but remains repairable without another amendment", async () => {
  const h = await goal();
  const note = { kind: "decision", title: "Выбор пути", decision: "Controlled flow validated, блокеры отсутствуют.", rationale: "Сохраняем исходные ограничения." };
  await assert.rejects(() => h.runTool("record_goal_note", note), /нужно исправить/i);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Возобнови согласованную работу" });
  await assert.rejects(() => h.runTool("resume_goal", {}), /repair/i);
  await h.runTool("record_goal_note", { ...note, decision: "Проверка завершена, блокеров нет." });
  await h.runTool("resume_goal", {});
  assert.equal(h.snapshot().goal?.status, "active");
});

test("old retry completion after session shutdown cannot reopen a manual pause", async () => {
  const h = await goal();
  h.emitBusEvent("pi-retry:started", { retryId: 27 });
  await emitPersistentAssistantError(h, 0, flagError);
  await h.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
  await h.reloadSession("reload");
  await h.runCommand("pause");
  h.emitBusEvent("pi-retry:completed", { retryId: 27 });
  assert.equal(h.snapshot().goal?.status, "paused");
});


test("manual pause revokes permission from the preceding user turn", async () => {
  const h = await goal();
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжай реализацию по плану" });
  await h.runCommand("pause");
  await assert.rejects(() => h.runTool("resume_goal", {}), /указания пользователя/i);
  assert.equal(h.snapshot().goal?.status, "paused");
});


test("cancelled resume tool preserves manual pause and sends no request", async () => {
  const h = await goal();
  await h.runSlashCommand("gp");
  await h.emit("input", { type: "input", source: "interactive", text: "Вернись к текущей работе." });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => h.runTool("resume_goal", {}, controller.signal), /Возобновление отменено/);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
});

test("session resume and internal continuation preserve durable projection repair", async () => {
  const h = await goal();
  await assert.rejects(() => h.runTool("record_goal_note", { kind: "decision", title: "Выбор пути", decision: "Controlled flow validated, блокеры отсутствуют.", rationale: "Сохраняем ограничения." }), /нужно исправить/i);
  await h.runCommand("pause");
  await h.reloadSession("resume");
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"repairPending":true/);
  assert.equal((await h.resumeGoal(h.snapshot().goal!.goalId)).ok, false);
  assert.equal((await h.continueGoal(h.snapshot().goal!.goalId)).ok, false);
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
  assert.ok(h.notifications.some(n => /исправ|синхрониз/.test(n)));
});

test("anonymous child lifecycle cannot activate a technical pause or cancel an executing main retry", async () => {
  const h = await goal();
  await emitPersistentAssistantError(h, 0, flagError);
  h.emitBusEvent("pi-retry:started", { retryId: 1 });
  h.emitBusEvent("pi-retry:completed", { retryId: 1 });
  assert.equal(h.snapshot().goal?.status, "paused");
  await retry(h);
  assert.equal(h.snapshot().goal?.status, "active");
  h.emitBusEvent("pi-retry:cancelled", { retryId: 1 });
  h.emitBusEvent("pi-retry:started", { retryId: 999 });
  assert.equal(h.snapshot().goal?.status, "active");
  await h.runTool("report_goal_progress", report);
  assert.equal(h.sentMessages.length, 0);
  await h.emit("agent_end", { type: "agent_end", messages: [{ ...assistantMessage("stop", { input: 1, output: 1 }), content: [{ type: "text", text: "Synthetic successful recovery." }] }] });
  assert.equal(h.snapshot().goal?.status, "active");
});

test("Esc converts an already technical pause to durable manual pause without altering the contract", async () => {
  const h = await goal("tui");
  await emitPersistentAssistantError(h, 0, flagError);
  const before = h.snapshot().goal!;
  assert.equal(before.pause?.kind, "recovery");
  assert.deepEqual(h.emitTerminalInput("\x1b"), [undefined]);
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
  assert.equal(h.snapshot().goal?.goalId, before.goalId);
  assert.deepEqual(h.snapshot().goal?.usage, before.usage);
  await h.waitForGoalProjection();
  await h.reloadSession("reload");
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
  await retry(h);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.abortCount, 1);
});

test("provider-limit auto resume cannot bypass durable projection repair", async t => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const h = await goal();
  await assert.rejects(() => h.runTool("record_goal_note", { kind: "decision", title: "Выбор пути", decision: "Controlled flow validated, блокеры отсутствуют.", rationale: "Сохраняем ограничения." }), /нужно исправить/i);
  await emitPersistentAssistantError(h, 0, "usage limit has been reached");
  fireProviderLimitAutoResume();
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
});

for (const transition of ["tree", "shutdown-reload"] as const) {
  test(`late retry carriers after ${transition} cannot reconstruct recovery intent from pause provenance`, async () => {
    const h = await goal();
    await emitPersistentAssistantError(h, 0, flagError);
    const original = h.snapshot().goal!;
    if (transition === "tree") await h.emit("session_tree", { type: "session_tree" });
    else {
      await h.emit("session_shutdown", { type: "session_shutdown" });
      await h.reloadSession("reload");
    }
    for (const customType of ["pi-retry:retry", "pi-retry:continue"]) {
      await h.emit("message_start", { type: "message_start", message: { role: "custom", customType, content: "Retry the previous request.", display: false, timestamp: 1 } });
    }
    assert.equal(h.snapshot().goal?.status, "paused");
    assert.equal(h.snapshot().goal?.pause?.kind, "recovery");
    assert.equal(h.snapshot().goal?.goalId, original.goalId);
    assert.equal(h.abortCount, 2);
    assert.equal(h.sentMessages.length, 0);
    assert.equal(h.sentUserMessages.length, 0);
  });
}

test("a queued copy of the previous carrier cannot reactivate the last failed retry", async () => {
  const h = await goal();
  await emitPersistentAssistantError(h, 0, flagError);
  const oldCarrier = await retry(h);
  await emitPersistentAssistantError(h, 1, flagError);
  await h.emit("message_start", { type: "message_start", message: oldCarrier });
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.snapshot().goal?.pause?.kind, "recovery");
  assert.equal(h.abortCount, 1);
  assert.equal(h.sentMessages.length, 0);
});

for (const text of ["Продолжай", "continue", "resume", "Продолжи!", "Продолжи."]) {
  test(`non-literal input ${text} waits for the model's resume_goal interpretation`, async () => {
    const h = await goal();
    await h.runCommand("pause");
    await h.emit("input", { type: "input", source: "interactive", text });
    assert.equal(h.snapshot().goal?.status, "paused");
    await h.runTool("resume_goal", {});
    assert.equal(h.snapshot().goal?.status, "active");
    assert.equal(h.sentUserMessages.length, 0);
  });
}

test("в английском варианте точное слово continue возобновляет цель, а «продолжи» ждёт модель", async () => {
  const h = await goal();
  setLanguage("en");
  try {
    await h.runCommand("pause");
    await h.emit("input", { type: "input", source: "interactive", text: "продолжи" });
    assert.equal(h.snapshot().goal?.status, "paused");
    await h.emit("input", { type: "input", source: "interactive", text: "Continue" });
    assert.equal(h.snapshot().goal?.status, "active");
  } finally {
    setLanguage("ru");
  }
});

test("repeated empty retry preserves a technical pause without scheduling a goal continuation", async () => {
  const h = await goal();
  const empty = assistantMessage("stop", { input: 1, output: 1 });
  async function emptyTurn(index: number) {
    await h.emit("turn_start", { type: "turn_start", turnIndex: index, timestamp: index + 1 });
    await h.emit("turn_end", { type: "turn_end", turnIndex: index, message: empty, toolResults: [] });
    await h.emit("agent_end", { type: "agent_end", messages: [empty] });
    await h.waitForGoalProjection();
  }
  await h.emit("agent_start", { type: "agent_start" });
  await emptyTurn(0);
  assert.equal(h.snapshot().goal?.pause?.kind, "recovery");
  const oldCarrier = await retry(h);
  await emptyTurn(1);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.sentMessages.length, 0);
  assert.equal(h.sentUserMessages.length, 0);
  await h.emit("message_start", { type: "message_start", message: oldCarrier });
  assert.equal(h.abortCount, 1);
  assert.equal(h.snapshot().goal?.status, "paused");
});

const awaiting = { action: "publish", status: "awaiting_user", phase: "Уточняю решение", summary: "Нужно выбрать вариант. Жду ответа.", needUser: "Выбрать вариант А или Б.", nextStep: "Дождаться решения." };

test("status input cannot remove a manual pause layered over awaiting_user", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", awaiting);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Что уже сделано?" });
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
  await assert.rejects(() => h.runTool("report_goal_progress", report), /goal_not_active/);
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"continuationHeld":true/);
});

test("explicit model resume after an answer activates but keeps the hold until working", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", awaiting);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Выбираю А, продолжай согласованную работу" });
  assert.equal(h.snapshot().goal?.status, "paused");
  await assert.rejects(() => h.runTool("resume_goal", {}), /decision/i);
  await h.runTool("resume_goal", { user_decision_confirmed: true });
  assert.equal(h.snapshot().goal?.status, "active");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"continuationHeld":true/);
  await h.runTool("report_goal_progress", report);
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"continuationHeld":false/);
  assert.equal(h.sentUserMessages.length, 0);
});

test("silent command resume cannot bypass repair, but works after verified repair", async () => {
  const h = await goal();
  const note = { kind: "decision", title: "Выбор пути", decision: "Controlled flow validated, блокеры отсутствуют.", rationale: "Сохраняем исходные ограничения." };
  await assert.rejects(() => h.runTool("record_goal_note", note), /нужно исправить/i);
  await h.runCommand("pause");
  await h.runSlashCommand("gr");
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"repairPending":true/);
  assert.equal(h.sentUserMessages.length, 0);
  await h.runTool("record_goal_note", { ...note, decision: "Проверка завершена, блокеров нет." });
  await h.runSlashCommand("gr");
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal(h.sentUserMessages.length, 0);
});

test("pause command converts technical backoff into a manual stop and rejects the next carrier", async () => {
  const h = await goal();
  await emitPersistentAssistantError(h, 0, flagError);
  assert.equal(h.snapshot().goal?.pause?.kind, "recovery");
  await h.runSlashCommand("gp");
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
  await retry(h);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.equal(h.abortCount, 1);
  assert.equal(h.sentMessages.length, 0);
});

test("ordinary answer cannot activate a technical pause while projections still need repair", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", awaiting);
  await emitPersistentAssistantError(h, 0, flagError);
  assert.equal(h.snapshot().goal?.pause?.kind, "recovery");
  await assert.rejects(() => h.runTool("record_goal_note", { kind: "decision", title: "Выбор", decision: "Controlled flow validated, блокеры отсутствуют.", rationale: "Сохраняем ограничения." }), /нужно исправить/i);
  await h.emit("input", { type: "input", source: "interactive", text: "Выбираю А" });
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"repairPending":true/);
});

test("status inquiry does not create a decision or permit silent activation of an unanswered hold", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", awaiting);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Что уже сделано?" });
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"userAnswerReceived":false/);
  await h.runSlashCommand("gr");
  assert.equal(h.snapshot().goal?.status, "paused");
  await assert.rejects(() => h.runTool("resume_goal", {}), /decision|answer/i);
  assert.equal(h.snapshot().goal?.pause?.kind, "manual");
});

test("decision confirmation is explicit, schema-backed and cannot use a camel-case alias", async () => {
  const h = await goal();
  const metadata = h.getToolMetadata("resume_goal");
  assert.ok(metadata);
  const schema = metadata.parameters;
  assert.ok(schema && typeof schema === "object" && "properties" in schema);
  assert.ok("additionalProperties" in schema && schema.additionalProperties === false);
  const properties = schema.properties;
  assert.ok(properties && typeof properties === "object" && "user_decision_confirmed" in properties);
  assert.match(metadata.promptSnippet ?? "", /user_decision_confirmed/);
  assert.match(metadata.promptGuidelines?.join(" ") ?? "", /user_decision_confirmed/);
  await h.runTool("report_goal_progress", awaiting);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Выбираю А, продолжай" });
  await assert.rejects(() => h.runTool("resume_goal", { userDecisionConfirmed: true }), /decision/i);
  await assert.rejects(() => h.runTool("resume_goal", { user_decision_confirmed: false }), /decision/i);
  await h.runTool("resume_goal", { user_decision_confirmed: true });
  assert.equal(h.snapshot().goal?.status, "active");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"userAnswerReceived":true/);
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"continuationHeld":true/);
});

test("a confirmation flag cannot replace a fresh reply after the question", async () => {
  const h = await goal();
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжай работу" });
  await h.runTool("report_goal_progress", awaiting);
  await emitPersistentAssistantError(h, 0, flagError);
  await assert.rejects(() => h.runTool("resume_goal", { user_decision_confirmed: true }), /decision|reply/i);
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"userAnswerReceived":false/);
});

test("an unconfirmed inquiry survives reload as data but cannot authorize silent resume", async () => {
  const h = await goal();
  await h.runTool("report_goal_progress", awaiting);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Что уже сделано?" });
  await h.reloadSession("reload");
  await h.runSlashCommand("gr");
  assert.equal(h.snapshot().goal?.status, "paused");
  assert.match(JSON.stringify(await h.runTool("get_goal", {})), /"userAnswerReceived":false/);
  await assert.rejects(() => h.runTool("resume_goal", { user_decision_confirmed: true }), /указани/i);
});
