import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGoalArtifacts } from "../../src/goal/goal-artifacts.js";
import { createGoalProjections, readGoalHistory } from "../../src/goal/goal-projections.js";
import { isGoalProjectionEvent, type GoalProjectionEvent } from "../../src/goal/goal-projection-reducer.js";
import { createThreadGoal } from "../../src/goal/state.js";
import { assistantMessage, createRuntimeHarness } from "../support/runtime-harness.js";

type Receipt = { operation: string; applied: boolean | null; stage: string; retryable: boolean; goalId: string; noteId: string; eventId: string; remediation: string };
type Operation = "decision" | "paper_cut" | "update";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "goal-canonical-note-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage({ role: "user", content: "Offline recovery fixture", timestamp: Date.now() });
  manager.appendMessage({ ...assistantMessage("stop", { input: 0, output: 0 }), role: "assistant" });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  const goal = createThreadGoal("Проверить восстановление записи заметки");
  let failAfterWrite = false;
  const pi = { appendEntry(customType: string, data: unknown) {
    manager.appendCustomEntry(customType, data);
    if (failAfterWrite) throw new Error("canonical acknowledgement lost");
  } };
  const artifacts = createGoalArtifacts({ ...pi, getCurrentGoal: () => goal });
  const ctx = { cwd, sessionManager: { getBranch: () => manager.getBranch() } };
  const createProjection = () => createGoalProjections(pi, artifacts, () => goal);
  const projections = createProjection();
  await projections.initialize(goal, ctx);
  return { cwd, goal, projections, ctx, sessionFile, createProjection,
    manager: () => manager,
    failAfterWrite(value: boolean) { failAfterWrite = value; },
    reopen() { manager = SessionManager.open(sessionFile); },
  };
}

function noteEvents(manager: SessionManager, kind: GoalProjectionEvent["kind"]) {
  return manager.getBranch().flatMap(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === kind ? [entry.data] : []);
}

const cut = { title: "Повтор записи", impact: "Повтор может создать лишнюю заметку.", severity: "medium" as const, createdAt: 1 };
const decision = { title: "Решение о проверке", decision: "Сначала сверить сохранённую ветку.", rationale: "Память процесса не доказывает запись файла.", createdAt: 1 };

for (const operation of ["decision", "paper_cut", "update"] as const) {
  for (const timing of ["before", "after"] as const) {
    test(`canonical ${operation} failure ${timing} persistence has an address and reconciles the real SDK file`, async t => {
      const f = await fixture(t);
      let cutId: string | undefined;
      if (operation === "update") {
        const saved = await f.projections.recordPaperCut(f.goal, cut, f.ctx, "seed-cut");
        cutId = saved.entryId;
        assert.ok(cutId);
      }
      const write = (p: ReturnType<typeof createGoalProjections>, op: Operation) => op === "decision"
        ? p.recordDecision(f.goal, decision, f.ctx, "uncertain-call")
        : op === "paper_cut" ? p.recordPaperCut(f.goal, cut, f.ctx, "uncertain-call")
        : p.updatePaperCut(f.goal, { id: cutId!, expectedRevision: 0, status: "resolved", resolution: "Причина повтора устранена." }, f.ctx, "uncertain-call");
      if (timing === "before") {
        await rename(f.sessionFile, f.sessionFile + ".saved");
        await mkdir(f.sessionFile);
      } else f.failAfterWrite(true);
      let receipt: Receipt | undefined;
      let raw = "";
      try { await write(f.projections, operation); }
      catch (error) { raw = error instanceof Error ? error.message : String(error); }
      finally {
        f.failAfterWrite(false);
        if (timing === "before") {
          await rm(f.sessionFile, { recursive: true });
          await rename(f.sessionFile + ".saved", f.sessionFile);
        }
      }
      assert.match(raw, /"applied":null/, "a canonical write failure must report uncertainty instead of a raw filesystem error");
      receipt = JSON.parse(raw) as Receipt;
      assert.equal(receipt.operation, "record_goal_note");
      assert.equal(receipt.applied, null);
      assert.equal(receipt.stage, "canonical");
      assert.equal(receipt.retryable, false);
      assert.equal(receipt.goalId, f.goal.goalId);
      assert.equal(typeof receipt.noteId, "string");
      assert.equal(typeof receipt.eventId, "string");
      assert.match(receipt.remediation, /saved.*session|session.*file/i);
      assert.match(receipt.remediation, /memory/i);
      const eventKind = operation === "decision" ? "decision_recorded" : operation === "paper_cut" ? "paper_cut_recorded" : "paper_cut_updated";
      assert.equal(noteEvents(f.manager(), eventKind).length, timing === "after" ? 1 : 0, "Pi 1.5 откатывает из памяти незаписанную запись, потерянное подтверждение — нет");
      f.reopen();
      assert.equal(noteEvents(f.manager(), eventKind).length, timing === "after" ? 1 : 0, "only reopening the real file establishes persistence");
      const restored = f.createProjection();
      await restored.initialize(f.goal, f.ctx);
      if (timing === "before") await write(restored, operation);
      else if (operation === "update") await write(restored, operation);
      else await restored.repairNote(f.goal, operation, receipt.noteId, f.ctx);
      assert.equal(noteEvents(f.manager(), eventKind).length, 1, "reconciliation and repair must not duplicate the note or closure");
      const event = noteEvents(f.manager(), eventKind)[0]!;
      assert.equal(event.idempotencyKey, receipt.eventId);
      if (event.kind === "decision_recorded" || event.kind === "paper_cut_recorded") assert.equal(event.entry.id, receipt.noteId);
      else if (event.kind === "paper_cut_updated") assert.equal(event.id, receipt.noteId);
      const history = readGoalHistory(f.manager().getBranch(), f.goal.goalId, { event_id: receipt.eventId });
      assert.equal(history.eventId, receipt.eventId);
    });
  }
}

