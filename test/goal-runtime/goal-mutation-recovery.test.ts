import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { reconstructGoal } from "../../src/goal/state.js";
import type { GoalWorkingState } from "../../src/goal/format.js";
import type { GoalWorkUpdateResult } from "../../src/goal/goal-work-state.js";
import { isGoalProjectionEvent } from "../../src/goal/goal-projection-reducer.js";

type CompletionReceipt = { applied: boolean | null; stage: string; retryable: boolean };
import { createRuntimeHarness, passAgreementCheck } from "../support/runtime-harness.js";

async function full(h: ReturnType<typeof createRuntimeHarness>) {
  const state = (await h.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
  assert.ok(state.goal);
  assert.ok(state.projection);
  return { ...state, goal: state.goal, projection: state.projection };
}
async function fixture() {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Проверить безопасное восстановление частичной записи." });
  await h.runTool("report_goal_progress", { action: "publish", eventKind: "goal_started", status: "working", phase: "Проверяю восстановление", summary: "Исходное состояние сохранено. Проверяю сбой записи.", changed: "Подготовлен изолированный сценарий.", nextStep: "Проверить управляемый сбой." });
  return h;
}
async function breakDocument(h: ReturnType<typeof createRuntimeHarness>) {
  const path = fileURLToPath((await full(h)).artifactRefs.find(r => r.artifact === "GOAL")!.path);
  await rename(path, path + ".saved"); await mkdir(path);
  return async () => { await rm(path, { recursive: true }); await rename(path + ".saved", path); };
}
function completeEntries(h: ReturnType<typeof createRuntimeHarness>) { return h.entries.filter(entry => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE && reconstructGoal([entry]).goal?.status === "complete"); }

test("an applied work-state write repairs its document without another semantic revision", async () => {
  const h = await fixture();
  const goalId = (await full(h)).goal.goalId;
  const state = { outcome: "Восстановить документ без повторной записи.", doneWhen: "Повтор не меняет версию плана.", summary: "Проверяю восстановление документа.", items: [{ id: "repair", title: "Проверить восстановление", status: "active", source: "user" }], activeDecisionIds: [], nextItemId: "repair" };
  const restore = await breakDocument(h);
  let receipt: GoalWorkUpdateResult;
  try { receipt = (await h.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state }) as { details: GoalWorkUpdateResult }).details; }
  finally { await restore(); }
  assert.equal(receipt.applied, true);
  assert.equal(receipt.workRevision, 1);
  assert.equal(receipt.projectionFresh, false);
  const stored = await full(h);
  assert.ok(stored.workState);
  const reordered = Object.fromEntries(Object.entries(stored.workState).reverse());
  const repaired = (await h.runTool("update_goal_work", { goal_id: goalId, expected_revision: stored.workRevision, state: reordered }) as { details: GoalWorkUpdateResult }).details;
  assert.equal(repaired.workRevision, 1);
  assert.equal(repaired.projectionFresh, true);
  assert.equal(h.entries.filter(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === "work_state_updated").length, 1);
});

test("canonical completion survives a document failure and repairs without completing twice", async () => {
  const h = await fixture();
  await h.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Сверяю результат", summary: "Договорённость и проверки сверены. Проверяю запись завершения.", verification: "Проверен изолированный путь завершения.", nextStep: "Завершить тестовую цель." });
  await passAgreementCheck(h);
  const restore = await breakDocument(h);
  let failure: CompletionReceipt | undefined;
  try { await h.runTool("update_goal", { status: "complete" }); }
  catch (error) { failure = JSON.parse((error as Error).message) as CompletionReceipt; }
  finally { await restore(); }
  assert.ok(failure);
  assert.equal(failure.applied, true);
  assert.equal(failure.stage, "projection");
  assert.equal(failure.retryable, true);
  assert.equal((await full(h)).goal.status, "complete");
  const count = completeEntries(h).length;
  assert.ok(count > 0);
  const recovered = (await h.runTool("update_goal", { status: "complete" }) as { details: CompletionReceipt }).details;
  assert.equal(recovered.applied, true);
  assert.equal(recovered.stage, "complete");
  assert.equal(completeEntries(h).length, count);
  assert.equal((await full(h)).projection.fresh, true);
});

test("blocked holds the whole Goal until a real reply and a working report, unlike a local blocked item", async () => {
  const h = await fixture();
  await h.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "Жду снятия ограничения", summary: "Безопасных действий не осталось. Продолжение ждёт снятия ограничения.", problemOrDecision: "Внешнее ограничение мешает всей цели.", nextStep: "Дождаться подтверждения оператора." });
  assert.equal((await full(h)).continuationHeld, true);
  assert.equal((await full(h)).awaitingUser, true);
  assert.equal((await full(h)).requiresUserDecision, false);
  const working = { action: "publish", status: "working", phase: "Продолжаю проверку", summary: "Проверяю состояние ограничения. Ответ ещё не получен.", changed: "Проверено состояние ожидания.", nextStep: "Дождаться ответа." };
  await h.runTool("report_goal_progress", working);
  assert.equal((await full(h)).continuationHeld, true);
  await h.runTool("report_goal_progress", { action: "suppress" });
  assert.equal((await full(h)).continuationHeld, true);
  await h.emit("input", { type: "input", source: "interactive", text: "Ограничение снято, продолжай." });
  await h.runTool("report_goal_progress", { ...working, changed: "Оператор подтвердил снятие ограничения." });
  assert.equal((await full(h)).continuationHeld, false);
  await h.reloadSession("reload");
  assert.equal((await full(h)).continuationHeld, false);
});

