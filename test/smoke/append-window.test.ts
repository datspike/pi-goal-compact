import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, withProbe, type ProbeScript } from "../support/offline-pi.js";

const script: ProbeScript = {
  append: true,
  calls: {
    1: ["create_goal", { objective: "Проверить append без сети.", agreement: AGREEMENT, self_decided: [] }],
    3: ["report_goal_progress", { action: "publish", status: "working", phase: "Работа", summary: "Факт сохранён.", changed: "Сохранён факт.", nextStep: "Продолжить." }],
    5: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Итог проверен.", verification: "Переход сжатия проверен.", nextStep: "Закрыть цель." }],
    6: ["update_goal", { status: "complete" }],
    7: ["update_goal", { status: "complete" }],
  },
  heavySteps: [4], lastStep: 8,
};

test("append в настоящем Pi сохраняет сводку и продолжает цель до закрытия", { timeout: 60000 }, async () => {
    await withProbe(script, async (start, requests) => {
      const fresh = await start("append-window", { commands: ["/context append on"] });
      const initialUser = fresh.find(row => row.message?.role === "user"); assert.ok(initialUser);
      // Как в истории, перенесённой из другого клиента: есть реплика, но нет сохранённой системной рамки.
      const seed = [fresh[0], { ...initialUser, parentId: null }].map(row => JSON.stringify(row)).join("\n") + "\n";
      const restored = await start("append-history", { seed, prompt: "Продолжить восстановленную историю.", commands: ["/context append on"] });
      assert.equal(requests("append-history")[0]?.firstRole, "user");
      for (const [name, rows] of [["append-window", fresh], ["append-history", restored]] as const) {
        assert.equal(rows.filter(row => row.type === "compaction").length, 1);
        assert.ok(rows.some(row => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"));
        assert.ok(rows.some(row => row.customType === "goal-compact-append" && row.data?.enabled === true), "переключатель append записан в окно");
        const attempts = rows.filter(row => row.customType === "goal-compact-append-attempt");
        assert.ok(attempts.some(row => (row.data as { phase?: string })?.phase === "response"), JSON.stringify(attempts));
        assert.ok(!attempts.some(row => ["fallback", "preflight-refusal"].includes((row.data as { phase: string }).phase)), JSON.stringify(attempts));
        assert.ok(rows.some(row => row.data?.kind === "append"), "карточка не маскирует append под обычное сжатие");
        const log = requests(name);
        assert.ok(log.some(row => row.kind === "summary"));
        assert.ok(log.some(row => row.kind === "turn" && row.step === 5 && row.window.includes("Продолжить проверку.")));
      }
    });
});

test("без включённого append то же сжатие идёт обычной сводкой и не пишет попыток", { timeout: 60000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const rows = await start("standard-window");
    const cards = rows.filter(row => row.customType === "goal-compact-card");
    assert.equal(cards.length, 1);
    const card = cards[0]!.data as { kind?: string; fallbackReason?: string };
    assert.equal(card.kind, "standard", "по умолчанию обычная сводка");
    assert.equal(card.fallbackReason, undefined, "выключенный append не считается отказом");
    assert.equal(rows.filter(row => row.customType === "goal-compact-append-attempt").length, 0);
    assert.equal(rows.filter(row => row.customType === "goal-compact-append").length, 0);
    const metrics = rows.filter(row => row.customType === "goal-compact-compact-metrics");
    assert.equal(metrics.length, 1);
    assert.equal((metrics[0]!.data as { kind?: string }).kind, "standard");
    assert.ok(requests("standard-window").some(row => row.kind === "summary"));
  });
});
