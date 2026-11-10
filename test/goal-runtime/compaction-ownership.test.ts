import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assistantMessage, createRuntimeHarness } from "../support/runtime-harness.js";

const CONTEXT_WINDOW = 272_000;
const OLD_GOAL_THRESHOLD_USAGE = 222_697;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (path.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function contextUsage(tokens: number) {
  return {
    tokens,
    contextWindow: CONTEXT_WINDOW,
    percent: (tokens / CONTEXT_WINDOW) * 100,
  };
}

// Сжатие начинает только модуль сжатия: по запросу агента или по решению Pi. Цель его не начинает.
test("код цели не начинает сжатие сам", () => {
  const forbidden = [
    "ctx.compact(",
    "proactiveCompaction",
    "PROACTIVE_COMPACTION_RESERVE_TOKENS",
  ];
  const violations: string[] = [];

  const goalFiles = [...sourceFiles("src/goal"), ...sourceFiles("src/shell").filter((file) => /goal-|tickets/.test(file))];
  assert.ok(goalFiles.length > 10);
  for (const file of goalFiles) {
    const source = readFileSync(file, "utf8");
    for (const token of forbidden) {
      if (source.includes(token)) {
        violations.push(`${file}: ${token}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("ходы с инструментами и отчётом на старом пороге 222697/272000 не запускают сжатие", async () => {
  const harness = createRuntimeHarness({ contextUsage: contextUsage(OLD_GOAL_THRESHOLD_USAGE) });
  await harness.runCommand("ship it");

  const toolUse = assistantMessage("toolUse", { input: 10, output: 2 });
  await harness.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 0,
    message: toolUse,
    toolResults: [],
  });

  assert.equal(harness.compactCalls.length, 0);

  await harness.emit("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2 });
  await harness.runTool("report_goal_progress", {
    action: "publish",
    status: "working",
    phase: "implementation",
    changed: "Recorded progress.",
    verification: "Checked the ownership boundary.",
    nextStep: "Continue implementation.",
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: {
      ...assistantMessage("toolUse", { input: 10, output: 2 }),
      content: [{ type: "toolCall", id: "report", name: "report_goal_progress", arguments: {} }],
    },
    toolResults: [],
  });

  assert.equal(harness.compactCalls.length, 0);
});
