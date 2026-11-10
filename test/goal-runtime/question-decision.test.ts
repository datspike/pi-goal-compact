import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRuntimeHarness, assistantMessage, flushContinuationScheduler, goalTickets, runTurn, sessionCompactEvent, settleRun } from "../support/runtime-harness.js";
import { reconstructGoalReportState } from "../../src/goal/goal-reports.js";

const waiting = { action: "publish", status: "awaiting_user", phase: "Выбор", needUser: "Выберите вариант.", nextStep: "Обработать ответ." };
const working = { action: "publish", status: "working", phase: "Продолжение", changed: "Получено решение пользователя.", nextStep: "Выполнить выбранный вариант." };
const call = { type: "toolCall" as const, id: "question-1", name: "ask_user", arguments: {} };
const answer = { role: "toolResult" as const, toolCallId: call.id, toolName: "ask_user", isError: false, timestamp: 1,
  content: [{ type: "text" as const, text: "User answered: Вариант A" }],
  details: { mode: "single", cancelled: false, response: { kind: "selection", selections: ["Вариант A"] } } };
const questionTurn = { ...assistantMessage("toolUse", { input: 1, output: 1 }), content: [call] };

async function setup() {
  const h = createRuntimeHarness();
  await h.runCommand("Проверить продолжение после ответа");
  h.sentMessages.length = 0;
  await h.emit("before_agent_start", { type: "before_agent_start", prompt: "Обработать вопрос", systemPrompt: "base" });
  await h.emit("agent_start", { type: "agent_start" });
  await h.runTool("report_goal_progress", waiting);
  return h;
}

async function answerTurn(h: ReturnType<typeof createRuntimeHarness>, result: unknown = answer) {
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message: questionTurn, toolResults: [result] });
}

test("ask_user answer permits working to release the hold without ordinary input", async () => {
  const h = await setup();
  await answerTurn(h);
  const result = await h.runTool("report_goal_progress", working) as { details: { state: { awaitingUser: boolean } } };
  assert.equal(result.details.state.awaitingUser, false);
});

// Ответ владельца снимает удержание на один проход: работа продолжается билетом из простоя,
// а законченный ответ без отчёта `working` снова держит цель.
test("compact immediately after ask_user resumes answer processing once, not an autonomous loop", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const h = await setup();
    await answerTurn(h);
    // Сжатие посреди прогона: продолжение решает граница этого же прогона, а не билет.
    await h.emit("agent_end", { type: "agent_end", messages: [questionTurn] });
    await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    const resumed = await settleRun(h);
    assert.equal(resumed.continued, true);
    assert.equal(resumed.entries.length, 1);
    const settled = await runTurn(h, 1, assistantMessage("stop", { input: 1, output: 1 }), { newRun: false });
    assert.equal(settled.continued, false, "without working the hold remains after the answer was processed");
    await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    flushContinuationScheduler();
    assert.equal(goalTickets(h).length, 0, "without working the hold remains after the answer was processed");
  } finally {
    mock.timers.reset();
  }
});

test("cancelled, errored, empty, unrelated and unpaired tool results do not authorize continuation", async () => {
  for (const result of [
    { ...answer, details: { ...answer.details, cancelled: true } },
    { ...answer, isError: true },
    { ...answer, details: { ...answer.details, response: null } },
    { ...answer, details: { ...answer.details, response: { kind: "freeform", text: " " } } },
    { ...answer, toolName: "bash" },
    { ...answer, toolCallId: "foreign" },
  ]) {
    const h = await setup();
    await answerTurn(h, result);
    const reported = await h.runTool("report_goal_progress", working) as { details: { state: { awaitingUser: boolean } } };
    assert.equal(reported.details.state.awaitingUser, true);
    await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.sentMessages.length, 0);
  }
});

