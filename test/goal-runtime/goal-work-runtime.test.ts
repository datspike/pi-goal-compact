import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalFilePath } from "../../src/goal/goal-artifacts.js";

import type { GoalWorkingState } from "../../src/goal/format.js";
import type { GoalWorkState } from "../../src/goal/goal-work-state.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";

function work(): GoalWorkState {
  return { outcome: "Понимать оставшийся путь цели.", doneWhen: "Обзор и подробная сводка согласованы.",
    summary: "Основа готова, представления ещё предстоят.", activeDecisionIds: [],
    items: [{ id: "views", title: "Подключить представления", status: "planned", source: "user" }] };
}

async function read(harness: ReturnType<typeof createRuntimeHarness>): Promise<GoalWorkingState> {
  return (await harness.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
}

async function setup() {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Единая сводка цели" });
  const goalId = harness.snapshot().goal!.goalId;
  return { harness, goalId };
}

test("update_goal_work stores a plan without reporting progress or starting a turn", async () => {
  const { harness, goalId } = await setup();
  const before = harness.entries.length;
  const response = await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() }) as { details: Record<string, unknown> };
  assert.equal(response.details.applied, true);
  assert.equal(response.details.workRevision, 1);
  assert.equal("workingState" in response.details, false);
  const state = await read(harness);
  assert.deepEqual(state.workState, work());
  assert.equal(state.workRevision, 1);
  assert.equal(state.workStateStale, false);
  assert.equal(state.lifecycle, "active");
  assert.equal(state.projection?.fresh, true);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);
  for (const entry of harness.entries.slice(before)) {
    if (entry.type === "custom" && entry.customType === "goal-compact-projection") {
      const event = entry.data as { kind: string };
      assert.notEqual(event.kind, "progress_reported");
      if (event.kind === "work_state_updated") assert.equal(harness.renderEntry(entry.customType, entry.data), null);
    }
  }
});

test("work state and revisions survive reload, while old goals do not gain invented plans", async () => {
  const { harness, goalId } = await setup();
  assert.equal((await read(harness)).workState, null);
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
  harness.reloadExtension();
  await harness.reloadSession("reload");
  const state = await read(harness);
  assert.deepEqual(state.workState, work());
  assert.equal(state.workRevision, 1);
});

test("stale writes, wrong goals and silent loss of user work do not alter the saved plan", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: { ...work(), summary: "Новая сводка со старой ревизией." } }), /Stale goal work revision/);
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: "other", expected_revision: 1, state: work() }), /Goal changed/);
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...work(), items: [] } }), /Unfinished user work/);
  assert.deepEqual((await read(harness)).workState, work());
  assert.equal((await read(harness)).workRevision, 1);
});

test("updating a held goal does not answer the user decision or resume it", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Уточняю границы переноса",
    summary: "Нужен выбор по переносу пользовательского документа.", needUser: "Выбрать перенос документа.", nextStep: "Получить решение владельца." });
  const before = await read(harness);
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
  const after = await read(harness);
  assert.equal(after.awaitingUser, true);
  assert.equal(after.continuationHeld, true);
  assert.equal(after.lifecycle, before.lifecycle);
  assert.equal(after.userAnswerReceived, before.userAnswerReceived);
});

test("contract amendments preserve the plan but mark it stale until explicitly updated", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
  await harness.runTool("amend_goal", { amendment: "Добавить проверку старых целей." });
  assert.equal((await read(harness)).workStateStale, true);
  assert.deepEqual((await read(harness)).workState, work());
  assert.equal((await read(harness)).workRevision, 2);
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: work() }), /Stale goal work revision/);
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 2, state: work() });
  assert.equal((await read(harness)).workStateStale, false);
});

