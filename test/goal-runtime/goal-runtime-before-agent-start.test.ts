import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { BeforeAgentStartEvent, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { continuationPrompt } from "../../src/goal/prompts.js";
import { assistantMessage, flushContinuationScheduler, goalTickets, runTurn, sessionBeforeCompactEvent, sessionCompactEvent, createExpandedRuntimeHarness as createRuntimeHarness } from "../support/runtime-harness.js";

const systemPromptOptions: NormalizedBuildSystemPromptOptions = {
  cwd: process.cwd(),
  selectedTools: [],
  hiddenTools: [],
  toolSnippets: {},
  toolGuidelines: {},
  promptGuidelines: [],
  appendSystemPrompt: "",
  sections: {},
  contextFiles: [],
  skills: [],
};
const userEvent = (prompt: string): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  messageType: "user",
  prompt,
  systemPrompt: "system",
  systemPromptOptions,
});
const customEvent = (customType: string, content: string | { type: "text"; text: string }[]): BeforeAgentStartEvent => ({
  type: "before_agent_start",
  messageType: "custom",
  message: {
    role: "custom",
    customType,
    content,
    display: false,
    timestamp: 0,
  },
  systemPrompt: "system",
  systemPromptOptions,
});





test("admits an owned custom continuation in the runtime handler", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const goal = harness.snapshot().goal;
  assert.ok(goal);
  const before = harness.snapshot();
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "custom",
    message: {
      role: "custom",
      customType: CUSTOM_ENTRY_TYPE,
      content: continuationPrompt(goal),
      display: false,
      timestamp: 0,
    },
    systemPrompt: "system",
    systemPromptOptions: {},
  });
  assert.deepEqual(harness.snapshot(), before);
});

test("foreign custom runs leave goal state and runtime guards untouched", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const before = harness.snapshot();
  const entriesBefore = harness.entries.length;
  const abortsBefore = harness.abortCount;
  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    messageType: "custom",
    message: {
      role: "custom",
      customType: "another-extension",
      content: "not a goal prompt",
      display: false,
      timestamp: 0,
    },
    systemPrompt: "system",
    systemPromptOptions: {},
  });
  assert.deepEqual(harness.snapshot(), before);
  assert.equal(harness.entries.length, entriesBefore);
  assert.equal(harness.abortCount, abortsBefore);
});
for (const stopReason of ["stop", "error", "aborted"] as const) {
  test(`foreign custom ${stopReason} run leaves the entire goal lifecycle untouched`, async () => {
    const h = createRuntimeHarness();
    await h.runCommand("ship it");
    const before = h.snapshot();
    const entriesBefore = h.entries.length;
    const sendsBefore = h.sentMessages.length;
    const foreign = customEvent("another-extension", "foreign request");
    await h.emit("before_agent_start", foreign);
    await h.emit("agent_start", { type: "agent_start" });
    await h.emit("message_start", { type: "message_start", message: foreign.messageType === "custom" ? foreign.message : undefined });
    await h.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await h.emit("tool_execution_start", { type: "tool_execution_start", toolCallId: "foreign", toolName: "read", args: {} });
    await h.emit("tool_execution_end", { type: "tool_execution_end", toolCallId: "foreign", toolName: "read", result: {}, isError: false });
    const response = { ...assistantMessage(stopReason, { input: 50, output: 25 }), errorMessage: "websocket closed" };
    await h.emit("turn_end", { type: "turn_end", turnIndex: 0, message: response, toolResults: [] });
    await h.emit("agent_end", { type: "agent_end", messages: [response] });
    await h.emit("agent_end", { type: "agent_end", messages: [response] });
    assert.deepEqual(h.snapshot(), before);
    assert.equal(h.entries.length, entriesBefore);
    assert.equal(h.sentMessages.length, sendsBefore);
    assert.equal(h.abortCount, 0);

    // A following user run must still participate in goal accounting.
    await h.emit("before_agent_start", userEvent("continue working"));
    await h.emit("agent_start", { type: "agent_start" });
    await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
    await h.emit("turn_end", { type: "turn_end", turnIndex: 1, message: assistantMessage("toolUse", { input: 10, output: 5 }), toolResults: [] });
    assert.equal(h.snapshot().goal?.usage.tokensUsed, (before.goal?.usage.tokensUsed ?? 0) + 15);
  });
}
test("completed compaction after a foreign custom run still schedules goal continuation", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const h = createRuntimeHarness();
    await h.runCommand("ship it");
    await h.emit("before_agent_start", userEvent("ordinary work"));
    h.sentMessages.length = 0;
    await h.emit("before_agent_start", customEvent("context-compaction-native", "service summary"));
    await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    flushContinuationScheduler();
    // Сжатие в простое будит цель билетом, даже если перед ним шёл чужой прогон.
    assert.equal(goalTickets(h).length, 1);
  } finally {
    mock.timers.reset();
  }
});

// В Pi 1.5 сжатие «перед прогоном» идёт в подготовке нового прогона, когда прошлый уже завершён:
// его время не принадлежит цели, а учёт начинается, только если прогон принят как её работа.
for (const owner of ["foreign", "user", "goal"] as const) {
  test(`сжатие перед прогоном не трогает цель, а учёт следует за допуском (${owner})`, async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      const h = createRuntimeHarness();
      await h.runCommand("ship it");
      await runTurn(h, 0, assistantMessage("stop", { input: 1, output: 1 }));
      h.sentMessages.length = 0;
      const before = h.snapshot();
      const entriesBefore = h.entries.length;
      mock.timers.tick(1100);
      await h.emit("session_before_compact", sessionBeforeCompactEvent({ reason: "threshold" }));
      await h.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
      assert.deepEqual(h.snapshot().goal?.usage, before.goal?.usage);
      const goal = h.snapshot().goal;
      assert.ok(goal);
      const admission = owner === "foreign" ? customEvent("other-extension", "foreign")
        : owner === "user" ? userEvent("continue") : customEvent(CUSTOM_ENTRY_TYPE, continuationPrompt(goal));
      await h.emit("before_agent_start", admission);
      await h.emit("agent_start", { type: "agent_start" });
      await h.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
      mock.timers.tick(1100);
      await h.emit("turn_end", { type: "turn_end", turnIndex: 1, message: assistantMessage("toolUse", { input: 3, output: 2 }), toolResults: [] });
      if (owner === "foreign") {
        assert.deepEqual(h.snapshot().goal?.usage, before.goal?.usage);
      } else {
        assert.ok(h.entries.length > entriesBefore);
        assert.equal(h.snapshot().goal?.usage.tokensUsed, (before.goal?.usage.tokensUsed ?? 0) + 5);
        assert.ok((h.snapshot().goal?.usage.activeSeconds ?? 0) >= 1);
      }
    } finally {
      mock.timers.reset();
    }
  });
}
