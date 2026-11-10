/**
 * Дымовой прогон Б5 на настоящем Pi без сети (требование Т10.3): сессию с незакрытой целью начинает
 * прежняя пара `pi-codex-goal` и `context-compaction`, а продолжает собранное расширение — цель видна,
 * продолжается после ответа владельца и закрывается.
 *
 * Прежние репозитории ищутся рядом с этим; без них проверка пропускается.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { probeSteps, withProbe, type ProbeScript, type Row } from "../support/offline-pi.js";

const siblings = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const legacy = [resolve(siblings, "pi-codex-goal/src/index.ts"), resolve(siblings, "context-compaction/index.ts")];
const available = legacy.every((path) => existsSync(path));

const script: ProbeScript = {
  calls: {
    // Ходы 1–3 идут на прежней паре и в её схеме инструментов.
    1: ["create_goal", { objective: "Проверить, что новая версия продолжает цель прежней пары." }],
    2: ["report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Выбор", summary: "Нужен выбор владельца.", needUser: "Выберите A.", nextStep: "Обработать ответ." }],
    4: ["report_goal_progress", { action: "publish", status: "working", phase: "Продолжение", summary: "Ответ A получен.", changed: "Ответ A обработан новой версией.", nextStep: "Завершить проверку." }],
    5: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Цель прежней пары продолжена и проверена.", nextStep: "Завершить цель." }],
    // Первая попытка закрытия возвращает договорённость на сверку, вторая закрывает цель.
    6: ["update_goal", { status: "complete" }],
    7: ["update_goal", { status: "complete" }],
  },
  heavySteps: [],
  stopSteps: [3],
  lastStep: 8,
};

const goalIds = (rows: Row[], type: string) => new Set(rows.filter((row) => row.customType === type).map((row) => row.data?.goal && (row.data.goal as { goalId?: string }).goalId).filter(Boolean));

test("Б5: сессия прежней пары с незакрытой целью продолжается и закрывается новой версией", { timeout: 60_000, skip: available ? false : "нет соседних репозиториев pi-codex-goal и context-compaction" }, async () => {
  await withProbe(script, async (start) => {
    const old = await start("legacy", { extensions: legacy });
    assert.deepEqual(probeSteps(old), [1, 2, 3], "прежняя пара остановилась в ожидании ответа");
    const [goalId] = goalIds(old, "pi-codex-goal");
    assert.ok(goalId, "цель создана прежней парой");
    assert.ok(old.some((row) => row.customType === "pi-codex-goal-projection" && row.data?.kind === "progress_reported"), "прежняя пара приняла отчёт об ожидании ответа");
    const seed = old.map((row) => JSON.stringify(row)).join("\n") + "\n";
    const rows = await start("current", { seed, prompt: "Ответ: A. Продолжай." });
    assert.deepEqual(probeSteps(rows), [1, 2, 3, 4, 5, 6, 7, 8], "каждый ход провайдера ровно один раз");
    const answer = rows.findIndex((row) => row.message?.role === "user" && JSON.stringify(row.message.content).includes("Ответ: A"));
    const resumed = rows.findIndex((row) => row.customType === "probe-step" && row.data?.step === 4);
    assert.ok(answer >= 0 && answer < resumed, "цель ждала ответа владельца и продолжилась только после него");
    const completed = rows.filter((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete");
    assert.ok(completed.length > 0, "цель закрыта новой версией");
    assert.deepEqual([...goalIds(completed, "goal-compact-goal")], [goalId], "закрыта та же цель");
    assert.equal(rows.filter((row) => row.message?.role === "assistant" && ["error", "aborted"].includes(row.message.stopReason ?? "")).length, 0, "без ошибок и обрывов");
  });
});