test("a recorded decision ID flows to the current plan and superseded decisions stay in history", async () => {
  const { harness, goalId } = await setup();
  const note = await harness.runTool("record_goal_note", { kind: "decision", title: "Одна сводка",
    decision: "Сохраняем одну сводку вместо разрозненных документов.", rationale: "Так виден целостный путь работы." }) as { details: { noteId: string } };
  assert.equal(typeof note.details.noteId, "string");
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: { ...work(), activeDecisionIds: [note.details.noteId] } });
  assert.equal((await read(harness)).activeDecisions[0]?.decision, "Сохраняем одну сводку вместо разрозненных документов.");
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: work() });
  assert.deepEqual((await read(harness)).activeDecisions, []);
  assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-compact-projection" &&
    (entry.data as { kind?: string }).kind === "decision_recorded").length, 1);
});

test("work update retries a rejected initial bootstrap after path repair without reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-bootstrap-"));
  const harness = createRuntimeHarness();
  harness.commandContext.cwd = root;
  try {
    await writeFile(join(root, ".pi"), "not a directory");
    try { await harness.runTool("create_goal", { objective: "Повторить запись плана после исправления пути." }); }
    catch (error) { assert.match(String(error), /unsafe existing directory component/); }
    const goalId = harness.snapshot().goal!.goalId;
    await assert.rejects(() => harness.waitForGoalProjection(), /unsafe existing directory component/);
    await rm(join(root, ".pi"));
    await mkdir(join(root, ".pi"));
    const result = await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() }) as { details: { applied: boolean; projectionFresh: boolean } };
    assert.equal(result.details.applied, true);
    assert.equal(result.details.projectionFresh, true);
    assert.equal((await read(harness)).workRevision, 1);
    assert.deepEqual((await read(harness)).workState, work());
    assert.match(await readFile(goalFilePath(root, goalId), "utf8"), /Подключить представления/);
    assert.equal(harness.entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-compact-projection" && (entry.data as { kind: string }).kind === "work_state_updated").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent amendment fences both stale work snapshots and pre-amendment reports", async () => {
  for (const workFirst of [false, true]) {
    const { harness, goalId } = await setup();
    await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
    const calls = [
      () => harness.runTool("amend_goal", { amendment: "Новый обязательный этап переноса." }),
      () => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: work() }),
    ];
    const results = await Promise.allSettled((workFirst ? calls.reverse() : calls).map((call) => call()));
    assert.ok(results.some((result) => result.status === "fulfilled"));
    const state = await read(harness);
    assert.match(state.goal!.objective, /Новый обязательный этап переноса/);
    assert.equal(state.workStateStale, true);
    for (const result of results) if (result.status === "rejected") assert.match(String(result.reason), /Stale goal work revision/);
    await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: state.workRevision, state: { ...work(), summary: "Учитываю новый обязательный этап переноса." } });
    assert.equal((await read(harness)).workStateStale, false);
    await harness.reloadSession("reload");
    assert.equal((await read(harness)).workStateStale, false);
  }
  const { harness } = await setup();
  // Реплика владельца приходит заранее, чтобы правка шла сразу за начатым отчётом.
  await harness.emit("input", { type: "input", text: "Добавь новую проверку переноса.", source: "interactive" });
  const oldReport = harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Старая проверка", summary: "Проверена прежняя цель.", verification: "Старое подтверждение.", nextStep: "Завершить прежнюю цель" });
  const oldRejected = assert.rejects(oldReport, /Goal contract changed/);
  await harness.runTool("amend_goal", { amendment: "Добавить новую проверку переноса." }, undefined, { ownerReply: false });
  await oldRejected;
  assert.equal((await read(harness)).latestUsefulVerification, null);
  assert.equal((await read(harness)).progressStatus, null);
});

test("an item disposition never amends the contract, grants approval, releases a hold or completes the goal", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Жду решения", summary: "Отмена этапа требует решения владельца.", needUser: "Выбрать дальнейший путь", nextStep: "Получить решение владельца" });
  const before = await read(harness);
  const state = work();
  state.items[0]!.status = "cancelled";
  state.items[0]!.result = "Записанный итог не служит разрешением.";
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state });
  const after = await read(harness);
  assert.equal(after.goal!.objective, before.goal!.objective);
  assert.equal(after.goal!.status, before.goal!.status);
  assert.equal(after.awaitingUser, true);
  assert.equal(after.continuationHeld, true);
  assert.equal(after.userAnswerReceived, false);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);
});