test("a saved awaiting-user report keeps its hold even when its document write fails", async () => {
  const h = await fixture();
  const note = (await h.runTool("record_goal_note", { kind: "decision", title: "Хранение события", decision: "Источник сохраняется до документа.", rationale: "Повтор не должен создавать второе событие." }) as { details: { noteId: string } }).details;
  const restore = await breakDocument(h);
  let failure: CompletionReceipt & { reportId: string } | undefined;
  try { await h.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Жду выбор", summary: "Нужен выбор владельца. До ответа продолжение удерживается.", needUser: "Выберите вариант восстановления.", nextStep: "Дождаться ответа." }); }
  catch (error) { failure = JSON.parse((error as Error).message) as typeof failure; }
  finally { await restore(); }
  assert.ok(failure);
  assert.equal(failure.applied, true);
  assert.equal(failure.stage, "projection");
  assert.equal(typeof failure.reportId, "string");
  assert.equal((await full(h)).continuationHeld, true);
  await h.runTool("record_goal_note", { kind: "decision", action: "repair", note_id: note.noteId });
  assert.equal((await full(h)).projection.fresh, true);
  assert.equal((await full(h)).continuationHeld, true);
  const questions = h.entries.filter(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === "progress_reported" && entry.data.report.status === "awaiting_user");
  assert.equal(questions.length, 1);
});

test("creation acknowledges its persisted Goal when initial document bootstrap fails", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-bootstrap-failure-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".pi"));
  const obstacle = join(cwd, ".pi", "goal-compact");
  await writeFile(obstacle, "controlled obstacle");
  const h = createRuntimeHarness({ cwd });
  let failure: CompletionReceipt & { goalId: string } | undefined;
  try { await h.runTool("create_goal", { objective: "Сохранить цель при ошибке её документа." }); }
  catch (error) { failure = JSON.parse((error as Error).message) as typeof failure; }
  assert.ok(failure);
  assert.equal(failure.applied, true);
  assert.equal(failure.stage, "projection");
  const id = h.snapshot().goal?.goalId;
  assert.equal(failure.goalId, id);
  await rm(obstacle);
  await h.runTool("report_goal_progress", { action: "publish", eventKind: "goal_started", status: "working", phase: "Проверяю восстановленную цель", summary: "Цель сохранилась. Документ восстановлен без повторного создания.", changed: "Восстановлен документ исходной цели.", nextStep: "Продолжить проверку." });
  assert.equal(h.snapshot().goal?.goalId, id);
  assert.equal((await full(h)).projection.fresh, true);
});

test("an explicit resume after a blocked paused Goal needs the real reply but not a fabricated decision flag", async () => {
  const h = await fixture();
  await h.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "Жду доступ", summary: "Доступ закрыт. Безопасной работы не осталось.", problemOrDecision: "Ограничение мешает всей цели.", nextStep: "Дождаться снятия ограничения." });
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Ограничение снято, продолжай эту цель." });
  await h.runTool("resume_goal", {});
  assert.equal(h.snapshot().goal?.status, "active");
  assert.equal((await full(h)).continuationHeld, true);
  await h.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Продолжаю после снятия ограничения", summary: "Оператор подтвердил доступ. Продолжаю исходную цель.", changed: "Получено подтверждение снятия ограничения.", nextStep: "Завершить проверку." });
  assert.equal((await full(h)).continuationHeld, false);
});

test("repair replays chronology rather than using a newer reply to release an older working report", async t => {
  const h = await fixture();
  await h.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Жду выбор", summary: "Нужен выбор. Продолжение удерживается.", needUser: "Выберите вариант.", nextStep: "Дождаться ответа." });
  const restore = await breakDocument(h);
  const push = h.entries.push.bind(h.entries);
  let input: ReturnType<typeof h.emit> | undefined;
  t.after(() => { h.entries.push = push; });
  h.entries.push = (...entries: Parameters<typeof h.entries.push>) => {
    const size = push(...entries);
    if (entries.some(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === "progress_reported" && entry.data.report.status === "working")) input = h.emit("input", { type: "input", source: "interactive", text: "Выбираю первый вариант." });
    return size;
  };
  try { await assert.rejects(() => h.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Сохраняю промежуточную проверку", summary: "Ответ ещё не получен. Подтверждаю только проверку ожидания.", changed: "Проверено состояние ожидания.", nextStep: "Дождаться ответа." }), /"applied":true/); }
  finally { await restore(); }
  await input;
  assert.ok(input);
  assert.equal((await full(h)).continuationHeld, true);
});

test("a blocked report cannot discard an unanswered choice", async () => {
  const h = await fixture();
  await h.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Жду выбор", summary: "Нужен выбор. Продолжение удерживается.", needUser: "Выберите вариант.", nextStep: "Получить ответ." });
  await h.runTool("report_goal_progress", { action: "publish", status: "blocked", phase: "Жду выбор и доступ", summary: "Выбор не получен. Дополнительно закрыт доступ.", problemOrDecision: "Доступ пока закрыт.", nextStep: "Получить выбор и доступ." });
  assert.equal((await full(h)).requiresUserDecision, true);
  await h.runCommand("pause");
  await h.emit("input", { type: "input", source: "interactive", text: "Продолжай." });
  await assert.rejects(() => h.runTool("resume_goal", {}), /pending user decision is not confirmed/);
  assert.equal(h.snapshot().goal?.status, "paused");
});