test("reload reconstructs old ask_user answers in branch order and honors subsequent working", async () => {
  const h = await setup();
  const entries = [...h.entries];
  const waitingEntry = entries.find(e => e.type === "custom" && e.customType === "goal-compact-projection" && (e.data as { kind: string }).kind === "progress_reported");
  assert.ok(waitingEntry?.type === "custom");
  const goalId = (waitingEntry.data as { goalId: string }).goalId;
  const answered = [...entries, { type: "message", message: questionTurn }, { type: "message", message: answer }];
  assert.equal(reconstructGoalReportState(answered, goalId).hasUserDecisionSinceAwaiting, false);
  assert.equal(reconstructGoalReportState(answered, goalId).hasUserReplySinceAwaiting, true);
  // An old working report was persisted even though the missing input event left its live hold set.
  await h.runTool("report_goal_progress", working);
  const release = h.entries.filter(e => e.type === "custom" && e.customType === "goal-compact-projection" && (e.data as { kind: string }).kind === "progress_reported").at(-1)!;
  assert.equal(reconstructGoalReportState([...answered, release], goalId).awaitingUser, false);
  const unpaired = [...entries, { type: "message", message: answer }];
  assert.equal(reconstructGoalReportState(unpaired, goalId).hasUserDecisionSinceAwaiting, false);
});

test("reload and restart resume an unfinished answer, but not a finished response without working", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    for (const reason of ["reload", "resume"] as const) {
      const h = await setup();
      const base = { id: "question-message", parentId: null, timestamp: new Date().toISOString(), type: "message" as const };
      h.entries.push({ ...base, message: { ...questionTurn, role: "assistant", api: "openai-responses" } });
      h.entries.push({ ...base, id: "answer-message", message: answer });
      await h.reloadSession(reason);
      flushContinuationScheduler();
      assert.equal(goalTickets(h).length, 1);
      h.sentMessages.length = 0;
      h.entries.push({ ...base, id: "final-message", message: { ...assistantMessage("stop", { input: 1, output: 1 }), role: "assistant", api: "openai-responses" } });
      await h.reloadSession(reason);
      flushContinuationScheduler();
      assert.equal(goalTickets(h).length, 0, "reload must not start an autonomous loop from an answered hold");
    }
  } finally {
    mock.timers.reset();
  }
});

test("freeform and batch answers are decisions; an entirely skipped batch is not", async () => {
  for (const [mode, response, releases] of [
    ["single", { kind: "freeform", text: "Не продолжать, объяснить ограничение" }, true],
    ["batch", { kind: "batch", answers: [{ id: "a", kind: "selection", selections: ["A"] }, { id: "b", kind: "skipped" }] }, true],
    ["batch", { kind: "batch", answers: [{ id: "a", kind: "skipped" }] }, false],
  ] as const) {
    const h = await setup();
    await answerTurn(h, { ...answer, details: { cancelled: false, mode, response } });
    const result = await h.runTool("report_goal_progress", working) as { details: { state: { awaitingUser: boolean } } };
    assert.equal(result.details.state.awaitingUser, !releases);
  }
});

test("duplicate answer and a new awaiting_user report cannot reopen the previous allowance", async () => {
  const h = await setup();
  await answerTurn(h);
  await h.runTool("report_goal_progress", { ...waiting, needUser: "Выберите другой вариант." });
  await answerTurn(h);
  await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.sentMessages.length, 0);
});

test("terminal agent_end without turn_end also closes answer processing", async () => {
  const h = await setup();
  await answerTurn(h);
  await h.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 1, output: 1 })] });
  await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(h.sentMessages.length, 0);
});

test("an unpaired result in history does not suppress a later paired live answer", async () => {
  const h = await setup();
  h.entries.push({ id: "unpaired-answer", parentId: null, timestamp: new Date().toISOString(), type: "message", message: answer });
  await h.reloadSession("reload");
  await answerTurn(h);
  const result = await h.runTool("report_goal_progress", working) as { details: { state: { awaitingUser: boolean } } };
  assert.equal(result.details.state.awaitingUser, false);
});

test("replay rejects the same paired answer after a new waiting report", async () => {
  const h = await setup();
  const original = [...h.entries];
  await h.runTool("report_goal_progress", { ...waiting, needUser: "Выберите другой вариант." });
  const nextWaiting = h.entries.filter(e => e.type === "custom" && e.customType === "goal-compact-projection" && (e.data as { kind: string }).kind === "progress_reported").at(-1)!;
  assert.ok(nextWaiting.type === "custom");
  const goalId = (nextWaiting.data as { goalId: string }).goalId;
  const pair = [{ type: "message", message: questionTurn }, { type: "message", message: answer }];
  const state = reconstructGoalReportState([...original, ...pair, nextWaiting, ...pair], goalId);
  assert.equal(state.questionAnswerPending, false);
  assert.equal(state.hasUserDecisionSinceAwaiting, false);
});
