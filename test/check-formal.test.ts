import assert from "node:assert/strict";
import { test } from "node:test";
import { RUNS, parseTlcOutput } from "../scripts/check-formal.ts";

test("разбор вывода TLC: нарушенное свойство и цепочка действий", () => {
  const output = [
    "Error: Invariant P2_HoldHolds is violated.",
    "State 1: <Initial predicate>",
    "State 2: <OwnerInput line 1, col 1 to line 2, col 2 of module Continuation>",
    "State 3: <BeforeSettle line 1, col 1 to line 2, col 2 of module Continuation>",
    "40 distinct states found",
  ].join("\n");
  assert.deepEqual(parseTlcOutput(output), { violated: "P2_HoldHolds", steps: ["OwnerInput", "BeforeSettle"], states: "40", error: null });
});

test("разбор вывода TLC: ошибка разбора модели не считается успехом", () => {
  assert.notEqual(parseTlcOutput("Fatal error during parsing").error, null);
});

test("переполнение окна проверяется своим набором прогонов и свойств", () => {
  const runs = RUNS.filter((run) => run.model === "Recovery");
  assert.deepEqual(runs.map((run) => run.bug), ["none", "lengthResets", "lengthIsSuccess", "noPauseAfterCap", "continueWhileRecovering", "continueWhilePaused"]);
  assert.deepEqual(runs.map((run) => run.expect), [null, "P19_LengthKeepsAttempts", "P19_LengthKeepsAttempts", "P20_RecoveryCapped", "P18_NoContinueWhileRecovering", "P21_NoContinueWhilePaused"]);
});

test("свойства продолжения и договорённости имеют намеренные поломки", () => {
  const broken = new Set(RUNS.map((run) => run.expect).filter((name) => name !== null));
  for (const name of ["P1_OneContinuation", "P2_HoldHolds", "P3_NoRevival", "P4_NoUnknownWrite", "P5_NoStaleTicket", "P6_NoSilentStall", "P7_OneCurrentAgreement", "P8_NoStaleClose", "P9_OwnerOnlyEdits", "P17_NoDeferredWakeDuringSwitch"]) {
    assert.ok(broken.has(name), name);
  }
});
