import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { reconstructGoal } from "../../src/goal/state.js";
import { assistantMessage, createRuntimeHarness } from "../support/runtime-harness.js";

type Receipt = { operation: string; applied: boolean | null; stage: string; retryable: boolean; goalId: string; amendment_id?: string; remediation: string };
const working = { action: "publish", status: "working", phase: "Проверяю сохранение", summary: "Проверяю сохранение цели.", changed: "Подготовлена проверка сохранения.", nextStep: "Сверить результат." };
const amendment = "Дополнительно проверить восстановление договора после ошибки сохранения.";

async function rejection(write: () => Promise<unknown>): Promise<Receipt> {
  try { await write(); } catch (error) {
    assert.ok(error instanceof Error);
    let receipt: Receipt;
    try { receipt = JSON.parse(error.message); } catch { assert.fail(`canonical failure must return an uncertainty receipt: ${error.message}`); }
    assert.equal(receipt.applied, null, "an unacknowledged write must not be reported as false or true");
    assert.equal(receipt.stage, "canonical");
    assert.equal(receipt.retryable, false);
    assert.match(receipt.remediation, /reopen|re-open/i);
    return receipt;
  }
  assert.fail("an unconfirmed canonical write must not become success from SDK memory");
}

for (const operation of ["create_goal", "amend_goal", "resume_goal", "update_goal"] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`canonical ${operation} ${timing} persistence reconciles the real file before recovery`, async t => {
      const cwd = await mkdtemp(join(tmpdir(), "goal-canonical-transition-"));
      t.after(() => rm(cwd, { recursive: true, force: true }));
      let manager = SessionManager.create(cwd, join(cwd, "sessions"));
      manager.appendMessage({ role: "user", content: "Offline transition recovery", timestamp: Date.now() });
      manager.appendMessage({ ...assistantMessage("stop", { input: 0, output: 0 }), role: "assistant" });
      const sessionFile = manager.getSessionFile();
      assert.ok(sessionFile);
      let loseAcknowledgement = false;
      const h = createRuntimeHarness({ cwd, persistEntry(customType, data) {
        manager.appendCustomEntry(customType, data);
        if (loseAcknowledgement && customType === CUSTOM_ENTRY_TYPE) throw new Error("snapshot acknowledgement lost");
      } });
      if (operation !== "create_goal") {
        await h.runTool("create_goal", { objective: "Проверить восстановление снимка цели" });
        await h.runTool("report_goal_progress", working);
      }
      if (operation === "resume_goal") {
        await h.runCommand("pause");
        await h.emit("input", { type: "input", source: "interactive", text: "Продолжи цель" });
      }
      if (operation === "update_goal") await h.runTool("report_goal_progress", { ...working, status: "verifying", verification: "Условия проверены." });
      const existingId = h.snapshot().goal?.goalId;
      if (timing === "before") {
        await rename(sessionFile, sessionFile + ".saved");
        await mkdir(sessionFile);
      } else loseAcknowledgement = true;
      const write = () => operation === "create_goal" ? h.runTool(operation, { objective: "Проверить восстановление снимка цели" })
        : operation === "amend_goal" ? h.runTool(operation, { amendment })
        : operation === "resume_goal" ? h.runTool(operation, {}) : h.runTool(operation, { status: "complete" });
      const receipt = await rejection(write);
      assert.equal(receipt.operation, operation);
      const goalId = receipt.goalId;
      assert.ok(goalId);
      if (existingId) assert.equal(goalId, existingId);
      if (operation === "amend_goal") assert.match(receipt.amendment_id!, /^amendment-[a-f0-9]{64}$/);
      // Pi 1.5 откатывает из памяти запись, которую не удалось записать в файл; потерянное подтверждение память не откатывает.
      const memoryGoal = reconstructGoal(manager.getBranch()).goal;
      const inMemory = operation === "create_goal" ? memoryGoal?.goalId === goalId : operation === "amend_goal" ? memoryGoal?.objective.includes(amendment) === true : memoryGoal?.status === (operation === "resume_goal" ? "active" : "complete");
      assert.equal(inMemory, timing === "after");
      loseAcknowledgement = false;
      if (timing === "before") {
        await rm(sessionFile, { recursive: true });
        await rename(sessionFile + ".saved", sessionFile);
      }
      // Restored storage is not proof that the first write reached the file.
      const count = manager.getBranch().length;
      if (operation === "create_goal") await assert.rejects(write);
      else await rejection(write);
      const replacement = await rejection(() => h.runTool("create_goal", { objective: "Не создавать другую цель до сверки", replace_existing: true }));
      assert.equal(replacement.goalId, goalId);
      assert.equal(manager.getBranch().length, count, "unconfirmed memory must not authorize another snapshot");
      manager = SessionManager.open(sessionFile);
      const saved = reconstructGoal(manager.getBranch()).goal;
      if (operation === "create_goal") assert.equal(saved?.goalId === goalId, timing === "after");
      else {
        assert.ok(saved);
        assert.equal(operation === "amend_goal" ? saved.objective.includes(amendment) : saved.status === (operation === "resume_goal" ? "active" : "complete"), timing === "after");
      }
      h.entries.splice(0, h.entries.length, ...manager.getBranch());
      await h.reloadSession("reload");
      if (operation === "create_goal") {
        if (timing === "before") await write();
        else assert.equal(h.snapshot().goal!.goalId, goalId);
      } else if (operation === "amend_goal") {
        await h.runTool(operation, timing === "after" ? { amendment_id: receipt.amendment_id } : { amendment });
        assert.equal(h.snapshot().goal!.objective.split(amendment).length - 1, 1);
      } else if (operation === "resume_goal") {
        await h.emit("input", { type: "input", source: "interactive", text: "Продолжи после сверки файла" });
        await h.runTool(operation, {});
        assert.equal(h.snapshot().goal!.status, "active");
      } else {
        if (timing === "before") await h.runTool("report_goal_progress", { ...working, status: "verifying", verification: "Файл повторно сверен." });
        await h.runTool(operation, { status: "complete" });
        assert.equal(h.snapshot().goal!.status, "complete");
      }
      const persisted = reconstructGoal(SessionManager.open(sessionFile).getBranch()).goal;
      assert.ok(persisted);
      if (operation === "amend_goal") assert.equal(persisted.objective.split(amendment).length - 1, 1);
      else assert.equal(persisted.status, operation === "update_goal" ? "complete" : "active");
    });
  }
}
