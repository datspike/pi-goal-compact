import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { formatFooterStatus } from "../../src/goal/format.js";
import {
  createRecoveryPausedAttention,
  createRecoveryPendingAttention,
  HOST_OVERFLOW_RECOVERY_REASON,
} from "../../src/goal/recovery.js";
import {
  assistantMessage,
  createExpandedRuntimeHarness as createRuntimeHarness,
  emitPersistentAssistantError,
  flushContinuationScheduler,
  settleRun,
  sessionCompactEvent } from "../support/runtime-harness.js";
import { givenOverflowPausedGoal } from "../support/scenarios.js";

function agentStartEvent(): object {
  return { type: "agent_start" };
}

test("turn_end provider errors defer recovery to agent_end without hidden continuation or extension compaction", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("host overflow session compaction does not queue extension continuation before host retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: errorMessage,
      toolResults: [],
    });
    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [errorMessage],
    });

    assert.equal(harness.compactCalls.length, 0);
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);

    await harness.emit("agent_start", agentStartEvent());
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("overflow compaction without host retry keeps recovery user-start gated", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await harness.emit("turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: errorMessage,
      toolResults: [],
    });
    await harness.emit("agent_end", { type: "agent_end", messages: [errorMessage] });

    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: false }));
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});


test("host overflow retry success resumes goal continuation after clearing recovery flag", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 30, output: 12 }, "context_length_exceeded");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });
  await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("agent_start", agentStartEvent());
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  // Удачный повтор Pi продолжает цель на границе перед простоем, а не сообщением в очередь.
  assert.equal((await settleRun(harness)).continued, true);
  assert.equal(harness.sentMessages.length, 0);
});

test("repeated context length errors pause after host default overflow recovery", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "context_length_exceeded");
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("first overflow error stays active while host performs compact-and-retry", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
  await harness.emit("agent_start", agentStartEvent());

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("context overflow recovery preserves compaction attempts across host session_compact", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await emitPersistentAssistantError(
      harness,
      attempt,
      `prompt is too long: ${(attempt + 1) * 100_000} tokens > 200000 maximum`,
    );
    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    if (harness.snapshot().goal?.status === "active") {
      await harness.emit("agent_start", agentStartEvent());
    }
  }

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
});

test("overflow after compaction and intervening transient error pauses with recoverable resume", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /Цель ждёт восстановления/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);

  await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
  await harness.emit("agent_start", agentStartEvent());
  assert.equal(harness.snapshot().goal?.status, "active");

  await emitPersistentAssistantError(harness, 1, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /Цель ждёт восстановления/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /На паузе · .*Цели нужно внимание/);
});

test("repeated transient errors stay active with pending attention without hidden retries", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await emitPersistentAssistantError(harness, attempt, "websocket closed");
    assert.equal(harness.snapshot().goal?.status, "active");
  }

  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
  assert.match(harness.goalNotice() ?? "", /Цель ждёт восстановления/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);
});

test("transient errors surface pending attention without pausing before host retry finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /Заблокировано · .*provider error \(websocket closed\)/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);
});

test("/gp after pending transient error clears recovery attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.goalNotice() ?? "", /Цель ждёт восстановления/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);

  await harness.runSlashCommand("gp");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.goalNotice(), "На паузе · 0s");
});

test("/gp after pending overflow error clears recovery attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.goalNotice() ?? "", /Цель ждёт восстановления/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);

  await harness.runSlashCommand("gp");

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.goalNotice(), "На паузе · 0s");
});

test("successful turns reset transient error counters and continue active goals", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "keep going",
    systemPrompt: "",
    systemPromptOptions: {},
  });
  await harness.emit("agent_start", agentStartEvent());
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 1, output: 1 }),
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [assistantMessage("stop", { input: 1, output: 1 })],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal((await settleRun(harness)).continued, true);

  await emitPersistentAssistantError(harness, 2, "websocket closed");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("exhausted context overflow retries show recoverable attention in the widget", async () => {
  const { harness, goal } = await givenOverflowPausedGoal("ship it");
  assert.match(harness.goalNotice() ?? "", /На паузе · .*Цели нужно внимание/);
});

test("agent_end only counts recovered errors once per failed run", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const errorMessage = assistantMessage("error", { input: 1, output: 1 }, "websocket closed");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: errorMessage,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [errorMessage],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.compactCalls.length, 0);
});

test("successful toolUse turns reset context overflow recovery counters", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");
  assert.equal(harness.compactCalls.length, 0);
  await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
  await harness.emit("agent_start", agentStartEvent());

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("toolUse", { input: 1, output: 1 }),
    toolResults: [],
  });
  assert.equal(harness.sentMessages.length, 0);

  await emitPersistentAssistantError(harness, 2, "context_length_exceeded");

  assert.equal(harness.compactCalls.length, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("first overflow error shows recoverable attention while host recovery is pending", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /Заблокировано · .*recovering from context overflow/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);
});

test("overflow without session_compact stays active with pending overflow attention", async () => {
  const harness = createRuntimeHarness({ compactBehavior: "unavailable" });
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  harness.sentMessages.length = 0;

  await emitPersistentAssistantError(harness, 0, "context_length_exceeded");

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.match(harness.goalNotice() ?? "", /Заблокировано · .*recovering from context overflow/);
  assert.doesNotMatch(harness.goalNotice() ?? "", /\/goal resume/);
});
