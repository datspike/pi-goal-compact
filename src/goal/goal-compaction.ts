import { createHash } from "node:crypto";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

import { compactContinuationPrompt, continuationPrompt } from "./prompts.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

type GoalCompactionInput = Pick<SessionBeforeCompactEvent["preparation"], "messagesToSummarize" | "turnPrefixMessages">;
type PreparedMessage = GoalCompactionInput["messagesToSummarize"][number];
const INSTRUCTION_BOUNDARY = "\nAvoid repeating work that is already done. Choose the next concrete action toward the objective.";
const NAMESPACED_GET_GOAL = " (or the exposed namespaced equivalent, such as pi__get_goal)";
// Recognize shipped footers after wording changes without embedding their old instructions.
const SHIPPED_FOOTERS = new Set([
  "a3851424877dd4ef2e00267b01532ead231e3e5819ed603676b652ce5933b094",
  "a0593c2c1950b2294f859d3c2436168fd7cc50dcddd0ecf932265f1fbf3c030c",
]);

/** Ignore only the known accounting counters when recognizing a pure control copy. */
function withoutBudgetCounters(content: string): string {
  return content.replace(
    /^Budget:\n- Time spent pursuing goal: [0-9 hms]+\n- Tokens used: [0-9.,KMB() ]+\n- Token budget: (?:none|[0-9.,KMB() ]+)\n- Tokens remaining: (?:unbounded|[0-9.,KMB() ]+)$/m,
    "Budget:",
  );
}

function projectContinuation(message: PreparedMessage): PreparedMessage | null {
  if (message.role !== "custom" || message.customType !== CUSTOM_ENTRY_TYPE || typeof message.content !== "string" ||
      !message.details || typeof message.details !== "object") return message;
  const details = message.details as { goalId?: unknown; kind?: unknown };
  if (typeof details.goalId !== "string" || !details.goalId || typeof details.kind !== "string" || ![
    "continuation", "superseded_continuation", "stale_continuation",
  ].includes(details.kind)) return message;

  const referenceGoal: ThreadGoal = {
    goalId: details.goalId, objective: "", status: "active", tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 0 }, createdAt: 0, updatedAt: 0,
  };
  const sourceContent = message.content;
  const compact = compactContinuationPrompt(referenceGoal);
  if (withoutBudgetCounters(message.content) === withoutBudgetCounters(compact)) return null;

  // Use the actual producers as the frame contract, not a second copy of their instructions.
  // Unknown frames remain intact; recognized bodies preserve every byte of factual context.
  for (const [reference, start] of [
    [compact, "\nBudget:\n"],
    [continuationPrompt(referenceGoal), "<untrusted_objective>"],
  ] as const) {
    const first = reference.indexOf(start);
    const last = reference.lastIndexOf(INSTRUCTION_BOUNDARY);
    if (first < 0 || last <= first) continue;
    const shortHeader = reference.slice(0, first).replace(NAMESPACED_GET_GOAL, "");
    const header = [shortHeader, shortHeader.replace("with get_goal if needed.", `with get_goal${NAMESPACED_GET_GOAL} if needed.`)]
      .find((candidate) => sourceContent.startsWith(candidate));
    const sourceLast = message.content.lastIndexOf(INSTRUCTION_BOUNDARY);
    if (!header || sourceLast <= header.length) continue;
    const footer = message.content.slice(sourceLast);
    if (footer !== reference.slice(last) && !SHIPPED_FOOTERS.has(createHash("sha256").update(footer).digest("hex"))) continue;
    return {
      ...message,
      content: `Goal ID: ${details.goalId}\n` + message.content.slice(header.length, sourceLast),
      details: { ...message.details, compactionProjection: { version: 1, originalContent: message.content } },
    };
  }
  return message;
}

/** Clean prepared copies; provenance lets append match the untouched cached message. */
export function filterGoalCompactionInput(preparation: GoalCompactionInput): void {
  const project = (messages: PreparedMessage[]) => messages.flatMap((message) => {
    const projected = projectContinuation(message);
    return projected ? [projected] : [];
  });
  if (Array.isArray(preparation.messagesToSummarize)) {
    preparation.messagesToSummarize = project(preparation.messagesToSummarize);
  }
  if (Array.isArray(preparation.turnPrefixMessages)) {
    preparation.turnPrefixMessages = project(preparation.turnPrefixMessages);
  }
}
