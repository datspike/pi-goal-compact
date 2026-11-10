import { goalHistoryText } from "../support/goal-history.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mock, test } from "node:test";
import type { GoalWorkingState } from "../../src/goal/format.js";
import type { GoalWorkState } from "../../src/goal/goal-work-state.js";
import { goalFilePath } from "../../src/goal/goal-artifacts.js";
import { compactContinuationPrompt, TOOL_PROMPT_GUIDELINES } from "../../src/goal/prompts.js";
import { createRuntimeHarness, flushContinuationScheduler, sessionCompactEvent } from "../support/runtime-harness.js";
import { harnessCwd } from "../support/runtime-harness.js";

function plan(): GoalWorkState {
  return { outcome: "Видеть целостную картину работы", doneWhen: "Обзор и продолжение согласованы", summary: "Основа готова, подключаем представления", activeDecisionIds: [], items: [
    { id: "state", title: "Основа состояния", status: "done", source: "user", result: "Состояние сохраняется", evidence: "Проверено повторным чтением" },
    { id: "views", title: "Подключить представления", status: "active", source: "user" },
    { id: "live", title: "Проверить настоящий интерфейс", status: "planned", source: "user" },
    { id: "publish", title: "Опубликовать результат", status: "blocked", source: "user", result: "Нужно разрешение на публикацию" },
    { id: "overlay", title: "Вернуть старую панель", status: "cancelled", source: "agent", result: "Не соответствует выбранному обзору" },
  ] };
}

async function setup() {
  const harness = createRuntimeHarness();
  const objective = `Сохранить полный исходный контракт. ${"Условия и важные качества результата. ".repeat(100)}КОНЕЦ_ИСХОДНОГО_КОНТРАКТА`;
  await harness.runTool("create_goal", { objective });
  const goalId = harness.snapshot().goal!.goalId;
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: plan() });
  return { harness, goalId, objective };
}

async function current(harness: ReturnType<typeof createRuntimeHarness>): Promise<GoalWorkingState> {
  return (await harness.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
}

function snapshot(harness: ReturnType<typeof createRuntimeHarness>): string {
  const entry = harness.entries.filter((item) => item.type === "custom" && item.customType === "goal-compact-observability").at(-1);
  assert.ok(entry && entry.type === "custom");
  return (entry.data as { lines: string[] }).lines.join("\n");
}

function continuation(harness: ReturnType<typeof createRuntimeHarness>): string {
  return [...harness.sentMessages.map((entry) => String(entry.message.content)), ...harness.sentUserMessages.map((entry) => entry.content)].join("\n");
}

test("/gw shows the short plan and a single detailed link, not the full contract", async () => {
  const { harness, goalId, objective } = await setup();
  await harness.runSlashCommand("gw");
  const overview = snapshot(harness);
  for (const text of ["Видеть целостную картину", "Основа готова", "Основа состояния", "Подключить представления", "Проверить настоящий интерфейс", "Нужно разрешение на публикацию"]) assert.ok(overview.includes(text), text);
  assert.doesNotMatch(overview, /Вернуть старую панель|КОНЕЦ_ИСХОДНОГО_КОНТРАКТА/);
  assert.ok(overview.length < 1_800);
  assert.equal(overview.match(/\u001b]8;;file:/g)?.length, 1);
  const document = await readFile(goalFilePath(harnessCwd, goalId), "utf8");
  assert.equal(document.includes(objective), false);
  assert.equal((await current(harness)).goal?.objective, objective);
  assert.match(document, /Проверено повторным чтением/);
  assert.match(document, /Отменённые работы/);
  const state = await current(harness);
  assert.equal(state.currentStep, "Подключить представления");
  assert.equal(state.nextStep, "Проверить настоящий интерфейс");
  assert.equal(state.blocker, "Нужно разрешение на публикацию");
});

