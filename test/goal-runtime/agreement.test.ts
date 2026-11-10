import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GoalWorkingState } from "../../src/goal/format.js";
import { assistantMessage, createRuntimeHarness, settleRun } from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

const AGREEMENT = { owner_wants: "Собрать отчёт о продажах за квартал.", done_when: "Отчёт открывается и сходится с выгрузкой." };

async function read(harness: Harness): Promise<GoalWorkingState> {
  return (await harness.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
}

async function setup(selfDecided: unknown[] = [{ kind: "assumption", text: "Квартал — календарный." }]) {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Отчёт о продажах", agreement: AGREEMENT, self_decided: selfDecided });
  return harness;
}

/** Реплика владельца: событие ввода и запись в ветке, на которую расширение ставит ссылку. */
async function ownerSays(harness: Harness, id: string, text: string): Promise<void> {
  await harness.emit("input", { type: "input", text, source: "interactive" });
  harness.entries.push({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: text, timestamp: Date.now() } });
}

async function endRun(harness: Harness): Promise<void> {
  await harness.emit("agent_end", { type: "agent_end", messages: [] });
}

test("create_goal требует договорённость и список «Решаю сам», пустой список допустим", async () => {
  const harness = createRuntimeHarness();
  await assert.rejects(harness.runTool("create_goal", { objective: "Отчёт", agreement: undefined }), /требует agreement/);
  await assert.rejects(harness.runTool("create_goal", { objective: "Отчёт", agreement: AGREEMENT, self_decided: undefined }), /требует self_decided/);
  await assert.rejects(harness.runTool("create_goal", { objective: "Отчёт", agreement: { owner_wants: "я".repeat(1500), done_when: "г".repeat(501) }, self_decided: [] }), /2000 знаков/);
  await harness.runTool("create_goal", { objective: "Отчёт", agreement: AGREEMENT, self_decided: [] });
  const goal = (await read(harness)).goal!;
  assert.deepEqual(goal.agreement, { ownerWants: AGREEMENT.owner_wants, doneWhen: AGREEMENT.done_when, revision: 1 });
  assert.deepEqual(goal.selfDecided, []);
});

test("пункты «Решаю сам» сохраняют вид, начинаются неподтверждёнными и переживают перезагрузку", async () => {
  const harness = await setup([{ kind: "assumption", text: "Квартал — календарный." }, { kind: "deferred_by_owner", text: "Формат выгрузки решим позже." }]);
  await harness.reloadSession("reload");
  const items = (await read(harness)).goal!.selfDecided!;
  assert.deepEqual(items.map((item) => [item.kind, item.state]), [["assumption", "unconfirmed"], ["deferred_by_owner", "unconfirmed"]]);
  assert.equal((await read(harness)).goal!.agreement!.revision, 1);
});

test("правка цели принимается только после реплики владельца и несёт новую редакцию договорённости", async () => {
  const harness = await setup();
  const amendment = { amendment: "Добавить разбивку по регионам.", agreement: { ...AGREEMENT, owner_wants: "Собрать отчёт о продажах с разбивкой по регионам." } };
  await assert.rejects(harness.runTool("amend_goal", amendment, undefined, { ownerReply: false }), /нужен настоящий ответ владельца/);
  await ownerSays(harness, "owner-1", "Добавь разбивку по регионам.");
  await assert.rejects(harness.runTool("amend_goal", { amendment: "Добавить разбивку по регионам.", agreement: undefined }, undefined, { ownerReply: false }), /передай agreement/);
  const applied = await harness.runTool("amend_goal", amendment, undefined, { ownerReply: false }) as { details: { amendment_id: string } };
  const goal = (await read(harness)).goal!;
  assert.equal(goal.agreement!.revision, 2);
  assert.match(goal.agreement!.ownerWants, /по регионам/);
  // Одна реплика разрешает одну правку: следующая ждёт новую реплику.
  await assert.rejects(harness.runTool("amend_goal", { ...amendment, amendment: "Ещё и по менеджерам." }, undefined, { ownerReply: false }), /нужен настоящий ответ владельца/);
  // Восстановление документа по amendment_id цель не меняет и реплики не требует.
  await harness.runTool("amend_goal", { amendment_id: applied.details.amendment_id }, undefined, { ownerReply: false });
});

