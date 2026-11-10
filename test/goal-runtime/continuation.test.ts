import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { formatFooterStatus } from "../../src/goal/format.js";
import { isGoalCustomEntry, setEntry } from "../../src/goal/state.js";
import { SUBAGENT_WAIT_TIMEOUT_MS } from "../../src/goal/runtime-config.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { compactContinuationPrompt } from "../../src/goal/prompts.js";
import {
  assistantMessage,
  createExpandedRuntimeHarness as createRuntimeHarness,
  emitPersistentAssistantError,
  fireProviderLimitAutoResume,
  flushContinuationScheduler,
  sessionBeforeCompactEvent,
  sessionCompactEvent,
  sessionShutdownEvent,
  deliverTicket,
  goalTickets,
  runTurn,
  settleRun,
  type SentMessage,
} from "../support/runtime-harness.js";

/** Скрытое сообщение из отправленного, как его видит Pi в начале хода. */
function queuedCustomMessage(sent: SentMessage, timestamp = 1) {
  return { role: "custom" as const, customType: sent.message.customType, content: sent.message.content, display: sent.message.display, details: sent.message.details, timestamp };
}

test("aborted turns pause goals and do not queue continuation", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", {
      input: 40,
      output: 2,
      cacheRead: 500,
      cacheWrite: 600,
      totalTokens: 1_142,
    }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "paused");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);
});

test("a new user-driven agent start leaves a paused goal paused", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });

  await harness.emit("before_agent_start", {
    type: "before_agent_start",
    prompt: "continue",
    systemPrompt: "",
    systemPromptOptions: {},
  });

  assert.equal(harness.snapshot().goal?.status, "paused");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 10);
});

test("session resume over-budget paused goal stays budgetLimited without follow-up turn", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
  await harness.runCommand("pause");
  const paused = harness.snapshot().goal;
  assert.ok(paused);
  assert.equal(paused.status, "paused");

  harness.entries.push({
    type: "custom",
    id: "entry-over-budget-paused",
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: CUSTOM_ENTRY_TYPE,
    data: setEntry(
      {
        ...paused,
        usage: { tokensUsed: 10, activeSeconds: paused.usage.activeSeconds },
      },
      "runtime",
    ),
  });
  harness.sentUserMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "budgetLimited");
  assert.equal(harness.sentUserMessages.length, 0);
});

test("session resume prompt can reactivate a paused goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("aborted", { input: 8, output: 2 }),
    toolResults: [],
  });
  harness.sentMessages.length = 0;

  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 1);
  const sentUserMessage = harness.sentUserMessages[0];
  assert.ok(sentUserMessage);
  assert.deepEqual(sentUserMessage.options, { deliverAs: "followUp" });
  const content = sentUserMessage.content;
  if (typeof content !== "string") {
    assert.fail("Expected session resume to send a user continuation prompt.");
  }
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /<pi_goal_continuation goal_id="/);
});

test("удачный ход учитывает вход и выход и продолжает активную цель на границе", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const settled = await runTurn(harness, 0, assistantMessage("stop", { input: 30, output: 12, cacheRead: 500, cacheWrite: 600, totalTokens: 1_142 }));

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(settled.continued, true);
  assert.equal(settled.entries[0]?.customType, CUSTOM_ENTRY_TYPE);
  assert.deepEqual(settled.entries[0]?.details, { kind: "continuation", goalId: goal?.goalId });
});

test("tool-use turn ends do not queue continuation before tool execution finishes", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 10, output: 3 }),
    toolResults: [],
  });

  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(harness.sentMessages.length, 0);
});

test("successful budget-crossing turn clears stale recovery footer attention", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });
  harness.sentMessages.length = 0;
  harness.footerStatuses.length = 0;

  await emitPersistentAssistantError(harness, 0, "websocket closed");
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.match(harness.goalNotice() ?? "", /Goal recovery pending/);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: assistantMessage("stop", { input: 8, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 13);
  assert.equal(harness.goalNotice(), "Лимит бюджета · 0s");
  assert.doesNotMatch(harness.goalNotice() ?? "", /Goal recovery pending/);
  assert.equal(harness.footerStatuses.at(-1), "Лимит бюджета · 0s");
});