test("a silent plan change reaches overview, document, get_goal and resumed continuation after reload", async () => {
  const { harness, goalId } = await setup();
  const updated = plan();
  updated.summary = "Представления готовы, проверяем пользовательский путь";
  updated.items[1] = { ...updated.items[1]!, status: "done", evidence: "Обзор показывает нужное содержимое" };
  updated.items[2] = { ...updated.items[2]!, status: "active" };
  const before = harness.sentMessages.length + harness.sentUserMessages.length;
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: updated });
  assert.equal(harness.sentMessages.length + harness.sentUserMessages.length, before);
  await harness.reloadSession("reload");
  assert.deepEqual((await current(harness)).workState, updated);
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /Сейчас: Представления готовы/);
  assert.match(snapshot(harness), /В работе: Проверить настоящий интерфейс/);
  assert.doesNotMatch(snapshot(harness), /В работе: Подключить представления/);
  assert.match(await readFile(goalFilePath(harnessCwd, goalId), "utf8"), /Обзор показывает нужное содержимое/);
  await harness.runSlashCommand("gp");
  const result = (await harness.continueGoal(goalId));
  assert.equal(result.ok, true);
  assert.match(continuation(harness), /Представления готовы/);
  assert.match(continuation(harness), /Проверить настоящий интерфейс/);
  assert.match(continuation(harness), /Опубликовать результат/);
  assert.match(continuation(harness), /Не соответствует выбранному обзору/);
});

test("a compact fallback receives the persisted current plan without resurrecting cancelled work", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { harness } = await setup();
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: compactContinuationPrompt(harness.snapshot().goal!), systemPrompt: "", systemPromptOptions: {} });
    harness.sentMessages.length = 0;
    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    flushContinuationScheduler();
    const prompt = continuation(harness);
    assert.match(prompt, /<untrusted_goal_work_snapshot>/);
    assert.match(prompt, /Проверить настоящий интерфейс/);
    assert.match(prompt, /"status":"cancelled"/);
    assert.match(prompt, /"source":"agent"/);
    assert.doesNotMatch(prompt, /КОНЕЦ_ИСХОДНОГО_КОНТРАКТА/);
  } finally { mock.timers.reset(); }
});

test("old decisions stay historical while only current decision IDs reach continuation", async () => {
  const { harness, goalId } = await setup();
  const record = async (title: string) => (await harness.runTool("record_goal_note", { kind: "decision", title, decision: title, rationale: "Сохраняем причины выбранного пути" }) as { details: { noteId: string } }).details.noteId;
  const old = await record("Ранний вариант");
  const active = await record("Один подробный документ");
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), activeDecisionIds: [old] } });
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 2, state: { ...plan(), activeDecisionIds: [active] } });
  await harness.runSlashCommand("gp");
  assert.equal((await harness.continueGoal(goalId)).ok, true);
  assert.match(continuation(harness), /Один подробный документ/);
  assert.doesNotMatch(continuation(harness), /Ранний вариант/);
  assert.doesNotMatch(await readFile(goalFilePath(harnessCwd, goalId), "utf8"), /Ранний вариант/);
  assert.match(goalHistoryText(harness.entries, goalId), /Ранний вариант/);
});

test("verification belongs to its work revision and old evidence cannot complete a changed plan", async () => {
  const { harness, goalId } = await setup();
  const verify = (verification = "Тесты проходят.") => harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Проверяю результат", verification, nextStep: "Завершить цель" });
  await verify();
  assert.equal((await current(harness)).latestUsefulVerification, "Тесты проходят.");
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), summary: "Добавлена новая работа" } });
  assert.equal((await current(harness)).latestUsefulVerification, null);
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying/);
  await harness.reloadSession("reload");
  assert.equal((await current(harness)).latestUsefulVerification, null);
  await assert.rejects(() => harness.runTool("update_goal", { status: "complete" }), /fresh verifying/);
  await verify("Повторная проверка пройдена.");
  assert.equal((await current(harness)).latestUsefulVerification, "Повторная проверка пройдена.");
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal(harness.snapshot().goal?.status, "complete");
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /^Цель: ✓ Завершена/);
});

