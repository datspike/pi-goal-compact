/**
 * Дымовой прогон Б3 на настоящем Pi без сети: при сжатии с активной целью служебные продолжения
 * не попадают во вход сводчика, а окно после сжатия несёт сводку без раздела «Цель» и ровно одну
 * копию договорённости.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, withProbe, type ProbeScript } from "../support/offline-pi.js";

const report = (n: number) => ["report_goal_progress", { action: "publish", status: "working", phase: "Работа", summary: `Шаг ${n} сделан.`, changed: `Сделан шаг ${n}.`, nextStep: "Следующий шаг." }] as [string, Record<string, unknown>];

const script: ProbeScript = {
  calls: {
    1: ["create_goal", { objective: "Проверить окно после сжатия без сети.", agreement: AGREEMENT, self_decided: [] }],
    // Ход 2 заканчивается ответом без инструмента: цель продолжается служебным сообщением. Ходы 3–5
    // отодвигают его из оставленного хвоста окна в сводимую часть истории.
    3: report(3),
    4: report(4),
    5: report(5),
    7: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Окно после сжатия проверено.", nextStep: "Завершить цель." }],
    // Первая попытка закрытия возвращает договорённость на сверку, вторая закрывает цель.
    8: ["update_goal", { status: "complete" }],
    9: ["update_goal", { status: "complete" }],
  },
  heavySteps: [6],
  lastStep: 10,
};

const count = (text: string, part: string) => text.split(part).length - 1;

test("Б3: окно после сжатия с целью — сводка без «Цели», одна договорённость, без служебных продолжений", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const rows = await start("window");
    assert.equal(rows.filter((row) => row.type === "compaction").length, 1, "ровно одно сжатие");
    assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"), "цель закрыта");
    const log = requests("window");
    const goalId = /"goalId":"([0-9a-f-]{36})"/.exec(JSON.stringify(rows))?.[1];
    assert.ok(goalId, "цель создана");
    const summaries = log.filter((request) => request.kind === "summary");
    assert.ok(summaries.length > 0, "сводку писало расширение");
    const summarized = summaries.map((request) => request.window).join("\n");
    assert.ok(summarized.includes(`Goal ID: ${goalId}`), "служебное продолжение попало в сводимую часть истории");
    assert.equal(count(summarized, "pi_goal_continuation"), 0, "во вход сводчика продолжение идёт без служебной обёртки");
    assert.equal(count(summarized, "goal-compact-ticket"), 0, "билет не попадает во вход сводчика");
    const after = log.find((request) => request.kind === "turn" && request.step === 7);
    assert.ok(after, "после сжатия цель продолжилась");
    assert.ok(after.window.includes("Продолжить проверку."), "в окне есть сводка");
    assert.ok(!after.window.includes("Довести проверку до закрытия цели."), "раздел «Цель» сводки уступил место договорённости");
    assert.equal(count(after.window, "## Договорённость (редакция"), 1, "ровно одна копия договорённости");
    // Закрытие после сжатия не меняет начало окна (решение 0012): договорённость и сводка без «Цели»
    // стоят там же, а ответ на закрытие говорит, что договорённость больше не действует.
    const closed = log.find((request) => request.kind === "turn" && request.step === 10);
    assert.ok(closed, "после закрытия был ещё запрос");
    const head = (window: string) => window.slice(0, window.indexOf("### Готово, когда"));
    assert.equal(head(closed.window), head(after.window), "начало окна после закрытия то же");
    assert.ok(!closed.window.includes("Довести проверку до закрытия цели."), "раздел «Цель» сводки не вернулся");
    assert.ok(closed.window.includes("остаётся там до следующего сжатия только как история"), "ответ на закрытие несёт пометку");
  });
});
