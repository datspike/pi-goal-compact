import assert from "node:assert/strict";
import test from "node:test";
import type { GoalStatusWorkingState } from "../../src/goal/format.js";
import { filterGoalCompactionInput } from "../../src/goal/goal-compaction.js";
import { createRuntimeHarness, settleRun } from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;
const status = async (h: Harness) => (await h.runTool("get_goal", { view: "status" }) as { details: GoalStatusWorkingState }).details;
const create = (h: Harness, minimum_active_seconds?: number | null) => h.runTool("create_goal", {
  objective: "Сравнить два способа выгрузки.", mode: "research", self_decided: [],
  agreement: { owner_wants: "Сравнить способы", done_when: "Есть проверенное сравнение и рекомендация.", minimum_active_seconds },
});

function toolEvent(h: Harness, type: "tool_execution_start" | "tool_execution_end", toolName: string) {
  return h.emit(type, { type, toolName, toolCallId: toolName, args: {}, result: {}, isError: false });
}

test("Подсказка и статус используют один остаток; чистое ожидание и разрыв не начисляют время", async t => {
  let now = 100_000;
  t.mock.method(Date, "now", () => now);
  const h = createRuntimeHarness();
  await create(h, 120);
  h.setIdle(false);
  await h.emit("agent_start", { type: "agent_start" });
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
  now += 2_000;
  await toolEvent(h, "tool_execution_start", "bg_wait");
  now += 10_000;
  assert.equal((await status(h)).usage.activeSeconds, 2);
  await toolEvent(h, "tool_execution_start", "bash");
  now += 3_000;
  await toolEvent(h, "tool_execution_end", "bash");
  now += 10_000;
  await toolEvent(h, "tool_execution_end", "bg_wait");
  assert.deepEqual((await status(h)).activeTimeEstimate, { kind: "approximate", countedSeconds: 5, minimumSeconds: 120, remainingSeconds: 115 });

  const frame = (await settleRun(h)).entries.find(entry => String(entry.content).includes("pi_goal_active_time"));
  assert.ok(frame && typeof frame.content === "string");
  assert.match(frame.content, /осталось около 1m/);
  assert.match(frame.content, /не вызывай инструменты для пересчёта/i);
  assert.doesNotMatch(frame.content, /Время работы над целью/);
  const copy = { ...frame, role: "custom", timestamp: now, display: false } as const;
  const prepared = { messagesToSummarize: [copy], turnPrefixMessages: [] } as Parameters<typeof filterGoalCompactionInput>[0];
  filterGoalCompactionInput(prepared);
  assert.equal(prepared.messagesToSummarize.length, 1);
  assert.doesNotMatch(JSON.stringify(prepared.messagesToSummarize.map(message => message.role === "custom" ? message.content : null)), /pi_goal_active_time|осталось около|для пересчёта/);

  await h.emit("agent_end", { type: "agent_end", messages: [] });
  h.setIdle(true);
  await h.runSlashCommand("gp");
  const paused = await status(h);
  assert.equal(paused.lifecycle, "paused");
  now += 7_200_000;
  await h.reloadSession();
  assert.deepEqual((await status(h)).activeTimeEstimate, paused.activeTimeEstimate);
  await h.runSlashCommand("gs");
  assert.match(JSON.stringify(h.entries.at(-1)), /осталось около 1m/);
  await h.runSlashCommand("gr");
  h.setIdle(false);
  await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
  now += 4_000;
  await h.emit("agent_end", { type: "agent_end", messages: [] });
  assert.equal((await status(h)).activeTimeEstimate?.kind, "approximate");
  assert.equal((await status(h)).usage.activeSeconds, 9);

  await h.runTool("update_goal", { status: "complete", verification: "Сравнение сохранено; по приблизительному учёту минимум не набран." });
  assert.equal((await status(h)).lifecycle, "complete", "сам счётчик не блокирует закрытие");
});

test("Недоступный остаток не превращается в ноль, прежний договор не получает новую оценку", async () => {
  const h = createRuntimeHarness();
  await create(h, null);
  assert.deepEqual((await status(h)).activeTimeEstimate, { kind: "unavailable" });
  h.setIdle(false);
  await h.emit("agent_start", { type: "agent_start" });
  assert.match(JSON.stringify((await settleRun(h)).entries), /оценка оставшегося времени недоступна/);
  const legacy = createRuntimeHarness();
  await create(legacy);
  assert.equal((await status(legacy)).activeTimeEstimate, undefined);
});

for (const mode of [undefined, "outcome"] as const) {
  for (const minimum of [120, null] as const) {
    test(`Правила минимума действуют и после поправки: ${mode ?? "без режима"}, ${minimum}`, async () => {
      const h = createRuntimeHarness();
      const agreement = { owner_wants: "Сверить выгрузки", done_when: "Есть сравнение выгрузок." };
      await h.runTool("create_goal", { objective: "Сверить выгрузки.", agreement, self_decided: [], ...(mode ? { mode } : {}) });
      await h.runTool("amend_goal", { amendment: "Добавить согласованный минимум времени.",
        agreement: { ...agreement, minimum_active_seconds: minimum } });
      await h.reloadSession();
      assert.equal((await status(h)).goal?.mode, mode);
      h.setIdle(false);
      await h.emit("agent_start", { type: "agent_start" });
      const frame = (await settleRun(h)).entries.find(entry => String(entry.content).includes("pi_goal_active_time"));
      assert.ok(frame && typeof frame.content === "string");
      if (minimum === null) {
        assert.match(frame.content, /Обязательный минимум времени не подтверждён/);
        assert.match(frame.content, /цель оставь открытой/);
      } else {
        assert.match(frame.content, /Время считает Pi/);
        assert.match(frame.content, /сразу начни его/);
        assert.match(frame.content, /чем сделанное отвечает условиям договора/);
      }
      const prepared = { messagesToSummarize: [{ ...frame, role: "custom", timestamp: 1, display: false }], turnPrefixMessages: [] } as Parameters<typeof filterGoalCompactionInput>[0];
      filterGoalCompactionInput(prepared);
      assert.equal(prepared.messagesToSummarize.length, 1);
      const projected = prepared.messagesToSummarize[0];
      assert.ok(projected?.role === "custom");
      assert.doesNotMatch(String(projected.content), /pi_goal_active_time/);
    });
  }
}
