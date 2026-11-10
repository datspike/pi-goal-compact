import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeHarness } from "../support/runtime-harness.js";
import { compactContinuationPrompt } from "../../src/goal/prompts.js";
import { createGoalProjectionState, goalPreservedContext } from "../../src/goal/goal-projection-state.js";
import { renderGoalDocument } from "../../src/goal/goal-projection-renderer.js";
import { createGoal } from "../../src/goal/state.js";
import type { GoalWorkState } from "../../src/goal/goal-work-state.js";

function definitions() {
  const harness = createRuntimeHarness();
  return ["resume_goal", "get_goal", "update_goal_work", "create_goal", "amend_goal", "load_goal_language_guide", "record_goal_note", "report_goal_progress", "update_goal"].map(name => {
    const metadata = harness.getToolMetadata(name);
    assert.ok(metadata);
    return { name, ...metadata };
  });
}

function snapshot(text: string): Record<string, unknown> {
  const encoded = text.match(/<untrusted_goal_work_snapshot>\n([^]*?)\n<\/untrusted_goal_work_snapshot>/)?.[1];
  assert.ok(encoded);
  return JSON.parse(encoded.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
}

test("read-only Goal context excludes mutation workflows in the actual SDK assembly", async () => {
  const tools = definitions();
  const sdk = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
  const sections = sdk.buildSystemPromptSections({ cwd: "/offline-goal-context", selectedTools: ["get_goal"], contextFiles: [], skills: [],
    toolSnippets: Object.fromEntries(tools.map(item => [item.name, item.promptSnippet])),
    toolGuidelines: Object.fromEntries(tools.map(item => [item.name, item.promptGuidelines])),
  });
  assert.doesNotMatch(sections.rules, /goal_started|replace_existing|amendment_id|eventKind deltas/);
  assert.match(sections.rules, /history/);
  assert.ok(sections.rules.length < 2000, `read-only rules: ${sections.rules.length}`);
});

test("однострочные подсказки инструментов, удалённого писателя документа нет", () => {
  assert.equal(createRuntimeHarness().getToolMetadata("goal_artifact"), undefined);
  for (const tool of definitions()) {
    assert.ok(tool.promptSnippet && tool.promptSnippet.length <= 180, `${tool.name} snippet`);
    assert.doesNotMatch(tool.promptSnippet, /[\r\n]/);
  }
});

test("the status choice carries the local-blocker rule and the paragraph limit is discoverable", () => {
  const tool = definitions().find(tool => tool.name === "report_goal_progress")!;
  const status = (tool.parameters as { properties: { status: { description: string } } }).properties.status.description;
  assert.match(status, /у всей цели нет безопасного следующего действия/);
  assert.match(status, /независимую работу, даже если один пункт заблокирован/);
  assert.match(tool.description, /700/);
});

test("a selected item outside the excerpt remains actionable and truncation is explicit", () => {
  const work: GoalWorkState = { outcome: "Проверить результат", doneWhen: "Условие готовности", summary: "План сохранён", activeDecisionIds: [],
    items: Array.from({ length: 9 }, (_, i) => ({ id: `item-${i}`, title: `Проверка ${i}`, status: "planned" as const, source: "user" as const })), nextItemId: "item-8" };
  const goal = createGoal(null, "Проверить результат", null).goal!;
  const result = snapshot(compactContinuationPrompt(goal, { stateSeq: 1, currentProjectionSeq: 1, workState: work }));
  assert.equal(result.nextItem, "item-8");
  const selected = result.selectedNextItem as { id?: unknown; title?: unknown };
  assert.equal(selected.id, "item-8");
  assert.equal(selected.title, "Проверка 8");
  assert.equal(result.truncated, true);
  assert.equal(result.omittedItems, 3);
});

test("preserved sources remain accessible without a permanent unfinished-review instruction", () => {
  const goal = createGoal(null, "Проверить сохранённые источники", null).goal!;
  const state = createGoalProjectionState(goal);
  state.importedDocuments = [{ artifact: "CURRENT", content: "Исходное ограничение сохраняется дословно." }];
  state.preservedSourceIds = ["documents:original"];
  state.workState = { outcome: "Сохранить источники", doneWhen: "Они доступны адресно", summary: "Действующее записано в снимке", items: [], activeDecisionIds: [] };
  const preserved = goalPreservedContext(state);
  assert.ok(preserved);
  assert.deepEqual(preserved.sourceEventIds, ["documents:original"]);
  assert.doesNotMatch(preserved.notice, /Пока их ограничения|Прочитайте источники и сохраните/);
  assert.match(preserved.notice, /не заменяет|не доказывает|не подтверждает/);
  const document = renderGoalDocument(state);
  assert.doesNotMatch(document, /Сохранённые записи: требуется сверка/);
  assert.match(document, /documents:original/);
  state.workStateStale = true;
  assert.match(renderGoalDocument(state), /Договорённость изменилась/);
});
