import { compactContinuationPrompt, continuationPrompt, type GoalContinuationSnapshot } from "../../src/goal/prompts.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "../../src/goal/types.js";

/** Real prompt producers with facts that occur nowhere else in the replay conversation. */
export function goalCompactionFixture(goalId = "saved-goal") {
  const goal: ThreadGoal = {
    goalId, objective: "KEEP_LEGACY_OBJECTIVE: preserve the accepted response.", status: "active", tokenBudget: null,
    usage: { tokensUsed: 1234, activeSeconds: 61 }, createdAt: 100, updatedAt: 100,
  };
  const snapshot: GoalContinuationSnapshot = {
    stateSeq: 7, currentProjectionSeq: 7, workRevision: 2,
    status: "working", verification: "KEEP_FULL_VERIFICATION: API returned the required fields.",
    nextStep: "KEEP_NEXT_STEP: verify the remaining endpoint.",
    workState: {
      outcome: "Preserve the accepted response.", doneWhen: "The endpoint returns all required fields.",
      summary: "KEEP_SNAPSHOT: the first endpoint has been checked.",
      items: [
        { id: "proof", title: "Check endpoint", status: "done", source: "user", evidence: "KEEP_EVIDENCE: HTTP 200 with required fields." },
        { id: "remaining", title: "Check second endpoint", status: "planned", source: "user" },
      ],
      activeDecisionIds: ["choice"], verification: "KEEP_VERIFICATION: first endpoint confirmed.",
      risks: "KEEP_RISK: second endpoint remains unchecked.",
    },
    activeDecisions: [{ id: "choice", title: "Response shape", decision: "KEEP_DECISION: keep the existing schema.",
      rationale: "KEEP_RATIONALE: consumers rely on these fields.", createdAt: 100 }],
  };
  const custom = (content: string) => ({ role: "custom" as const, customType: CUSTOM_ENTRY_TYPE,
    content, display: false, details: { kind: "continuation", goalId }, timestamp: 100 });
  return {
    goal, snapshot,
    pure: custom(compactContinuationPrompt(goal)),
    mixed: custom(compactContinuationPrompt(goal, snapshot)),
    legacy: custom(continuationPrompt(goal)),
    unknown: custom("A future continuation format with KEEP_UNKNOWN_EVIDENCE: deployment is not approved."),
  };
}
