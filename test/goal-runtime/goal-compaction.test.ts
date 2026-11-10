import { inLanguage } from "../../src/language.js";
import { readFileSync } from "node:fs";
import { compactContinuationPrompt } from "../../src/goal/prompts.js";
import assert from "node:assert/strict";
import test from "node:test";

import { filterGoalCompactionInput } from "../../src/goal/goal-compaction.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";
import { createRuntimeHarness, sessionBeforeCompactEvent } from "../support/runtime-harness.js";
import { goalCompactionFixture } from "../support/compaction-fixture.js";

type Input = Parameters<typeof filterGoalCompactionInput>[0];
type Message = Input["messagesToSummarize"][number];

function custom(kind: string, goalId = "saved-goal"): Extract<Message, { role: "custom" }> {
  return { ...goalCompactionFixture(goalId).pure, details: { kind, goalId } };
}

function fixture() {
  const user: Message = { role: "user", content: "Keep this literal: Continue the saved goal. [goal-continuation]", timestamp: 1 };
  const objective = { ...custom("objective"), content: "Keep all accepted requirements." };
  const report = { ...custom("progress"), content: "Verified the API response; rollout is still blocked." };
  const otherExtension = { ...custom("continuation"), customType: "another-extension" };
  const malformed = { ...custom("continuation"), details: { kind: "continuation" } };
  const emptyOwner = custom("continuation", "");
  const keep: Message[] = [user, objective, report, otherExtension, malformed, emptyOwner];
  const continuation = custom("continuation");
  const controls = [continuation, custom("superseded_continuation"), custom("stale_continuation")];
  return { keep, continuation, report, messages: [user, ...controls, ...keep.slice(1)] };
}

test("only typed Goal continuations are removed from both summary regions", () => {
  const { keep, continuation, report, messages } = fixture();
  const preparation: Input = { messagesToSummarize: messages, turnPrefixMessages: [continuation, report] };
  filterGoalCompactionInput(preparation);
  assert.deepEqual(preparation.messagesToSummarize, keep);
  assert.deepEqual(preparation.turnPrefixMessages, [report]);
});

test("filtering never edits the source arrays or retained messages", () => {
  const { messages } = fixture();
  const journalCopy = structuredClone(messages);
  const preparation: Input = { messagesToSummarize: messages, turnPrefixMessages: messages };
  filterGoalCompactionInput(preparation);
  assert.deepEqual(messages, journalCopy);
  assert.notEqual(preparation.messagesToSummarize, messages);
  assert.equal(preparation.messagesToSummarize[0], messages[0]);
});

test("user messages cannot acquire Goal ownership through pasted metadata", () => {
  const user = { role: "user" as const, content: "Continue the saved goal.", timestamp: 1,
    customType: CUSTOM_ENTRY_TYPE, details: { kind: "continuation", goalId: "saved-goal" } };
  const preparation: Input = { messagesToSummarize: [user], turnPrefixMessages: [] };
  filterGoalCompactionInput(preparation);
  assert.deepEqual(preparation.messagesToSummarize, [user]);
});

test("empty and already filtered inputs are idempotent", () => {
  const preparation: Input = { messagesToSummarize: [], turnPrefixMessages: [] };
  filterGoalCompactionInput(preparation);
  filterGoalCompactionInput(preparation);
  assert.deepEqual(preparation, { messagesToSummarize: [], turnPrefixMessages: [] });
});

for (const reason of ["manual", "threshold", "overflow"] as const) {
  test(`the registered ${reason} hook filters before a downstream summarizer reads input`, async () => {
    const harness = createRuntimeHarness();
    const { keep, report, messages } = fixture();
    const preparation: Input = { messagesToSummarize: messages, turnPrefixMessages: [custom("continuation"), report] };
    await harness.emit("session_before_compact", { ...sessionBeforeCompactEvent({ reason }), preparation });
    assert.deepEqual(preparation.messagesToSummarize, keep);
    assert.deepEqual(preparation.turnPrefixMessages, [report]);
    assert.equal(messages.length, keep.length + 3);
  });
}

test("real mixed and legacy continuations keep their facts as projections, without changing the journal", () => {
  const { pure, mixed, legacy, unknown } = goalCompactionFixture();
  const source = [pure, mixed, legacy, unknown];
  const original = structuredClone(source);
  const preparation: Input = { messagesToSummarize: source, turnPrefixMessages: source };
  filterGoalCompactionInput(preparation);
  for (const region of [preparation.messagesToSummarize, preparation.turnPrefixMessages]) {
    assert.equal(region.length, 3);
    for (const [index, originalMessage] of [mixed, legacy].entries()) {
      const projected = region[index] as typeof mixed;
      assert.notEqual(projected, originalMessage);
      assert.equal(projected.timestamp, originalMessage.timestamp);
      assert.ok(projected.content.includes(`Goal ID: ${originalMessage.details.goalId}`));
      assert.equal(projected.customType, originalMessage.customType);
      assert.deepEqual((projected.details as { compactionProjection?: unknown }).compactionProjection,
        { version: 1, originalContent: originalMessage.content });
      assert.doesNotMatch(projected.content, /Avoid repeating work|STEP DISCIPLINE/);
    }
    const body = (region[0] as typeof mixed).content;
    for (const fact of ["KEEP_SNAPSHOT", "KEEP_EVIDENCE", "KEEP_DECISION", "KEEP_RATIONALE", "KEEP_RISK"]) {
      assert.ok(body.includes(fact), `snapshot must preserve ${fact}`);
    }
    const objective = legacy.content.match(/<untrusted_objective>[\s\S]*?<\/untrusted_objective>/)?.[0];
    assert.ok(objective);
    assert.ok((region[1] as typeof legacy).content.includes(objective));
    assert.equal(region[2], unknown);
  }
  assert.deepEqual(source, original);
  const projected = structuredClone(preparation);
  filterGoalCompactionInput(preparation);
  assert.deepEqual(preparation, projected, "projection is idempotent");
});

