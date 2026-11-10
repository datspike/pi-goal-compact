import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import goalExtension from "../src/index.js";
import { RECORD } from "../src/records.js";
import { CUSTOM_ENTRY_TYPE } from "../src/goal/types.js";
import { isGoalProjectionEvent } from "../src/goal/goal-projection-reducer.js";
import { loadedGoalRuntimeRevision } from "../src/goal/goal-runtime-revision.js";

function goalIdFromToolResult(result: unknown): string {
  assert.ok(result && typeof result === "object");
  const details = (result as { details?: unknown }).details;
  assert.ok(details && typeof details === "object");
  const goal = (details as { goal?: unknown }).goal;
  assert.ok(goal && typeof goal === "object");
  const goalId = (goal as { goalId?: unknown }).goalId;
  if (typeof goalId !== "string") {
    assert.fail("Expected tool result goal id.");
  }
  return goalId;
}

// Сжатие с `willRetry: true` повторяет запрос в том же прогоне Pi 1.5, поэтому запасного
// продолжения нет, даже если повтор не пришёл (решение `D-a3330bcc22bfb48c`).
test("настоящий SDK Pi сохраняет ревизию создания цели и не будит цель после сжатия с повтором", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "goal-sdk-revision-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const agentDir = join(cwd, "agent");
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  sessionManager.appendMessage({ role: "user", content: "Offline lifecycle fixture", timestamp: Date.now() });
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noContextFiles: true,
    noExtensions: true,
    extensionFactories: [goalExtension],
  });
  await loader.reload();

  const model = {
    provider: "sdk-smoke",
    id: "mini",
    name: "SDK Smoke",
    api: "sdk-smoke-api",
    baseUrl: "http://localhost",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000,
    maxTokens: 100,
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    noTools: "builtin",
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });

  try {
    const runner = session.extensionRunner;
    const toolContext = {
      ...runner.createContext(),
      tools: [],
      executeTool: async () => { throw new Error("nested tool execution is not implemented in this smoke test."); },
    };
    const recordGoalNote = runner.getToolDefinition("record_goal_note");
    assert.ok(recordGoalNote);
    const recordGoalNoteSchema = recordGoalNote.parameters as { type?: unknown; anyOf?: unknown; required?: unknown };
    assert.equal(recordGoalNoteSchema.type, "object");
    assert.equal(recordGoalNoteSchema.anyOf, undefined);
    assert.deepEqual(recordGoalNoteSchema.required, ["kind"]);
    const reportGoalProgress = runner.getToolDefinition("report_goal_progress");
    assert.ok(reportGoalProgress);
    const declaredReportTool = session.agent.state.tools.find((tool) => tool.name === "report_goal_progress");
    assert.ok(declaredReportTool, "The progress tool must be declared before its first call.");
    assert.equal(declaredReportTool.description, reportGoalProgress.description);
    assert.match(declaredReportTool.description, /Пиши прозу по-русски/);
    assert.match(declaredReportTool.description, /не длиннее 700 знаков/);
    assert.match(declaredReportTool.description, /без изменений во встроенном или блочном коде/);
    assert.match(declaredReportTool.description, /Независимые факты разделяй пустыми строками/);
    const updateGoal = runner.getToolDefinition("update_goal");
    assert.ok(updateGoal);
    const declaredUpdateTool = session.agent.state.tools.find((tool) => tool.name === "update_goal");
    assert.ok(declaredUpdateTool, "The update tool must be declared before its first call.");
    assert.equal(declaredUpdateTool.description, updateGoal.description);
    assert.match(updateGoal.description, /согласованный результат и обязательные доказательства/);
    assert.match(updateGoal.description, /ни затраченные усилия, ни пометка риска не заменяют обязательное доказательство/);
    assert.match(updateGoal.description, /status=verifying.*дождись успеха перед отдельным вызовом закрытия/);
    assert.match(updateGoal.description, /goal_completed со статусом working недостаточно/);
    const reportGoalProgressSchema = reportGoalProgress.parameters as { type?: unknown; anyOf?: unknown };
    assert.equal(reportGoalProgressSchema.type, "object");
    assert.equal(reportGoalProgressSchema.anyOf, undefined);
    const createGoal = runner.getToolDefinition("create_goal");
    assert.ok(createGoal);
    const result = await createGoal.execute(
      "tool-call",
      { objective: "ship it", agreement: { owner_wants: "Выпустить сборку.", done_when: "Сборка выпущена." }, self_decided: [] },
      undefined,
      undefined,
      toolContext,
    );
    const goalId = goalIdFromToolResult(result);
    const sessionFile = sessionManager.getSessionFile();
    assert.ok(sessionFile);
    const saved = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const creation = saved.find((entry) => entry.type === "custom" && entry.customType === CUSTOM_ENTRY_TYPE && entry.data?.goal?.goalId === goalId);
    assert.ok(creation, "The actual SDK appendEntry path must persist the creation event.");
    assert.deepEqual(creation.data.extensionRevision, loadedGoalRuntimeRevision);
    assert.match(creation.data.extensionRevision.gitCommit, /^[a-f0-9]{40}$/);
    assert.equal(runner.getToolDefinition("goal_artifact"), undefined, "скрытый инструмент снят (К1)");
    await assert.rejects(() => recordGoalNote.execute("missing-title", { kind: "decision", decision: "Выбор.", rationale: "Причина." }, undefined, undefined, toolContext), /title/);
    const recorded = await recordGoalNote.execute("record-cut", { kind: "paper_cut", title: "Проверка повтора", impact: "Повтор не должен создавать вторую запись.", severity: "low" }, undefined, undefined, toolContext);
    const noteId = (recorded.details as { noteId: string }).noteId;
    assert.equal(typeof noteId, "string");
    const closed = await recordGoalNote.execute("close-cut", { kind: "paper_cut", action: "update", note_id: noteId, expected_revision: 0, status: "wont_fix", resolution: "Риск принят для изолированной проверки протокола." }, undefined, undefined, toolContext);
    assert.equal((closed.details as { noteRevision: number }).noteRevision, 1);
    const reopened = SessionManager.open(sessionFile);
    const updates = reopened.getEntries().filter(entry => entry.type === "custom" && isGoalProjectionEvent(entry.data) && entry.data.kind === "paper_cut_updated");
    assert.equal(updates.length, 1, "the real SDK session file contains the update event");
    const getGoal = runner.getToolDefinition("get_goal")!;
    const current = await getGoal.execute("read-cuts", {}, undefined, undefined, toolContext);
    const cuts = (current.details as { paperCuts: Array<{ id: string; revision: number; status: string }> }).paperCuts;
    assert.equal(cuts.find(cut => cut.id === noteId)?.status, "wont_fix");
    assert.equal(cuts.find(cut => cut.id === noteId)?.revision, 1);
    const amendGoal = runner.getToolDefinition("amend_goal");
    assert.ok(amendGoal);
    await runner.emitInput("Согласен с изменением цели.", undefined, "interactive");
    const amended = await amendGoal.execute(
      "amend-tool-call",
      { amendment: "Approved addition.", agreement: { owner_wants: "Выпустить сборку с дополнением.", done_when: "Сборка выпущена." } },
      undefined,
      undefined,
      toolContext,
    );
    assert.equal(goalIdFromToolResult(amended), goalId);
    assert.match(JSON.stringify(amended), /ship it/);
    assert.match(JSON.stringify(amended), /Approved amendment/);

    await runner.emit({
      type: "session_compact",
      compactionEntry: {
        type: "compaction",
        id: "compaction-entry",
        parentId: null,
        timestamp: new Date().toISOString(),
        summary: "compact summary",
        firstKeptEntryId: "entry-1",
        tokensBefore: 100,
      },
      fromExtension: false,
      reason: "manual",
      willRetry: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const wakeups = session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && (entry.customType === RECORD.ticket || entry.customType === CUSTOM_ENTRY_TYPE));
    assert.deepEqual(wakeups, [], "повтор идёт в том же прогоне; расширение не добавляет своё продолжение");
  } finally {
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
    }
  }
});
