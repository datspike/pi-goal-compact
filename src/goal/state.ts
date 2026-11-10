import { randomUUID } from "node:crypto";

import {
  CUSTOM_ENTRY_TYPE,
  GOAL_ARTIFACT_NAMES,
  MAX_OBJECTIVE_CHARS,
  type GoalCustomEntry,
  type GoalArtifactName,
  type GoalEntrySource,
  type GoalResult,
  type GoalSnapshot,
  type GoalStatus,
  type GoalUsage,
  type RuntimeUsageGoalStatus,
  type SessionEntryLike,
  type ThreadGoal,
} from "./types.js";

export interface ApplyUsageOptions {
  expectedGoalId?: string | null;
  accountBudgetLimited?: boolean;
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Метка времени для обычного перехода не должна отставать от текущего снимка. */
export function nonDecreasingUpdatedAt(current: ThreadGoal): number {
  return Math.max(unixSeconds(), current.updatedAt);
}

export function cloneUsage(usage: GoalUsage): GoalUsage {
  return { ...usage };
}

export function cloneGoal(goal: ThreadGoal): ThreadGoal {
  return {
    ...goal,
    usage: cloneUsage(goal.usage),
    ...(goal.pause ? { pause: { ...goal.pause } } : {}),
  };
}

export function goalsEquivalent(left: ThreadGoal, right: ThreadGoal): boolean {
  return (
    left.goalId === right.goalId &&
    left.objective === right.objective &&
    left.status === right.status &&
    JSON.stringify(left.pause) === JSON.stringify(right.pause) &&
    left.tokenBudget === right.tokenBudget &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.usage.tokensUsed === right.usage.tokensUsed &&
    left.usage.activeSeconds === right.usage.activeSeconds
  );
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}

export function statusAfterBudgetLimit(status: GoalStatus, tokensUsed: number, tokenBudget: number | null): GoalStatus {
  if (status === "active" && tokenBudget !== null && tokensUsed >= tokenBudget) {
    return "budgetLimited";
  }
  return status;
}

export function createThreadGoal(objective: string, tokenBudget?: number | null, now = unixSeconds()): ThreadGoal {
  return {
    goalId: randomUUID(),
    objective: objective.trim(),
    status: "active",
    tokenBudget: tokenBudget ?? null,
    usage: {
      tokensUsed: 0,
      activeSeconds: 0,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export function setEntry(goal: ThreadGoal, source: GoalEntrySource, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "set",
    source,
    goal: cloneGoal(goal),
    at,
  };
}

export function runtimeUsageEntry(goal: ThreadGoal, at = unixSeconds()): GoalCustomEntry {
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    throw new Error(`Cannot persist ${goal.status} goal as runtime usage entry.`);
  }
  return {
    version: 1,
    kind: "usage",
    source: "runtime",
    goalId: goal.goalId,
    status: goal.status,
    usage: cloneUsage(goal.usage),
    updatedAt: goal.updatedAt,
    at,
  };
}

export function clearEntry(
  clearedGoalId: string | null,
  source: GoalEntrySource,
  at = unixSeconds(),
): GoalCustomEntry {
  return {
    version: 1,
    kind: "clear",
    source,
    clearedGoalId,
    at,
  };
}

export function hostOverflowCapResetEntry(active: boolean, at = unixSeconds()): GoalCustomEntry {
  return {
    version: 1,
    kind: "host_overflow_cap_reset",
    active,
    at,
  };
}

export function artifactEntry(goalId: string, artifact: GoalArtifactName, revision: number, at = unixSeconds()): GoalCustomEntry {
  return { version: 1, kind: "artifact", goalId, artifact, revision, at };
}

export function isGoalCustomEntry(data: unknown): data is GoalCustomEntry {
  if (!data || typeof data !== "object") {
    return false;
  }
  const entry = data as GoalCustomEntry;
  if (entry.version !== 1 || typeof entry.at !== "number") {
    return false;
  }
  if (entry.kind === "clear") {
    return entry.clearedGoalId === null || typeof entry.clearedGoalId === "string";
  }
  if (entry.kind === "usage") {
    return (
      entry.source === "runtime" &&
      typeof entry.goalId === "string" &&
      isRuntimeUsageGoalStatus(entry.status) &&
      isGoalUsage(entry.usage) &&
      typeof entry.updatedAt === "number"
    );
  }
  if (entry.kind === "host_overflow_cap_reset") {
    return typeof entry.active === "boolean";
  }
  if (entry.kind === "artifact") {
    return typeof entry.goalId === "string" && isGoalArtifactName(entry.artifact) && Number.isInteger(entry.revision) && entry.revision >= 0;
  }
  return entry.kind === "set" && isThreadGoal(entry.goal);
}

export function isGoalUsage(usage: unknown): usage is GoalUsage {
  if (!usage || typeof usage !== "object") {
    return false;
  }
  const candidate = usage as GoalUsage;
  return typeof candidate.tokensUsed === "number" && typeof candidate.activeSeconds === "number";
}

export function isRuntimeUsageGoalStatus(status: unknown): status is RuntimeUsageGoalStatus {
  return status === "active" || status === "budgetLimited";
}

export function isThreadGoal(goal: unknown): goal is ThreadGoal {
  if (!goal || typeof goal !== "object") {
    return false;
  }
  const candidate = goal as ThreadGoal;
  const appliedAmendments = candidate.appliedAmendments;
  return (
    typeof candidate.goalId === "string" &&
    typeof candidate.objective === "string" &&
    isGoalStatus(candidate.status) &&
    (candidate.tokenBudget === null || typeof candidate.tokenBudget === "number") &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.updatedAt === "number" &&
    isGoalUsage(candidate.usage) &&
    (candidate.pause === undefined || (candidate.status === "paused" && candidate.pause !== null && typeof candidate.pause === "object" &&
      ["manual", "recovery", "shutdown"].includes(candidate.pause.kind) && typeof candidate.pause.reason === "string")) &&
    (appliedAmendments === undefined || (Array.isArray(appliedAmendments) && appliedAmendments.every((item) => typeof item === "string")))
  );
}

export function isGoalArtifactName(value: unknown): value is GoalArtifactName {
  return typeof value === "string" && (GOAL_ARTIFACT_NAMES as readonly string[]).includes(value);
}

export function reconstructGoalArtifactRevisions(entries: Iterable<SessionEntryLike>, goalId: string | null): Record<GoalArtifactName, number> {
  const revisions: Record<GoalArtifactName, number> = { GOAL: 0, CURRENT: 0, TIMELINE: 0, DECISIONS: 0, "CONTEXT-MAP": 0, "PAPER-CUTS": 0 };
  if (!goalId) return revisions;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE || !isGoalCustomEntry(entry.data) || entry.data.kind !== "artifact" || entry.data.goalId !== goalId) continue;
    revisions[entry.data.artifact] = Math.max(revisions[entry.data.artifact], entry.data.revision);
  }
  return revisions;
}

