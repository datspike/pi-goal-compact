import assert from "node:assert/strict";
import { test } from "node:test";
import { initialState } from "../../src/core/model.js";
import { step } from "../../src/core/step.js";

test("передача запрещает продолжение во время смены модели и после ошибки", () => {
 for (const phase of ["applying", "failed"] as const) {
  const state = { ...initialState, agent: "running" as const, transfer: phase };
  assert.equal(step(state, { type: "before_settle", gate: "runs", outcome: "completed", pendingMessages: false }).effects.length, 0);
  assert.equal(step({ ...state, agent: "idle" }, { type: "wake", gate: "runs" }).effects.length, 0);
 }
});
test("передача из простоя сжимает, но не придумывает продолжение без задачи", () => {
 const request = { mainObjective: "сохранить", completedCheckpoint: "текущее состояние", continuationTarget: "не начинать новую задачу" };
 let state = step(initialState, { type: "checkpoint_requested", request, alreadyCompacted: false, continueAfter: false }).state;
 const settled = step(state, { type: "settled", aborted: false });
 assert.equal(settled.effects[0]?.type, "compact");
 state = settled.state;
 assert.equal(step(state, { type: "checkpoint_compact_done", ok: true, pendingMessages: false }).effects.length, 0);
});
test("отмена передачи снимает только удержание передачи", () => {
 const state = step({ ...initialState, transfer: "failed" }, { type: "transfer_cancelled" }).state;
 assert.equal(state.transfer, undefined);
 assert.equal(step(state, { type: "wake", gate: "held" }).effects.length, 0);
});
