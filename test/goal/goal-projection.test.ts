import assert from "node:assert/strict";
import test from "node:test";

import { createThreadGoal } from "../../src/goal/state.js";
import { renderCurrent, renderDecisions, renderPaperCuts } from "../../src/goal/goal-projection-renderer.js";
import {
  createGoalProjectionState,
  isCurrentProjectionFresh,
  markCurrentProjectionFresh,
  markCurrentProjectionStale,
} from "../../src/goal/goal-projection-state.js";
import {
  projectionEventKey,
  reduceGoalProjection,
  replayGoalProjection,
  isGoalProjectionEvent,
  type GoalProjectionEvent,
} from "../../src/goal/goal-projection-reducer.js";

test("projection reducer increments stateSeq and ignores duplicate idempotency keys", () => {
  const goal = createThreadGoal("Проверить проекции", null, 10);
  const initial = createGoalProjectionState(goal);
  const event: GoalProjectionEvent = {
    kind: "progress_reported",
    goalId: goal.goalId,
    idempotencyKey: projectionEventKey(goal.goalId, "report-1"),
    reportId: "report-1",
    report: {
      status: "working",
      phase: "реализация",
      changed: "Добавлено ядро проекций.",
      verification: "Тесты проходят.",
      nextStep: "Подключить reducer к controller.",
    },
  };

  const next = reduceGoalProjection(initial, event);
  assert.equal(next.stateSeq, 1);
  assert.equal(next.currentProjectionSeq, 0);
  assert.deepEqual(reduceGoalProjection(next, event), next);
  assert.equal(isCurrentProjectionFresh(next), false);

  const fresh = markCurrentProjectionFresh(next);
  assert.equal(isCurrentProjectionFresh(fresh), true);
});

test("goal amendment invalidates an earlier verifying report", () => {
  const goal = createThreadGoal("Проверить amendment", null, 10);
  let state = createGoalProjectionState(goal);
  state = reduceGoalProjection(state, {
    kind: "progress_reported",
    goalId: goal.goalId,
    idempotencyKey: "report:verified",
    reportId: "verified",
    report: { status: "verifying", phase: "проверка", verification: "Тесты проходят.", nextStep: "Завершить." },
  });
  assert.equal(state.latestProgress?.status, "verifying");
  const amended = { ...goal, objective: `${goal.objective}\nДополнительно проверить восстановление.` , updatedAt: goal.updatedAt + 1 };
  state = reduceGoalProjection(state, { kind: "goal_updated", goalId: goal.goalId, idempotencyKey: "amend:1", goal: amended });
  assert.equal(state.latestProgress, null);
  assert.equal(state.latestReportId, null);
});

test("language repair is durable, idempotent, and isolated by goal", () => {
  const goal = createThreadGoal("Проверить language repair", null, 10);
  const other = createThreadGoal("Чужая цель", null, 10);
  const required: GoalProjectionEvent = {
    kind: "language_repair_required",
    goalId: goal.goalId,
    idempotencyKey: "repair:report:1",
    repair: { artifact: "CURRENT", fields: ["changed"], findings: ["русская и английская лексика смешаны в одном предложении"] },
  };
  const state = reduceGoalProjection(createGoalProjectionState(goal), required);
  assert.deepEqual(state.languageRepair, required.repair);
  assert.equal(reduceGoalProjection(state, required), state);
  const replayed = replayGoalProjection(goal, [required, required, {
    kind: "language_repair_cleared",
    goalId: goal.goalId,
    idempotencyKey: "repair-cleared:report:2",
    repairKey: required.idempotencyKey,
  }]);
  assert.equal(replayed.languageRepair, null);
  const newerRepair = reduceGoalProjection(state, {
    ...required,
    idempotencyKey: "repair:report:2",
    repair: { ...required.repair, findings: ["предложение в основном написано по-английски"] },
  });
  const staleClear = reduceGoalProjection(newerRepair, {
    kind: "language_repair_cleared",
    goalId: goal.goalId,
    idempotencyKey: "repair-cleared:report:1",
    repairKey: required.idempotencyKey,
  });
  assert.ok(staleClear.languageRepair);
  assert.throws(() => reduceGoalProjection(createGoalProjectionState(other), required), /belongs to goal/);
  assert.equal(isGoalProjectionEvent(required), true);
});

