import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRuntimeHarness, useHarnessLanguage } from "../support/runtime-harness.js";
import type { GoalWorkingState } from "../../src/goal/format.js";
import { isGoalProjectionEvent, type GoalProjectionEvent } from "../../src/goal/goal-projection-reducer.js";

useHarnessLanguage("en");

type NoteReceipt = { noteId: string; noteRevision: number; applied: boolean; stage: string; retryable: boolean };

async function fixture() {
  const harness = createRuntimeHarness();
  await harness.runTool("create_goal", { objective: "Проверить полный путь отложенного недочёта." });
  await harness.runTool("report_goal_progress", { action: "publish", eventKind: "goal_started", status: "working", phase: "Проверяю недочёты", summary: "Цель записана. Проверяю полный путь недочёта.", changed: "Исходное состояние сохранено.", nextStep: "Проверить закрытие недочёта." });
  return harness;
}
async function full(h: ReturnType<typeof createRuntimeHarness>) {
  const state = (await h.runTool("get_goal", {}) as { details: GoalWorkingState }).details;
  assert.ok(state.goal);
  assert.ok(state.paperCuts);
  return { ...state, goal: state.goal, paperCuts: state.paperCuts };
}
function records<K extends GoalProjectionEvent["kind"]>(h: ReturnType<typeof createRuntimeHarness>, kind: K) {
  return h.entries.map(entry => entry.type === "custom" ? entry.data : undefined).filter((data): data is Extract<GoalProjectionEvent, { kind: K }> => isGoalProjectionEvent(data) && data.kind === kind);
}
const input = { kind: "paper_cut", title: "Повтор записи", impact: "Повтор может создать лишнюю запись.", severity: "medium" };

test("a paper cut has an addressable id and revision, closes through the public API and survives reload", async () => {
  const h = await fixture();
  const saved = (await h.runTool("record_goal_note", input) as { details: NoteReceipt }).details;
  assert.equal(typeof saved.noteId, "string");
  const before = await full(h);
  assert.equal(before.paperCuts[0]!.id, saved.noteId);
  assert.equal(before.paperCuts[0]!.revision, 0);
  const path = fileURLToPath(before.artifactRefs.find(r => r.artifact === "GOAL")!.path);
  assert.match(await readFile(path, "utf8"), /Повтор записи/);
  const args = { kind: "paper_cut", action: "update", note_id: saved.noteId, expected_revision: 0, status: "resolved", resolution: "Повтор закрыт адресной проверкой." };
  const closed = (await h.runTool("record_goal_note", args) as { details: NoteReceipt }).details;
  assert.equal(closed.noteId, saved.noteId);
  assert.equal(closed.noteRevision, 1);
  assert.equal(closed.applied, true);
  assert.equal(closed.stage, "complete");
  assert.doesNotMatch(await readFile(path, "utf8"), /### Повтор записи/);
  const first = records(h, "paper_cut_recorded");
  assert.equal(first.length, 1);
  assert.equal(first[0]!.entry.status, "open");
  assert.equal(records(h, "paper_cut_updated").length, 1);
  await h.runTool("record_goal_note", args);
  assert.equal(records(h, "paper_cut_updated").length, 1, "an applied retry must not append again");
  await h.reloadSession("reload");
  const reloaded = await full(h);
  assert.equal(reloaded.paperCuts[0]!.status, "resolved");
  assert.equal(reloaded.paperCuts[0]!.revision, 1);
  assert.equal(reloaded.paperCuts[0]!.resolution, args.resolution);
  const original = (await h.runTool("get_goal", { view: "history", event_id: saved.noteId }) as { details: unknown }).details;
  assert.match(JSON.stringify(original), /Повтор записи/);
  assert.match(JSON.stringify(original), /open/);
  const status = (await h.runTool("get_goal", { view: "status" }) as { details: Partial<GoalWorkingState> }).details;
  assert.equal(status.paperCuts, undefined);
});

test("closing a cut requires a reason and a current note revision, without amending the Goal", async () => {
  const h = await fixture();
  const id = (await h.runTool("record_goal_note", input) as { details: NoteReceipt }).details.noteId;
  const objective = (await full(h)).goal.objective;
  await assert.rejects(h.runTool("record_goal_note", { kind: "paper_cut", action: "update", note_id: id, expected_revision: 0, status: "wont_fix" }), /resolution/);
  await assert.rejects(h.runTool("record_goal_note", { kind: "paper_cut", action: "update", noteId: id, expected_revision: 0, status: "wont_fix", resolution: "Отложено." }), /note_id|Unexpected/);
  await h.runTool("record_goal_note", { kind: "paper_cut", action: "update", note_id: id, expected_revision: 0, status: "wont_fix", resolution: "Риск принят: редкий сценарий не блокирует согласованный результат." });
  await assert.rejects(h.runTool("record_goal_note", { kind: "paper_cut", action: "update", note_id: id, expected_revision: 0, status: "resolved", resolution: "Устаревшее решение." }), /[Ss]tale.*note|revision/);
  const state = await full(h);
  assert.equal(state.goal.objective, objective);
  assert.equal(state.goal.status, "active");
  assert.equal(state.paperCuts[0]!.status, "wont_fix");
  assert.equal(records(h, "paper_cut_updated").length, 1);
});

test("a note committed before a document failure is repairable by id without a duplicate", async () => {
  const h = await fixture();
  const before = await full(h);
  const path = fileURLToPath(before.artifactRefs.find(r => r.artifact === "GOAL")!.path);
  await rename(path, path + ".saved");
  await mkdir(path);
  let failure: NoteReceipt | undefined;
  try { await h.runTool("record_goal_note", input); }
  catch (error) { failure = JSON.parse((error as Error).message) as NoteReceipt; }
  finally { await rm(path, { recursive: true }); await rename(path + ".saved", path); }
  assert.ok(failure);
  assert.equal(failure.applied, true);
  assert.equal(failure.stage, "projection");
  assert.equal(failure.retryable, true);
  assert.equal(typeof failure.noteId, "string");
  const repaired = (await h.runTool("record_goal_note", { kind: "paper_cut", action: "repair", note_id: failure.noteId }) as { details: NoteReceipt }).details;
  assert.equal(repaired.stage, "complete");
  assert.equal(records(h, "paper_cut_recorded").length, 1);
  assert.match(await readFile(path, "utf8"), /Повтор записи/);
});
