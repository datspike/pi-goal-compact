import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { goalStatusWorkingState, type GoalStatusWorkingState, type GoalWorkingState } from "../../src/goal/format.js";
import type { GoalWorkState } from "../../src/goal/goal-work-state.js";
import type { GoalStatus } from "../../src/goal/types.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;
type ToolResponse = { content: { type: string; text: string }[]; details: Record<string, unknown> };

type ViewState = { full: GoalWorkingState; status: GoalStatusWorkingState };

async function read<View extends keyof ViewState = "full">(harness: Harness, view?: View) {
  const response = await harness.runTool("get_goal", view ? { view } : {}) as ToolResponse;
  return { response, state: JSON.parse(response.content[0]!.text) as ViewState[View] };
}

function expectedMetadata(full: GoalWorkingState) {
  const { goal, workState: _work, activeDecisions: _decisions, paperCuts: _cuts, ...metadata } = full;
  if (!goal) return { ...metadata, goal: null };
  const { objective: _objective, ...identity } = goal;
  return { ...metadata, goal: identity };
}

function assertStatus(full: GoalWorkingState, status: GoalStatusWorkingState) {
  const { omitted, fullStateRequiredFor, ...metadata } = status;
  assert.deepEqual(metadata, expectedMetadata(full));
  assert.deepEqual(omitted, ["goal.objective", "workState", "activeDecisions", "paperCuts"]);
  assert.ok(fullStateRequiredFor.includes("get_goal без view=status"));
  assert.ok(!("workState" in status));
  assert.ok(!("activeDecisions" in status));
  assert.ok(!("paperCuts" in status));
  if (status.goal) assert.ok(!("objective" in status.goal));
}

test("get_goal defaults to the unchanged full view; status is explicit and read-only", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить короткое чтение без потери исходного договора." });
  const goalId = harness.snapshot().goal!.goalId;
  const note = await harness.runTool("record_goal_note", { kind: "decision", title: "Сохранить договор", decision: "Полное чтение остаётся источником обязательств.", rationale: "Короткий статус не заменяет проверку содержания." }) as { details: { noteId: string } };
  const plan: GoalWorkState = { outcome: "Сохранить правильность чтения.", doneWhen: "Договор и блокировки доступны.", summary: "Проверяем необязательный вид.", items: [{ id: "verify", title: "Проверить представления", status: "planned", source: "user", evidence: "Адресная проверка интерфейса." }], activeDecisionIds: [note.details.noteId] };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: plan });
  const before = structuredClone(harness.snapshot());
  const count = harness.entries.length;
  const full = await read(harness);
  const explicit = await read(harness, "full");
  assert.deepEqual(explicit.response, full.response);
  assert.equal(full.state.goal!.objective, before.goal!.objective);
  assert.deepEqual(full.state.workState, plan);
  assert.equal(full.state.activeDecisions.length, 1);
  const short = await read(harness, "status");
  assertStatus(full.state, short.state);
  assert.deepEqual(short.response.details, { ...short.state, error: null });
  assert.equal(harness.entries.length, count);
  assert.deepEqual(harness.snapshot(), before);
  assert.equal(harness.sentMessages.length + harness.sentUserMessages.length, 0);
});

test("status preserves an absent goal and all lifecycle, stale-plan and repair metadata", async () => {
  const harness = createRuntimeHarness();
  const absent = (await read(harness)).state;
  assertStatus(absent, goalStatusWorkingState(absent));
  assert.equal(goalStatusWorkingState(absent).goal, null);
  await harness.runTool("create_goal", { objective: "Проверить состояния цели и сохранность блокировок." });
  const base = (await read(harness)).state;
  for (const lifecycle of ["active", "paused", "budgetLimited", "complete"] satisfies GoalStatus[]) {
    for (const repairPending of [false, true]) {
      const state: GoalWorkingState = { ...base, lifecycle, goal: { ...base.goal!, status: lifecycle }, workStateStale: true, awaitingUser: true, continuationHeld: true, userAnswerReceived: false, needUser: "Выбрать дальнейший путь.", blocker: "Нужно решение владельца.", projection: { stateSeq: 4, currentProjectionSeq: repairPending ? 3 : 4, fresh: !repairPending, repairPending } };
      const original = structuredClone(state);
      assertStatus(state, goalStatusWorkingState(state));
      assert.deepEqual(state, original);
    }
  }
});

test("reading status after reload does not answer the outstanding user decision", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Сохранить ожидание решения владельца при коротком чтении." });
  await harness.runTool("report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Уточняю границы", summary: "Дальнейшая работа требует выбора владельца.", needUser: "Выбрать вариант продолжения.", nextStep: "Получить решение владельца." });
  await harness.reloadSession("reload");
  const before = structuredClone(harness.snapshot());
  const count = harness.entries.length;
  const full = (await read(harness)).state;
  const short = (await read(harness, "status")).state;
  assertStatus(full, short);
  assert.equal(short.awaitingUser, true);
  assert.equal(short.continuationHeld, true);
  assert.equal(short.userAnswerReceived, false);
  assert.equal(short.goal!.status, "active");
  assert.equal(harness.entries.length, count);
  assert.deepEqual(harness.snapshot(), before);
  assert.equal((await read(harness)).state.goal!.objective, before.goal!.objective);
});

test("the registered view guidance matches its optional public schema", () => {
  const metadata = createRuntimeHarness().getToolMetadata("get_goal")!;
  const schema = metadata.parameters as Parameters<typeof Check>[0];
  for (const params of [{}, { view: "full" }, { view: "status" }]) assert.equal(Check(schema, params), true);
  for (const params of [{ view: "short" }, { mode: "status" }, { view: null }]) assert.equal(Check(schema, params), false);
  assert.ok(metadata.promptSnippet!.includes("view=status"));
  assert.ok(metadata.promptSnippet!.includes("полный вид цели по умолчанию"));
});