test("projection diagnostics reject unknown fields and arbitrary diagnostic payloads", () => {
  const goal = createThreadGoal("Проверить diagnostics", null, 10);
  const base = {
    kind: "language_repair_required",
    goalId: goal.goalId,
    idempotencyKey: "repair:strict",
    repair: {
      artifact: "CURRENT",
      fields: ["changed"],
      findings: ["русская и английская лексика смешаны в одном предложении"],
      diagnostics: [{
        artifact: "CURRENT", code: "mixed-language", field: "changed", length: null, limit: null,
        repair: "Не смешивайте русскую и английскую лексику в одном предложении; технические литералы оформите как код.",
      }],
    },
  };
  assert.equal(isGoalProjectionEvent(base), true);
  assert.equal(isGoalProjectionEvent({
    ...base,
    repair: {
      ...base.repair,
      diagnostics: [{ ...base.repair.diagnostics[0], excerpt: "SENSITIVE RAW" }],
    },
  }), false);
  assert.equal(isGoalProjectionEvent({
    ...base,
    repair: {
      ...base.repair,
      diagnostics: [{ ...base.repair.diagnostics[0], repair: "RAW SECRET excerpt" }],
    },
  }), false);
  assert.equal(isGoalProjectionEvent({
    ...base,
    repair: { ...base.repair, findings: ["RAW SECRET excerpt"] },
  }), false);
  assert.equal(isGoalProjectionEvent({
    ...base,
    repair: { ...base.repair, excerpt: "RAW SECRET excerpt" },
  }), false);
  assert.equal(isGoalProjectionEvent({
    ...base,
    repair: {
      ...base.repair,
      fields: ["projection"],
      diagnostics: [{
        ...base.repair.diagnostics[0],
        code: "ai-cluster",
        field: "projection",
        repair: "Замените кластер шаблонной лексики конкретными фактами и проверками.",
      }],
    },
  }), true);
});

test("projection events fail closed for unknown, malformed, and foreign events", () => {
  const goal = createThreadGoal("Проверить границы", null, 10);
  const other = createThreadGoal("Чужая цель", null, 10);
  assert.equal(isGoalProjectionEvent({ kind: "unknown", idempotencyKey: "x", goalId: goal.goalId }), false);
  assert.throws(() => reduceGoalProjection(createGoalProjectionState(goal), {
    kind: "progress_reported", goalId: other.goalId, idempotencyKey: "foreign",
    report: { status: "working", phase: "проверка", nextStep: "Продолжить." },
  }));
});

test("goal_completed projection events require a complete goal payload", () => {
  const goal = createThreadGoal("Проверить terminal event", null, 10);
  assert.equal(isGoalProjectionEvent({
    kind: "goal_completed",
    idempotencyKey: "complete:malformed",
    goalId: goal.goalId,
    goal,
  }), false);
  assert.equal(isGoalProjectionEvent({
    kind: "goal_completed",
    idempotencyKey: "complete:valid",
    goalId: goal.goalId,
    goal: { ...goal, status: "complete" },
  }), true);
});

test("stale projection sequence never becomes negative", () => {
  const goal = createThreadGoal("Проверить stale", null, 10);
  const state = createGoalProjectionState(goal);
  assert.equal(markCurrentProjectionStale(state).currentProjectionSeq, 0);
});

test("projection replay is branch-friendly and preserves append-only entries", () => {
  const goal = createThreadGoal("Вести решения", null, 10);
  const events: GoalProjectionEvent[] = [
    {
      kind: "decision_recorded",
      goalId: goal.goalId,
      idempotencyKey: "decision-1",
      entry: {
        id: "decision-1",
        title: "Оставить CONTEXT-MAP legacy",
        decision: "Не удалять старый файл.",
        rationale: "Существующие рабочие каталоги могут на него ссылаться.",
        createdAt: 11,
      },
    },
    {
      kind: "paper_cut_recorded",
      goalId: goal.goalId,
      idempotencyKey: "paper-cut-1",
      entry: {
        id: "paper-cut-1",
        title: "Нет интеграции с controller",
        impact: "Состояние пока не обновляется из runtime.",
        severity: "low",
        status: "open",
        createdAt: 11,
      },
    },
    {
      kind: "paper_cut_updated",
      goalId: goal.goalId,
      idempotencyKey: "paper-cut-1-resolve",
      id: "paper-cut-1",
      status: "resolved",
      resolution: "Интеграция запланирована отдельным этапом.",
    },
  ];
  const state = replayGoalProjection(goal, events);
  assert.equal(state.stateSeq, 3);
  assert.equal(state.decisions.length, 1);
  assert.equal(state.paperCuts[0]?.status, "resolved");
  assert.equal(replayGoalProjection(goal, [...events, events[1]!]).stateSeq, 3);
});

