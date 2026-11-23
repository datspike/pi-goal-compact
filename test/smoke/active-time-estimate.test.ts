import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { seedThrough, withProbe, type ProbeScript, type Row } from "../support/offline-pi.js";

const extensions = ["../../src/index.ts", "../support/offline-clock.ts"].map(path => fileURLToPath(new URL(path, import.meta.url)));
const script: ProbeScript = {
  calls: {
    1: ["create_goal", { mode: "research", objective: "Сравнить две выгрузки.", self_decided: [],
      agreement: { owner_wants: "Сравнить выгрузки", done_when: "Есть сравнение и рекомендация.", minimum_active_seconds: 600 } }],
    2: ["clock_sample", {}],
    3: ["bg_wait", {}],
    5: ["get_goal", { view: "status" }],
    6: ["update_goal", { status: "complete", verification: "Выгрузки совпали; сравнение завершено, оценка времени ниже минимума." }],
    7: ["update_goal", { status: "complete" }],
  }, heavySteps: [], lastStep: 8,
};

function estimate(rows: Row[]) {
  const result = rows.find(row => row.message?.toolName === "get_goal");
  assert.ok(result && !result.message?.isError);
  const content = result.message?.content as [{ text: string }];
  return JSON.parse(content[0].text).activeTimeEstimate as { kind: string; countedSeconds: number; minimumSeconds: number; remainingSeconds: number };
}

test("Новый процесс Pi читает сохранённый остаток, не засчитывает разрыв и не блокирует закрытие", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const rows = await start("clock-first", { extensions });
    const before = estimate(rows);
    assert.equal(before.kind, "approximate");
    assert.ok(before.countedSeconds >= 1 && before.remainingSeconds > 0);
    const boundary = requests("clock-first").find(r => r.step === 5)?.window;
    assert.match(boundary ?? "", /<pi_goal_active_time>По учёту Pi:/);
    assert.ok(rows.some(row => row.data?.goal?.status === "complete"));

    // Новый процесс открывает канонические записи сразу после той же границы. Старые отметки
    // журнала моделируют долгий разрыв без ожидания в тесте и не заменяют сохранённые секунды.
    const seed = seedThrough(rows, row => row.type === "custom_message" && typeof row.content === "string" && row.content.includes("<pi_goal_active_time>"))
      .trim().split("\n").map(line => JSON.stringify({ ...JSON.parse(line), timestamp: "2000-01-01T00:00:00.000Z" })).join("\n") + "\n";
    const resumed = await start("clock-reopened", { extensions, seed, prompt: "Продолжай сравнение." });
    const after = estimate(resumed);
    assert.equal(after.minimumSeconds, before.minimumSeconds);
    assert.ok(after.countedSeconds >= before.countedSeconds && after.countedSeconds <= before.countedSeconds + 1);
    assert.ok(resumed.some(row => row.data?.goal?.status === "complete"));
  });
});
