import assert from "node:assert/strict";
import test from "node:test";
import { createThreadGoal } from "../../src/goal/state.js";
import { createGoalProjectionState } from "../../src/goal/goal-projection-state.js";
import { renderGoalDocument } from "../../src/goal/goal-projection-renderer.js";
import { isGoalWorkState, selectNextGoalWork, goalWorkNeedsCompaction, type GoalWorkState } from "../../src/goal/goal-work-state.js";
import { readGoalHistory, reconstructGoalProjectionState } from "../../src/goal/goal-projections.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import { goalWorkingState } from "../../src/goal/format.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";

function work(): GoalWorkState {
  return { outcome: "Сохранить результат и выполнить доступные действия", doneWhen: "Проверен полный контракт", summary: "Удаление заблокировано, карточку можно исправить", nextItemId: "card", activeDecisionIds: [], items: [
    { id: "delete", title: "Удалить каталог", status: "blocked", source: "user", result: "Не проверены процессы" },
    { id: "card", title: "Исправить карточку", status: "planned", source: "user" },
  ] };
}

test("next item validates references and skips a local blocker without granting authority", () => {
  const state = work();
  assert.equal(isGoalWorkState(state), true);
  assert.equal(selectNextGoalWork(state)?.id, "card");
  for (const nextItemId of ["missing", "delete", null, 1]) assert.equal(isGoalWorkState({ ...state, nextItemId }), false);
  for (const status of ["done", "cancelled"]) assert.equal(isGoalWorkState({ ...state, items: state.items.map(x => x.id === "card" ? { ...x, status } : x) }), false);
  const { nextItemId: _next, ...legacy } = state;
  assert.equal(selectNextGoalWork(legacy)?.id, "card");
  assert.equal(selectNextGoalWork({ ...legacy, items: [state.items[0]!] }), null);
});

test("history does not accumulate in the current document and rendering leaves readiness unchanged", () => {
  const state = createGoalProjectionState(createThreadGoal("ИСХОДНЫЙ_КОНТРАКТ"));
  state.workState = work(); state.workRevision = 4; state.verifiedWorkRevision = 4;
  state.decisions = [{ id: "active", title: "Выбор", decision: "Сохранить уникальные данные", rationale: "Нельзя потерять результат", createdAt: 0 }];
  state.workState.activeDecisionIds = ["active"];
  state.importedDocuments = [{ artifact: "CURRENT", content: "СОХРАНЁННЫЙ_ИСХОДНИК".repeat(1000) }];
  const small = renderGoalDocument(state);
  state.decisions = [...state.decisions, ...Array.from({ length: 1000 }, (_, i) => ({ id: `D${i}`, title: "История", decision: "ПОДРОБНОСТИ_ИСТОРИИ".repeat(50), rationale: "Причина", createdAt: i }))];
  const before = structuredClone(state);
  const large = renderGoalDocument(state);
  assert.ok(large.length < small.length + 400);
  assert.doesNotMatch(large, /ПОДРОБНОСТИ_ИСТОРИИ|СОХРАНЁННЫЙ_ИСХОДНИК|ИСХОДНЫЙ_КОНТРАКТ/);
  for (const text of ["Нельзя потерять результат", "Удалить каталог", "Не проверены процессы", "Исправить карточку", 'get_goal', 'history']) assert.ok(large.includes(text), text);
  assert.deepEqual(state, before);
  assert.equal(goalWorkNeedsCompaction(work()), false);
  assert.equal(goalWorkNeedsCompaction({ ...work(), summary: "с".repeat(17000) }), true);
  state.workState = null;
  assert.match(renderGoalDocument(state), /ИСХОДНЫЙ_КОНТРАКТ/);
});

test("addressed history is exact, bounded, branch-scoped, and keeps original work snapshots", () => {
  const goal = createThreadGoal("Контракт");
  const event = { kind: "work_state_updated", idempotencyKey: "work:1", goalId: goal.goalId, expectedRevision: 0, workState: { ...work(), summary: "😀Условия".repeat(3000) } };
  const entries = [
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: { ...event, goalId: "foreign", idempotencyKey: "foreign" } },
    { type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data: event },
  ];
  const index = readGoalHistory(entries, goal.goalId, {});
  assert.equal(index.total, 1);
  assert.equal(index.records?.[0]?.id, "work:1");
  let content = "", offset = 0;
  do {
    const page = readGoalHistory(entries, goal.goalId, { event_id: "work:1", content_offset: offset, content_limit: 117 });
    assert.ok([...page.content!].length <= 117);
    content += page.content;
    if (page.nextContentOffset === null) break;
    offset = page.nextContentOffset!;
  } while (true);
  assert.deepEqual(JSON.parse(content), event);
  assert.throws(() => readGoalHistory(entries, goal.goalId, { event_id: "foreign" }), /not found/);
  assert.throws(() => readGoalHistory(entries, goal.goalId, { content_limit: 0 }), /Invalid/);
});

