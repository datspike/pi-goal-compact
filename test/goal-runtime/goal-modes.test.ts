import assert from "node:assert/strict";
import test from "node:test";
import type { GoalWorkingState } from "../../src/goal/format.js";
import { createRuntimeHarness } from "../support/runtime-harness.js";

for (const mode of [undefined, "outcome", "research"] as const) {
  test("Режим сохраняется при переоткрытии и не меняет закрытие: " + (mode ?? "прежний"), async () => {
    const harness = createRuntimeHarness();
    await harness.runTool("create_goal", {
      objective: "Сверить выгрузку", agreement: { owner_wants: "Сверить выгрузку", done_when: "Суммы сходятся" },
      self_decided: [], ...(mode === undefined ? {} : { mode }),
    });
    const goal = async () => (await harness.runTool("get_goal", {}) as { details: GoalWorkingState }).details.goal!;
    assert.equal((await goal()).mode, mode);
    await harness.reloadSession("reload");
    assert.equal((await goal()).mode, mode);
    await assert.rejects(harness.runTool("update_goal", { status: "complete", verification: "Суммы по двум источникам совпали." }, undefined, { agreementCheck: "raw" }), /agreement_check/);
    assert.equal((await goal()).status, "active");
    await harness.runTool("update_goal", { status: "complete" });
    assert.equal((await goal()).status, "complete");
  });
}
