import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "../../src/compaction/file-hints.js";

import { DEFAULT_GOAL_FEATURES } from "../../src/goal/goal-report-config.js";
import { clearEntry, createThreadGoal, setEntry, withAgreement } from "../../src/goal/state.js";
import { assembleWindow, compactedOwnerReplies, goalAtCompaction, lastOwnerReplies, withoutGoalSection } from "../../src/goal/window.js";
import { RECORD } from "../../src/records.js";
import type { ThreadGoal } from "../../src/goal/types.js";

const SUMMARY = ["## Цель", "Пересказ цели моделью.", "", "## Ограничения и предпочтения", "- Писать по-русски.", "", "## Прогресс", "### Готово", "- [x] Шаг"].join("\n");
const summary: AgentMessage = { role: "compactionSummary", summary: SUMMARY, tokensBefore: 1000, timestamp: 5 };
const kept: AgentMessage = { role: "user", content: "Сохранённая реплика.", timestamp: 6 };
const agreementInput = { ownerWants: "Отчёт о продажах.", doneWhen: "Отчёт сходится с выгрузкой.", selfDecided: [{ kind: "assumption" as const, text: "Квартал календарный." }] };

const goalWithAgreement = () => createThreadGoal("Отчёт о продажах", null, 1, agreementInput);
const customOf = (messages: readonly AgentMessage[], type: string) => messages.filter((message) => message.role === "custom" && message.customType === type);
const textOf = (message: AgentMessage | undefined): string => message?.role === "custom" && typeof message.content === "string" ? message.content : "";