test("explicit next work is shared by get_goal, document, overview and continuation after reload", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Проверить независимые действия" });
  const goalId = h.snapshot().goal!.goalId;
  await h.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: work() });
  await h.reloadSession("reload");
  const result = await h.runTool("get_goal", {}) as { details: { nextStep: string; workState: GoalWorkState } };
  assert.equal(result.details.nextStep, "Исправить карточку");
  assert.equal(result.details.workState.nextItemId, "card");
  const history = await h.runTool("get_goal", { view: "history" }) as { details: { records: { kind: string; id: string }[] } };
  const record = history.details.records.find(x => x.kind === "work_state_updated");
  assert.ok(record);
  const detail = await h.runTool("get_goal", { view: "history", event_id: record.id }) as { details: { content: string } };
  assert.equal(JSON.parse(detail.details.content).workState.nextItemId, "card");
  await h.runSlashCommand("gw");
  const overview = h.entries.filter(x => x.type === "custom" && x.customType === "goal-compact-observability").at(-1)!;
  assert.ok(overview.type === "custom");
  assert.match(JSON.stringify(overview.data), /Исправить карточку/);
  await h.runSlashCommand("gp");
  assert.equal((await h.continueGoal(goalId)).ok, true);
  const continuation = [...h.sentMessages.map(x => String(x.message.content)), ...h.sentUserMessages.map(x => x.content)].join("\n");
  assert.match(continuation, /Исправить карточку/);
});

test("every current milestone and cancelled obligation retains its result and evidence", () => {
  const state = createGoalProjectionState(createThreadGoal("Сохранить все вехи"));
  state.workState = work();
  for (const status of ["done", "cancelled"] as const) {
    for (let i = 0; i < 5; i++) state.workState.items.push({ id: `${status}-${i}`, title: `Веха ${status}-${i}`, status, source: "user", result: `Результат ${status}-${i}`, evidence: `/proof/${status}-${i}` });
  }
  const before = structuredClone(state);
  const document = renderGoalDocument(state);
  for (const item of state.workState.items) {
    assert.ok(document.includes(item.title), item.id);
    if (item.result) assert.ok(document.includes(item.result), item.id);
    if (item.evidence) assert.ok(document.includes(item.evidence), item.id);
  }
  assert.deepEqual(state, before);
});

test("preserved context is explicit and addressable without declaring historical decisions active", () => {
  const goal = createThreadGoal("Перенести прежние договорённости без потерь");
  const events = [
    { kind: "documents_imported", idempotencyKey: "import-source", goalId: goal.goalId, documents: [{ artifact: "CURRENT", content: "Не удалять резервную копию до приёмки" }] },
    { kind: "legacy_migrated", idempotencyKey: "legacy-source", goalId: goal.goalId, decisions: "Сохранить прежний способ до сравнения", paperCuts: "Не подтверждена установка" },
    { kind: "decision_recorded", idempotencyKey: "decision-source", goalId: goal.goalId, entry: { id: "D-old", title: "Сохранность", decision: "Не удалять уникальные данные", rationale: "Нет второй копии", createdAt: 1 } },
  ];
  const entries = events.map(data => ({ type: "custom", customType: GOAL_PROJECTION_ENTRY_TYPE, data }));
  const state = reconstructGoalProjectionState(entries, goal);
  const document = renderGoalDocument(state);
  assert.ok(document.includes("Не удалять уникальные данные"));
  for (const id of ["import-source", "legacy-source", "D-old"]) assert.ok(document.includes(id), id);
  const before = structuredClone(state);
  const view = goalWorkingState(goal, state, null);
  const context = (view.history as { preservedContext?: { sourceEventIds: string[]; notice: string } }).preservedContext;
  assert.ok(context?.notice);
  assert.deepEqual(context.sourceEventIds, ["import-source", "legacy-source", "D-old"]);
  for (const id of context.sourceEventIds) assert.ok(readGoalHistory(entries, goal.goalId, { event_id: id }).content);
  assert.deepEqual(view.activeDecisions, []);
  assert.deepEqual(state, before);
  assert.deepEqual(reconstructGoalProjectionState(entries, goal), state);
  state.workState = work();
  const current = goalWorkingState(goal, state, null);
  const remaining = (current.history as { preservedContext: { sourceEventIds: string[] } }).preservedContext;
  assert.deepEqual(remaining.sourceEventIds, ["import-source", "legacy-source"]);
  assert.ok(!renderGoalDocument(state).includes("Не удалять уникальные данные"), "A snapshot must not resurrect a retired decision");
});

test("full get_goal exposes context sources before a work snapshot exists", async () => {
  const h = createRuntimeHarness();
  await h.runTool("create_goal", { objective: "Сохранить прежние ограничения при продолжении" });
  await h.runTool("record_goal_note", { kind: "decision", title: "Сохранность данных", decision: "Не удалять уникальные данные", rationale: "Нет второй копии" });
  const result = await h.runTool("get_goal", {}) as { details: { activeDecisions: unknown[]; history: { preservedContext?: { sourceEventIds: string[] } } } };
  assert.deepEqual(result.details.activeDecisions, []);
  const ids = result.details.history.preservedContext?.sourceEventIds;
  assert.ok(ids?.length);
  const original = await h.runTool("get_goal", { view: "history", event_id: ids[0] }) as { details: { content: string } };
  assert.equal(JSON.parse(original.details.content).entry.decision, "Не удалять уникальные данные");
});