export function isGoalStatus(status: unknown): status is GoalStatus {
  return status === "active" || status === "paused" || status === "budgetLimited" || status === "complete";
}

function canApplyRuntimeUsageEntry(goal: ThreadGoal | null, entry: Extract<GoalCustomEntry, { kind: "usage" }>): goal is ThreadGoal {
  if (!goal || goal.goalId !== entry.goalId) {
    return false;
  }
  if (!isRuntimeUsageGoalStatus(goal.status)) {
    return false;
  }
  if (goal.status === "budgetLimited" && entry.status === "active") {
    return false;
  }
  return (
    entry.updatedAt >= goal.updatedAt &&
    entry.usage.tokensUsed >= goal.usage.tokensUsed &&
    entry.usage.activeSeconds >= goal.usage.activeSeconds
  );
}

export function reconstructGoal(entries: Iterable<SessionEntryLike>): GoalSnapshot {
  let goal: ThreadGoal | null = null;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "clear") {
      goal = null;
    } else if (entry.data.kind === "set") {
      goal = cloneGoal(entry.data.goal);
    } else if (entry.data.kind === "usage") {
      if (!canApplyRuntimeUsageEntry(goal, entry.data)) {
        continue;
      }
      goal = cloneGoal(goal);
      goal.status = entry.data.status;
      goal.usage = cloneUsage(entry.data.usage);
      goal.updatedAt = entry.data.updatedAt;
    }
  }

  return {
    goal,
    hasGoal: goal !== null,
  };
}

export function reconstructHostOverflowCapNeedsUserReset(entries: Iterable<SessionEntryLike>): boolean {
  let needsReset = false;

  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) {
      continue;
    }
    if (!isGoalCustomEntry(entry.data)) {
      continue;
    }
    if (entry.data.kind === "host_overflow_cap_reset") {
      needsReset = entry.data.active;
    }
  }

  return needsReset;
}

export function createGoal(current: ThreadGoal | null, objective: string, tokenBudget?: number | null): GoalResult {
  if (current && current.status !== "complete") {
    return {
      ok: false,
      message:
        "cannot create a new goal because this thread already has a non-complete goal; use /gc to clear it or create_goal with replace_existing: true after an explicit user request",
      goal: current,
    };
  }

  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal created.",
    goal,
  };
}

