import assert from "node:assert/strict";
import test from "node:test";
import { createExpandedRuntimeHarness as createRuntimeHarness } from "../support/runtime-harness.js";
import { renderDecisions } from "../../src/goal/goal-projection-renderer.js";
import type { GoalDecisionEntry } from "../../src/goal/goal-projection-state.js";

const progress = {
  action: "publish", status: "working", phase: "Проверяю восстановление",
  summary: "Проверяю сохранение условий. Затем проверю документы.",
  changed: "Начата проверка сохранения условий.", nextStep: "Проверить документы.",
};

async function projectionFailure(harness: ReturnType<typeof createRuntimeHarness>, amendment: string) {
  let payload: Record<string, unknown> | undefined;
  await assert.rejects(() => harness.runTool("amend_goal", { amendment }), (error: unknown) => {
    assert.ok(error instanceof Error);
    payload = JSON.parse(error.message);
    return true;
  });
  assert.equal(payload?.applied, true);
  assert.match(String(payload?.amendment_id), /^amendment-[a-f0-9]{64}$/);
  assert.match(String(payload?.remediation), /amendment_id/);
  return String(payload?.amendment_id);
}

test("approved long amendment is rendered verbatim without a language-repair loop", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Проверить длинные условия");
  await harness.runTool("report_goal_progress", progress);
  const amendment = "Согласованное условие сохраняется без изменения смысла. ".repeat(18) + "```literal```";
  const result = await harness.runTool("amend_goal", { amendment }) as { details: { amendment_id: string } };
  assert.match(result.details.amendment_id, /^amendment-[a-f0-9]{64}$/);
  const objective = harness.snapshot().goal!.objective;
  assert.equal(objective.split(amendment).length - 1, 1);
  const state = await harness.runTool("get_goal", {}) as { details: { projection: { repairPending: boolean } } };
  assert.equal(state.details.projection.repairPending, false);
  const entries = harness.entries.filter((r) => r.type === "custom").map((r) => r.data as { kind?: string; entry?: GoalDecisionEntry })
    .filter((r) => r.kind === "decision_recorded").map((r) => r.entry!);
  const decisions = renderDecisions(entries);
  assert.ok(decisions.includes(amendment));
  assert.ok(decisions.includes("````text"));
});

test("repair by amendment id survives reload and cannot append a reworded amendment", async () => {
  const harness = createRuntimeHarness({ failAmendmentProjectionPersists: 1 });
  await harness.runCommand("Проверить отказ записи документа");
  await harness.runTool("report_goal_progress", progress);
  const amendment = "Первое согласованное условие. Второе согласованное условие.";
  const id = await projectionFailure(harness, amendment);
  const objective = harness.snapshot().goal!.objective;
  await harness.reloadSession("reload");
  const result = await harness.runTool("amend_goal", { amendment_id: id }) as { details: { amendment_id: string } };
  assert.equal(result.details.amendment_id, id);
  assert.equal(harness.snapshot().goal!.objective, objective);
  await harness.runTool("report_goal_progress", { ...progress, changed: "Документы проверены, продолжаю работу." });
  await harness.runTool("amend_goal", { amendment_id: id });
  assert.equal(harness.snapshot().goal!.objective, objective);
  const decisions = harness.entries.filter((r) => r.type === "custom")
    .map((r) => r.data as { kind?: string }).filter((r) => r.kind === "decision_recorded");
  assert.equal(decisions.length, 1);
  const before = harness.entries.length;
  await assert.rejects(() => harness.runTool("amend_goal", {
    amendment_id: id, amendment: amendment.replace(". ", ".\n\n"),
  }), /exactly one/);
  assert.equal(harness.entries.length, before);
});

test("unknown and foreign amendment ids never change the goal", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Первая цель");
  const result = await harness.runTool("amend_goal", { amendment: "Проверить первое условие." }) as { details: { amendment_id: string } };
  await harness.runCommand("Вторая цель");
  const objective = harness.snapshot().goal!.objective;
  await assert.rejects(() => harness.runTool("amend_goal", { amendment_id: result.details.amendment_id }), /not found/);
  await assert.rejects(() => harness.runTool("amend_goal", {}), /exactly one/);
  assert.equal(harness.snapshot().goal!.objective, objective);
});

test("a projection repair resumes a paused goal only after the documents are repaired", async () => {
  const harness = createRuntimeHarness({ failAmendmentProjectionPersists: 1 });
  await harness.runCommand("Проверить восстановление паузы");
  await harness.runTool("report_goal_progress", progress);
  await harness.runSlashCommand("gp");
  const id = await projectionFailure(harness, "Сохранить ограничение при восстановлении.");
  assert.equal(harness.snapshot().goal!.status, "paused");
  const sent = harness.sentMessages.length;
  await harness.reloadSession("reload");
  await harness.runTool("amend_goal", { amendment_id: id });
  assert.equal(harness.snapshot().goal!.status, "active");
  assert.equal(harness.sentMessages.length, sent);
});

test("recovery can finish a rejected amendment decision with an old pending repair", async () => {
  const harness = createRuntimeHarness();
  await harness.runCommand("Восстановить прежнюю диагностику решения");
  await harness.runTool("report_goal_progress", progress);
  const result = await harness.runTool("amend_goal", { amendment: "Сохранить одобренные условия." }) as { details: { amendment_id: string } };
  const goal = harness.snapshot().goal!;
  harness.entries.push({
    type: "custom", id: "old-decision-repair", parentId: null, timestamp: new Date().toISOString(),
    customType: "goal-compact-projection",
    data: { kind: "language_repair_required", idempotencyKey: "old-decision-repair", goalId: goal.goalId,
      repair: { artifact: "DECISIONS", fields: ["decision"], findings: ["абзац слишком длинный; разделите независимые мысли"] } },
  });
  await harness.reloadSession("reload");
  const before = await harness.runTool("get_goal", {}) as { details: { projection: { repairPending: boolean } } };
  assert.equal(before.details.projection.repairPending, true);
  await harness.runTool("amend_goal", { amendment_id: result.details.amendment_id });
  const after = await harness.runTool("get_goal", {}) as { details: { projection: { repairPending: boolean } } };
  assert.equal(after.details.projection.repairPending, false);
  assert.equal(harness.snapshot().goal!.objective, goal.objective);
});

test("amendment recovery guidance matches the registered root object schema", () => {
  const harness = createRuntimeHarness();
  const metadata = harness.getToolMetadata("amend_goal")!;
  const schema = metadata.parameters as { type: string; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.properties.amendment);
  assert.ok(schema.properties.amendment_id);
  assert.match(metadata.promptSnippet!, /amendment_id/);
});
