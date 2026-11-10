import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { SUBAGENT_RPC_TIMEOUT_MS, SUBAGENT_WAIT_TIMEOUT_MS } from "../../src/goal/runtime-config.js";
import {
  createExpandedRuntimeHarness as createRuntimeHarness,
  flushContinuationScheduler,
  goalTickets,
  runTurn,
} from "../support/runtime-harness.js";

type Harness = ReturnType<typeof createRuntimeHarness>;

const REQUEST_CHANNEL = "subagents:rpc:v1:request";
const READY_CHANNEL = "subagents:rpc:v1:ready";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

interface SnapshotRun {
  id: string;
  state: string;
  startedAt?: number;
}

/** Answers every pi-subagents `status` request with the current value of `runs`; `null` stays silent. */
function answerStatusRequests(
  harness: Harness,
  state: {
    runs: SnapshotRun[] | null;
    omitted?: { runs: number } | undefined;
    failure?: boolean;
    requests: number;
    /** When set, replies wait in `deferred` until a test sends them. */
    deferred?: Array<() => void>;
  },
): void {
  harness.onBusEvent(REQUEST_CHANNEL, (raw) => {
    const request = raw as { requestId: string; method: string };
    state.requests += 1;
    if (request.method !== "status" || state.runs === null) return;
    const reply = state.failure
      ? { version: 1, requestId: request.requestId, success: false, error: { code: "x", message: "x" } }
      : {
          version: 1,
          requestId: request.requestId,
          method: "status",
          success: true,
          data: { asyncSnapshot: {
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              omitted: { runs: state.omitted?.runs ?? 0, children: 0, byteLimitExceeded: false },
              runs: state.runs,
            },
          },
        };
    const send = (): void => harness.emitBusEvent(`${REPLY_PREFIX}${request.requestId}`, reply);
    if (state.deferred) state.deferred.push(send);
    else send();
  });
}

// Продолжение цели приходит одним из двух путей: на границе перед простоем, если ничто не держит
// цель, или билетом из простоя, когда сабагенты её отпустили.
const continuations = new WeakMap<Harness, number>();

/** Сколько продолжений получила цель: на границе и билетами. */
function continued(harness: Harness): number {
  return (continuations.get(harness) ?? 0) + goalTickets(harness).length;
}

/** Создаёт цель и завершает её первый прогон: сессия простаивает с активной целью. */
async function startGoalAndEndRun(harness: Harness): Promise<void> {
  await harness.runCommand("ship it");
  harness.sentMessages.length = 0;
  const settled = await runTurn(harness, 0);
  continuations.set(harness, settled.continued ? 1 : 0);
}

async function withMockTimers(body: () => Promise<void>, apis: Array<"setTimeout" | "Date"> = ["setTimeout"]): Promise<void> {
  mock.timers.enable({ apis });
  try {
    await body();
  } finally {
    mock.timers.reset();
  }
}

