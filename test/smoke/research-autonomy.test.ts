import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AGREEMENT, seedThrough, withProbe, type ProbeRequest, type ProbeScript, type Row } from "../support/offline-pi.js";

const extensions = ["../../src/index.ts", "../support/offline-research.ts"].map(path => fileURLToPath(new URL(path, import.meta.url)));
const work = ["get_goal", { view: "status" }] satisfies [string, object];
const createResearch = ["create_goal", { mode: "research", objective: "Сравнить способы выгрузки.", agreement: AGREEMENT, self_decided: [] }] satisfies [string, object];
const script: ProbeScript = {
  calls: { 1: createResearch, 2: work, 3: ["ask_user", {}], 4: ["try_nested_question", {}], 5: work,
    6: ["update_goal", { status: "complete", verification: "Сравнение завершено." }], 7: ["update_goal", { status: "complete" }], 8: ["ask_user", {}] },
  heavySteps: [4], lastStep: 9,
};

function assertInput(input: ProbeRequest, active: boolean, questionDisabled: boolean): void {
  const count = input.window.split("инженерный соавтор и «двойник»").length - 1;
  assert.equal(count, active ? 1 : 0, `запрос ${input.step}: число полных инструкций`);
  assert.equal(input.tools.includes("ask_user"), !active && !questionDisabled, `запрос ${input.step}: объявление инструмента`);
  if (!active) return;
  for (const rule of [/нашу память и решения владельца в прошлых сессиях/, /первичный эпизод/, /как мы работали/, /поднимись на ступеньку выше/, /Выбери и начни/, /не дают новых полномочий/, /конкретный блокер/]) assert.match(input.window, rule);
}

function results(rows: Row[], tool: string) {
  return rows.flatMap(row => row.message?.role === "toolResult" && row.message.toolName === tool ? [row.message] : []);
}

for (const questionDisabled of [false, true]) test(
  `Настоящий Pi: сохраняет исходную доступность анкеты (${questionDisabled ? "выключена" : "включена"}) при запуске, сжатии, открытии, паузе и закрытии`,
  { timeout: 65_000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const fresh = await start("fresh", { extensions, questionDisabled, prompt: "Начни исследование." });
    const input = (name: string, step: number) => requests(name).find(r => r.kind === "turn" && r.step === step)!;
    assertInput(input("fresh", 1), false, questionDisabled);
    assert.match(input("fresh", 1).window, /При явной просьбе запустить research не вызывай ask_user перед созданием/);
    for (const step of [2, 3, 4, 5, 6, 7]) assertInput(input("fresh", step), true, questionDisabled);
    assertInput(input("fresh", 8), false, questionDisabled);
    assert.ok(fresh.some(row => row.type === "compaction"));
    assert.ok(requests("fresh").some(row => row.kind === "summary"));
    assert.ok(!requests("fresh").filter(row => row.kind === "summary").some(row => row.window.includes("инженерный соавтор и «двойник»")));
    assert.ok(!JSON.stringify(fresh).includes("инженерный соавтор и «двойник»"), "блок не попадает в журнал");
    assert.deepEqual(results(fresh, "ask_user").map(r => r.isError), [true, questionDisabled]);
    assert.doesNotMatch(JSON.stringify(results(fresh, "ask_user")[0]), /User answered/);
    assert.match(JSON.stringify(results(fresh, "try_nested_question")), questionDisabled ? /Tool ask_user not found/ : /В активной исследовательской цели ask_user недоступен/);
    assert.ok(fresh.some(row => row.data?.goal?.status === "complete"));

    const seed = seedThrough(fresh, row => row.type === "compaction");
    await start("reopened", { seed, extensions, questionDisabled, prompt: "Разбери результат проверки." });
    assertInput(requests("reopened").find(r => r.kind === "turn")!, true, questionDisabled);

    const beforeWork = seedThrough(fresh, row => row.data?.goal?.status === "active");
    const paused = await start("paused", { seed: beforeWork, extensions, questionDisabled, command: "/gp", prompt: "Посмотри состояние на паузе." });
    const pauseIndex = paused.findIndex(row => row.customType === "goal-compact-goal" && row.data?.goal?.status === "paused");
    assert.ok(pauseIndex > 0);
    const firstOnPause = paused.slice(pauseIndex + 1).find(row => row.customType === "probe-step")?.data?.step;
    assert.ok(firstOnPause && firstOnPause <= 7, "успели увидеть запрос на паузе до закрытия");
    assertInput(input("paused", firstOnPause), false, questionDisabled);
  });
});
