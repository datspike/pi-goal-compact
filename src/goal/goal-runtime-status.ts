import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { STATUS_KEY } from "../records.js";
import { formatDuration, formatFooterStatus } from "./format.js";
import { type GoalProgressHistoryEntry, type GoalReportState } from "./goal-reports.js";
import { isGoalProgressSemanticText, stripGoalTerminalControls, type GoalProgressStatus } from "./report-schema.js";
import type { GoalRecoveryMachineState } from "./recovery-machine.js";
import type { SessionEntryLike, ThreadGoal } from "./types.js";

/** Что расширение делает сейчас: показывается в строке цели. */
export interface GoalRuntimeActivity {
  label: string;
  detail?: string;
}

export interface StatusContext {
  cwd?: string;
  mode?: ExtensionContext["mode"];
  sessionManager?: { getBranch(): Iterable<SessionEntryLike> };
  ui: Pick<ExtensionContext["ui"], "setStatus">;
}

export interface GoalWidgetLink {
  label: string;
  path: string;
}

interface GoalRuntimeStatusDeps {
  getGoalForDisplay: () => ThreadGoal | null;
  getGoalStatus: () => ThreadGoal["status"] | null;
  getRecoveryAttention: () => GoalRecoveryMachineState["attention"];
  isProviderLimitAutoResumeScheduled: (goalId: string) => boolean;
  getReportState: () => GoalReportState;
  getAgentRunSequence?: () => number;
  getArtifactRefs?: (goal: ThreadGoal, ctx: StatusContext) => GoalWidgetLink[];
  setActivity: (activity: GoalRuntimeActivity | null) => void;
}

function compactSemanticText(value: string | undefined): string | null {
  const compact = stripGoalTerminalControls(value ?? "").replace(/\s+/g, " ").trim();
  if (!compact || !isGoalProgressSemanticText(compact)) return null;
  return [...compact].length <= 160 ? compact : `${[...compact].slice(0, 157).join("").trimEnd()}…`;
}

const CURRENT_ACTION_FALLBACK = "Работаю над целью";

function completedActionText(item: GoalProgressHistoryEntry): string | null {
  return compactSemanticText(item.report.completed)
    ?? compactSemanticText(item.report.changed)
    ?? compactSemanticText(item.report.verification)
    ?? compactSemanticText(item.report.riskAndComplexity)
    ?? compactSemanticText(item.report.problemOrDecision);
}

function currentActionText(item: GoalProgressHistoryEntry): string {
  const rawPhase = item.report.phase?.trim();
  const phase = compactSemanticText(item.report.phase);
  if (phase) return phase;
  if (rawPhase) return CURRENT_ACTION_FALLBACK;
  return compactSemanticText(item.report.problemOrDecision) ?? CURRENT_ACTION_FALLBACK;
}

/** Kept as a pure formatter for non-TUI integrations and replay tests. */
export function formatGoalProgressWidget(goal: ThreadGoal, reportState: GoalReportState, progressOverride?: GoalProgressStatus): string[] {
  const current = reportState.recentReports.at(-1);
  const reportStatus = (reportState.lastReport ?? current?.report)?.status;
  // blocked тоже держит продолжение, но в заголовке остаётся блокером, а не вопросом пользователю.
  const progress = progressOverride ?? (reportState.awaitingUser && !reportState.hasUserDecisionSinceAwaiting && (reportState.requiresUserDecision ?? reportStatus !== "blocked")
    ? "awaiting_user" : reportStatus);
  const heading = goal.status === "complete" ? "✓ Завершена"
    : goal.status === "paused" ? "На паузе"
    : goal.status === "budgetLimited" ? "Лимит бюджета"
    : progress === "awaiting_user" && !reportState.hasUserDecisionSinceAwaiting ? "Жду ответа"
    : progress === "blocked" ? "Заблокировано"
    : progress === "verifying" ? "Проверяю" : "Работаю";
  const lines = [`${heading} · ${formatDuration(goal.usage.activeSeconds)}`];
  if (goal.status !== "active") {
    return [...lines, ...reportState.recentReports
      .map((item) => completedActionText(item) ?? compactSemanticText(item.report.summary))
      .filter((text): text is string => text !== null)
      .slice(-2)
      .map((text) => `✓ ${text}`)];
  }
  if (!current) return [...lines, "→ Работаю над целью"];
  const completed = reportState.recentReports
    .slice(0, -1)
    .map((item) => completedActionText(item))
    .filter((text): text is string => text !== null)
    .slice(-2)
    .map((text) => `✓ ${text}`);
  return [...lines, ...completed, `→ ${currentActionText(current)}`];
}

function formatFooterStatusForRuntime(deps: GoalRuntimeStatusDeps): string | undefined {
  const goal = deps.getGoalForDisplay();
  return formatFooterStatus(
    goal,
    deps.getRecoveryAttention(),
    goal ? deps.isProviderLimitAutoResumeScheduled(goal.goalId) : false,
  );
}