test("раздел «Цель» вырезается до следующего заголовка, остальные разделы остаются", () => {
  const stripped = withoutGoalSection(SUMMARY);
  assert.doesNotMatch(stripped, /Пересказ цели/);
  assert.match(stripped, /^## Ограничения и предпочтения/);
  assert.match(stripped, /### Готово/);
  assert.equal(withoutGoalSection("## Goal\nx\n## Progress\ny"), "## Progress\ny");
});

test("при незакрытой цели сразу за сводкой стоит одна копия последней редакции договорённости", () => {
  const goal = goalWithAgreement();
  const window = assembleWindow([summary, kept], { goal, features: DEFAULT_GOAL_FEATURES, ownerReplies: ["Старая реплика."] })!;
  assert.equal(window[0]!.role, "compactionSummary");
  assert.doesNotMatch(window[0]!.role === "compactionSummary" ? window[0]!.summary : "", /Пересказ цели/);
  assert.equal(window[1]!.role === "custom" && window[1]!.customType, RECORD.agreement);
  assert.match(textOf(window[1]), /редакция 1[\s\S]*Отчёт о продажах\.[\s\S]*1\. \[допущение\] Квартал календарный\.[\s\S]*Отчёт сходится с выгрузкой\./);
  assert.equal(customOf(window, RECORD.agreement).length, 1);
  assert.equal(customOf(window, RECORD.ownerReplies).length, 0);
  assert.deepEqual(window[2], kept);
  // Сборщик не держит копию между запросами: новая редакция сразу заменяет прежнюю.
  const amended = withAgreement(goal, { ownerWants: "Отчёт о продажах по регионам.", doneWhen: "Отчёт сходится." });
  const next = assembleWindow([summary, kept], { goal: amended, features: DEFAULT_GOAL_FEATURES, ownerReplies: [] })!;
  assert.equal(customOf(next, RECORD.agreement).length, 1);
  assert.match(textOf(next[1]), /редакция 2[\s\S]*по регионам/);
});

test("без сжатия окно не меняется", () => {
  assert.equal(assembleWindow([kept], { goal: goalWithAgreement(), features: DEFAULT_GOAL_FEATURES, ownerReplies: ["x"] }), undefined);
});

test("без цели сводка остаётся целой, а за ней идут последние реплики владельца дословно", () => {
  const goals: Array<ThreadGoal | null> = [null, { ...goalWithAgreement(), status: "complete" }];
  for (const goal of goals) {
    const assembled: AgentMessage[] = assembleWindow([summary, kept], { goal, features: DEFAULT_GOAL_FEATURES, ownerReplies: ["Первая.", "Сделай отчёт\nпо-русски."] })!;
    assert.equal(assembled[0], summary);
    assert.equal(customOf(assembled, RECORD.agreement).length, 0);
    assert.match(textOf(assembled[1]), /> Первая\.\n\n> Сделай отчёт\n> по-русски\./);
  }
  assert.equal(assembleWindow([summary], { goal: null, features: DEFAULT_GOAL_FEATURES, ownerReplies: [] }), undefined);
});

test("реплики владельца ограничены по объёму, новые важнее старых", () => {
  const replies = lastOwnerReplies(["старая", "а".repeat(1000), "б".repeat(800)], 1500);
  assert.equal(replies.length, 2);
  assert.equal(replies[1], "б".repeat(800));
  assert.equal(replies[0], `…${"а".repeat(700)}`);
});

test("каждая доработка окна выключается отдельно и возвращает прежнее поведение", () => {
  const goal = goalWithAgreement();
  const noStrip = assembleWindow([summary], { goal, features: { ...DEFAULT_GOAL_FEATURES, singleFactOwner: false }, ownerReplies: [] })!;
  assert.equal(noStrip[0], summary);
  assert.equal(customOf(noStrip, RECORD.agreement).length, 1);
  const noAgreement = assembleWindow([summary], { goal, features: { ...DEFAULT_GOAL_FEATURES, agreementInWindow: false }, ownerReplies: [] })!;
  assert.equal(customOf(noAgreement, RECORD.agreement).length, 0);
  assert.equal(assembleWindow([summary], { goal: null, features: { ...DEFAULT_GOAL_FEATURES, ownerRepliesWithoutGoal: false }, ownerReplies: ["x"] }), undefined);
});

test("цель прежней пары без договорённости показывает свой договор", () => {
  const legacy = createThreadGoal("Прежний договор цели целиком.", null, 1);
  const window = assembleWindow([summary], { goal: legacy, features: DEFAULT_GOAL_FEATURES, ownerReplies: [] })!;
  assert.match(textOf(window[1]), /Договорённость не записана[\s\S]*Прежний договор цели целиком\./);
});

test("в реплики попадает только сжатая часть ветки, не сохранённые сообщения", () => {
  const user = (id: string, content: unknown) => ({ type: "message", id, message: { role: "user", content } });
  const branch = [
    user("1", "Первая реплика."),
    { type: "message", id: "2", message: { role: "assistant", content: [] } },
    user("3", [{ type: "text", text: "Вторая" }, { type: "image" }]),
    user("4", "Сохранённая."),
    { type: "compaction", id: "5", firstKeptEntryId: "4" },
  ];
  assert.deepEqual(compactedOwnerReplies(branch), ["Первая реплика.", "Вторая"]);
  assert.deepEqual(compactedOwnerReplies(branch.slice(0, 4)), []);
});

const goalRecord = (data: unknown) => ({ type: "custom", customType: RECORD.goal, data });
const compaction = { type: "compaction" };

const headOf = (branch: readonly { type: string; customType?: string; data?: unknown }[], current: ThreadGoal | null) =>
  assembleWindow([summary, kept], { goal: goalAtCompaction(branch, current) ?? current, features: DEFAULT_GOAL_FEATURES, ownerReplies: ["Реплика."] })!;

test("закрытие и поправка той же цели после сжатия не меняют начало окна до следующего сжатия", () => {
  const open = goalWithAgreement();
  const amended = withAgreement(open, { ownerWants: "Отчёт по регионам.", doneWhen: "Сходится." });
  const closed: ThreadGoal = { ...amended, status: "complete" };
  const atCompaction = [goalRecord(setEntry(open, "tool", 1)), compaction];
  const before = headOf(atCompaction, open);
  const afterAmend = [...atCompaction, goalRecord(setEntry(amended, "tool", 2))];
  // Начало окна байт в байт то же: кэш провайдера после сводки не сбрасывается.
  assert.deepEqual(headOf(afterAmend, amended), before);
  assert.match(textOf(before[1]), /редакция 1/);
  const afterClose = [...afterAmend, goalRecord(setEntry(closed, "tool", 3))];
  assert.deepEqual(headOf(afterClose, closed), before);
  const afterClear = [...afterAmend, goalRecord(clearEntry(open.goalId, "command", 3))];
  assert.deepEqual(headOf(afterClear, null), before);
  // Следующее сжатие ставит наверх состояние на свой момент.
  assert.match(textOf(headOf([...afterAmend, compaction], amended)[1]), /редакция 2[\s\S]*по регионам/);
  assert.equal(goalAtCompaction([...afterClose, compaction], null), null);
});

test("другая открытая цель сразу встаёт в начало окна, без сжатия снимка нет", () => {
  const first = goalWithAgreement();
  const second = createThreadGoal("Другая цель", null, 5, { ownerWants: "Другая работа.", doneWhen: "Сделано." });
  const replaced = [goalRecord(setEntry(first, "tool", 1)), compaction, goalRecord(clearEntry(first.goalId, "command", 2)), goalRecord(setEntry(second, "tool", 3))];
  assert.equal(goalAtCompaction(replaced, second), null);
  assert.match(textOf(headOf(replaced, second)[1]), /Другая работа\./);
  const closedBefore = [goalRecord(setEntry(first, "tool", 1)), goalRecord(setEntry({ ...first, status: "complete" }, "tool", 2)), compaction];
  assert.equal(goalAtCompaction(closedBefore, null), null);
  assert.equal(goalAtCompaction([goalRecord(setEntry(first, "tool", 1))], first), null);
});
