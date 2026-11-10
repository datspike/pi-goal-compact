import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExternalRetryRecovery } from "../../src/goal/external-retry-recovery.js";
import { createThreadGoal } from "../../src/goal/state.js";

function fixture() {
  let goal = createThreadGoal("Synthetic retry probe");
  let terminalInput: ((data: string) => unknown) | null = null;
  let pauses = 0;
  let settled = 0;
  let hostTime = 10;
  const ctx = { mode: "tui", sessionManager: { getSessionId: () => "main", getSessionFile: () => undefined }, ui: { onTerminalInput(handler: (data: string) => unknown) { terminalInput = handler; return () => { terminalInput = null; }; } } } as ExtensionContext;
  const child = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => "child" } };
  const bridge = createExternalRetryRecovery({
    getGoal: () => goal, isAvailable: () => true, now: () => hostTime, canRecover: () => true, clearContinuation: () => {},
    resume() { goal = { ...goal, status: "active" }; delete goal.pause; },
    pause(_ctx, reason) { pauses++; goal = { ...goal, status: "paused", pause: { kind: "recovery", reason } }; },
    pauseManual() { pauses++; goal = { ...goal, status: "paused", pause: { kind: "manual", reason: "Esc" } }; },
    pending() {}, settled() { settled++; },
  });
  bridge.bind(ctx);
  return { bridge, ctx, child, freshTimestamp: () => ++hostTime, key: (data: string) => terminalInput?.(data), goal: () => goal, pauses: () => pauses, settled: () => settled };
}

test("Esc during backoff remains a manual interruption and is passed to Pi", () => {
  const f = fixture();
  f.bridge.error(f.ctx, "Synthetic failure");
  assert.equal(f.key("\x1b"), undefined);
  assert.equal(f.goal().pause?.kind, "manual");
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), false);
  assert.equal(f.pauses(), 1);
  assert.equal(f.settled(), 0);
});

test("child results and carriers cannot own or settle main recovery", () => {
  const f = fixture();
  f.bridge.error(f.child, "Child failure");
  assert.equal(f.bridge.active(), false);
  f.bridge.error(f.ctx, "Main failure");
  assert.equal(f.bridge.admit(f.child, f.freshTimestamp()), false);
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.finish(f.child, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic recovered result." }] });
  assert.equal(f.settled(), 0);
  assert.equal(f.bridge.active(), true);
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic recovered result." }] });
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic recovered result." }] });
  assert.equal(f.settled(), 1);
});

test("shutdown detaches the terminal listener and rejects old carriers", () => {
  const f = fixture();
  f.bridge.error(f.ctx, "Main failure");
  f.bridge.detach();
  f.bridge.detach();
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), false);
  assert.equal(f.bridge.active(), false);
  assert.equal(f.key("\x1b"), undefined);
});

test("length recovery needs this session's actual result, not an unrelated carrier", () => {
  const f = fixture();
  f.bridge.result(f.child, { role: "assistant", stopReason: "length" });
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), false);
  f.bridge.result(f.ctx, { role: "assistant", stopReason: "length" });
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.result(f.ctx, { role: "assistant", stopReason: "length" });
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "length" });
  assert.equal(f.settled(), 0);
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic recovered result." }] });
  assert.equal(f.settled(), 1);
});

test("lazy creation of the session file does not change retry ownership", () => {
  const f = fixture();
  f.bridge.error(f.ctx, "Main failure before session persistence");
  f.ctx.sessionManager.getSessionFile = () => "/synthetic/session.jsonl";
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Synthetic recovered result." }] });
  assert.equal(f.settled(), 1);
});

test("rebind never reconstructs live retry intent from a durable technical pause", () => {
  const f = fixture();
  f.bridge.error(f.ctx, "First failure");
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.error(f.ctx, "Retry failure");
  assert.equal(f.goal().pause?.kind, "recovery");
  f.bridge.bind(f.ctx);
  assert.equal(f.bridge.active(), false);
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), false);
  assert.equal(f.goal().status, "paused");
});

test("each attempt consumes a newer SDK-created carrier; failed retries reject their old copies", () => {
  const f = fixture();
  f.bridge.error(f.ctx, "Initial failure");
  const first = f.freshTimestamp();
  assert.equal(f.bridge.admit(f.ctx, first), true);
  assert.equal(f.bridge.admit(f.ctx, first), false);
  f.bridge.error(f.ctx, "Last failed attempt");
  assert.equal(f.bridge.admit(f.ctx, first), false);
  assert.equal(f.bridge.admit(f.ctx, first - 1), false);
  assert.equal(f.bridge.admit(f.ctx, Number.NaN), false);
  assert.equal(f.goal().pause?.kind, "recovery");
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
});

test("repeated empty results remain technical failures rather than goal continuation permission", () => {
  const f = fixture();
  const empty = { role: "assistant", stopReason: "stop", content: [] };
  f.bridge.result(f.ctx, empty);
  f.bridge.finish(f.ctx, empty);
  assert.equal(f.goal().pause?.kind, "recovery");
  const first = f.freshTimestamp();
  assert.equal(f.bridge.admit(f.ctx, first), true);
  f.bridge.result(f.ctx, empty);
  f.bridge.finish(f.ctx, empty);
  assert.equal(f.goal().pause?.kind, "recovery");
  assert.equal(f.settled(), 0);
  assert.equal(f.bridge.admit(f.ctx, first), false);
  assert.equal(f.bridge.admit(f.ctx, f.freshTimestamp()), true);
  f.bridge.finish(f.ctx, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Recovered." }] });
  assert.equal(f.settled(), 1);
});
