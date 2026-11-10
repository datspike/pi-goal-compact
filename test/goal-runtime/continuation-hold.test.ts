import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { createExpandedRuntimeHarness as createRuntimeHarness, runTurn } from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

const kindsOf = (entries: Array<{ details?: unknown }>): Array<string | undefined> =>
  entries.map((entry) => (entry.details as { kind?: string } | undefined)?.kind);

/** Уведомления цели, отправленные мимо границы (предел скрытых продолжений). */
function notices(harness: Harness) {
  const sent = harness.sentMessages.filter((item) => item.message.customType === CUSTOM_ENTRY_TYPE);
  harness.sentMessages.length = 0;
  return sent;
}

test("отчёт blocked держит скрытое продолжение до ответа владельца и отчёта working", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Убрать старые worktree" });
  const blocked = await harness.runTool("report_goal_progress", {
    action: "publish", status: "blocked", phase: "Не вижу процессов хоста",
    summary: "Без списка процессов удаление не доказано. Жду решения.",
    problemOrDecision: "Процессы хоста недоступны.", nextStep: "Получить список процессов.",
  }) as { details: { state: { awaitingUser: boolean }; workingState: { continuationHeld: boolean } } };
  assert.equal(blocked.details.state.awaitingUser, true);
  assert.equal(blocked.details.workingState.continuationHeld, true);

  assert.deepEqual(kindsOf((await runTurn(harness, 0)).entries), []);

  await harness.emit("input", { type: "input", text: "Процессов нет, удаляй.", source: "interactive" });
  await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Удаляю", changed: "Пользователь подтвердил отсутствие процессов.", nextStep: "Удалить." });
  const released = await runTurn(harness, 1);
  assert.equal(released.continued, true);
  assert.deepEqual(kindsOf(released.entries), ["continuation"]);
});

async function withProjectPolicy(policy: object, run: (cwd: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "goal-compact-hold-"));
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(join(root, ".pi", "goal-reports.json"), JSON.stringify(policy));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("скрытые продолжения останавливаются на заданном пределе до реплики владельца", async () => {
  await withProjectPolicy({ maxHiddenContinuations: 2 }, async (cwd) => {
    const harness = createRuntimeHarness({ cwd });
    await harness.reloadSession();
    await harness.runTool("create_goal", { objective: "Довести аудит" });

    assert.deepEqual(kindsOf((await runTurn(harness, 0)).entries), ["continuation"]);
    assert.deepEqual(kindsOf((await runTurn(harness, 1, undefined, { newRun: false })).entries), ["continuation"]);

    const stopped = await runTurn(harness, 2, undefined, { newRun: false });
    assert.equal(stopped.continued, false);
    const [notice, ...rest] = notices(harness);
    assert.equal(rest.length, 0);
    assert.equal((notice?.message.details as { kind?: string }).kind, "continuation_limit");
    assert.equal(notice?.message.display, true);
    assert.match(String(notice?.message.content), /2 подряд без сообщения пользователя/);
    assert.equal(harness.snapshot().goal?.status, "active");

    // Уведомление уходит один раз, дальше цель просто ждёт.
    assert.equal((await runTurn(harness, 3)).continued, false);
    assert.deepEqual(notices(harness), []);

    await harness.emit("input", { type: "input", text: "Сузь до трёх каталогов.", source: "interactive" });
    assert.deepEqual(kindsOf((await runTurn(harness, 4)).entries), ["continuation"]);
  });
});

test("без заданного предела скрытые продолжения не ограничены, как раньше", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Довести аудит" });
  for (let turn = 0; turn < 12; turn += 1) {
    assert.deepEqual(kindsOf((await runTurn(harness, turn, undefined, { newRun: turn === 0 })).entries), ["continuation"]);
  }
});
