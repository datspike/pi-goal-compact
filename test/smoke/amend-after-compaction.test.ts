/**
 * Дымовой прогон на настоящем Pi без сети (решение 0012): поправка договорённости после сжатия
 * не меняет начало окна, а действующая редакция приходит в ответе `amend_goal` в конце окна.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, seedThrough, withProbe, type ProbeScript } from "../support/offline-pi.js";

const AMENDED = { owner_wants: "Проверить продолжение без сети и по регионам.", done_when: "Цель закрыта." };

const script: ProbeScript = {
  calls: {
    1: ["create_goal", { objective: "Проверить поправку после сжатия без сети.", agreement: AGREEMENT, self_decided: [] }],
    // Ожидание владельца держит цель: после сжатия прогон останавливается без продолжений.
    3: ["report_goal_progress", { action: "publish", status: "awaiting_user", eventKind: "progress_checkpoint", phase: "Вопрос", summary: "Нужен ответ владельца.", nextStep: "Ждать ответа.", needUser: "Нужны ли регионы?" }],
    5: ["amend_goal", { amendment: "Владелец добавил регионы.", agreement: AMENDED, self_decided: [] }],
  },
  heavySteps: [2],
  stopSteps: [4],
  lastStep: 6,
};

test("поправка после сжатия: начало окна то же, новая редакция в конце окна", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const first = await start("before");
    assert.equal(first.filter((row) => row.type === "compaction").length, 1, "ровно одно сжатие");
    const last = first[first.length - 1]!;
    const rows = await start("after", { seed: seedThrough(first, (row) => row === last), prompt: "Да, добавь регионы." });
    assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && (JSON.stringify(row.data?.goal) ?? "").includes("по регионам")), "поправка применена");
    const before = requests("before").find((request) => request.kind === "turn" && request.step === 4);
    const after = requests("after").find((request) => request.kind === "turn" && request.step === 6);
    assert.ok(before && after, "оба запроса после сжатия записаны");
    const head = (window: string) => window.slice(0, window.indexOf("### Готово, когда"));
    assert.match(head(before.window), /редакция 1/);
    assert.equal(head(after.window), head(before.window), "начало окна после поправки то же");
    assert.ok(after.window.includes("Действует новая редакция ниже"), "ответ на поправку несёт пометку");
    assert.match(after.window.slice(head(after.window).length), /редакция 2[\s\S]*по регионам/, "новая редакция в конце окна");
  });
});