test("подтвердить или отклонить пункт можно только в ходе, начатом репликой владельца", async () => {
  const harness = await setup();
  const added = await harness.runTool("record_goal_note", { kind: "decision", title: "Источник данных", decision: "Беру выгрузку из CRM.", rationale: "Других источников в задаче нет.", self_decided: "proposal" }) as { details: { selfDecidedId: string } };
  const itemId = added.details.selfDecidedId;
  assert.match(itemId, /^S-/);
  assert.equal((await read(harness)).goal!.selfDecided!.length, 2);
  await assert.rejects(harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "confirmed" }), /только владелец/);
  await ownerSays(harness, "owner-crm", "CRM подходит.");
  await harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "confirmed" });
  const confirmed = (await read(harness)).goal!.selfDecided!.find((item) => item.id === itemId)!;
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.ownerEntryId, "owner-crm");
  await endRun(harness);
  await assert.rejects(harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "rejected" }), /только владелец/);
});

test("ответ владельца на ask_user открывает ход для подтверждения пункта", async () => {
  const harness = await setup();
  const itemId = (await read(harness)).goal!.selfDecided![0]!.id;
  const call = { type: "toolCall" as const, id: "ask-1", name: "ask_user", arguments: {} };
  const answer = { role: "toolResult" as const, toolCallId: call.id, toolName: "ask_user", isError: false, timestamp: 1,
    content: [{ type: "text" as const, text: "User answered: финансовый квартал" }],
    details: { mode: "single", cancelled: false, response: { kind: "freeform", text: "Нет, финансовый квартал." } } };
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  harness.entries.push({ type: "message", id: "answer-1", parentId: null, timestamp: new Date().toISOString(), message: answer });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: { ...assistantMessage("toolUse", { input: 1, output: 1 }), content: [call] }, toolResults: [answer] });
  await harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "rejected" });
  const item = (await read(harness)).goal!.selfDecided![0]!;
  assert.deepEqual([item.state, item.ownerEntryId], ["rejected", "answer-1"]);
});

const verifying = { action: "publish", status: "verifying", phase: "Сверяю отчёт", summary: "Отчёт собран и сверен с выгрузкой.", verification: "Итоги отчёта совпали с выгрузкой.", nextStep: "Закрыть цель." };
const complete = (harness: Harness) => harness.runTool("update_goal", { status: "complete" }, undefined, { agreementCheck: "raw" });

test("первая попытка закрытия возвращает договорённость, вторая при тех же данных закрывает цель", async () => {
  const harness = await setup();
  await harness.runTool("report_goal_progress", verifying);
  await assert.rejects(complete(harness), (error: unknown) => {
    const receipt = JSON.parse((error as Error).message) as { stage: string; applied: boolean; message: string };
    assert.equal(receipt.stage, "agreement_check");
    assert.equal(receipt.applied, false);
    assert.match(receipt.message, /Собрать отчёт о продажах за квартал/);
    assert.match(receipt.message, /Квартал — календарный/);
    assert.match(receipt.message, /Отчёт открывается и сходится с выгрузкой/);
    return true;
  });
  assert.equal((await read(harness)).goal!.status, "active");
  const done = await complete(harness) as { content: Array<{ text: string }>; details: { unconfirmedSelfDecided?: unknown[] } };
  assert.equal((await read(harness)).goal!.status, "complete");
  // Владелец видит, что агент решил сам без его слова (Т6.4).
  assert.match(done.content[0]!.text, /Не подтверждено владельцем:\n1\. \[допущение\] Квартал — календарный\./);
  assert.equal(done.details.unconfirmedSelfDecided?.length, 1);
});

