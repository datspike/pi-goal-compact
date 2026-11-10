/**
 * Дымовой прогон Б1 на настоящем Pi без сети: ответ `ask_user` переживает сжатие, перезапуск
 * процесса и перезагрузку расширения; затем один отчёт `working`, одно продолжение и закрытие.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, probeSteps, seedThrough, withProbe, type ProbeScript, type Row } from "../support/offline-pi.js";

const script: ProbeScript = {
  calls: {
    1: ["create_goal", { objective: "Проверить автоматическое продолжение после ответа пользователя без сети.", agreement: AGREEMENT, self_decided: [] }],
    2: ["report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Выбор", summary: "Нужен выбор пользователя.", needUser: "Выберите A.", nextStep: "Обработать ответ." }],
    3: ["ask_user", {}],
    4: ["report_goal_progress", { action: "publish", status: "working", phase: "Продолжение", summary: "Ответ A получен.", changed: "Ответ A обработан.", nextStep: "Завершить проверку." }],
    6: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Ответ обработан, продолжение выполнено один раз.", nextStep: "Завершить цель." }],
    // Первая попытка закрытия возвращает договорённость на сверку, вторая закрывает цель.
    7: ["update_goal", { status: "complete" }],
    8: ["update_goal", { status: "complete" }],
  },
  heavySteps: [3],
  lastStep: 9,
};

function assertCompleted(rows: Row[], name: string): void {
  assert.deepEqual(probeSteps(rows), Array.from({ length: script.lastStep }, (_, index) => index + 1), `${name}: каждый ход провайдера ровно один раз`);
  // Ответ на вопрос — квитанция `user_input`, а не подтверждённое решение: `user_decision` пишет только
  // `resume_goal` с подтверждением (так же в `pi-codex-goal` с коммита 2a38b19).
  assert.ok(rows.some((row) => row.customType === "goal-compact-progress" && row.data?.kind === "user_input"), `${name}: ответ пользователя записан`);
  const results = rows.filter((row) => row.message?.role === "toolResult").map((row) => ({ tool: row.message?.toolName, error: row.message?.isError, text: row.message?.content }));
  assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"), `${name}: цель закрыта ${JSON.stringify(results).slice(-3000)}`);
  assert.equal(rows.filter((row) => row.message?.role === "assistant" && ["error", "aborted"].includes(row.message.stopReason ?? "")).length, 0, `${name}: без ошибок и обрывов`);
  assert.equal(rows.filter((row) => row.type === "compaction").length, 1, `${name}: ровно одно сжатие`);
}

test("Б1: ответ на вопрос переживает сжатие, перезапуск и перезагрузку на настоящем Pi", { timeout: 90_000 }, async () => {
  await withProbe(script, async (start) => {
    const fresh = await start("fresh");
    assertCompleted(fresh, "fresh");
    const seed = seedThrough(fresh, (row) => row.type === "compaction");
    assertCompleted(await start("restart", { seed }), "restart");
    assertCompleted(await start("reload", { seed, reload: true }), "reload");
  });
});
