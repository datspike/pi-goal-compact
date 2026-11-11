import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { fakePi, type FakeEntry } from "../support/pi-fake.js";
import { STATUS_KEY } from "../../src/records.js";

const OBJECTIVE = "Перенести модуль цели в новое расширение и проверить жизненный цикл.";

function setup(branch?: FakeEntry[]) {
  const cwd = mkdtempSync(join(tmpdir(), "goal-compact-session-"));
  const fake = fakePi(branch ? { branch } : {});
  fake.ctx.cwd = cwd;
  fake.ctx.signal = undefined;
  return { fake, cwd, done: () => rmSync(cwd, { recursive: true, force: true }) };
}

async function call(fake: ReturnType<typeof fakePi>, name: string, params: Record<string, unknown>, id = `${name}-1`) {
  return fake.runTool(name, params, id);
}

const text = (result: { text: string }): string => result.text;

test("цель проходит путь от создания до закрытия через инструменты модели", async () => {
  const { fake, done } = setup();
  try {
    await fake.event("session_start", { reason: "startup" });
    assert.ok(STATUS_KEY.goal.localeCompare(STATUS_KEY.context) < 0, "ключ цели сортируется в футере раньше окна");
    const created = await call(fake, "create_goal", { objective: OBJECTIVE });
    assert.match(text(created), /active/);
    assert.ok(fake.entries.some((entry) => entry.type === "goal-compact-goal"), "цель записана под новым именем");

    const goal = JSON.parse(text(await call(fake, "get_goal", { view: "status" })));
    const ref = JSON.stringify(goal).match(/file:\/\/[^"]+GOAL\.md/)?.[0];
    assert.ok(ref, "документ цели создан");
    assert.match(fileURLToPath(ref), /\.pi\/goal-compact\//);
    assert.match(readFileSync(fileURLToPath(ref), "utf8"), /Перенести модуль цели/);

    await call(fake, "report_goal_progress", {
      action: "publish", status: "working", eventKind: "goal_started", phase: "Начинаю перенос",
      summary: "Цель поставлена, начинаю перенос модуля.", changed: "Цель создана.", nextStep: "Перенести модуль.",
    }, "report-1");
    // После первого отчёта цель управляемая: закрыть её можно только после свежего verifying.
    await assert.rejects(call(fake, "update_goal", { status: "complete" }), /verifying/);
    await call(fake, "report_goal_progress", {
      action: "publish", status: "verifying", eventKind: "verification", phase: "Проверяю перенос",
      summary: "Модуль цели перенесён, проверка проходит.", verification: "Тесты модуля цели проходят.", nextStep: "Закрыть цель.",
    }, "report-2");
    const completed = await call(fake, "update_goal", { status: "complete" });
    assert.match(text(completed), /complete/);
  } finally {
    done();
  }
});

test("цель из журнала прежнего расширения восстанавливается после старта сессии", async () => {
  const first = setup();
  let branch: FakeEntry[];
  try {
    await first.fake.event("session_start", { reason: "startup" });
    await call(first.fake, "create_goal", { objective: OBJECTIVE });
    // Те же записи, но под именами прежнего расширения, как в старой сессии.
    const names: Record<string, string> = { "goal-compact-goal": "pi-codex-goal", "goal-compact-projection": "pi-codex-goal-projection" };
    branch = first.fake.ctx.sessionManager.getBranch().map((entry) => {
      const legacy = typeof entry.customType === "string" ? names[entry.customType] : undefined;
      return entry.type === "custom" && legacy ? { ...entry, customType: legacy } : entry;
    });
    assert.ok(branch.some((entry) => entry.customType === "pi-codex-goal"));
  } finally {
    first.done();
  }

  const second = setup(branch);
  try {
    await second.fake.event("session_start", { reason: "resume" });
    const full = JSON.parse(text(await call(second.fake, "get_goal", {})));
    assert.equal(full.goal.objective, OBJECTIVE);
    assert.equal(full.goal.status, "active");
  } finally {
    second.done();
  }
});

test("обрыв хода ставит активную цель на паузу, а возобновление требует слова владельца", async () => {
  const { fake, done } = setup();
  try {
    await fake.event("session_start", { reason: "startup" });
    await call(fake, "create_goal", { objective: OBJECTIVE });
    await fake.event("before_agent_start", { messageType: "user", prompt: "работай" });
    await fake.event("agent_start", {});
    await fake.event("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [], usage: { input: 1, output: 1 } }] });
    assert.match(text(await call(fake, "get_goal", { view: "status" })), /paused/);

    await assert.rejects(call(fake, "resume_goal", {}), /явного указания пользователя/);
    await fake.event("input", { source: "interactive", text: "продолжай работу по цели" });
    const resumed = await call(fake, "resume_goal", {});
    assert.match(text(resumed), /active/);
  } finally {
    done();
  }
});
