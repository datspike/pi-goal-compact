import { createExpandedRuntimeHarness, sessionBeforeCompactEvent } from "../support/runtime-harness.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createAccountingState, createGoalAccounting } from "../../src/goal/goal-accounting.js";
import type { ThreadGoal } from "../../src/goal/types.js";

function goal(goalId = "accounting-goal"): ThreadGoal {
  return { goalId, objective: "Account active work", status: "active", tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 0 }, createdAt: 100, updatedAt: 100 };
}

function clockHarness(t: TestContext) {
  let now = 100_000;
  let current: ThreadGoal | null = goal();
  const state = createAccountingState();
  const ctx = { isIdle: () => false } as ExtensionContext;
  t.mock.method(Date, "now", () => now);
  const accounting = createGoalAccounting({
    getGoal: () => current,
    getAccounting: () => state,
    applyRuntimeAccountingTransition: (_ctx, next) => { current = next; },
    sendMessage: () => {},
  });
  return {
    ...accounting,
    advance(ms: number) { now += ms; },
    sample(tokens = 0, includeLimited = false) { accounting.accountProgress(ctx, false, tokens, includeLimited); },
    current: () => { assert.ok(current); return current; },
    replace(next: ThreadGoal | null) { current = next; },
  };
}

test("frequent tool samples retain fractional active seconds", t => {
  const h = clockHarness(t);
  h.beginAccounting();
  for (let i = 0; i < 4; i++) { h.advance(600); h.sample(); }
  assert.equal(h.current().usage.activeSeconds, 2);
});

test("fractional time survives ordinary turn boundaries without charging idle gaps", t => {
  const h = clockHarness(t);
  for (let i = 0; i < 20; i++) {
    h.beginAccounting(); h.advance(250); h.sample(); h.advance(10_000);
  }
  assert.equal(h.current().usage.activeSeconds, 5);
});

test("pausing retains only the same goal's already sampled fraction", t => {
  const h = clockHarness(t);
  h.beginAccounting(); h.advance(600); h.sample();
  h.clearActiveAccounting();
  h.replace({ ...h.current(), status: "paused" });
  h.advance(3_600_000); h.sample();
  assert.equal(h.current().usage.activeSeconds, 0);
  h.replace({ ...h.current(), status: "active" });
  h.beginAccounting(); h.advance(400); h.sample();
  assert.equal(h.current().usage.activeSeconds, 1);
});

test("replacement does not inherit the previous goal's fraction", t => {
  const h = clockHarness(t);
  h.beginAccounting(); h.advance(900); h.sample(); h.clearActiveAccounting();
  h.replace(goal("replacement")); h.beginAccounting(); h.advance(200); h.sample();
  assert.equal(h.current().usage.activeSeconds, 0);
  h.advance(800); h.sample();
  assert.equal(h.current().usage.activeSeconds, 1);
});

test("cleared goals and inactive time do not add elapsed seconds", t => {
  const h = clockHarness(t);
  h.beginAccounting(); h.advance(500); h.sample();
  h.replace(null); h.sample(); h.advance(100_000);
  h.replace(goal("after-clear")); h.beginAccounting(); h.advance(500); h.sample();
  assert.equal(h.current().usage.activeSeconds, 0);
});

test("backward clock movement cannot subtract active time", t => {
  const h = clockHarness(t);
  h.beginAccounting(); h.advance(1_200); h.sample(); h.advance(-500); h.sample();
  assert.equal(h.current().usage.activeSeconds, 1);
  h.advance(800); h.sample();
  assert.equal(h.current().usage.activeSeconds, 2);
});

test("budget-limited final accounting preserves fractions without changing token accounting", t => {
  const h = clockHarness(t);
  h.beginAccounting(); h.advance(600); h.sample(11);
  h.replace({ ...h.current(), status: "budgetLimited" });
  h.advance(400); h.sample(7, true);
  assert.equal(h.current().usage.activeSeconds, 1);
  assert.equal(h.current().usage.tokensUsed, 18);
});

for (const boundary of ["session_before_compact", "session_shutdown", "session_tree"] as const) {
  test(`idle ${boundary} cannot restart accounting while a user decision is pending`, async t => {
    let now = 100_000;
    t.mock.method(Date, "now", () => now);
    const harness = createExpandedRuntimeHarness();
    harness.setIdle(false);
    await harness.runTool("create_goal", { objective: "Проверить учёт ожидания", token_budget: null });
    await harness.emit("agent_start", { type: "agent_start" });
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: now });
    now += 600;
    await harness.runTool("report_goal_progress", { action: "publish", status: "awaiting_user",
      phase: "Жду решение", needUser: "Выбрать адрес сервиса.", nextStep: "Получить ответ." });
    await harness.emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 } }] });
    harness.setIdle(true);
    for (let i = 0; i < 2; i++) {
      now += 60_000;
      await harness.emit(boundary, boundary === "session_before_compact" ? sessionBeforeCompactEvent() : { type: boundary });
      const result = await harness.runTool("get_goal", {}) as { details: { goal: { timeUsedSeconds: number }; continuationHeld: boolean } };
      assert.equal(result.details.continuationHeld, true);
      assert.equal(result.details.goal.timeUsedSeconds, 0);
    }
    if (boundary !== "session_shutdown") {
      await harness.emit("input", { type: "input", text: "Используй тестовый адрес", source: "interactive" });
      await harness.runTool("report_goal_progress", { action: "publish", status: "working", phase: "Проверяю адрес", changed: "Выбран тестовый адрес.", nextStep: "Проверить доступ." });
      harness.setIdle(false);
      await harness.emit("agent_start", { type: "agent_start" });
      await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: now });
      now += 400;
      await harness.emit("agent_end", { type: "agent_end", messages: [] });
      harness.setIdle(true);
      const result = await harness.runTool("get_goal", {}) as { details: { goal: { timeUsedSeconds: number } } };
      assert.equal(result.details.goal.timeUsedSeconds, 1);
    }
    await harness.runCommand("clear");
  });
}