test("правка плана или нового пункта после первой попытки требует сверки заново", async () => {
  const harness = await setup();
  const goalId = (await read(harness)).goal!.goalId;
  await harness.runTool("report_goal_progress", verifying);
  await assert.rejects(complete(harness), /agreement_check/);
  await harness.runTool("record_goal_note", { kind: "decision", title: "Округление", decision: "Округляю суммы до рубля.", rationale: "Так в выгрузке.", self_decided: "assumption" });
  // Новый пункт делает прежнюю проверку устаревшей (П8), а после новой проверки договорённость возвращается снова.
  await assert.rejects(complete(harness), /свежий отчёт со статусом verifying/);
  await harness.runTool("report_goal_progress", { ...verifying, verification: "Округление сверено с выгрузкой." });
  await assert.rejects(complete(harness), /agreement_check/);
  const plan = { outcome: "Отчёт о продажах.", doneWhen: "Отчёт сходится.", summary: "Отчёт собран.", activeDecisionIds: [], items: [{ id: "report", title: "Собрать отчёт", status: "done", source: "user" }] };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: plan });
  await harness.runTool("report_goal_progress", { ...verifying, verification: "План сверен, итоги совпали с выгрузкой." });
  await assert.rejects(complete(harness), /agreement_check/);
  await complete(harness);
  assert.equal((await read(harness)).goal!.status, "complete");
});

test("с выключенной сверкой закрытие идёт с первой попытки, как в прежней сборке", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-agreement-features-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "goal-reports.json"), JSON.stringify({ features: { completionReturn: false } }));
    const harness = createRuntimeHarness({ cwd });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runTool("create_goal", { objective: "Отчёт о продажах", agreement: AGREEMENT, self_decided: [] });
    await harness.runTool("report_goal_progress", verifying);
    await complete(harness);
    assert.equal((await read(harness)).goal!.status, "complete");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("собранное расширение ставит договорённость за сводкой сжатия в каждом запросе", async () => {
  const harness = await setup();
  const summary = { role: "compactionSummary", summary: "## Цель\nПересказ.\n\n## Прогресс\n- шаг", tokensBefore: 10, timestamp: 1 };
  const results = await harness.emit("context", { type: "context", messages: [summary, { role: "user", content: "дальше", timestamp: 2 }] }) as Array<{ messages?: Array<{ role: string; customType?: string; content?: unknown; summary?: string }> } | undefined>;
  const messages = results.find((result) => result?.messages?.some((message) => message.customType === "goal-compact-agreement"))?.messages;
  assert.ok(messages, "договорённость должна попасть в окно");
  assert.equal(messages[0]!.summary, "## Прогресс\n- шаг");
  assert.equal(messages[1]!.customType, "goal-compact-agreement");
  assert.match(String(messages[1]!.content), /Собрать отчёт о продажах за квартал/);
});

async function continuationAfterPlan(harness: Harness): Promise<string> {
  const goalId = (await read(harness)).goal!.goalId;
  const plan = { outcome: "Пересказ результата в плане.", doneWhen: "Пересказ критерия в плане.", summary: "Отчёт собирается.", activeDecisionIds: [], items: [{ id: "report", title: "Собрать отчёт", status: "active", source: "user" }] };
  await harness.runTool("update_goal_work", { goal_id: goalId, expected_revision: 0, state: plan });
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Собираю отчёт", summary: "Начал сборку отчёта.", changed: "Подключена выгрузка.", nextStep: "Свести итоги." });
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 10, output: 2 }), toolResults: [] });
  const settled = await settleRun(harness);
  assert.equal(settled.continued, true);
  return String(settled.entries[0]?.content ?? "");
}