function formatLiveStatus(deps: GoalRuntimeStatusDeps, resumedBlocker: boolean): string | undefined {
  const goal = deps.getGoalForDisplay();
  if (!goal) return undefined;
  const reportState = deps.getReportState();
  const reportStatus = (reportState.lastReport ?? reportState.recentReports.at(-1)?.report)?.status;
  const attention = deps.getRecoveryAttention();
  const heading = goal.status === "complete" ? "✓ Завершена"
    : goal.status === "paused" ? "На паузе"
    : goal.status === "budgetLimited" ? "Лимит бюджета"
    : reportState.awaitingUser && !reportState.hasUserDecisionSinceAwaiting && (reportState.requiresUserDecision ?? reportStatus !== "blocked") ? "Жду ответа"
    : attention || (reportStatus === "blocked" && !resumedBlocker) ? "Заблокировано"
    : reportStatus === "verifying" ? "Проверяю" : "Работаю";
  const base = `${heading} · ${formatDuration(goal.usage.activeSeconds)}`;
  const legacyAttention = formatFooterStatusForRuntime(deps);
  if (attention && legacyAttention) return `${base} — ${stripGoalTerminalControls(legacyAttention)}`;
  return base;
}

export function createGoalRuntimeStatus(deps: GoalRuntimeStatusDeps) {
  let statusContext: StatusContext | null = null;
  let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let dismissedCompletedGoalId: string | null = null;
  let previousGoal: Pick<ThreadGoal, "goalId" | "status"> | null = null;
  let runSequence = deps.getAgentRunSequence?.();
  let resumedBlocker: { goalId: string; reportId: string } | null = null;

  const render = (): void => {
    if (!statusContext) return;
    const goal = deps.getGoalForDisplay();
    const reportState = deps.getReportState();
    const nextRunSequence = deps.getAgentRunSequence?.();
    const reportId = reportState.lastReportId ?? reportState.recentReports.at(-1)?.reportId;
    const reportStatus = (reportState.lastReport ?? reportState.recentReports.at(-1)?.report)?.status;
    const sameGoal = goal && previousGoal?.goalId === goal.goalId;
    if (!sameGoal) resumedBlocker = null;
    if (sameGoal && goal.status === "active" && reportId && reportStatus === "blocked" &&
      (nextRunSequence !== runSequence || previousGoal?.status !== "active")) {
      resumedBlocker = { goalId: goal.goalId, reportId };
    }
    runSequence = nextRunSequence;
    previousGoal = goal ? { goalId: goal.goalId, status: goal.status } : null;
    const blockerWasResumed = goal?.goalId === resumedBlocker?.goalId && reportId === resumedBlocker?.reportId;
    const dismissed = goal?.status === "complete" && goal.goalId === dismissedCompletedGoalId;
    statusContext.ui.setStatus(STATUS_KEY.goal, dismissed ? undefined : formatLiveStatus(deps, blockerWasResumed));
  };

  const stopStatusRefresh = (clearStatus = false): void => {
    if (statusRefreshTimer) {
      clearInterval(statusRefreshTimer);
      statusRefreshTimer = null;
    }
    deps.setActivity(null);
    if (clearStatus) statusContext?.ui.setStatus(STATUS_KEY.goal, undefined);
  };

  const syncStatusRefresh = (): void => {
    if (deps.getGoalStatus() === "active" && statusContext && !statusRefreshTimer) {
      statusRefreshTimer = setInterval(() => {
        if (!statusContext || deps.getGoalStatus() !== "active") {
          stopStatusRefresh();
          return;
        }
        render();
      }, 1_000);
      statusRefreshTimer.unref?.();
      return;
    }
    if (deps.getGoalStatus() !== "active") stopStatusRefresh();
  };

  const refreshUi = (ctx: StatusContext): void => {
    statusContext = ctx;
    ctx.ui.setStatus(STATUS_KEY.goal, undefined);
    const goal = deps.getGoalForDisplay();
    if (!goal || goal.goalId !== dismissedCompletedGoalId || goal.status !== "complete") dismissedCompletedGoalId = null;
    render();
    syncStatusRefresh();
  };

  const dismissCompletedGoal = (ctx: StatusContext): void => {
    const goal = deps.getGoalForDisplay();
    if (!goal || goal.status !== "complete") return;
    statusContext = ctx;
    dismissedCompletedGoalId = goal.goalId;
    stopStatusRefresh(true);
  };

  const setActivity = (activity: GoalRuntimeActivity | null, options: { refresh?: boolean } = {}): void => {
    deps.setActivity(activity);
    if (options.refresh !== false) render();
  };

  return {
    dismissCompletedGoal,
    refreshUi,
    setActivity,
    stopStatusRefresh,
    /** Compatibility surface for old hosts; the new UI has no expandable widget. */
    toggleWidget(ctx: StatusContext) {
      refreshUi(ctx);
    },
  };
}
