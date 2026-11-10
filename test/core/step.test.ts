import { describe, expect, test } from "../support/expect.js";
import { initialState, type CoreEvent, type CoreState } from "../../src/core/model.js";
import { step } from "../../src/core/step.js";

const request = { mainObjective: "цель", completedCheckpoint: "сделано", continuationTarget: "дальше" };

/** Прогоняет события по порядку и собирает действия всех шагов. */
function run(events: readonly CoreEvent[], state: CoreState = initialState) {
  const effects: string[] = [];
  for (const event of events) {
    const next = step(state, event);
    state = next.state;
    effects.push(...next.effects.map((effect) => effect.type === "checkpoint_cancelled" || effect.type === "checkpoint_refused" ? `${effect.type}:${effect.reason}` : effect.type));
  }
  return { state, effects };
}

const scheduled: CoreEvent[] = [
  { type: "run_started" },
  { type: "checkpoint_requested", request, alreadyCompacted: false },
];
const compacted: CoreEvent[] = [
  ...scheduled,
  { type: "settled", aborted: false },
  { type: "compaction_started", reason: "manual", willRetry: false },
  { type: "compaction_finished", reason: "manual", willRetry: false, ok: true },
];
const done: CoreEvent = { type: "checkpoint_compact_done", ok: true, pendingMessages: false };

describe("контрольная точка", () => {
  test("сжатие начинается только после успокоения хода, продолжение — после завершения сжатия", () => {
    expect(run(scheduled).effects).toEqual(["checkpoint_scheduled"]);
    expect(run(compacted).effects).toEqual(["checkpoint_scheduled", "compact"]);
    const { state, effects } = run([...compacted, done]);
    expect(effects.at(-1)).toBe("send_ticket");
    expect(state.ticketEpoch).toBe(state.epoch);
    expect(state.checkpoint.phase).toBe("none");
  });

  test("вторая просьба во время ожидания и просьба после уже сделанного сжатия отклоняются", () => {
    expect(run([...scheduled, { type: "checkpoint_requested", request, alreadyCompacted: false }]).effects.at(-1)).toBe("checkpoint_refused:in_progress");
    expect(run([{ type: "checkpoint_requested", request, alreadyCompacted: true }]).effects).toEqual(["checkpoint_refused:already_compacted"]);
  });

  test("неудачное сжатие снимает точку без продолжения", () => {
    expect(run([...compacted, { type: "checkpoint_compact_done", ok: false, pendingMessages: false }]).effects.at(-1)).toBe("checkpoint_cancelled:failed");
  });

  test("сжатие по порогу до успокоения хода отменяет ждущую точку", () => {
    const { state, effects } = run([...scheduled, { type: "compaction_started", reason: "threshold", willRetry: false }, { type: "settled", aborted: false }]);
    expect(effects).toEqual(["checkpoint_scheduled", "checkpoint_cancelled:threshold"]);
    expect(state.checkpoint.phase).toBe("none");
  });

  test("повтор Pi после переполнения подавляет своё продолжение", () => {
    const retry: CoreEvent = { type: "compaction_started", reason: "overflow", willRetry: true };
    expect(run([...compacted.slice(0, 3), retry, done]).effects).not.toContain("send_ticket");
    expect(run([...scheduled, retry, { type: "settled", aborted: false }, done]).effects).not.toContain("send_ticket");
  });

  test("ждущее сообщение в очереди Pi заменяет продолжение", () => {
    expect(run([...compacted, { type: "checkpoint_compact_done", ok: true, pendingMessages: true }]).effects).not.toContain("send_ticket");
  });

  test("реплика владельца во время сжатия отменяет продолжение старой эпохи", () => {
    const { effects } = run([...compacted, { type: "owner_input" }, done]);
    expect(effects).not.toContain("send_ticket");
  });

  test("смена контекста до сжатия снимает ждущую точку", () => {
    expect(run([...scheduled, { type: "context_switched" }, { type: "settled", aborted: false }]).effects).toEqual(["checkpoint_scheduled", "checkpoint_cancelled:context_switched"]);
  });

  test("обрыв хода владельцем снимает ждущую точку", () => {
    expect(run([...scheduled, { type: "settled", aborted: true }]).effects.at(-1)).toBe("checkpoint_cancelled:aborted");
  });
});

