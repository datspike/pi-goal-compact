import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readGoalHistory } from "../../src/goal/goal-projections.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import { reconstructGoal } from "../../src/goal/state.js";
import { assistantMessage, createRuntimeHarness } from "../support/runtime-harness.js";

type Receipt = { applied: boolean | null; operation: string; stage: string; retryable: boolean; eventId: string; reportId?: string; remediation: string; amendment_id?: string };
const working = { action: "publish", status: "working", phase: "Проверяю запись", summary: "Проверяю восстановление записи.", changed: "Подготовлены условия проверки.", nextStep: "Сверить сохранённый файл." };
const amendment = "Дополнительно проверить адрес события после отказа записи.";
const scenarios = [
  { operation: "create_goal", reportStatus: undefined },
  { operation: "amend_goal", reportStatus: undefined },
  { operation: "update_goal", reportStatus: undefined },
  ...["verifying", "blocked", "awaiting_user"].map(reportStatus => ({ operation: "report_goal_progress", reportStatus })),
];

for (const { operation, reportStatus } of scenarios) for (const timing of ["before", "after"] as const) {
  test(`public ${operation} ${reportStatus ?? ""} preserves uncertain projection address ${timing} persistence`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "goal-projection-receipt-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    let manager = SessionManager.create(cwd, join(cwd, "sessions"));
    manager.appendMessage({ role: "user", content: "Offline projection receipt", timestamp: Date.now() });
    manager.appendMessage({ ...assistantMessage("stop", { input: 0, output: 0 }), role: "assistant" });
    const file = manager.getSessionFile();
    assert.ok(file);
    let armed = false;
    let failed = false;
    const h = createRuntimeHarness({ cwd, persistEntry(customType, data) {
      const fail = armed && customType === GOAL_PROJECTION_ENTRY_TYPE;
      if (fail) {
        armed = false;
        failed = true;
        if (timing === "before") { renameSync(file, file + ".saved"); mkdirSync(file); }
      }
      manager.appendCustomEntry(customType, data);
      if (fail) throw new Error("projection acknowledgement lost");
    } });
    if (operation !== "create_goal") {
      await h.runTool("create_goal", { objective: "Проверить квитанцию записи события" });
      await h.runTool("report_goal_progress", working);
    }
    if (operation === "update_goal") await h.runTool("report_goal_progress", { ...working, status: "verifying", verification: "Условия готовности проверены." });
    const report = { ...working, status: reportStatus, verification: "Условия проверены.", problemOrDecision: "Нужно дождаться внешнего условия.", needUser: "Подтвердить выбранное решение." };
    armed = true;
    let receipt: Receipt | undefined;
    try {
      await h.runTool(operation, operation === "create_goal" ? { objective: "Проверить квитанцию записи события" }
        : operation === "amend_goal" ? { amendment } : operation === "update_goal" ? { status: "complete" }
        : operation === "report_goal_progress" ? report : {});
    } catch (error) {
      assert.ok(error instanceof Error);
      try { receipt = JSON.parse(error.message); } catch { assert.fail(`public error must retain a structured receipt: ${error.message}`); }
    }
    assert.equal(failed, true, "the requested path must reach a canonical projection write");
    assert.ok(receipt, "an uncertain projection cannot report success");
    assert.equal(receipt.operation, operation);
    assert.equal(receipt.applied, operation === "report_goal_progress" ? null : true);
    assert.equal(receipt.stage, operation === "report_goal_progress" ? "canonical" : "projection");
    assert.equal(receipt.retryable, false);
    assert.ok(receipt.eventId, "the public receipt must not bury its address inside message");
    assert.match(receipt.remediation, /reopen|re-open/i);
    if (operation === "report_goal_progress") assert.ok(receipt.reportId);
    if (operation === "amend_goal") assert.ok(receipt.amendment_id);
    if (timing === "before") { await rm(file, { recursive: true }); renameSync(file + ".saved", file); }
    const count = manager.getBranch().length;
    await assert.rejects(() => h.runTool("create_goal", { objective: "Не заменять цель до сверки", replace_existing: true }));
    assert.equal(manager.getBranch().length, count);
    manager = SessionManager.open(file);
    const goal = reconstructGoal(manager.getBranch()).goal;
    assert.ok(goal);
    if (timing === "after") assert.ok(readGoalHistory(manager.getBranch(), goal.goalId, { event_id: receipt.eventId }));
    else assert.throws(() => readGoalHistory(manager.getBranch(), goal.goalId, { event_id: receipt.eventId }), /not found/);
    h.entries.splice(0, h.entries.length, ...manager.getBranch());
    await h.reloadSession("reload");
    if (operation === "report_goal_progress") {
      if (timing === "before") await h.runTool(operation, report);
      const status = await h.runTool("get_goal", { view: "status" }) as { details: { progressStatus: string } };
      assert.equal(status.details.progressStatus, reportStatus);
    } else if (operation === "amend_goal") {
      await h.runTool(operation, { amendment_id: receipt.amendment_id });
      assert.equal(h.snapshot().goal!.objective.split(amendment).length - 1, 1);
    } else if (operation === "update_goal") await h.runTool(operation, { status: "complete" });
    const final = reconstructGoal(SessionManager.open(file).getBranch()).goal;
    assert.ok(final);
    assert.equal(final.goalId, goal.goalId);
  });
}
