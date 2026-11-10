import assert from "node:assert/strict";
import { mock, test } from "node:test";

import {
  assistantMessage,
  createExpandedRuntimeHarness as createRuntimeHarness,
  deliverTicket,
  flushContinuationScheduler,
  goalTickets,
  sessionCompactEvent,
  settleRun,
} from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

/** Активная цель и выданный, но ещё не доставленный билет продолжения (смена ветки). */
async function goalWithTicket(): Promise<{ harness: Harness; ticket: ReturnType<typeof goalTickets>[number] }> {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  const [ticket, ...rest] = goalTickets(harness);
  assert.ok(ticket);
  assert.equal(rest.length, 0);
  return { harness, ticket };
}

/** Pi обрывает прогон после ctx.abort(): ответ ассистента с `aborted`, затем граница и простой. */
async function abortedRunEnds(harness: Harness): Promise<void> {
  const message = assistantMessage("aborted", { input: 0, output: 0 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [] });
  await harness.emit("agent_end", { type: "agent_end", messages: [message] });
  await settleRun(harness, "aborted");
}

test("свой отказ устаревшему билету прерывает прогон, но цель не встаёт на паузу", async () => {
  const { harness, ticket } = await goalWithTicket();
  await harness.emit("input", { type: "input", text: "погоди, другое", source: "interactive" });

  await deliverTicket(harness, ticket);
  assert.equal(harness.abortCount, 1);
  await abortedRunEnds(harness);

  assert.equal(harness.snapshot().goal?.status, "active");
});

test("билет, доставленный в ожидание ответа владельца, прерывается без паузы", async () => {
  const { harness, ticket } = await goalWithTicket();
  await harness.runTool("report_goal_progress", {
    action: "publish", status: "awaiting_user", phase: "Жду решения", summary: "Нужен выбор владельца. Без него не продолжаю.",
    needUser: "Выбрать вариант.", nextStep: "Получить ответ.",
  });

  await deliverTicket(harness, ticket);
  assert.equal(harness.abortCount, 1);
  await abortedRunEnds(harness);

  assert.equal(harness.snapshot().goal?.status, "active");
});

test("свежий билет проходит, а обрыв прогона владельцем ставит цель на паузу", async () => {
  const { harness, ticket } = await goalWithTicket();
  await deliverTicket(harness, ticket);
  assert.equal(harness.abortCount, 0);

  await abortedRunEnds(harness);
  assert.equal(harness.snapshot().goal?.status, "paused");
});

test("смена ветки продолжает только активную цель", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runSlashCommand("gp");
  harness.sentMessages.length = 0;
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  assert.equal(goalTickets(harness).length, 0);
});

test("/gr возобновляет цель молча: ни билета, ни сообщения", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.runSlashCommand("gp");
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;
  await harness.runSlashCommand("gr");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);
});

test("сжатие по порогу в простое будит активную цель одним билетом", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold", willRetry: false }));
    flushContinuationScheduler();
    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold", willRetry: false }));
    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("сжатие с обещанным повтором Pi не будит цель: повторит сам Pi", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("реплика владельца в очереди Pi важнее продолжения на границе", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("agent_start", { type: "agent_start" });
  assert.equal((await settleRun(harness, "completed", true)).continued, false);
});