test("budget crossing sends one hidden budget-limit steering message", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it", token_budget: 10 });

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("toolUse", { input: 8, output: 3 }),
    toolResults: [],
  });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "budgetLimited");
  assert.equal(goal?.usage.tokensUsed, 11);
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.sentMessages[0]?.message.details, {
    kind: "budget_limit",
    goalId: goal?.goalId,
  });

  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
  assert.equal(harness.sentMessages.length, 1);
});

test("замена цели посреди хода не списывает старые токены на новую цель", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("old goal");
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.runCommand("new goal");
  const replacement = harness.snapshot().goal;
  assert.equal(replacement?.objective, "new goal");

  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: assistantMessage("stop", { input: 80, output: 20 }), toolResults: [] });

  const goal = harness.snapshot().goal;
  assert.equal(goal?.goalId, replacement?.goalId);
  assert.equal(goal?.usage.tokensUsed, 0);
  assert.equal((await settleRun(harness)).continued, true);
});

test("amend_goal accounts live active time exactly once", async (t) => {
  const originalNow = Date.now;
  t.after(() => {
    Date.now = originalNow;
  });
  let now = 1_000;
  Date.now = () => now;

  const harness = createRuntimeHarness();
  await harness.runCommand("Original request: ship it");
  harness.sentMessages.length = 0;
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });

  now = 6_000;
  await harness.runTool("amend_goal", { amendment: "Keep the documented import path." });
  assert.equal(harness.snapshot().goal?.usage.activeSeconds, 5);

  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "amend-call",
    toolName: "amend_goal",
    args: {},
    result: {},
    isError: false,
  });
  now = 7_000;
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: assistantMessage("stop", { input: 1, output: 1 }),
    toolResults: [],
  });

  const amended = harness.snapshot().goal;
  assert.equal(amended?.usage.activeSeconds, 6);
  assert.equal(amended?.usage.tokensUsed, 2);
  assert.match(amended?.objective ?? "", /Approved amendment:[\s\S]*documented import path/);
});

test("awaiting_user budget crossing suppresses hidden steering and permits the working release", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "old goal", token_budget: 42 });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "awaiting_user",
    phase: "decision",
    nextStep: "Wait for the user's choice.",
    needUser: "Choose a path.",
  });
  harness.sentMessages.length = 0;

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  const terminal = assistantMessage("stop", { input: 30, output: 12 });
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: terminal, toolResults: [] });

  assert.equal(harness.snapshot().goal?.status, "budgetLimited");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42);
  assert.equal(harness.sentMessages.length, 0);

  await harness.emit("input", { type: "input", text: "Use the documented path.", source: "user" });
  const release = await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "implementation",
    changed: "Применён выбранный путь.",
    nextStep: "Apply the selected path.",
  }) as { details: { state: { awaitingUser: boolean } } };

  assert.equal(release.details.state.awaitingUser, false);
  assert.equal(harness.snapshot().goal?.status, "budgetLimited");
  assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42);
});

test("agent_end-only terminal usage under awaiting_user is accounted exactly once", async () => {
  for (const stopReason of ["stop", "toolUse", "error"] as const) {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: `held ${stopReason}`, token_budget: 42 });
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for the user's choice.",
      needUser: "Choose a path.",
    });
    harness.sentMessages.length = 0;

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    const terminal = assistantMessage(stopReason, { input: 30, output: 12 });
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });

    assert.equal(harness.snapshot().goal?.status, "budgetLimited", stopReason);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42, stopReason);
    assert.equal(harness.sentMessages.length, 0, stopReason);

    await harness.emit("input", { type: "input", text: "Use the documented path.", source: "user" });
    const release = await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "working",
      phase: "implementation",
      changed: "Применён выбранный путь.",
      nextStep: "Apply the selected path.",
    }) as { details: { state: { awaitingUser: boolean } } };

    assert.equal(release.details.state.awaitingUser, false, stopReason);
    assert.equal(harness.snapshot().goal?.status, "budgetLimited", stopReason);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 42, stopReason);
  }
});

