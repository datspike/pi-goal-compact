import { cloneGoalWorkState, selectNextGoalWork, type GoalWorkState } from "./goal-work-state.js";
import type { GoalDecisionEntry, GoalPaperCutEntry } from "./goal-projection-state.js";

export type GoalPaperCutSummary = Pick<GoalPaperCutEntry, "id" | "title" | "severity" | "status" | "resolution"> & { revision: number };
import { formatRecoveryAttention, type RecoveryAttention } from "./recovery.js";
import type { GoalReportState } from "./goal-reports.js";
import type { GoalProgressReport } from "./report-schema.js";
import { goalPreservedContext, type GoalProjectionState } from "./goal-projection-state.js";
import type { GoalArtifactRef, GoalStatus, ThreadGoal } from "./types.js";
import { say } from "../language.js";

const COMPACT_TOKEN_UNITS = [
  { suffix: "T", value: 1_000_000_000_000 },
  { suffix: "B", value: 1_000_000_000 },
  { suffix: "M", value: 1_000_000 },
  { suffix: "K", value: 1_000 },
] as const;

export interface GoalToolRecord {
  pause?: ThreadGoal["pause"];
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  /** Договорённость последней редакции; нет у целей прежней пары. */
  agreement?: ThreadGoal["agreement"];
  /** Список «Решаю сам» с видом и состоянием каждого пункта. */
  selfDecided?: ThreadGoal["selfDecided"];
}

export interface GoalWorkingState {
  lifecycle: GoalStatus | null;
  goal: GoalToolRecord | null;
  currentStep: string | null;
  workState: GoalWorkState | null;
  workRevision: number;
  workStateStale: boolean;
  activeDecisions: GoalDecisionEntry[];
  paperCuts?: GoalPaperCutSummary[];
  progressStatus: string | null;
  nextStep: string | null;
  latestUsefulVerification: string | null;
  blocker: string | null;
  needUser: string | null;
  awaitingUser: boolean;
  requiresUserDecision?: boolean;
  continuationHeld: boolean;
  usage: { tokensUsed: number; activeSeconds: number };
  projection: { stateSeq: number; currentProjectionSeq: number; fresh: boolean; repairPending: boolean } | null;
  userAnswerReceived: boolean;
  artifactRefs: GoalArtifactRef[];
  history: { source: "session-events"; preservedContext?: NonNullable<ReturnType<typeof goalPreservedContext>> };
}

export type GoalStatusWorkingState = Omit<GoalWorkingState, "goal" | "workState" | "activeDecisions" | "paperCuts"> & {
  goal: Omit<GoalToolRecord, "objective"> | null;
  omitted: ["goal.objective", "workState", "activeDecisions", "paperCuts"];
  fullStateRequiredFor: string;
};

export interface GoalActionWorkingState {
  lifecycle: GoalStatus | null;
  currentStep: string | null;
  progressStatus: string | null;
  nextStep: string | null;
  latestUsefulVerification: string | null;
  blocker: string | null;
  needUser: string | null;
  awaitingUser: boolean;
  requiresUserDecision?: boolean;
  continuationHeld: boolean;
  userAnswerReceived: boolean;
  projection?: { stateSeq: number; currentProjectionSeq: number; fresh: boolean; repairPending: boolean };
}

export interface GoalToolResponse {
  goal: GoalToolRecord | null;
  remainingTokens: number | null;
  completionBudgetReport: string | null;
}