test("empty and stale plans are explicit, rather than evidence that nothing remains", async () => {
  const { harness, goalId } = await setup();
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), items: plan().items.map((entry) => ({ ...entry, status: "done" })) } });
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /полноту результата ещё нужно проверить/);
  await harness.runTool("amend_goal", { amendment: "Также проверить частично заполненные планы" });
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /договорённость изменилась/);
  const prompt = compactContinuationPrompt(harness.snapshot().goal!, { stateSeq: 1, currentProjectionSeq: 1, workState: plan(), workStateStale: true });
  assert.match(prompt, /"stale":true/);
  assert.match(prompt, /Before acting when a relevant field is truncated, work is omitted or the view is stale, read get_goal/);
});

test("long plans are bounded excerpts, with omitted stages retained in the complete state", () => {
  const work = plan();
  work.items = Array.from({ length: 20 }, (_, index) => ({ id: `step-${index}`, title: `Этап ${index} ${"подробности ".repeat(100)}`, status: "planned", source: "user" }));
  const goal = { goalId: "example", objective: "Длинный план", status: "active" as const, tokenBudget: null, usage: { tokensUsed: 0, activeSeconds: 0 }, createdAt: 0, updatedAt: 0 };
  const prompt = compactContinuationPrompt(goal, { stateSeq: 1, currentProjectionSeq: 1, workState: work, currentStep: work.items.map((item) => item.title).join("; "), nextStep: "ещё ".repeat(1_000) });
  assert.match(prompt, /"omittedItems":14/);
  assert.match(prompt, /Этап 0/);
  assert.ok(prompt.length < 10_000);
  assert.equal(work.items.length, 20);
  assert.match(TOOL_PROMPT_GUIDELINES.join("\n"), /update_goal_work/);
  assert.doesNotMatch(TOOL_PROMPT_GUIDELINES.join("\n"), /keep CURRENT|TIMELINE as/);
});

test("registered work guidance uses the public schema and a camel-case revision is rejected", async () => {
  const { harness, goalId } = await setup();
  const metadata = harness.getToolMetadata("update_goal_work");
  assert.ok(metadata);
  const schema = metadata.parameters as { properties: Record<string, unknown>; required: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["expected_revision", "goal_id", "state"]);
  assert.deepEqual([...schema.required].sort(), ["expected_revision", "goal_id", "state"]);
  assert.match((metadata.promptGuidelines ?? []).join("\n"), /goal_id, expected_revision and the full state/);
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expectedRevision: 1, state: plan() }), /malformed goal projection event/);
  assert.equal((await current(harness)).workRevision, 1);
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), summary: "Проверены имена публичных полей" } });
  assert.equal((await current(harness)).workRevision, 2);
});

test("user provenance cannot be downgraded to erase work from any consumer", async () => {
  const { harness, goalId } = await setup();
  const before = await readFile(goalFilePath(harnessCwd, goalId), "utf8");
  for (const status of ["planned", "active", "blocked", "done", "cancelled"] as const) {
    const downgraded = { ...plan(), items: plan().items.map((item) => item.id === "live" ? { ...item, status, source: "agent" as const } : item) };
    await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: downgraded }), /User work provenance/);
  }
  await assert.rejects(() => harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: { ...plan(), items: plan().items.filter((item) => item.id !== "live") } }), /Unfinished user work/);
  assert.equal((await current(harness)).workRevision, 1);
  assert.deepEqual((await current(harness)).workState, plan());
  assert.equal(await readFile(goalFilePath(harnessCwd, goalId), "utf8"), before);
  await harness.reloadSession("reload");
  assert.deepEqual((await current(harness)).workState, plan());
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /Проверить настоящий интерфейс/);
  await harness.runSlashCommand("gp");
  assert.equal((await harness.continueGoal(goalId)).ok, true);
  assert.match(continuation(harness), /"id":"live","title":"Проверить настоящий интерфейс","status":"planned","source":"user"/);
});