test("late turn_end and duplicate agent_end do not re-account an awaiting_user fallback", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "held ordering", token_budget: 80 });
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for the user's choice.",
      needUser: "Choose a path.",
    });

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    const terminal = assistantMessage("stop", { input: 30, output: 12 });
    now = 6_000;
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.deepEqual(harness.snapshot().goal?.usage, { tokensUsed: 42, activeSeconds: 5 });

    now = 11_000;
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: terminal, toolResults: [] });
    now = 16_000;
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.deepEqual(harness.snapshot().goal?.usage, { tokensUsed: 42, activeSeconds: 5 });
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("duplicate agent_end after turn_end does not add active time twice", async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: "normal ordering", token_budget: 100 });
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for the user's choice.",
      needUser: "Choose a path.",
    });

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    const terminal = assistantMessage("stop", { input: 30, output: 12 });
    now = 6_000;
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 0, message: terminal, toolResults: [] });
    now = 11_000;
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });
    now = 16_000;
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });

    assert.deepEqual(harness.snapshot().goal?.usage, { tokensUsed: 42, activeSeconds: 10 });
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("duplicate aborted and error agent_end events cannot pause a goal after working release", async () => {
  for (const stopReason of ["aborted", "error"] as const) {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", { objective: `release ${stopReason}`, token_budget: 100 });
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for the user's choice.",
      needUser: "Choose a path.",
    });

    await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    const terminal = assistantMessage(stopReason, { input: 1, output: 1 });
    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });
    assert.equal(harness.snapshot().goal?.status, "paused", stopReason);

    await harness.emit("input", { type: "input", text: "Use the documented path.", source: "user" });
    await harness.runTool("resume_goal", { user_decision_confirmed: true });
    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "working",
      phase: "implementation",
      changed: "Применён выбранный путь.",
      nextStep: "Apply the selected path.",
    });
    assert.equal(harness.snapshot().goal?.status, "active", stopReason);

    await harness.emit("agent_end", { type: "agent_end", messages: [terminal] });
    assert.equal(harness.snapshot().goal?.status, "active", stopReason);
    assert.equal(harness.snapshot().goal?.usage.tokensUsed, 2, stopReason);
  }
});

test("goal tools return Codex-shaped response details", async () => {
  const harness = createRuntimeHarness();
  const created = (await harness.runTool("create_goal", {
    objective: "ship it",
    token_budget: 20,
  })) as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

  assert.equal((created.details.goal as { objective?: string }).objective, "ship it");
  assert.equal((created.details.goal as { tokenBudget?: number }).tokenBudget, 20);
  assert.equal(created.details.remainingTokens, 20);
  assert.equal(created.details.completionBudgetReport, null);
  assert.deepEqual(JSON.parse(created.content[0]?.text ?? ""), {
    goal: created.details.goal,
    remainingTokens: 20,
    completionBudgetReport: null,
  });

  const completed = (await harness.runTool("update_goal", { status: "complete" })) as {
    details: Record<string, unknown>;
  };
  assert.match(String(completed.details.completionBudgetReport), /^Goal achieved\. Report final budget usage to the user:/);
});

test("продолжение даёт граница перед простоем, а не agent_end или agent_settled", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await harness.emit("agent_start", { type: "agent_start" });
  harness.sentMessages.length = 0;
  harness.sentUserMessages.length = 0;

  await harness.emit("agent_end", { type: "agent_end", messages: [assistantMessage("stop", { input: 30, output: 12 })] });
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);

  assert.equal((await settleRun(harness)).continued, true);
  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.sentMessages.length, 0);
});

test("сообщения в очереди Pi откладывают продолжение до следующей границы", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  await runTurn(harness, 0, assistantMessage("stop", { input: 30, output: 12 }), { pendingMessages: true }).then((settled) => assert.equal(settled.continued, false));

  // Pi доставил очередь отдельным прогоном; на его границе цель продолжается.
  const settled = await runTurn(harness, 1);
  assert.equal(harness.snapshot().goal?.status, "active");
  assert.equal(settled.continued, true);
  assert.deepEqual(settled.entries[0]?.details, { kind: "continuation", goalId: harness.snapshot().goal?.goalId });
});