export function amendGoal(current: ThreadGoal | null, amendment: string): GoalResult {
  if (!current || (current.status !== "active" && current.status !== "paused")) {
    return {
      ok: false,
      message: "Only active or paused goals can be amended.",
      goal: current,
    };
  }

  const trimmedAmendment = amendment.trim();
  if (trimmedAmendment.length === 0) {
    return { ok: false, message: "Amendment must not be empty.", goal: current };
  }

  const goal = cloneGoal(current);
  goal.objective = `${current.objective}\n\nApproved amendment:\n${trimmedAmendment}`;
  const objectiveError = validateObjective(goal.objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: current };
  }
  const amendmentKey = `${current.goalId}\u0000${trimmedAmendment}`;
  goal.appliedAmendments = [...(current.appliedAmendments ?? []), amendmentKey];
  goal.updatedAt = Math.max(unixSeconds(), current.updatedAt + 1);
  return { ok: true, message: "Goal amended.", goal };
}

export function replaceGoal(objective: string, tokenBudget?: number | null): GoalResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, goal: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, goal: null };
  }

  const goal = createThreadGoal(objective, tokenBudget);
  return {
    ok: true,
    message: "Goal set.",
    goal,
  };
}

export function updateGoalStatus(current: ThreadGoal | null, status: GoalStatus): GoalResult {
  if (!current) {
    return {
      ok: false,
      message: "No active goal exists.",
      goal: null,
    };
  }

  if (current.status === "complete") {
    if (status === "complete") {
      return {
        ok: true,
        message: "Goal already complete.",
        goal: current,
      };
    }
    return {
      ok: false,
      message: "Completed goals are terminal; ask the agent to create a new goal or use /gc to clear it.",
      goal: current,
    };
  }

  if (status === "complete") {
    const goal = cloneGoal(current);
    goal.status = "complete";
    delete goal.pause;
    goal.updatedAt = nonDecreasingUpdatedAt(current);
    return {
      ok: true,
      message: "Goal marked complete.",
      goal,
    };
  }

  if (status === "paused" && current.status !== "active" && !(current.status === "paused" && current.pause?.kind === "recovery")) {
    return {
      ok: false,
      message: "Only active goals can be paused.",
      goal: current,
    };
  }

  if (status === "active" && current.status !== "paused") {
    return {
      ok: false,
      message: "Only paused goals can be resumed.",
      goal: current,
    };
  }

  const goal = cloneGoal(current);
  if (current.status === "budgetLimited" && (status === "active" || status === "paused")) {
    goal.status = "budgetLimited";
  } else {
    goal.status = statusAfterBudgetLimit(status, goal.usage.tokensUsed, goal.tokenBudget);
  }
  if (goal.status === "paused") goal.pause = { kind: "manual", reason: "Paused by user command." };
  else delete goal.pause;
  goal.updatedAt = nonDecreasingUpdatedAt(current);

  return {
    ok: true,
    message: `Goal marked ${goal.status}.`,
    goal,
  };
}

export function applyUsage(
  current: ThreadGoal | null,
  tokensDelta: number,
  activeSecondsDelta: number,
  options: ApplyUsageOptions = {},
): { goal: ThreadGoal | null; changed: boolean; crossedBudget: boolean } {
  if (!current) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  if (
    options.expectedGoalId !== undefined &&
    options.expectedGoalId !== null &&
    current.goalId !== options.expectedGoalId
  ) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const canAccount =
    current.status === "active" || (options.accountBudgetLimited === true && current.status === "budgetLimited");
  if (!canAccount) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const tokens = Math.max(0, Math.trunc(tokensDelta));
  const seconds = Math.max(0, Math.trunc(activeSecondsDelta));
  if (tokens === 0 && seconds === 0) {
    return { goal: current, changed: false, crossedBudget: false };
  }

  const goal = cloneGoal(current);
  const wasUnderBudget = goal.tokenBudget === null || goal.usage.tokensUsed < goal.tokenBudget;
  goal.usage.tokensUsed += tokens;
  goal.usage.activeSeconds += seconds;
  goal.status = statusAfterBudgetLimit(goal.status, goal.usage.tokensUsed, goal.tokenBudget);
  goal.updatedAt = nonDecreasingUpdatedAt(current);

  const crossedBudget =
    current.status === "active" &&
    wasUnderBudget &&
    goal.tokenBudget !== null &&
    goal.usage.tokensUsed >= goal.tokenBudget;

  return { goal, changed: true, crossedBudget };
}

export function goalWithLiveUsage(
  current: ThreadGoal | null,
  activeGoalId: string | null,
  lastAccountedAt: number | null,
  now = Date.now(),
): ThreadGoal | null {
  if (!current || current.status !== "active" || activeGoalId !== current.goalId || lastAccountedAt === null) {
    return current;
  }

  const liveSeconds = Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
  if (liveSeconds === 0) {
    return current;
  }

  const goal = cloneGoal(current);
  goal.usage.activeSeconds += liveSeconds;
  return goal;
}
