import assert from "node:assert/strict";
import { test } from "node:test";

import { compactContinuationPrompt, continuationPrompt } from "../../src/goal/prompts.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { createRuntimeHarness, deliverTicket, goalTickets, runTurn } from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

function continuationMessage(content: string, goalId: string, timestamp: number) {
  return { role: "custom", customType: CUSTOM_ENTRY_TYPE, content, display: false, details: { kind: "continuation", goalId }, timestamp };
}

/** Окно, которое увидит провайдер: ответы обработчиков `context`, применённые по очереди. */
async function providerView(harness: Harness, messages: unknown[]): Promise<string[]> {
  const results = await harness.emit("context", { type: "context", messages }) as Array<{ messages?: unknown[] } | undefined>;
  const view = results.reduce<unknown[]>((current, result) => result?.messages ?? current, messages);
  return view.map((message) => JSON.stringify(message));
}

test("контекст провайдера дописывается, а прежние запросы остаются побайтно теми же", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);

  // Кэш промпта совпадает по целому префиксу прежнего запроса: продолжение может только
  // дописываться, а правка любого отправленного сообщения сбрасывает кэш всей истории после него.
  const history: unknown[] = [];
  let previous: string[] = [];
  for (let turn = 1; turn <= 4; turn += 1) {
    history.push(continuationMessage(compactContinuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: turn * 100, activeSeconds: turn * 10 } }), goal.goalId, turn));
    const sent = await providerView(harness, [...history]);
    assert.equal(sent.length, history.length);
    assert.deepEqual(sent.slice(0, previous.length), previous, `ход ${turn} переписал прежнее сообщение`);
    previous = sent;
  }
});

test("много продолжений цели в истории не трогаются", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  const messages = [
    continuationMessage(continuationPrompt(goal), goal.goalId, 1),
    continuationMessage(continuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: 1, activeSeconds: 1 } }), goal.goalId, 2),
    continuationMessage(compactContinuationPrompt({ ...goal, usage: { ...goal.usage, tokensUsed: 99, activeSeconds: 42 } }), goal.goalId, 3),
  ];
  const results = await harness.emit("context", { type: "context", messages }) as unknown[];
  assert.ok(results.every((result) => result === undefined));
});

test("продолжение на границе ложится в историю записью цели и не переписывается дальше", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const { entries, continued } = await runTurn(harness, 0);
  assert.equal(continued, true);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.customType, CUSTOM_ENTRY_TYPE);
  const message = { role: "custom", ...entries[0], display: false, timestamp: 1 };
  const first = await providerView(harness, [message]);
  const second = await providerView(harness, [message, { role: "user", content: "дальше", timestamp: 2 }]);
  assert.deepEqual(second.slice(0, 1), first);
});

test("устаревший билет гаснет одинаково в каждом следующем запросе", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.waitForGoalProjection();
  const ticket = goalTickets(harness)[0];
  assert.ok(ticket);
  // Владелец написал раньше, чем билет дошёл: билет устарел.
  await harness.emit("input", { type: "input", text: "стоп, другое", source: "interactive" });
  await deliverTicket(harness, ticket);
  assert.equal(harness.abortCount, 1);

  const stale = { role: "custom", customType: ticket.message.customType, content: ticket.message.content, display: false, details: ticket.message.details, timestamp: 1 };
  const first = await providerView(harness, [stale]);
  const second = await providerView(harness, [stale, { role: "user", content: "стоп, другое", timestamp: 2 }]);
  assert.doesNotMatch(first[0]!, /pi_goal_continuation|Continue/);
  assert.deepEqual(second.slice(0, 1), first);
});
