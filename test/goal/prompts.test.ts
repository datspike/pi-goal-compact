import { inLanguage } from "../../src/language.js";
import assert from "node:assert/strict";
import test from "node:test";

import {
  goalToolGuidelines,
  goalToolNameGuidance,
  toolPromptGuidelines,
  budgetLimitPrompt,
  compactContinuationPrompt,
  completionAuditContinuationPromptSection,
  completionAuditToolGuidelines,
  continuationGoalIdFromPrompt,
  continuationPrompt,
  goalToolReference,
} from "../../src/goal/prompts.js";
import { createGoal } from "../../src/goal/state.js";

test("tool prompt guidelines resolve exposed names without repeating alias footnotes", () => inLanguage("en", () => {
  assert.match(goalToolNameGuidance(), /exact available tool names/);
  assert.match(goalToolNameGuidance(), /including namespace/);
  assert.match(goalToolNameGuidance(), /not display\/history\/transcript aliases/);
  assert.equal(goalToolReference("update_goal"), "update_goal");
  const combined = toolPromptGuidelines().join("\n");
  for (const name of ["get_goal", "update_goal"]) assert.ok(combined.includes(name));
  // Остальное об инструментах несут их описания: у правила с тем же фактом был бы второй хозяин.
  for (const name of ["get_goal", "create_goal", "resume_goal", "amend_goal"] as const) assert.deepEqual(goalToolGuidelines(name), [goalToolNameGuidance()]);
  assert.match(combined, /English prose in paragraphs of at most 700 characters/);
  assert.doesNotMatch(combined, /goal_started/);
  for (const guideline of completionAuditToolGuidelines()) assert.ok(toolPromptGuidelines().includes(guideline));
}));

test("continuation prompt uses the canonical completion-audit contract", () => inLanguage("en", () => {
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
}));

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

test("continuation and budget-limit prompts reference exposed goal-completion tool names", () => inLanguage("en", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);

  const continuation = continuationPrompt(created);
  const budget = budgetLimitPrompt(created);

  assert.match(budget, /marked the goal as budgetLimited/);
  assert.doesNotMatch(budget, /budget_limited/);

  for (const prompt of [continuation, budget]) {
    assert.match(prompt, /update_goal/);
    assert.match(prompt, /available tool names.*namespace/);
    assert.match(prompt, /not display\/history\/transcript aliases/);
  }
}));

test("continuation prompts carry the legacy done-criterion fallback", () => inLanguage("en", () => {
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
}));

test("continuation marker detection tolerates a missing prompt from custom messages", () => {
  assert.equal(continuationGoalIdFromPrompt(undefined), null);
});

test("русский вариант правил несёт те же обязательства, что и английский", () => {
  const created = createGoal(null, "ship it", 10).goal;
  assert.ok(created);
  const continuation = continuationPrompt(created);
  const compact = compactContinuationPrompt(created);
  const budget = budgetLimitPrompt(created);
  const guidelines = toolPromptGuidelines().join("\n");
  assert.match(goalToolNameGuidance(), /точные доступные имена инструментов.*namespace/);
  assert.match(guidelines, /по-русски абзацами не длиннее 700 знаков/);
  for (const guideline of completionAuditToolGuidelines()) assert.ok(toolPromptGuidelines().includes(guideline));
  assert.match(continuation, /Прежде чем решить, что цель достигнута, проверь завершение/);
  assert.match(continuation, /список «требование → артефакт»/);
  assert.match(continuation, /Не принимай косвенные признаки за завершение/);
  assert.match(continuation, /Не отмечай цель завершённой только потому, что бюджет почти исчерпан/);
  assert.ok(continuation.includes(completionAuditContinuationPromptSection().join("\n")));
  for (const prompt of [continuation, compact]) {
    assert.match(prompt, /классифицируй прошлый ход/);
    assert.match(prompt, /Обязательное доказательство — это работа/);
    assert.match(prompt, /оставь текущий вариант и заверши с отрицательным результатом/);
    assert.match(prompt, /точка выбора пути, а не отрицательный результат/);
    assert.match(prompt, /неизрасходованный бюджет не квота на новые попытки/);
    assert.match(prompt, /Недостающее доказательство этого критерия — по-прежнему незавершённая работа/);
    assert.match(prompt, /update_goal/);
  }
  assert.match(budget, /отметила цель как budgetLimited/);
  assert.match(budget, /Не вызывай update_goal, пока цель действительно не завершена/);
  for (const prompt of [continuation, compact, budget]) assert.doesNotMatch(prompt.replace(/<[^>]+>/g, ""), /\b(?:Continue|Before|Avoid|Budget|Do not)\b/);
});