test("completing a goal cancels a scheduled continuation before it is sent", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await harness.emit("agent_end", {
      type: "agent_end",
      messages: [assistantMessage("stop", { input: 30, output: 12 })],
    });
    assert.equal(harness.sentMessages.length, 0);

    await harness.runTool("update_goal", { status: "complete" });
    const completeSetEntries = harness.entries.filter((entry) => {
      return (
        entry.type === "custom" &&
        entry.customType === CUSTOM_ENTRY_TYPE &&
        isGoalCustomEntry(entry.data) &&
        entry.data.kind === "set" &&
        entry.data.goal.status === "complete"
      );
    });
    assert.equal(completeSetEntries.length, 1);
    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "complete");
    assert.equal(harness.sentMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("продолжения на границе идут подряд без отказов, пока не достигнут предел", async () => {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "ship it" });
  assert.equal((await runTurn(harness, 0)).continued, true);
  assert.equal((await runTurn(harness, 1, assistantMessage("stop", { input: 5, output: 6 }), { newRun: false })).continued, true);
  assert.equal(harness.abortCount, 0);
  assert.equal(harness.snapshot().goal?.status, "active");
});

test("продолжение на границе использует короткий промпт без текста цели", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  const content = String((await runTurn(harness, 0, assistantMessage("stop", { input: 1, output: 1 }))).entries[0]?.content);
  assert.match(content, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(content, /<untrusted_objective>/);
  assert.match(content, /get_goal/);
});

/** Цель поставлена инструментом в ходе агента; прогон ещё не дошёл до границы. */
async function startGoalContinuation(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
}

test("сжатие по порогу в простое будит цель одним билетом", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startGoalContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(goalTickets(harness).length, 0);
    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 1);
  } finally {
    mock.timers.reset();
  }
});

// В Pi 1.5 повтор после сжатия по переполнению запускается в том же прогоне сразу после
// compaction_end. Прервать его может только отказ, и тогда продолжать нельзя. Поэтому
// запасного пробуждения на случай «Pi обещал повтор, но не начал» больше нет.
test("сжатие с обещанным повтором не будит цель: повтор запускает сам Pi", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startGoalContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));

    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("сжатие во время прогона оставляет продолжение границе этого прогона", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false });
    await startGoalContinuation(harness);
    await harness.emit("agent_start", { type: "agent_start" });

    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 0);

    assert.equal((await settleRun(harness)).continued, true);
    assert.equal(goalTickets(harness).length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("повтор Pi после сжатия продолжается на своей границе без билета", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startGoalContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    await harness.emit("agent_start", { type: "agent_start" });
    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 0);
    assert.equal((await settleRun(harness)).continued, true);
  } finally {
    mock.timers.reset();
  }
});

test("билет после сжатия гаснет, если владелец успел написать раньше", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startGoalContinuation(harness);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "threshold" }));
    flushContinuationScheduler();
    const [ticket] = goalTickets(harness);
    assert.ok(ticket);
    await harness.emit("input", { type: "input", text: "new user work", source: "interactive" });

    await deliverTicket(harness, ticket);
    assert.equal(harness.abortCount, 1);
    assert.equal(harness.snapshot().goal?.status, "active");
  } finally {
    mock.timers.reset();
  }
});

test("реплика-продолжение активной цели после сжатия проходит без лишнего билета", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await startGoalContinuation(harness);
    const goal = harness.snapshot().goal;
    assert.ok(goal);

    await harness.emit("session_compact", sessionCompactEvent({ reason: "overflow", willRetry: true }));
    const input = await harness.emit("input", { type: "input", text: compactContinuationPrompt(goal), source: "extension", streamingBehavior: "followUp" });
    assert.deepEqual(input.filter(Boolean), [{ action: "continue" }]);

    flushContinuationScheduler();
    assert.equal(goalTickets(harness).length, 0);
  } finally {
    mock.timers.reset();
  }
});


test("provider-limit pauses schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");

    const paused = harness.snapshot().goal;
    assert.equal(paused?.status, "paused");
    assert.match(harness.goalNotice() ?? "", /Auto-resume will retry in about 5 minutes/);
    assert.equal(harness.sentUserMessages.length, 0);

    fireProviderLimitAutoResume();

    const resumed = harness.snapshot().goal;
    assert.equal(resumed?.goalId, paused?.goalId);
    assert.equal(resumed?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
    const content = harness.sentUserMessages[0]?.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /<pi_goal_continuation goal_id="/);
    assert.doesNotMatch(String(content), /<untrusted_objective>/);
  } finally {
    mock.timers.reset();
  }
});

