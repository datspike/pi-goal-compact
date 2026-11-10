import assert from "node:assert/strict";
import test from "node:test";

import { createThreadGoal } from "../../src/goal/state.js";
import { createGoalProjectionState, snapshotGoalProjection } from "../../src/goal/goal-projection-state.js";
import { isGoalProjectionEvent, reduceGoalProjection, replayGoalProjection, type GoalProjectionEvent } from "../../src/goal/goal-projection-reducer.js";
import { cloneGoalWorkState, isGoalWorkState, remainingGoalWork, type GoalWorkState } from "../../src/goal/goal-work-state.js";

function work(): GoalWorkState {
  return {
    outcome: "Видеть весь оставшийся путь цели без чтения трёх документов.",
    doneWhen: "Обзор и продолжение агента используют одну актуальную картину.",
    summary: "Контракт согласован; предстоят перенос данных и подключение представлений.",
    items: [
      { id: "contract", title: "Согласовать контракт", source: "user", status: "done", evidence: "Решение владельца в сессии." },
      { id: "migration", title: "Сохранить старые данные", source: "user", status: "active" },
      { id: "views", title: "Подключить обзор и продолжения", source: "agent", status: "planned" },
      { id: "panel", title: "Вернуть постоянную панель", source: "agent", status: "cancelled", result: "Сохраняем отказ от overlay." },
    ],
    activeDecisionIds: [],
  };
}

function fixture() {
  const goal = createThreadGoal("Единая рабочая сводка");
  const state = createGoalProjectionState(goal);
  const event: GoalProjectionEvent = { kind: "work_state_updated", goalId: goal.goalId, idempotencyKey: "work:1", expectedRevision: 0, workState: work() };
  return { goal, state, event };
}

test("legacy goals have no invented work plan", () => {
  const { state } = fixture();
  assert.equal(state.workState, null);
  assert.equal(state.workRevision, 0);
  assert.equal(state.workStateStale, false);
});

test("work state validates structure without prescribing prose", () => {
  assert.equal(isGoalWorkState(work()), true);
  assert.equal(isGoalWorkState({ ...work(), summary: "", items: [], activeDecisionIds: [] }), true);
  assert.equal(isGoalWorkState({ ...work(), items: [work().items[0], work().items[0]] }), false);
  assert.equal(isGoalWorkState({ ...work(), activeDecisionIds: ["D1", "D1"] }), false);
  assert.equal(isGoalWorkState({ ...work(), items: [{ ...work().items[0], status: "unknown" }] }), false);
  assert.equal(isGoalWorkState(null), false);
});

test("remaining work excludes completed and cancelled items and preserves the planned order", () => {
  const state = work();
  const remaining = remainingGoalWork(state);
  assert.deepEqual(remaining.map((item) => item.id), ["migration", "views"]);
  remaining[0]!.title = "Changed";
  assert.equal(state.items[1]!.title, "Сохранить старые данные");
});

test("work updates replay durably and idempotently without a progress report", () => {
  const { goal, state, event } = fixture();
  assert.equal(isGoalProjectionEvent(event), true);
  const updated = reduceGoalProjection(state, event);
  assert.equal(updated.workRevision, 1);
  assert.equal(updated.latestProgress, null);
  assert.equal(updated.progressEvents.length, 0);
  assert.equal(updated.currentProjectionSeq < updated.stateSeq, true);
  assert.equal(reduceGoalProjection(updated, event), updated);
  assert.deepEqual(replayGoalProjection(goal, [event, event]), updated);
  assert.equal(state.workState, null);
});

test("work snapshots and incoming events do not share mutable references", () => {
  const { state, event } = fixture();
  const updated = reduceGoalProjection(state, event);
  const snapshot = snapshotGoalProjection(updated);
  snapshot.workState!.items[0]!.title = "Changed";
  const copied = cloneGoalWorkState(updated.workState)!;
  copied.activeDecisionIds.push("Changed");
  if (event.kind === "work_state_updated") event.workState.items[0]!.title = "Changed";
  assert.equal(updated.workState!.items[0]!.title, "Согласовать контракт");
  assert.deepEqual(updated.workState!.activeDecisionIds, []);
});

test("stale updates and unknown decision references are rejected", () => {
  const { state, event } = fixture();
  const updated = reduceGoalProjection(state, event);
  assert.throws(() => reduceGoalProjection(updated, { ...event, idempotencyKey: "work:stale" }), /Ревизия плана устарела/);
  assert.throws(() => reduceGoalProjection(state, { ...event, workState: { ...work(), activeDecisionIds: ["missing"] } } as GoalProjectionEvent), /неизвестное решение/);
  assert.equal(isGoalProjectionEvent({ ...event, expectedRevision: -1 }), false);
});

test("unfinished user work cannot silently vanish, but may be explicitly cancelled", () => {
  const { state, event } = fixture();
  const updated = reduceGoalProjection(state, event);
  const next = { ...event, idempotencyKey: "work:2", expectedRevision: 1 } as Extract<GoalProjectionEvent, { kind: "work_state_updated" }>;
  next.workState = { ...work(), items: work().items.filter((item) => item.id !== "migration") };
  assert.throws(() => reduceGoalProjection(updated, next), /Незавершённый пункт пользователя не может исчезнуть/);
  next.workState = work();
  next.workState.items[1]!.status = "cancelled";
  assert.equal(reduceGoalProjection(updated, next).workRevision, 2);
});

test("contract amendments mark the view stale while lifecycle and reports preserve the plan", () => {
  const { goal, state, event } = fixture();
  const updated = reduceGoalProjection(state, event);
  const paused = reduceGoalProjection(updated, { kind: "goal_updated", goalId: goal.goalId, idempotencyKey: "pause", goal: { ...goal, status: "paused" } });
  assert.equal(paused.workStateStale, false);
  const amended = reduceGoalProjection(paused, { kind: "goal_updated", goalId: goal.goalId, idempotencyKey: "amend", goal: { ...goal, objective: "Изменённый контракт" } });
  assert.equal(amended.workStateStale, true);
  assert.deepEqual(amended.workState, updated.workState);
  const refreshed = reduceGoalProjection(amended, { ...event, idempotencyKey: "work:2", expectedRevision: amended.workRevision });
  assert.equal(refreshed.workStateStale, false);
});

test("terminal events cannot label a snapshot for a changed contract as fresh", () => {
  const { goal, state, event } = fixture();
  const updated = reduceGoalProjection(state, event);
  for (const changed of [{ ...goal, objective: "Новый контракт" }, { ...goal, tokenBudget: 500 }]) {
    const completed = reduceGoalProjection(updated, { kind: "goal_completed", goalId: goal.goalId,
      idempotencyKey: `complete:${changed.objective}:${changed.tokenBudget}`, goal: { ...changed, status: "complete" } });
    assert.equal(completed.workStateStale, true);
    assert.deepEqual(completed.workState, updated.workState);
  }
});
