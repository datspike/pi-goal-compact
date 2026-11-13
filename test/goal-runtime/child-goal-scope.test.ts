import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createExpandedRuntimeHarness as harness, goalTickets } from "../support/runtime-harness.js";

const root = mkdtempSync(join(tmpdir(), "goal-child-scope-"));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
type Harness = ReturnType<typeof harness>;

function child(entries: SessionEntry[], parent?: string, id = "child", isChild = true): Harness {
  const prior = process.env.PI_SUBAGENT_CHILD;
  if (isChild) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  let h: Harness;
  try { h = harness(); }
  finally {
    if (prior === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = prior;
  }
  h.entries.push(...structuredClone(entries));
  h.commandContext.sessionManager.getHeader = () => ({
    type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root,
    ...(parent ? { parentSession: parent } : {}),
  });
  h.commandContext.sessionManager.getSessionId = () => id;
  return h;
}
function save(entries: SessionEntry[], id = "parent"): string {
  const file = join(root, `source-${++sequence}.jsonl`);
  // Без завершающего LF: читающий код не должен даже «чинить» исходный файл.
  writeFileSync(file, [{ type: "session", version: 3, id, cwd: root }, ...entries].map(e => JSON.stringify(e)).join("\n"));
  return file;
}
async function parent() {
  const h = harness();
  await h.runCommand("Завершить исходную задачу");
  await h.waitForGoalProjection();
  return { entries: structuredClone(h.entries), goalId: h.snapshot().goal!.goalId };
}
async function start(h: Harness, reason = "startup") {
  await h.emit("session_start", { type: "session_start", reason });
  await h.waitForGoalProjection();
}
async function goal(h: Harness) {
  const r = await h.runTool("get_goal", {}) as { details: { goal: { goalId: string } | null } };
  return r.details.goal;
}

test("native fork не продолжает родительскую Goal и не меняет исходный журнал", async () => {
  const p = await parent();
  const file = save(p.entries);
  const before = readFileSync(file);
  const h = child(p.entries, file);
  await start(h);
  assert.equal(await goal(h), null);
  assert.equal(goalTickets(h).length, 0);
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(h.entries.slice(0, p.entries.length), p.entries);
  h.sentMessages.length = 0;
  await h.emit("agent_settled", { type: "agent_settled", outcome: "completed" });
  assert.equal(goalTickets(h).length, 0);
});

test("интерактивный fork продолжает обычную цель", async () => {
  const p = await parent();
  const h = child(p.entries, save(p.entries), "interactive", false);
  await start(h);
  assert.equal((await goal(h))?.goalId, p.goalId);
  assert.equal(goalTickets(h).length, 1);
});

test("свежий ребёнок без родительского журнала сохраняет собственную цель", async () => {
  const p = await parent();
  const h = child(p.entries);
  await start(h);
  assert.equal((await goal(h))?.goalId, p.goalId);
});

test("ребёнок может создать свою цель, а повторное открытие не требует родителя", async () => {
  const p = await parent();
  const file = save(p.entries);
  const h = child(p.entries, file);
  await start(h);
  await h.runCommand("Завершить дочернюю задачу");
  await h.waitForGoalProjection();
  const ownId = (await goal(h))!.goalId;
  assert.notEqual(ownId, p.goalId);
  rmSync(file);
  const reopened = child(h.entries, file);
  await start(reopened, "resume");
  assert.equal((await goal(reopened))?.goalId, ownId);
  assert.equal(goalTickets(reopened).length, 1);
});

test("повторное открытие форка без собственной цели не оживляет родительскую", async () => {
  const p = await parent();
  const file = save(p.entries);
  const h = child(p.entries, file);
  await start(h);
  rmSync(file);
  const reopened = child(h.entries, file);
  await start(reopened, "reload");
  assert.equal(await goal(reopened), null);
  assert.equal(goalTickets(reopened).length, 0);
});

test("собственная цель старого ребёнка до установки границы сохраняется", async () => {
  const p = await parent();
  const local = await parent();
  const localEntries = local.entries.map(e => ({ ...e, id: `local-${e.id}`, parentId: e.parentId ? `local-${e.parentId}` : null }));
  const h = child([...p.entries, ...localEntries], save(p.entries));
  await start(h);
  assert.equal((await goal(h))?.goalId, local.goalId);
  assert.equal(goalTickets(h).length, 1);
});

test("вложенный fork не наследует собственную цель предыдущего ребёнка", async () => {
  const p = await parent();
  const h = child(p.entries, save(p.entries));
  await start(h);
  await h.runCommand("Выполнить первую дочернюю задачу");
  await h.waitForGoalProjection();
  const nested = child(h.entries, save(h.entries, "child"), "nested");
  await start(nested);
  assert.equal(await goal(nested), null);
  assert.equal(goalTickets(nested).length, 0);
});

test("недоступный родитель без сохранённой границы не заменяется догадкой", async () => {
  const p = await parent();
  const h = child(p.entries, join(root, "missing.jsonl"));
  await assert.rejects(start(h), /границ|boundary|ENOENT/);
});
