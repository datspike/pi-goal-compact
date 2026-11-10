/**
 * Дымовой прогон Б2 на настоящем Pi без сети: сжатие, после которого повторного хода у Pi нет,
 * будит активную цель ровно одним продолжением.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, probeSteps, seedThrough, withProbe, type ProbeScript, type Row } from "../support/offline-pi.js";

const script: ProbeScript = {
  calls: {
    1: ["create_goal", { objective: "Проверить продолжение после сжатия в простое без сети.", agreement: AGREEMENT, self_decided: [] }],
    3: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Продолжение после сжатия выполнено.", nextStep: "Завершить цель." }],
    // Первая попытка закрытия возвращает договорённость на сверку, вторая закрывает цель.
    4: ["update_goal", { status: "complete" }],
    5: ["update_goal", { status: "complete" }],
  },
  heavySteps: [2],
  lastStep: 6,
};

const wakeups = (rows: Row[]) => rows.filter((row) => row.type === "custom_message" && (row.customType === "goal-compact-ticket" || row.customType === "goal-compact-goal"));

function assertCompleted(rows: Row[], name: string): void {
  assert.deepEqual(probeSteps(rows), [1, 2, 3, 4, 5, 6], `${name}: каждый ход провайдера ровно один раз`);
  assert.equal(rows.filter((row) => row.type === "compaction").length, 1, `${name}: ровно одно сжатие`);
  assert.equal(rows.filter((row) => row.message?.role === "assistant" && ["error", "aborted"].includes(row.message.stopReason ?? "")).length, 0, `${name}: без ошибок и обрывов`);
  assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"), `${name}: цель закрыта`);
}

test("Б2: сжатие по порогу после ответа будит цель одним продолжением на настоящем Pi", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start) => {
    const rows = await start("threshold");
    assertCompleted(rows, "threshold");
    // На Pi 1.5 продолжение уходит на `agent_before_settle` раньше сжатия, и билет уже не нужен.
    assert.equal(wakeups(rows).length, 1, "ровно одно пробуждение");
  });
});

test("Б2: сжатие в простое после перезапуска будит активную цель одним билетом на настоящем Pi", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start) => {
    const first = await start("source");
    const stopped = first.find((row) => row.message?.role === "assistant" && row.message.stopReason === "stop");
    assert.ok(stopped, "в журнале есть ответ без вызова инструмента");
    // Журнал обрывается на ответе с почти полным окном: новый процесс сжимает его при старте, в простое и без повтора.
    const rows = await start("idle", { seed: seedThrough(first, (row) => row === stopped) });
    assertCompleted(rows, "idle");
    assert.equal(rows.filter((row) => row.type === "custom_message" && row.customType === "goal-compact-ticket").length, 1, "ровно один билет");
    assert.equal(wakeups(rows).length, 1, "ровно одно пробуждение");
  });
});