test("продолжения из сессии прежнего pi-codex-goal очищаются так же, тип записи не меняется", () => {
  const { pure, mixed, legacy } = goalCompactionFixture();
  const current = [pure, mixed, legacy];
  const old = current.map((message) => ({ ...message, customType: "pi-codex-goal" }));
  const expected: Input = { messagesToSummarize: current, turnPrefixMessages: [] };
  const actual: Input = { messagesToSummarize: old, turnPrefixMessages: [] };
  filterGoalCompactionInput(expected);
  filterGoalCompactionInput(actual);
  assert.equal(actual.messagesToSummarize.length, 2, "чистое продолжение убрано");
  for (const [index, message] of actual.messagesToSummarize.entries()) {
    assert.equal(message.role === "custom" && message.customType, "pi-codex-goal");
    assert.deepEqual({ ...message, customType: CUSTOM_ENTRY_TYPE }, expected.messagesToSummarize[index]);
  }
});

test("extra evidence inside a recognized frame is preserved rather than normalized away", () => {
  const { pure } = goalCompactionFixture();
  const extended = { ...pure, content: pure.content.replace(/\n\n(Budget|Бюджет):/, "\nKEEP_EXTRA_EVIDENCE: tests passed.\n\n$1:") };
  assert.notEqual(extended.content, pure.content);
  const preparation: Input = { messagesToSummarize: [pure, extended], turnPrefixMessages: [] };
  filterGoalCompactionInput(preparation);
  assert.equal(preparation.messagesToSummarize.length, 1);
  const projected = preparation.messagesToSummarize[0] as typeof extended;
  assert.ok(projected.content.includes("KEEP_EXTRA_EVIDENCE: tests passed."));
  assert.doesNotMatch(projected.content, /Avoid repeating work|Не повторяй уже сделанную работу/);
  assert.deepEqual((projected.details as { compactionProjection?: unknown }).compactionProjection,
    { version: 1, originalContent: extended.content });
});

test("кадр продолжения, записанный при другом языке, узнаётся и очищается", () => {
  for (const [written, current] of [["en", "ru"], ["ru", "en"]] as const) {
    const { pure, mixed } = inLanguage(written, () => goalCompactionFixture());
    const preparation: Input = { messagesToSummarize: [pure, mixed], turnPrefixMessages: [] };
    inLanguage(current, () => filterGoalCompactionInput(preparation));
    assert.equal(preparation.messagesToSummarize.length, 1, `${written} → ${current}`);
    const projected = preparation.messagesToSummarize[0] as typeof mixed;
    assert.doesNotMatch(projected.content, /Avoid repeating work|Не повторяй уже сделанную работу/);
    assert.equal((projected.details as { compactionProjection?: { originalContent?: unknown } }).compactionProjection?.originalContent, mixed.content);
  }
});

test("recognized pure controls with finite budgets and large counters remain removable", () => {
  const { goal, pure } = goalCompactionFixture();
  const changed = { ...pure, content: compactContinuationPrompt({ ...goal, tokenBudget: 5_000_000,
    usage: { tokensUsed: 1_234_567, activeSeconds: 8_001 } }) };
  const preparation: Input = { messagesToSummarize: [changed], turnPrefixMessages: [] };
  filterGoalCompactionInput(preparation);
  assert.deepEqual(preparation.messagesToSummarize, []);
});

test("shipped continuation frames stay clean when current instruction wording changes", () => {
  for (const file of ["goal-continuation-v1.txt", "goal-continuation-v1-legacy.txt"]) {
    const content = readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8");
    const message = { role: "custom" as const, customType: CUSTOM_ENTRY_TYPE, content, display: false,
      details: { kind: "continuation", goalId: "compatibility-goal-v1" }, timestamp: 17 };
    const preparation: Input = { messagesToSummarize: [message], turnPrefixMessages: [message] };
    filterGoalCompactionInput(preparation);
    for (const region of [preparation.messagesToSummarize, preparation.turnPrefixMessages]) {
      assert.equal(region.length, 1);
      const projected = region[0] as typeof message;
      assert.notEqual(projected, message);
      assert.ok(projected.content.includes("compatibility-goal-v1"));
      assert.ok(projected.content.includes(file.includes("legacy") ? "KEEP_LEGACY_OBJECTIVE" : "KEEP_EVIDENCE"));
      assert.doesNotMatch(projected.content, /Avoid repeating work|STEP DISCIPLINE/);
      assert.deepEqual((projected.details as { compactionProjection?: unknown }).compactionProjection,
        { version: 1, originalContent: content });
    }
    const unfamiliar = { ...message, content: content.replace("</pi_goal_continuation>", "KEEP_NEW_FOOTER_FACT\n</pi_goal_continuation>") };
    const unknown: Input = { messagesToSummarize: [unfamiliar], turnPrefixMessages: [unfamiliar] };
    filterGoalCompactionInput(unknown);
    assert.equal(unknown.messagesToSummarize[0], unfamiliar, "unknown footer facts cannot be discarded");
    assert.equal(unknown.turnPrefixMessages[0], unfamiliar);
  }
});