test("продолжение несёт шаг и план, но не пересказывает результат и критерий из договорённости", async () => {
  const text = await continuationAfterPlan(await setup());
  assert.match(text, /Собрать отчёт/);
  assert.doesNotMatch(text, /Пересказ результата в плане|Пересказ критерия в плане/);
  const cwd = await mkdtemp(join(tmpdir(), "goal-agreement-features-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "goal-reports.json"), JSON.stringify({ features: { singleFactOwner: false } }));
    const legacy = createRuntimeHarness({ cwd });
    await legacy.emit("session_start", { type: "session_start", reason: "startup" });
    await legacy.runTool("create_goal", { objective: "Отчёт о продажах", agreement: AGREEMENT, self_decided: [] });
    assert.match(await continuationAfterPlan(legacy), /Пересказ критерия в плане/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("описание create_goal просит задать вопросы до цели, выключатель возвращает прежнее", async () => {
  const description = (harness: Harness) => String(harness.getToolMetadata("create_goal")?.description ?? "");
  const harness = createRuntimeHarness();
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.match(description(harness), /спроси владельца одним пакетом ask_user[\s\S]*запиши свои допущения в self_decided/);
  const cwd = await mkdtemp(join(tmpdir(), "goal-agreement-features-"));
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "goal-reports.json"), JSON.stringify({ features: { askBeforeGoal: false } }));
    const quiet = createRuntimeHarness({ cwd });
    await quiet.emit("session_start", { type: "session_start", reason: "startup" });
    assert.doesNotMatch(description(quiet), /пакетом ask_user/);
    assert.match(description(quiet), /Создаёт долгую цель только после явной просьбы/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("GOAL.md показывает договорённость и состояние пунктов «Решаю сам» после подтверждения владельцем", async () => {
  const harness = await setup();
  const state = await read(harness);
  const path = fileURLToPath(state.artifactRefs.find((ref) => ref.artifact === "GOAL")!.path);
  const before = await readFile(path, "utf8");
  assert.match(before, /## Договорённость \(редакция 1\)[\s\S]*Собрать отчёт о продажах за квартал\.[\s\S]*\[допущение\] Квартал — календарный\.[\s\S]*Отчёт открывается и сходится с выгрузкой\./);
  const itemId = state.goal!.selfDecided![0]!.id;
  await ownerSays(harness, "owner-quarter", "Да, календарный.");
  await harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "confirmed" });
  await harness.waitForGoalProjection();
  assert.match(await readFile(path, "utf8"), /\[допущение — подтверждено владельцем\] Квартал — календарный\./);
});

test("каждая новая редакция договорённости один раз появляется в ленте, /gw показывает договорённость", async () => {
  const harness = await setup();
  const agreementEntries = () => harness.entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-compact-observability"
    && String((entry.data as { key?: unknown }).key).startsWith("agreement")).map((entry) => (entry.type === "custom" ? entry.data as { lines: string[] } : { lines: [] }).lines.join("\n"));
  assert.equal(agreementEntries().length, 1);
  assert.match(agreementEntries()[0]!, /редакция 1[\s\S]*Собрать отчёт о продажах за квартал\.[\s\S]*1\. \[допущение\] Квартал — календарный\./);
  await ownerSays(harness, "owner-region", "Добавь разбивку по регионам.");
  await harness.runTool("amend_goal", { amendment: "Разбить отчёт по регионам.", agreement: { owner_wants: "Отчёт о продажах по регионам.", done_when: "Отчёт сходится по каждому региону." } }, undefined, { ownerReply: false });
  assert.equal(agreementEntries().length, 2);
  assert.match(agreementEntries()[1]!, /редакция 2[\s\S]*по регионам/);
  await harness.runSlashCommand("gw");
  const overview = harness.entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-compact-observability").at(-1);
  const lines = (overview?.type === "custom" ? overview.data as { lines: string[] } : { lines: [] }).lines.join("\n");
  assert.match(lines, /Договорённость \(ред\. 2\): Отчёт о продажах по регионам\.\nГотово, когда: Отчёт сходится по каждому региону\.\nРешаю сам, не подтверждено:\n  1\. Квартал — календарный\./);
});

test("после смены пунктов «Решаю сам» прежний отчёт verifying не закрывает цель", async () => {
  const harness = await setup();
  const verifying = { action: "publish", status: "verifying", phase: "Проверяю отчёт", summary: "Отчёт собран и сверен.", verification: "Сверено с выгрузкой.", nextStep: "Закрыть цель." };
  await harness.runTool("report_goal_progress", verifying);
  const itemId = (await read(harness)).goal!.selfDecided![0]!.id;
  await ownerSays(harness, "owner-no", "Нет, квартал финансовый.");
  await harness.runTool("record_goal_note", { kind: "decision", action: "update", note_id: itemId, confirmation: "rejected" });
  await assert.rejects(harness.runTool("update_goal", { status: "complete" }), /свежий отчёт со статусом verifying/);
  assert.equal((await read(harness)).goal!.status, "active");
  await harness.runTool("report_goal_progress", { ...verifying, summary: "Отчёт пересобран по финансовому кварталу." });
  await harness.runTool("update_goal", { status: "complete" });
  assert.equal((await read(harness)).goal!.status, "complete");
});
