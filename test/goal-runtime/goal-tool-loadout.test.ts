import assert from "node:assert/strict";
import test from "node:test";
import { OPEN_GOAL_TOOLS, goalToolLoadout } from "../../src/goal/tools.js";
import { createExpandedRuntimeHarness as createRuntimeHarness, emitToolExecutionEnd, sessionCompactEvent } from "../support/runtime-harness.js";

const goalTools = (active: readonly string[]): string[] => active.filter((name) => (OPEN_GOAL_TOOLS as readonly string[]).includes(name));

test("without a goal the model sees only create_goal; the goal tools join after creation", async () => {
  const harness = createRuntimeHarness();
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.ok(harness.activeTools().includes("create_goal"));
  assert.deepEqual(goalTools(harness.activeTools()), []);
  assert.equal(harness.activeTools().includes("load_goal_language_guide"), false);
  await harness.runTool("create_goal", { objective: "Проверить набор инструментов" });
  await emitToolExecutionEnd(harness);
  assert.deepEqual(goalTools(harness.activeTools()).sort(), [...OPEN_GOAL_TOOLS].sort());
});

test("closing the goal keeps its tools until the next window boundary, then removes them", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить отложенное снятие");
  await emitToolExecutionEnd(harness);
  await harness.runTool("report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", verification: "Проверка завершена.", nextStep: "Закрыть цель." });
  await harness.runTool("update_goal", { status: "complete" });
  await emitToolExecutionEnd(harness);
  await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "дальше", systemPrompt: "base" });
  // Снятие посреди окна переписало бы его начало и сбросило кэш провайдера (решение 0013).
  assert.deepEqual(goalTools(harness.activeTools()).sort(), [...OPEN_GOAL_TOOLS].sort());
  await harness.emit("session_compact", sessionCompactEvent());
  assert.deepEqual(goalTools(harness.activeTools()), []);
  assert.ok(harness.activeTools().includes("create_goal"));
});

test("the loadout never touches tools of other owners", () => {
  assert.deepEqual(goalToolLoadout(["bash", "create_goal", "get_goal"], false, true), ["bash", "create_goal"]);
  assert.deepEqual(goalToolLoadout(["bash", "create_goal", "get_goal"], false, false), ["bash", "create_goal", "get_goal"]);
  assert.deepEqual(goalToolLoadout(["bash"], true, false), ["bash", ...OPEN_GOAL_TOOLS]);
});
