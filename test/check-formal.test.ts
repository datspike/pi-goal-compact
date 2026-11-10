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

test("каждое свойство обеих моделей ломается хотя бы одной поломкой", () => {
  const broken = new Set(RUNS.map((run) => run.expect).filter((name) => name !== null));
  for (const name of ["P1_OneContinuation", "P2_HoldHolds", "P3_NoRevival", "P4_NoUnknownWrite", "P5_NoStaleTicket", "P6_NoSilentStall", "P7_OneCurrentAgreement", "P8_NoStaleClose", "P9_OwnerOnlyEdits"]) {
    assert.ok(broken.has(name), name);
  }
});