test("an agent proposal can become user work and user work can get an explicit disposition", async () => {
  const { harness, goalId } = await setup();
  const revised = plan();
  revised.items = revised.items.map((item) => item.id === "overlay" ? { ...item, source: "user" } : item.id === "live" ? { ...item, status: "cancelled", result: "Владелец явно отменил этап" } : item);
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 1, state: revised });
  assert.equal((await current(harness)).workState!.items.find((item) => item.id === "overlay")!.source, "user");
  assert.equal((await current(harness)).workState!.items.find((item) => item.id === "live")!.status, "cancelled");
});

test("amendment invalidates current reports without a work snapshot but retains their history", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Исходная цель" });
  const goalId = harness.snapshot().goal!.goalId;
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Старая проверка", summary: "Исходная проверка прошла.", verification: "СТАРОЕ_ПОДТВЕРЖДЕНИЕ", nextStep: "Старое завершение" });
  await harness.runTool("amend_goal", { amendment: "Дополнительно проверить перенос." });
  for (const reload of [false, true]) {
    if (reload) await harness.reloadSession("reload");
    const state = await current(harness);
    assert.equal(state.workState, null);
    assert.equal(state.progressStatus, null);
    assert.equal(state.currentStep, null);
    assert.equal(state.nextStep, null);
    assert.equal(state.latestUsefulVerification, null);
    await harness.runSlashCommand("gw");
    assert.doesNotMatch(snapshot(harness), /Старая проверка|СТАРОЕ_ПОДТВЕРЖДЕНИЕ|Старое завершение/);
  }
  const document = await readFile(goalFilePath(harnessCwd, goalId), "utf8");
  assert.match(document, /Ранее записанная проверка/);
  assert.match(document, /СТАРОЕ_ПОДТВЕРЖДЕНИЕ/);
  assert.match(document, /## Проверки текущего плана\s+Подтверждение не записано\./);
  await harness.runSlashCommand("gp");
  assert.equal((await harness.continueGoal(goalId)).ok, true);
  assert.doesNotMatch(continuation(harness), /Старая проверка|СТАРОЕ_ПОДТВЕРЖДЕНИЕ|Старое завершение/);
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Проверяю дополнение", summary: "Работа продолжается.", changed: "Учитывается новое требование.", nextStep: "Проверить дополнение" });
  assert.equal((await current(harness)).latestUsefulVerification, null);
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Свежая проверка", summary: "Дополнение проверено.", verification: "СВЕЖЕЕ_ПОДТВЕРЖДЕНИЕ", nextStep: "Завершить после проверки" });
  assert.equal((await current(harness)).latestUsefulVerification, "СВЕЖЕЕ_ПОДТВЕРЖДЕНИЕ");
});

test("tree navigation adopts a shorter same-goal branch in every current view and can return", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Сравнить ветки одной цели." });
  const goalId = harness.snapshot().goal!.goalId;
  const shorter = [...harness.entries];
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: plan() });
  const longer = [...harness.entries];
  harness.entries.splice(0, harness.entries.length, ...shorter);
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  assert.equal((await current(harness)).workState, null);
  assert.equal((await current(harness)).workRevision, 0);
  await harness.runSlashCommand("gw");
  assert.doesNotMatch(snapshot(harness), /Проверить настоящий интерфейс|Видеть целостную картину/);
  assert.doesNotMatch(await readFile(goalFilePath(harnessCwd, goalId), "utf8"), /Проверить настоящий интерфейс|Видеть целостную картину/);
  await harness.runSlashCommand("gp");
  assert.equal((await harness.continueGoal(goalId)).ok, true);
  assert.doesNotMatch(continuation(harness), /Проверить настоящий интерфейс|Видеть целостную картину/);
  harness.entries.splice(0, harness.entries.length, ...longer);
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  assert.deepEqual((await current(harness)).workState, plan());
  assert.equal((await current(harness)).workRevision, 1);
  await harness.runSlashCommand("gw");
  assert.match(snapshot(harness), /Проверить настоящий интерфейс/);
  assert.match(await readFile(goalFilePath(harnessCwd, goalId), "utf8"), /Проверить настоящий интерфейс/);
});