export function formatDuration(seconds: number): string {
  const normalized = Math.max(0, Math.trunc(seconds));
  const days = Math.floor(normalized / 86_400);
  const hours = Math.floor((normalized % 86_400) / 3_600);
  const minutes = Math.floor((normalized % 3_600) / 60);
  const remainingSeconds = normalized % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${remainingSeconds}s`;
}

export function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(value)).toLocaleString("en-US");
}

export function formatCompactTokenValue(value: number): string {
  const normalized = Math.max(0, Math.trunc(value));
  if (normalized < 100_000) {
    return formatInteger(normalized);
  }

  const unit = COMPACT_TOKEN_UNITS.find((candidate) => normalized >= candidate.value);
  if (!unit) {
    return formatInteger(normalized);
  }

  const scaled = normalized / unit.value;
  const fractionDigits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  const compact = scaled.toLocaleString("en-US", {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: 0,
  });
  return `${compact}${unit.suffix}`;
}

export function formatTokenValue(value: number): string {
  const exact = formatInteger(value);
  const compact = formatCompactTokenValue(value);
  if (compact === exact) {
    return exact;
  }
  return `${compact} (${exact})`;
}

export function formatBudget(goal: ThreadGoal): string {
  if (goal.tokenBudget === null) {
    return `${formatTokenValue(goal.usage.tokensUsed)} tokens`;
  }
  return `${formatTokenValue(goal.usage.tokensUsed)}/${formatTokenValue(goal.tokenBudget)} ${say("токенов", "tokens")}`;
}

function statusLabel(status: GoalStatus): string {
  return say<Record<GoalStatus, string>>(
    { active: "активна", paused: "на паузе", complete: "завершена", budgetLimited: "исчерпан бюджет" },
    { active: "active", paused: "paused", complete: "complete", budgetLimited: "limited by budget" },
  )[status];
}

function commandHint(status: GoalStatus): string {
  if (status === "active") {
    return "/gp, /gc";
  }
  if (status === "paused") {
    return say("/gr (тихое возобновление), /gc", "/gr (silent resume), /gc");
  }
  return say("/gc; попроси агента создать или заменить цель", "/gc; ask the agent to create or replace a goal");
}

export function formatGoalSummary(goal: ThreadGoal | null): string {
  if (!goal) {
    return say("Цель сейчас не задана. Попроси агента создать цель.", "No goal is currently set. Ask the agent to create a goal.");
  }

  const lines = [
    `${say("Статус", "Status")}: ${statusLabel(goal.status)}`,
    `${say("Цель", "Objective")}: ${goal.objective}`,
    `${say("Время работы", "Time used")}: ${formatDuration(goal.usage.activeSeconds)}`,
    `${say("Использовано токенов", "Tokens used")}: ${formatTokenValue(goal.usage.tokensUsed)}`,
  ];

  if (goal.tokenBudget !== null) {
    lines.push(`${say("Бюджет токенов", "Token budget")}: ${formatTokenValue(goal.tokenBudget)}`);
  }

  lines.push(`${say("Подсказка", "Hint")}: ${commandHint(goal.status)}`);
  return lines.join("\n");
}

function compactBudgetUsage(goal: ThreadGoal): string {
  if (goal.tokenBudget === null) {
    return `${formatCompactTokenValue(goal.usage.tokensUsed)} ${say("токенов", "tokens")}`;
  }
  return `${formatCompactTokenValue(goal.usage.tokensUsed)} / ${formatCompactTokenValue(goal.tokenBudget)}`;
}

export function formatFooterStatus(
  goal: ThreadGoal | null,
  recoveryAttention: RecoveryAttention | null = null,
  providerLimitAutoResumeScheduled = false,
): string | undefined {
  if (!goal) {
    return undefined;
  }

  if (goal.status === "budgetLimited") {
    if (goal.tokenBudget !== null) {
      return say(`Цель не достигнута (${compactBudgetUsage(goal)} токенов)`, `Goal unmet (${compactBudgetUsage(goal)} tokens)`);
    }
    return say("Цель оставлена", "Goal abandoned");
  }

  if (goal.status === "paused" && providerLimitAutoResumeScheduled) {
    return say("Цель на паузе: исчерпан лимит провайдера. Автовозобновление попробует примерно через 5 минут. /gr сделает цель активной без нового хода, /gc очистит цель и остановит автовозобновление.", "Goal paused because the provider usage limit was reached. Auto-resume will retry in about 5 minutes. Use /gr to mark active without starting a turn, or /gc to clear the goal and stop auto-resume.");
  }

  const recoveryAttentionMessage = formatRecoveryAttention(recoveryAttention);
  if (recoveryAttentionMessage) {
    return recoveryAttentionMessage;
  }

  if (goal.status === "active") {
    if (goal.tokenBudget !== null) {
      return say(`Работаю над целью (${compactBudgetUsage(goal)})`, `Pursuing goal (${compactBudgetUsage(goal)})`);
    }
    if (goal.usage.activeSeconds > 0) {
      return say(`Работаю над целью (${formatDuration(goal.usage.activeSeconds)})`, `Pursuing goal (${formatDuration(goal.usage.activeSeconds)})`);
    }
    return say("Работаю над целью", "Pursuing goal");
  }

  if (goal.status === "paused") {
    return say("Цель на паузе (/gr сделает её активной; затем отправь сообщение, чтобы продолжить)", "Goal paused (/gr to mark active; then send a message to continue)");
  }

  if (goal.tokenBudget !== null) {
    return say(`Цель достигнута (${formatCompactTokenValue(goal.usage.tokensUsed)} токенов)`, `Goal achieved (${formatCompactTokenValue(goal.usage.tokensUsed)} tokens)`);
  }
  if (goal.usage.activeSeconds > 0) {
    return say(`Цель достигнута (${formatDuration(goal.usage.activeSeconds)})`, `Goal achieved (${formatDuration(goal.usage.activeSeconds)})`);
  }
  return say("Цель достигнута", "Goal achieved");
}

export function toToolGoal(goal: ThreadGoal): GoalToolRecord {
  return {
    ...(goal.pause ? { pause: { ...goal.pause } } : {}),
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.usage.tokensUsed,
    timeUsedSeconds: goal.usage.activeSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    ...(goal.agreement ? { agreement: { ...goal.agreement } } : {}),
    ...(goal.selfDecided ? { selfDecided: goal.selfDecided.map((item) => ({ ...item })) } : {}),
  };
}

export function remainingTokens(goal: ThreadGoal | null): number | null {
  if (!goal || goal.tokenBudget === null) {
    return null;
  }
  return Math.max(0, goal.tokenBudget - goal.usage.tokensUsed);
}

export function completionBudgetReport(goal: ThreadGoal | null): string | null {
  if (!goal || goal.status !== "complete") {
    return null;
  }
  if (goal.tokenBudget === null && goal.usage.activeSeconds <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (goal.usage.activeSeconds > 0) {
    parts.push(say(`время работы: ${formatDuration(goal.usage.activeSeconds)}.`, `time used: ${formatDuration(goal.usage.activeSeconds)}.`));
  }
  if (goal.tokenBudget !== null) {
    parts.push(say(`использовано токенов: ${formatInteger(goal.usage.tokensUsed)} из ${formatInteger(goal.tokenBudget)}.`, `tokens used: ${formatInteger(goal.usage.tokensUsed)} of ${formatInteger(goal.tokenBudget)}.`));
  } else if (goal.usage.tokensUsed > 0) {
    parts.push(say(`использовано токенов: ${formatInteger(goal.usage.tokensUsed)}.`, `tokens used: ${formatInteger(goal.usage.tokensUsed)}.`));
  }

  return say(`Цель достигнута. Сообщи пользователю итоговый расход бюджета: ${parts.join(" ")}`, `Goal achieved. Report final budget usage to the user: ${parts.join(" ")}`);
}

/** Merge canonical projection and replayed legacy report state, returning the current report and last useful verification. */
export function goalWorkingProgress(
  projection: GoalProjectionState | null,
  reportState: GoalReportState | null,
 ): { progress: GoalProgressReport | null; latestUsefulVerification: string | null } {
  if (projection && (projection.latestProgress || projection.progressInvalidated)) {
    return { progress: projection.latestProgress, latestUsefulVerification: projection.workVerification };
  }
  return { progress: reportState?.lastReport ?? null, latestUsefulVerification: reportState?.latestUsefulVerification ?? null };
}

export function goalWorkingState(
  goal: ThreadGoal | null,
  projection: GoalProjectionState | null,
  reportState: GoalReportState | null,
  artifactRefs: GoalArtifactRef[] = [],
): GoalWorkingState {
  const workingProgress = goalWorkingProgress(projection, reportState);
  const progress = workingProgress.progress;
  const work = projection?.workState;
  const preservedContext = projection ? goalPreservedContext(projection) : null;
  const latestUsefulVerification = work
    ? projection?.workStateStale ? null : work.verification || (projection?.verifiedWorkRevision === projection?.workRevision ? projection?.workVerification ?? null : null)
    : workingProgress.latestUsefulVerification;
  return {
    lifecycle: goal?.status ?? null,
    goal: goal ? toToolGoal(goal) : null,
    currentStep: work ? work.items.filter((item) => item.status === "active").map((item) => item.title).join("; ") || work.summary : progress?.phase ?? null,
    workState: cloneGoalWorkState(projection?.workState ?? null),
    workRevision: projection?.workRevision ?? 0,
    workStateStale: projection?.workStateStale ?? false,
    activeDecisions: projection?.decisions.filter((entry) => projection.workState?.activeDecisionIds.includes(entry.id)).map((entry) => ({ ...entry })) ?? [],
    paperCuts: projection?.paperCuts.map(({ id, title, severity, status, resolution, revision }) => ({ id, title, severity, status, ...(resolution === undefined ? {} : { resolution }), revision: revision ?? 0 })) ?? [],
    progressStatus: progress?.status ?? null,
    nextStep: work ? selectNextGoalWork(work)?.title ?? null : progress?.nextStep ?? null,
    latestUsefulVerification,
    blocker: work?.items.find((item) => item.status === "blocked")?.result || work?.items.find((item) => item.status === "blocked")?.title || ((progress?.status === "blocked" || progress?.status === "awaiting_user") ? progress.problemOrDecision ?? null : null),
    needUser: progress?.needUser ?? null,
    awaitingUser: reportState?.awaitingUser ?? progress?.status === "awaiting_user",
    requiresUserDecision: reportState ? reportState.awaitingUser && (reportState.requiresUserDecision ?? true) : progress?.status === "awaiting_user",
    continuationHeld: reportState ? reportState.awaitingUser && !reportState.questionAnswerPending : false,
    usage: goal?.usage ? { ...goal.usage } : { tokensUsed: 0, activeSeconds: 0 },
    projection: projection ? {
      stateSeq: projection.stateSeq,
      currentProjectionSeq: projection.currentProjectionSeq,
      fresh: projection.currentProjectionSeq === projection.stateSeq,
      repairPending: projection.languageRepair !== null,
    } : null,
    userAnswerReceived: reportState?.hasUserDecisionSinceAwaiting ?? false,
    artifactRefs: artifactRefs.map((ref) => ({ ...ref })),
    history: { source: "session-events", ...(preservedContext ? { preservedContext } : {}) },
  };
}

/** Return only the state needed to choose the next goal action after a successful write. */
export function goalActionWorkingState(workingState: GoalWorkingState): GoalActionWorkingState {
  const projection = workingState.projection;
  return {
    lifecycle: workingState.lifecycle,
    currentStep: workingState.currentStep,
    progressStatus: workingState.progressStatus,
    nextStep: workingState.nextStep,
    latestUsefulVerification: workingState.latestUsefulVerification,
    blocker: workingState.blocker,
    needUser: workingState.needUser,
    awaitingUser: workingState.awaitingUser,
    requiresUserDecision: workingState.requiresUserDecision ?? workingState.awaitingUser,
    continuationHeld: workingState.continuationHeld,
    userAnswerReceived: workingState.userAnswerReceived,
    ...(projection && (!projection.fresh || projection.repairPending) ? { projection: { ...projection } } : {}),
  };
}

/** Return live status metadata without treating omitted obligations as read or completed. */
export function goalStatusWorkingState(workingState: GoalWorkingState): GoalStatusWorkingState {
  const { goal, workState: _work, activeDecisions: _decisions, paperCuts: _cuts, ...metadata } = workingState;
  let identity: Omit<GoalToolRecord, "objective"> | null = null;
  if (goal) {
    const { objective: _objective, ...record } = goal;
    identity = record;
  }
  return {
    ...metadata,
    ...goalActionWorkingState(workingState),
    goal: identity,
    omitted: ["goal.objective", "workState", "activeDecisions", "paperCuts"],
    fullStateRequiredFor: say("Для контракта, плана, решений и проверки завершения читай get_goal без view=status. Никакое чтение не даёт права снять удержание.", "Read get_goal without view=status for the contract, plan, decisions or completion audit. No read grants permission to change a hold."),
  };
}

export function goalToolResponse(goal: ThreadGoal | null, includeCompletionBudgetReport = false): GoalToolResponse {
  return {
    goal: goal ? toToolGoal(goal) : null,
    remainingTokens: remainingTokens(goal),
    completionBudgetReport: includeCompletionBudgetReport ? completionBudgetReport(goal) : null,
  };
}

export function toToolText(goal: ThreadGoal | null, includeCompletionBudgetReport = false): string {
  return JSON.stringify(goalToolResponse(goal, includeCompletionBudgetReport), null, 2);
}