test("awaiting_user blocks queued and provider-limit continuations, while ordinary input resumes the paused decision turn", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    const goal = harness.snapshot().goal;
    assert.ok(goal);
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "awaiting_user",
      phase: "decision",
      nextStep: "Wait for the user's choice.",
      needUser: "Choose the import path.",
    });
    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    assert.equal(harness.snapshot().goal?.status, "paused");

    const extensionInput = await harness.emit("input", {
      type: "input",
      text: compactContinuationPrompt(goal),
      source: "extension",
    });
    assert.deepEqual(extensionInput.filter(Boolean), [{ action: "handled" }]);
    assert.equal(harness.entries.some((entry) => (
      entry.type === "custom" &&
      entry.customType === "pi-codex-goal-progress" &&
      (entry.data as { kind?: string }).kind === "user_decision"
    )), false);
    fireProviderLimitAutoResume();
    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);

    await harness.emit("input", { type: "input", text: "Use the documented path.", source: "user" });
    assert.equal(harness.snapshot().goal?.status, "paused");
    await harness.runTool("resume_goal", { user_decision_confirmed: true });
    assert.equal(harness.snapshot().goal?.status, "active");
    const release = await harness.runTool("report_goal_progress", {
      action: "publish",
      status: "working",
      phase: "implementation",
      changed: "Применён выбранный путь.",
      nextStep: "Apply the selected path.",
    }) as { details: { state: { awaitingUser: boolean } } };
    assert.equal(release.details.state.awaitingUser, false);
  } finally {
    mock.timers.reset();
  }
});

test("provider-limit auto-resume retries instead of resuming while busy", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness({ idle: false, pendingMessages: true });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.match(harness.goalNotice() ?? "", /Auto-resume will retry/);

    harness.setIdle(true);
    harness.setPendingMessages(false);
    flushContinuationScheduler();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("non-limit non-retryable pauses do not schedule auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "invalid api key");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.doesNotMatch(harness.goalNotice() ?? "", /Auto-resume/);
  } finally {
    mock.timers.reset();
  }
});

