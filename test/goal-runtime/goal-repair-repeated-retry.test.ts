import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExpandedRuntimeHarness, useHarnessLanguage } from "../support/runtime-harness.js";

useHarnessLanguage("en");

test("a decision note with language findings is recorded at once and leaves resume open", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "goal-clean-retry-"));
  try {
    const h = createExpandedRuntimeHarness();
    h.commandContext.cwd = cwd;
    await h.runCommand("Проверить восстановление служебных записей");
    await h.runTool("report_goal_progress", {
      action: "publish", status: "working", phase: "Проверяю восстановление",
      summary: "Проверяю сохранение условий. Затем проверю документы.",
      changed: "Начата проверка сохранения условий.", nextStep: "Проверить документы.",
    });
    const originalContract = h.snapshot().goal!.objective;
    for (let n = 1; n <= 2; n++) {
      await h.runTool("record_goal_note", {
        kind: "decision", title: `Проверка ${n}`,
        decision: "Подготовка + проверка.", rationale: "Сохраняем исходные ограничения.",
      });
      const state = await h.runTool("get_goal", {}) as { details: { projection: { fresh: boolean } } };
      assert.equal(state.details.projection.fresh, true, `note ${n}`);
    }
    const decisions = h.entries.filter((r) => r.type === "custom").map((r) => r.data as { kind?: string }).filter((r) => r.kind === "decision_recorded");
    assert.equal(decisions.length, 2);
    await h.runSlashCommand("gp");
    await h.emit("input", { type: "input", source: "interactive", text: "продолжай" });
    const sentBefore = [h.sentMessages.length, h.sentUserMessages.length];
    await h.runTool("resume_goal", {});
    assert.equal(h.snapshot().goal!.status, "active");
    assert.equal(h.snapshot().goal!.objective, originalContract);
    assert.deepEqual([h.sentMessages.length, h.sentUserMessages.length], sentBefore);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});