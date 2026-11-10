import assert from "node:assert/strict";
import test from "node:test";

import {
  GOAL_TOOL_NAME_GUIDANCE,
  TOOL_PROMPT_GUIDELINES,
  budgetLimitPrompt,
  compactContinuationPrompt,
  completionAuditContinuationPromptSection,
  completionAuditToolGuidelines,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  goalToolReference,
} from "../../src/goal/prompts.js";
import { createGoal } from "../../src/goal/state.js";

test("tool prompt guidelines resolve exposed names without repeating alias footnotes", () => {
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /available tool list/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /namespace.*pi__get_goal/);
  assert.match(GOAL_TOOL_NAME_GUIDANCE, /Never treat display, history or transcript names as callable aliases/);
  assert.equal(goalToolReference("update_goal"), "update_goal");
  const combined = TOOL_PROMPT_GUIDELINES.join("\n");
  for (const name of ["get_goal", "create_goal", "update_goal", "amend_goal"]) assert.ok(combined.includes(name));
  assert.match(combined, /awaiting_user/);
  assert.match(combined, /goal_started before substantive work/);
  for (const guideline of completionAuditToolGuidelines()) assert.ok(TOOL_PROMPT_GUIDELINES.includes(guideline));
});

test("continuation prompt uses the canonical completion-audit contract", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  assert.match(continuation, /Before deciding that the goal is achieved, perform a completion audit/);
  assert.match(continuation, /prompt-to-artifact checklist/);
  assert.match(continuation, /Do not accept proxy signals as completion by themselves/);
  assert.match(continuation, /Do not mark a goal complete merely because the budget is nearly exhausted/);
  assert.match(continuation, /Classify the previous turn before choosing the next action/);
  assert.match(continuation, /evaluate manifestability before scheduling work/);
  assert.match(continuation, /Required evidence is work, not an optional residual risk/);
  assert.match(continuation, /instead of adding unrelated verification cycles/);
  assert.match(continuation, /agreed outcome and required evidence satisfy its done criterion/);
  assert.match(continuation, /cannot replace required work or proof/);
  assert.ok(continuation.includes(completionAuditContinuationPromptSection().join("\n")));
});

test("compact continuation keeps marker detection without repeating the full objective", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const compact = compactContinuationPrompt(created);
  const full = continuationPrompt(created);

  assert.equal(continuationGoalIdFromPrompt(compact), created.goalId);
  assert.match(compact, /<pi_goal_continuation goal_id="/);
  assert.doesNotMatch(compact, /<untrusted_objective>/);
  assert.match(compact, /get_goal/);
  assert.ok(compact.length < full.length);
});

test("continuation and budget-limit prompts reference exposed goal-completion tool names", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  const budget = budgetLimitPrompt(created);

  assert.match(budget, /marked the goal as budgetLimited/);
  assert.doesNotMatch(budget, /budget_limited/);

  for (const prompt of [continuation, budget]) {
    assert.match(prompt, /update_goal/);
    assert.match(prompt, /available tool list.*namespace/);
    assert.match(prompt, /Never treat display, history or transcript names as callable aliases/);
  }
});

test("continuation prompts carry the legacy done-criterion fallback", () => {
  const created = createGoal(null, "legacy ship", null)?.goal;
  assert.ok(created);
  const full = continuationPrompt(created);
  const compact = compactContinuationPrompt(created);
  for (const prompt of [full, compact]) {
    assert.match(prompt, /Outcome and Evidence/);
    assert.match(prompt, /for comparison or optimization objectives, when benefit stays unproven after the agreed experiments, keep the current variant and finish with a negative result/);
    assert.match(prompt, /decision point about the path, not a negative result for an outcome-seeking goal/);
    assert.match(prompt, /Continue authorized alternatives, or ask if every remaining path needs new authority/);
    assert.match(prompt, /unused budget is not a quota for more trials/);
    assert.doesNotMatch(prompt, /fallback: when benefit is unproven/);
    assert.match(prompt, /Missing evidence for that criterion is still unfinished work/);
  }
  assert.match(compact, /get_goal/);
});

test("continuation marker detection tolerates a missing prompt from custom messages", () => {
  assert.equal(continuationGoalIdFromPrompt(undefined), null);
});