test("renderers neutralize heading injection without breaking fences or nested lists", () => {
  const goal = createThreadGoal("Проверить", null, 10);
  const current = renderCurrent(goal, {
    status: "working", phase: "проверка", nextStep: "Продолжить.",
    changed: "```ts\nconst value = 1;\n```\n- вложенный пункт\n## Injected",
  });
  assert.match(current, /```ts\nconst value = 1;\n```/);
  assert.match(current, /- вложенный пункт/);
  assert.doesNotMatch(current, /\n## Injected/);
  const decisions = renderDecisions([{ id: "d1", title: "Безопасный\n## Injected", decision: "Решение.", rationale: "Причина.", createdAt: 1 }]);
  assert.doesNotMatch(decisions, /\n## Injected/);
});

test("renderer preserves nested shorter fences inside a longer fence", () => {
  const goal = createThreadGoal("Проверить", null, 10);
  const changed = [
    "````md",
    "```js",
    "const value = 1;",
    "```",
    "````",
    "## Injected",
  ].join("\n");
  const current = renderCurrent(goal, { status: "working", phase: "проверка", nextStep: "Продолжить.", changed });
  assert.match(current, /````md\n```js\nconst value = 1;\n```\n````/);
  assert.doesNotMatch(current, /\n## Injected/);
});

test("renderer treats fences indented by four spaces as ordinary Markdown", () => {
  const goal = createThreadGoal("Проверить", null, 10);
  const changed = ["    ```", "# Injected heading", "    ```"].join("\n");
  const current = renderCurrent(goal, { status: "working", phase: "проверка", nextStep: "Продолжить.", changed });
  assert.doesNotMatch(current, /\n# Injected heading/);
  assert.match(current, /\\# Injected heading/);
});

test("renderer rejects a backtick fence with a backtick in its info string", () => {
  const goal = createThreadGoal("Проверить", null, 10);
  const changed = ["```bad`", "# Injected heading", "```"].join("\n");
  const current = renderCurrent(goal, { status: "working", phase: "проверка", nextStep: "Продолжить.", changed });
  assert.doesNotMatch(current, /\n# Injected heading/);
  assert.match(current, /\\# Injected heading/);
});

test("renderers produce stable Russian Markdown and keep technical tokens", () => {
  const goal = createThreadGoal("Проверить", null, 10);
  const progress = {
    status: "verifying" as const,
    phase: "проверка",
    changed: "Проверен `report_goal_progress` для MR `!42`.",
    completed: "CURRENT обновляется из структурированного отчёта.",
    verification: "`npm test` прошёл.",
    nextStep: "Подключить модуль к `goal-runtime-controller.ts`.",
  };
  const current = renderCurrent(goal, progress);
  assert.match(current, /^# Текущее состояние\n/);
  assert.match(current, /## Проверка/);
  assert.match(current, /`goal-runtime-controller\.ts`/);
  assert.doesNotMatch(current, /\n\n\n/);

  const decisions = renderDecisions([{
    id: "d1",
    title: "Не удалять legacy-файл",
    decision: "CONTEXT-MAP остаётся доступным старым целям.",
    rationale: "Миграция будет отдельным этапом.",
    createdAt: 1,
  }]);
  assert.match(decisions, /^# Решения\n/);
  assert.match(decisions, /## D-1 · Не удалять legacy-файл/);

  const paperCuts = renderPaperCuts([{
    id: "pc1",
    title: "Нужна интеграция",
    impact: "Без неё runtime не обновляет проекцию.",
    severity: "low",
    status: "open",
    createdAt: 1,
  }]);
  assert.match(paperCuts, /^# Отложенные проблемы\n/);
  assert.match(paperCuts, /низкий приоритет/);
});