test("manual resume clears provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "insufficient_quota 429");
    await harness.runSlashCommand("gr");
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 0);

    fireProviderLimitAutoResume();
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("/gc clears the goal and cancels provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "Monthly usage limit reached");
    await harness.runSlashCommand("gc");

    assert.equal(harness.snapshot().goal, null);
    assert.equal(harness.goalNotice(), undefined);
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();
    assert.equal(harness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("user input and session shutdown clear provider-limit auto-resume", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const userInputHarness = createRuntimeHarness();
    await userInputHarness.runCommand("ship it");
    userInputHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(userInputHarness, 0, "available balance");
    await userInputHarness.emit("input", {
      type: "input",
      text: "I'll handle it",
      source: "user",
      streamingBehavior: "normal",
    });
    fireProviderLimitAutoResume();
    assert.equal(userInputHarness.snapshot().goal?.status, "paused");
    assert.equal(userInputHarness.sentUserMessages.length, 0);

    const shutdownHarness = createRuntimeHarness();
    await shutdownHarness.runCommand("ship it");
    shutdownHarness.sentMessages.length = 0;
    await emitPersistentAssistantError(shutdownHarness, 0, "quota exceeded");
    await shutdownHarness.emit("session_shutdown", sessionShutdownEvent());
    fireProviderLimitAutoResume();
    assert.equal(shutdownHarness.sentUserMessages.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test("a second provider-limit failure after auto-resume schedules one new retry", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await emitPersistentAssistantError(harness, 0, "FreeUsageLimitError");
    fireProviderLimitAutoResume();
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);

    harness.sentUserMessages.length = 0;
    await emitPersistentAssistantError(harness, 1, "FreeUsageLimitError");
    assert.equal(harness.snapshot().goal?.status, "paused");
    assert.equal(harness.sentUserMessages.length, 0);
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("ход с ошибкой ассистента учитывается, но не продолжает цель сразу", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;

  const settled = await runTurn(harness, 0, assistantMessage("error", { input: 30, output: 12 }, "websocket closed"));

  const goal = harness.snapshot().goal;
  assert.equal(goal?.status, "active");
  assert.equal(goal?.usage.tokensUsed, 42);
  assert.equal(settled.continued, false);
  assert.equal(goalTickets(harness).length, 0);
});

// Продолжение приходит одним из двух путей: на границе перед простоем, если ничто не держит
// цель, или билетом из простоя, когда сабагенты её отпустили.
const boundaryContinuations = new WeakMap<ReturnType<typeof createRuntimeHarness>, number>();

/** Сколько продолжений получила цель: на границе и билетами. */
function continued(harness: ReturnType<typeof createRuntimeHarness>): number {
  return (boundaryContinuations.get(harness) ?? 0) + goalTickets(harness).length;
}

/** Завершает прогон активной цели до границы перед простоем. */
async function endActiveGoalRun(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  const settled = await runTurn(harness, 0, assistantMessage("stop", { input: 30, output: 12 }));
  boundaryContinuations.set(harness, (boundaryContinuations.get(harness) ?? 0) + (settled.continued ? 1 : 0));
}

test("a running background subagent holds continuation until its completion event", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    await endActiveGoalRun(harness);
    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "run-1" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
    assert.equal((goalTickets(harness)[0]?.message.details as { kind?: string } | undefined)?.kind, "goal");
  } finally {
    mock.timers.reset();
  }
});

test("continuation resumes only after every background subagent has completed", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    harness.emitBusEvent("subagent:async-started", { id: "run-2" });
    await endActiveGoalRun(harness);
    harness.emitBusEvent("subagent:async-complete", { id: "run-1" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "run-2" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("a lost subagent completion releases continuation after the wait timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-lost" });
    await endActiveGoalRun(harness);
    flushContinuationScheduler();
    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS - 1_000);
    assert.equal(continued(harness), 0);

    mock.timers.tick(1_000);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("session shutdown forgets background subagents and malformed events are ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", undefined);
    harness.emitBusEvent("subagent:async-started", { id: 7 });
    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    await harness.emit("session_shutdown", sessionShutdownEvent("reload"));
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    await endActiveGoalRun(harness);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("an overlapping run keeps a fallback timer after the first run completes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    harness.emitBusEvent("subagent:async-started", { id: "run-2" });
    await endActiveGoalRun(harness);
    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    harness.emitBusEvent("subagent:async-complete", { id: "run-1" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("subagent events of another session neither hold nor release continuation", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "foreign", sessionId: "other-session" });
    harness.emitBusEvent("subagent:async-started", { id: "own", sessionId: "session" });
    await endActiveGoalRun(harness);
    harness.emitBusEvent("subagent:async-complete", { id: "own", sessionId: "other-session" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "own", sessionId: "session" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("provider-limit auto-resume waits for background subagents instead of sending directly", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;
    harness.sentUserMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    await emitPersistentAssistantError(harness, 0, "usage limit has been reached");
    fireProviderLimitAutoResume();

    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(harness.sentUserMessages.length, 0);
    assert.equal(harness.sentMessages.length, 0);

    harness.emitBusEvent("subagent:async-complete", { id: "run-1" });
    flushContinuationScheduler();
    assert.equal(harness.sentMessages.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("session shutdown unsubscribes from subagent events and a restart does not duplicate subscriptions", async () => {
  const harness = createRuntimeHarness();
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.busListenerCount("subagent:async-started"), 1);
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(harness.busListenerCount("subagent:async-started"), 1);
  await harness.emit("session_shutdown", sessionShutdownEvent("reload"));
  assert.equal(harness.busListenerCount("subagent:async-started"), 0);
  assert.equal(harness.busListenerCount("subagent:async-complete"), 0);
});


test("a repeated start event does not extend the wait for a lost completion", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const harness = createRuntimeHarness();
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    harness.sentMessages.length = 0;

    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    await endActiveGoalRun(harness);
    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS / 2);
    harness.emitBusEvent("subagent:async-started", { id: "run-1" });
    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS / 2);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  } finally {
    mock.timers.reset();
  }
});

test("create_goal exposes the done criterion where the objective is authored", () => {
  const metadata = createRuntimeHarness().getToolMetadata("create_goal");
  assert.ok(metadata);
  assert.match(metadata.promptSnippet ?? "", /done criterion/i);
  const schema = metadata.parameters as { properties: { objective: { description: string } } };
  const guidance = schema.properties.objective.description;
  assert.match(guidance, /done criterion/i);
  assert.match(guidance, /agreed experiments and required evidence/);
  assert.match(guidance, /spending cap is not a quota/);
  assert.match(guidance, /cannot replace required work or proof/);
  assert.match(guidance, /failed approach alone is not a negative result/);
});