describe("билет продолжения", () => {
  const issued = run([...compacted, done]).state;

  test("свежий билет допускается один раз", () => {
    const first = step(issued, { type: "ticket_arrived", ticket: { epoch: issued.epoch, kind: "checkpoint" }, gate: "absent" });
    expect(first.effects).toEqual([{ type: "admit_ticket" }]);
    const second = step(first.state, { type: "ticket_arrived", ticket: { epoch: issued.epoch, kind: "checkpoint" }, gate: "absent" });
    expect(second.effects).toEqual([{ type: "abort_run" }]);
  });

  test("после реплики владельца билет устарел, и его прерывание не считается обрывом", () => {
    const answered = step(issued, { type: "owner_input" }).state;
    const stale = step(answered, { type: "ticket_arrived", ticket: { epoch: issued.epoch, kind: "checkpoint" }, gate: "absent" });
    expect(stale.effects).toEqual([{ type: "abort_run" }]);
    expect(stale.state.selfAbort).toBe(true);
    const pending = step(stale.state, { type: "checkpoint_requested", request, alreadyCompacted: false }).state;
    const settled = step(pending, { type: "settled", aborted: true });
    expect(settled.effects).toEqual([{ type: "compact", request }]);
    expect(settled.state.selfAbort).toBe(false);
  });

  test("билет чужого процесса прерывается", () => {
    expect(step(issued, { type: "ticket_arrived", ticket: { epoch: -1, kind: "checkpoint" }, gate: "absent" }).effects).toEqual([{ type: "abort_run" }]);
  });
});

describe("продолжение цели", () => {
  const running = run([{ type: "run_started" }]).state;
  const settle = (gate: "runs" | "held" | "absent", extra: Partial<{ outcome: "completed" | "aborted" | "error"; pendingMessages: boolean }> = {}): CoreEvent =>
    ({ type: "before_settle", gate, outcome: extra.outcome ?? "completed", pendingMessages: extra.pendingMessages ?? false });

  test("граница перед простоем продолжает только разрешённую цель после удачного прогона", () => {
    expect(step(running, settle("runs")).effects).toEqual([{ type: "continue_goal" }]);
    expect(step(running, settle("held")).effects).toEqual([]);
    expect(step(running, settle("absent")).effects).toEqual([]);
    expect(step(running, settle("runs", { outcome: "error" })).effects).toEqual([]);
    expect(step(running, settle("runs", { outcome: "aborted" })).effects).toEqual([]);
  });

  test("реплика владельца в очереди и ждущая контрольная точка важнее продолжения", () => {
    expect(step(running, settle("runs", { pendingMessages: true })).effects).toEqual([]);
    expect(run([...scheduled, settle("runs")]).effects).toEqual(["checkpoint_scheduled"]);
  });

  test("пробуждение из простоя ставит один билет цели, во время прогона не нужно", () => {
    const idle = run([{ type: "run_started" }, { type: "settled", aborted: false }]).state;
    const woken = step(idle, { type: "wake", gate: "runs" });
    expect(woken.effects).toEqual([{ type: "send_ticket", ticket: { epoch: idle.epoch, kind: "goal" }, request: null }]);
    expect(step(woken.state, { type: "wake", gate: "runs" }).effects).toEqual([]);
    expect(step(idle, { type: "wake", gate: "held" }).effects).toEqual([]);
    expect(step(running, { type: "wake", gate: "runs" }).effects).toEqual([]);
  });

  test("билет цели допускается, только пока цель разрешает работу и эпоха та же", () => {
    const idle = run([{ type: "run_started" }, { type: "settled", aborted: false }]).state;
    const issued = step(idle, { type: "wake", gate: "runs" }).state;
    const ticket = { epoch: issued.epoch, kind: "goal" as const };
    expect(step(issued, { type: "ticket_arrived", ticket, gate: "runs" }).effects).toEqual([{ type: "admit_ticket" }]);
    // Цель ушла в ожидание ответа владельца между постановкой и доставкой.
    expect(step(issued, { type: "ticket_arrived", ticket, gate: "held" }).effects).toEqual([{ type: "abort_run" }]);
    expect(step(issued, { type: "ticket_arrived", ticket, gate: "absent" }).effects).toEqual([{ type: "abort_run" }]);
    const switched = step(issued, { type: "context_switched" }).state;
    expect(step(switched, { type: "ticket_arrived", ticket, gate: "runs" }).effects).toEqual([{ type: "abort_run" }]);
  });

  test("продолжение после сжатия по запросу агента не обходит ожидающую цель", () => {
    const { state } = run([...compacted, done]);
    const ticket = { epoch: state.epoch, kind: "checkpoint" as const };
    expect(step(state, { type: "ticket_arrived", ticket, gate: "held" }).effects).toEqual([{ type: "abort_run" }]);
    expect(step(state, { type: "ticket_arrived", ticket, gate: "runs" }).effects).toEqual([{ type: "admit_ticket" }]);
  });
});