for (const timing of ["before", "after"] as const) {
  test(`canonical plan failure ${timing} persistence uses the same saved-branch recovery`, async t => {
    const f = await fixture(t);
    const plan = { outcome: "Проверить сохранение плана.", doneWhen: "Запись восстановлена.", summary: "Проверяю границу сохранения.", items: [{ id: "check", title: "Проверить запись", status: "planned" as const, source: "agent" as const }], activeDecisionIds: [], nextItemId: "check" };
    if (timing === "before") { await rename(f.sessionFile, f.sessionFile + ".saved"); await mkdir(f.sessionFile); }
    else f.failAfterWrite(true);
    let raw = "";
    try { await f.projections.updateWork(f.goal.goalId, plan, 0, f.ctx, "uncertain-plan"); }
    catch (error) { raw = error instanceof Error ? error.message : String(error); }
    finally {
      f.failAfterWrite(false);
      if (timing === "before") { await rm(f.sessionFile, { recursive: true }); await rename(f.sessionFile + ".saved", f.sessionFile); }
    }
    const receipt = JSON.parse(raw) as Receipt;
    assert.equal(receipt.operation, "update_goal_work");
    assert.equal(receipt.applied, null);
    assert.equal(receipt.retryable, false);
    f.reopen();
    const restored = f.createProjection();
    await restored.initialize(f.goal, f.ctx);
    await restored.updateWork(f.goal.goalId, plan, restored.current()!.workRevision, f.ctx, "reconciled-plan");
    assert.equal(noteEvents(f.manager(), "work_state_updated").length, 1);
    assert.equal(restored.current()!.workRevision, 1);
  });
}

test("the public note tool preserves the unknown-commit receipt", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-note-api-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const h = createRuntimeHarness({ cwd });
  await h.runTool("create_goal", { objective: "Проверить ответ публичного инструмента." });
  const push = h.entries.push;
  h.entries.push = function (...entries) {
    if (entries.some(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === "paper_cut_recorded")) throw new Error("canonical write unavailable");
    return push.apply(this, entries);
  };
  try {
    await assert.rejects(() => h.runTool("record_goal_note", { kind: "paper_cut", title: cut.title, impact: cut.impact, severity: cut.severity }), error => {
      assert.ok(error instanceof Error);
      const receipt = JSON.parse(error.message) as Receipt;
      assert.equal(receipt.applied, null);
      assert.equal(receipt.operation, "record_goal_note");
      assert.equal(typeof receipt.noteId, "string");
      assert.equal(typeof receipt.eventId, "string");
      return true;
    });
  } finally { h.entries.push = push; }
  // This fixture retains only acknowledged entries; reopen that saved branch.
  await h.reloadSession("reload");
  await h.runCommand("clear");
});