test("a run reported active by pi-subagents at session start holds continuation until it completes", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc = { runs: [{ id: "pre-reload", state: "running" }], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(rpc.requests, 1);
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "pre-reload" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("runs in terminal or paused states do not hold continuation", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    answerStatusRequests(harness, {
      runs: [
        { id: "done", state: "complete" },
        { id: "failed", state: "failed" },
        { id: "waiting", state: "paused" },
      ],
      requests: 0,
    });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("continuation waits for the status reply and proceeds when pi-subagents stays silent", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    answerStatusRequests(harness, { runs: null, requests: 0 });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    mock.timers.tick(SUBAGENT_RPC_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("an error reply is treated like an absent pi-subagents", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    answerStatusRequests(harness, { runs: [{ id: "ignored", state: "running" }], failure: true, requests: 0 });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("no status request is sent while the subagent tool is not registered", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness();
    const rpc = { runs: [{ id: "x", state: "running" }], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(rpc.requests, 0);
    assert.equal(continued(harness), 1);
  });
});

test("the ready announcement of pi-subagents triggers a fresh status sync", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness();
    const rpc = { runs: [{ id: "late", state: "queued" }], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(rpc.requests, 0);

    harness.emitBusEvent(READY_CHANNEL, {});
    assert.equal(rpc.requests, 1);
    await startGoalAndEndRun(harness);

    flushContinuationScheduler();
    assert.equal(continued(harness), 0);
    harness.emitBusEvent("subagent:async-complete", { id: "late" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("a run past the wait cap that pi-subagents still reports active keeps holding", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc: { runs: SnapshotRun[] | null; requests: number } = { runs: [], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    harness.emitBusEvent("subagent:async-started", { id: "long" });
    await startGoalAndEndRun(harness);
    const requestsBefore = rpc.requests;

    rpc.runs = [{ id: "long", state: "running" }];
    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(rpc.requests, requestsBefore + 1);
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "long" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("a run past the wait cap that pi-subagents no longer lists is released", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc: { runs: SnapshotRun[] | null; requests: number } = { runs: [], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    harness.emitBusEvent("subagent:async-started", { id: "lost" });
    await startGoalAndEndRun(harness);

    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("shutdown cancels a pending status request", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    answerStatusRequests(harness, { runs: null, requests: 0 });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(harness.busListenerCount(READY_CHANNEL), 1);

    await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    assert.equal(harness.busListenerCount(READY_CHANNEL), 0);
    mock.timers.tick(SUBAGENT_RPC_TIMEOUT_MS * 2);
  });
});

test("a cut snapshot ending in an active run is confirmed again before continuation is released", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc: { runs: SnapshotRun[] | null; omitted?: { runs: number } | undefined; requests: number } = {
      runs: [{ id: "listed", state: "running" }],
      omitted: { runs: 1 },
      requests: 0,
    };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    // The hidden second run shows up only once the listed one is gone.
    rpc.runs = [{ id: "hidden", state: "running" }];
    rpc.omitted = undefined;
    harness.emitBusEvent("subagent:async-complete", { id: "listed" });
    flushContinuationScheduler();
    assert.equal(rpc.requests, 2);
    assert.equal(continued(harness), 0);

    harness.emitBusEvent("subagent:async-complete", { id: "hidden" });
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("a cut snapshot whose last run is finished already lists every active run", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc: { runs: SnapshotRun[] | null; omitted?: { runs: number } | undefined; requests: number } = {
      runs: [
        { id: "listed", state: "running" },
        { id: "finished", state: "complete" },
      ],
      omitted: { runs: 30 },
      requests: 0,
    };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    harness.emitBusEvent("subagent:async-complete", { id: "listed" });
    flushContinuationScheduler();
    assert.equal(rpc.requests, 1);
    assert.equal(continued(harness), 1);
  });
});

test("возобновление по согласию владельца не ждёт ответа на запрос статуса сабагентов", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    answerStatusRequests(harness, { runs: null, requests: 0 });
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.runCommand("ship it");
    await harness.runSlashCommand("gp");
    harness.sentMessages.length = 0;

    // Открытие сессии с приостановленной целью: владелец подтверждает возобновление в диалоге.
    await harness.emit("session_start", { type: "session_start", reason: "resume" });
    assert.equal(harness.snapshot().goal?.status, "active");
    assert.equal(goalTickets(harness).length, 1);
  });
});

test("a reply that predates a completion does not bring the finished run back", async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc = { runs: [{ id: "racing", state: "running" }], requests: 0, deferred: [] as Array<() => void> };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await startGoalAndEndRun(harness);

    harness.emitBusEvent("subagent:async-complete", { id: "racing" });
    for (const send of rpc.deferred.splice(0)) send();
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  });
});

test("a run past the wait cap waits for the status timeout without spinning timers", { timeout: 5_000 }, async () => {
  await withMockTimers(async () => {
    const harness = createRuntimeHarness({ tools: ["subagent"] });
    const rpc: { runs: SnapshotRun[] | null; requests: number } = { runs: [], requests: 0 };
    answerStatusRequests(harness, rpc);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    harness.emitBusEvent("subagent:async-started", { id: "silent" });
    await startGoalAndEndRun(harness);

    rpc.runs = null;
    mock.timers.tick(SUBAGENT_WAIT_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(continued(harness), 0);

    mock.timers.tick(SUBAGENT_RPC_TIMEOUT_MS);
    flushContinuationScheduler();
    assert.equal(continued(harness), 1);
  }, ["setTimeout", "Date"]);
});
