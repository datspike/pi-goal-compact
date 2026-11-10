import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { budgetLimitPrompt } from "./prompts.js";
import { applyUsage } from "./state.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "./types.js";

export interface AccountingState {
  activeGoalId: string | null;
  lastAccountedAt: number | null;
  /** The sampled fraction belongs to one goal, even across a pause. */
  remainderGoalId: string | null;
  remainderMs: number;
  budgetWarningSentFor: string | null;
}

export interface AssistantUsage {
  input: number;
  output: number;
}

export interface AssistantTurnMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
  usage?: AssistantUsage;
}

export function createAccountingState(): AccountingState {
  return {
    activeGoalId: null,
    lastAccountedAt: null,
    remainderGoalId: null,
    remainderMs: 0,
    budgetWarningSentFor: null,
  };
}

function usageChannelTokens(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

export function assistantTurnTokens(message: AssistantTurnMessage): number {
  if (message.role !== "assistant" || !message.usage) {
    return 0;
  }
  return usageChannelTokens(message.usage.input) + usageChannelTokens(message.usage.output);
}

export function isAbortedAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "aborted";
}

export function isToolUseAssistantMessage(message: AssistantTurnMessage): boolean {
  return message.role === "assistant" && message.stopReason === "toolUse";
}

/** Возвращает true, если ход ассистента вызвал инструмент отчёта по цели. */
export function hasGoalProgressToolCall(message: AssistantTurnMessage): boolean {
  return (
    message.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some(
      (content) =>
        typeof content === "object" &&
        content !== null &&
        "type" in content &&
        content.type === "toolCall" &&
        "name" in content &&
        typeof content.name === "string" &&
        (content.name === "report_goal_progress" || content.name.endsWith("__report_goal_progress")),
    )
  );
}

interface GoalAccountingDeps {
  getGoal: () => ThreadGoal | null;
  getAccounting: () => AccountingState;
  applyRuntimeAccountingTransition: (ctx: ExtensionContext, nextGoal: ThreadGoal) => void;
  sendMessage: ExtensionAPI["sendMessage"];
}

/** Count only sampled active intervals; retain their subsecond remainder for the same goal. */
export function createGoalAccounting(deps: GoalAccountingDeps) {
  const clearActiveAccounting = (): void => {
    const accounting = deps.getAccounting();
    accounting.activeGoalId = null;
    accounting.lastAccountedAt = null;
  };

  const beginAccounting = (): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    if (!goal || goal.status !== "active") {
      accounting.activeGoalId = null;
      accounting.lastAccountedAt = null;
      return;
    }

    if (accounting.remainderGoalId !== goal.goalId) {
      accounting.remainderGoalId = goal.goalId;
      accounting.remainderMs = 0;
    }
    accounting.activeGoalId = goal.goalId;
    accounting.lastAccountedAt = Date.now();
  };

  const accountProgress = (
    ctx: ExtensionContext,
    allowBudgetSteering: boolean,
    completedTurnTokens = 0,
    accountBudgetLimited = false,
  ): void => {
    const goal = deps.getGoal();
    const accounting = deps.getAccounting();
    const canAccount = goal?.status === "active" || (accountBudgetLimited && goal?.status === "budgetLimited");
    if (!goal || accounting.activeGoalId !== goal.goalId || !canAccount) {
      if (ctx.isIdle()) {
        clearActiveAccounting();
      } else {
        beginAccounting();
      }
      return;
    }

    const now = Date.now();
    const deltaMs = accounting.lastAccountedAt === null ? 0 : Math.max(0, now - accounting.lastAccountedAt);
    const totalMs = accounting.remainderMs + deltaMs;
    const elapsed = Math.floor(totalMs / 1000);
    accounting.remainderMs = totalMs - elapsed * 1000;
    accounting.lastAccountedAt = now;

    const result = applyUsage(goal, completedTurnTokens, elapsed, {
      expectedGoalId: accounting.activeGoalId,
      accountBudgetLimited,
    });
    if (!result.changed || !result.goal) {
      return;
    }

    deps.applyRuntimeAccountingTransition(ctx, result.goal);

    if (allowBudgetSteering && result.crossedBudget && accounting.budgetWarningSentFor !== result.goal.goalId) {
      accounting.budgetWarningSentFor = result.goal.goalId;
      deps.sendMessage(
        {
          customType: CUSTOM_ENTRY_TYPE,
          content: budgetLimitPrompt(result.goal),
          display: false,
          details: { kind: "budget_limit", goalId: result.goal.goalId },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  };

  return {
    clearActiveAccounting,
    beginAccounting,
    accountProgress,
  };
}
