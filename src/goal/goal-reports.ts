import { say } from "../language.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GoalArtifactRef, GoalUsage, SessionEntryLike, ThreadGoal } from "./types.js";
import { RECORD } from "../records.js";
import { isGoalProjectionEvent } from "./goal-projection-reducer.js";
import {
  type GoalProgressEventKind,
  type GoalProgressReport,
  type GoalProgressStatus,
  goalProgressEventLabel,
  isGoalProgressSemanticText,
  isRecord,
  normalizedGoalProgressEventKind,
  stripGoalTerminalControls,
  validateGoalProgressReport,
} from "./report-schema.js";
import { DEFAULT_GOAL_REPORT_POLICY, type GoalReportPolicy } from "./goal-report-config.js";

export const GOAL_PROJECTION_ENTRY_TYPE = RECORD.projection;
export const GOAL_PROGRESS_ENTRY_TYPE = RECORD.progress;
export const GOAL_PROGRESS_INSTRUCTION_CUSTOM_TYPE = RECORD.progressInstruction;
/** Hidden message steered into a running turn when a progress report is due. */
export const GOAL_PROGRESS_DUE_CUSTOM_TYPE = RECORD.progressDue;
const ARTIFACT_PATH_INDENT = "    ";

export type GoalReportAction = "publish" | "suppress";
export type GoalReportDueReason = "periodic_time" | "periodic_turns" | "compaction";

interface GoalReportEntryBase {
  version: 1;
  goalId: string;
  createdAt: number;
  turnIndex: number | null;
  activeSeconds: number;
  tokensUsed: number;
}

export type GoalReportEntry =
  | (GoalReportEntryBase & {
      kind: "assistant_turn";
      assistantTurns: number;
    })
  | (GoalReportEntryBase & {
      kind: "publish";
      reportId: string;
      triggerReason: GoalReportDueReason | "manual";
      report: GoalProgressReport;
      artifactRefs?: GoalArtifactRef[];
      assistantTurns?: number;
    })
  | (GoalReportEntryBase & { kind: "suppress"; assistantTurns?: number })
  | (GoalReportEntryBase & {
      kind: "due";
      dueReason: GoalReportDueReason;
      dueReasons?: GoalReportDueReason[];
      assistantTurns?: number;
    })
  | { version: 1; kind: "user_decision"; goalId: string; createdAt: number; confirmed?: boolean }
  | { version: 1; kind: "user_input"; goalId: string; createdAt: number };

export interface GoalProgressHistoryEntry {
  reportId: string;
  createdAt: number;
  eventKind: GoalProgressEventKind;
  report: GoalProgressReport;
}

export interface GoalReportState {
  policy: GoalReportPolicy;
  lastReportId: string | null;
  lastReportAt: number | null;
  lastReportTurn: number | null;
  lastReport: GoalProgressReport | null;
  latestUsefulVerification: string | null;
  lastEventKind: GoalProgressEventKind | null;
  recentReports: GoalProgressHistoryEntry[];
  dueReason: GoalReportDueReason | null;
  dueReasons: GoalReportDueReason[];
  lastActionActiveSeconds: number;
  lastActionTurn: number;
  assistantTurns: number;
  instructionInjected: boolean;
  awaitingUser: boolean;
  requiresUserDecision?: boolean;
  hasUserDecisionSinceAwaiting: boolean;
  hasUserReplySinceAwaiting?: boolean;
  questionAnswerPending: boolean;
}

export function createGoalReportState(policy: GoalReportPolicy = DEFAULT_GOAL_REPORT_POLICY): GoalReportState {
  return {
    policy: { ...policy },
    lastReportId: null,
    lastReportAt: null,
    lastReportTurn: null,
    lastReport: null,
    latestUsefulVerification: null,
    lastEventKind: null,
    recentReports: [],
    dueReason: null,
    dueReasons: [],
    lastActionActiveSeconds: 0,
    lastActionTurn: 0,
    assistantTurns: 0,
    instructionInjected: false,
    awaitingUser: false,
    requiresUserDecision: false,
    hasUserDecisionSinceAwaiting: false,
    hasUserReplySinceAwaiting: false,
    questionAnswerPending: false,
  };
}

/** Keep the same sticky hold rules for live reports and both replay formats. */
function applyReportHold(state: GoalReportState, report: GoalProgressReport): void {
  if (holdsContinuation(report.status)) {
    // A blocked report must not discard an unanswered choice.
    state.requiresUserDecision = (state.requiresUserDecision ?? state.awaitingUser) || report.status === "awaiting_user";
    state.awaitingUser = true;
  } else if (report.status === "working" && (state.hasUserDecisionSinceAwaiting || state.hasUserReplySinceAwaiting)) {
    state.awaitingUser = false;
    state.requiresUserDecision = false;
  } else return;
  state.hasUserDecisionSinceAwaiting = false;
  state.hasUserReplySinceAwaiting = false;
  state.questionAnswerPending = false;
}

function questionCallIds(message: unknown): string[] {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter((part) => isRecord(part) && part.type === "toolCall" && part.name === "ask_user" && typeof part.id === "string").map((part) => part.id as string);
}

function hasQuestionAnswer(result: unknown): result is Record<string, unknown> {
  if (!isRecord(result) || result.role !== "toolResult" || result.toolName !== "ask_user" || result.isError !== false) return false;
  const details = result.details;
  if (!isRecord(details) || details.cancelled !== false || !isRecord(details.response)) return false;
  const nonempty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  const answered = (value: unknown): boolean => isRecord(value) && (
    value.kind === "freeform" && nonempty(value.text) ||
    value.kind === "selection" && Array.isArray(value.selections) && value.selections.length > 0 && value.selections.every(nonempty)
  );
  return details.mode === "single" ? answered(details.response) : details.mode === "batch" && details.response.kind === "batch" && Array.isArray(details.response.answers) && details.response.answers.some(answered);
}

/** Only a successful result paired with this turn's ask_user call is a user decision. */
export function answeredQuestionCallIds(message: unknown, results: readonly unknown[]): string[] {
  const calls = new Set(questionCallIds(message));
  return results.filter(hasQuestionAnswer).filter(result => typeof result.toolCallId === "string" && calls.has(result.toolCallId)).map(result => result.toolCallId as string);
}

/** Последняя запись ветки с настоящей репликой владельца: его сообщение или ответ `ask_user`. */
export function latestOwnerEntryId(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message" || typeof entry.id !== "string") continue;
    const message = entry.message;
    if (isRecord(message) && (message.role === "user" || hasQuestionAnswer(message))) return entry.id;
  }
  return null;
}

function consumeQuestionAnswer(message: unknown, calls: Set<string>): string | null {
  if (!isRecord(message)) return null;
  if (message.role === "assistant") {
    calls.clear();
    for (const id of questionCallIds(message)) calls.add(id);
  }
  return message.role === "toolResult" && typeof message.toolCallId === "string" && calls.delete(message.toolCallId) && hasQuestionAnswer(message)
    ? message.toolCallId : null;
}

function isUsageSnapshot(value: unknown): value is GoalUsage {
  return (
    isRecord(value) &&
    typeof value.tokensUsed === "number" &&
    Number.isFinite(value.tokensUsed) &&
    typeof value.activeSeconds === "number" &&
    Number.isFinite(value.activeSeconds)
  );
}

function isPersistedGoalProgressReport(value: unknown): value is GoalProgressReport {
  if (validateGoalProgressReport(value) === null) {
    return true;
  }
  // v1 entries produced before awaiting_user required a visible question remain
  // readable after upgrade; new tool calls are still rejected atomically.
  return (
    isRecord(value) &&
    value.status === "awaiting_user" &&
    value.needUser === undefined &&
    validateGoalProgressReport({ ...value, needUser: "Legacy user decision required." }) === null
  );
}

function isAssistantTurnCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isGoalReportDueReasons(value: unknown): value is GoalReportDueReason[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length > 0 && value.every(isGoalReportDueReason));
}

export function isGoalReportEntry(value: unknown): value is GoalReportEntry {
  if (!isRecord(value) || value.version !== 1 || typeof value.createdAt !== "number" ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    return false;
  }
  if (value.kind === "user_decision" || value.kind === "user_input") {
    return typeof value.goalId === "string" && (value.kind !== "user_decision" || value.confirmed === undefined || typeof value.confirmed === "boolean");
  }
  if (
    typeof value.goalId !== "string" ||
    (value.turnIndex !== null && (typeof value.turnIndex !== "number" || !Number.isSafeInteger(value.turnIndex) || value.turnIndex < 0)) ||
    !isUsageSnapshot({ tokensUsed: value.tokensUsed, activeSeconds: value.activeSeconds })
  ) {
    return false;
  }
  if (value.kind === "assistant_turn") {
    return isAssistantTurnCount(value.assistantTurns);
  }
  if (value.kind === "suppress") {
    return value.assistantTurns === undefined || isAssistantTurnCount(value.assistantTurns);
  }
  if (value.kind === "due") {
    return isGoalReportDueReason(value.dueReason) &&
      isGoalReportDueReasons(value.dueReasons) &&
      (value.assistantTurns === undefined || isAssistantTurnCount(value.assistantTurns));
  }
  return (
    value.kind === "publish" &&
    typeof value.reportId === "string" &&
    (value.assistantTurns === undefined || isAssistantTurnCount(value.assistantTurns)) &&
    (value.triggerReason === "manual" || isGoalReportDueReason(value.triggerReason)) &&
    isPersistedGoalProgressReport(value.report) &&
    (value.artifactRefs === undefined || (Array.isArray(value.artifactRefs) && value.artifactRefs.every((ref) => ref && typeof ref === "object")))
  );
}

function isGoalReportDueReason(value: unknown): value is GoalReportDueReason {
  return value === "periodic_time" || value === "periodic_turns" || value === "compaction";
}

function hasSemanticActionText(report: GoalProgressReport): boolean {
  return [
    report.completed,
    report.changed,
    report.verification,
    report.riskAndComplexity,
    report.problemOrDecision,
  ].some((value) => isGoalProgressSemanticText(value));
}

function turnAnchor(turnIndex: number | null): number {
  return turnIndex === null ? 0 : Math.max(0, Math.trunc(turnIndex) + 1);
}

function applyActionAnchor(
  state: GoalReportState,
  entry: Exclude<GoalReportEntry, { kind: "user_decision" | "user_input" }>,
): void {
  state.lastActionActiveSeconds = Math.max(0, Math.trunc(entry.activeSeconds));
  // Старые publish/suppress не хранили durable assistantTurns. Их anchor —
  // счётчик, уже восстановленный к позиции entry, а не SDK turnIndex.
  state.lastActionTurn = entry.kind === "publish" || entry.kind === "suppress"
    ? entry.assistantTurns ?? state.assistantTurns
    : turnAnchor(entry.turnIndex);
  if (entry.kind === "publish") {
    const eventKind = normalizedGoalProgressEventKind(entry.report);
    const report = { ...entry.report };
    state.lastReport = report;
    if (report.verification) state.latestUsefulVerification = report.verification;
    state.lastEventKind = eventKind;
    const current = { reportId: entry.reportId, createdAt: entry.createdAt, eventKind, report };
    const previousSemantic = state.recentReports
      .filter((item) => item.reportId !== entry.reportId)
      .filter((item) => hasSemanticActionText(item.report));
    state.recentReports = [
      ...[...previousSemantic, current].slice(-3, -1),
      current,
    ];
  }
  state.dueReason = null;
  state.dueReasons = [];
  state.instructionInjected = false;
}

function legacySuppressFingerprint(entry: Extract<GoalReportEntry, { kind: "suppress" }>): string | null {
  if (entry.assistantTurns !== undefined) {
    return null;
  }
  return [entry.goalId, entry.createdAt, entry.turnIndex, entry.activeSeconds, entry.tokensUsed].join("|");
}

/** Read legacy reports alongside the canonical semantic stream without double-counting migrated entries. */
function normalizeReportEntries(entries: readonly SessionEntryLike[]): SessionEntryLike[] {
  const canonicalIds = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_PROJECTION_ENTRY_TYPE || !isGoalProjectionEvent(entry.data)) continue;
    if (entry.data.kind === "progress_reported" && entry.data.reportAnchor && entry.data.reportId) canonicalIds.add(entry.data.reportId);
  }
  return entries.flatMap((entry): SessionEntryLike[] => {
    if (entry.type !== "custom") return [entry];
    if (entry.customType === GOAL_PROGRESS_ENTRY_TYPE && isGoalReportEntry(entry.data) &&
        entry.data.kind === "publish" && canonicalIds.has(entry.data.reportId)) return [];
    if (entry.customType !== GOAL_PROJECTION_ENTRY_TYPE || !isGoalProjectionEvent(entry.data) ||
        entry.data.kind !== "progress_reported" || !entry.data.reportAnchor || !entry.data.reportId) return [entry];
    const event = entry.data;
    const anchor = event.reportAnchor!;
    const published: Extract<GoalReportEntry, { kind: "publish" }> = {
      version: 1, kind: "publish", goalId: event.goalId, reportId: event.reportId!,
      createdAt: event.createdAt ?? 0, turnIndex: anchor.turnIndex,
      activeSeconds: anchor.activeSeconds, tokensUsed: anchor.tokensUsed,
      assistantTurns: anchor.assistantTurns, triggerReason: "manual", report: event.report,
    };
    return [{ ...entry, customType: GOAL_PROGRESS_ENTRY_TYPE, data: published }];
  });
}

/**
 * Статусы, после которых скрытые продолжения ждут сообщения пользователя. `blocked` держит так же,
 * как `awaiting_user`: без удержания модель получала продолжения на неснимаемом блокере и повторяла
 * тот же отказ или расширяла задачу вместо остановки.
 */
export function holdsContinuation(status: GoalProgressStatus | undefined): boolean {
  return status === "awaiting_user" || status === "blocked";
}

export function reconstructGoalReportState(
  entries: Iterable<SessionEntryLike>,
  goalId: string | null,
  policy: GoalReportPolicy = DEFAULT_GOAL_REPORT_POLICY,
 ): GoalReportState {
  const state = createGoalReportState(policy);
  const reportIds = new Set<string>();
  const legacySuppresses = new Set<string>();

  const questionCalls = new Set<string>();
  const answeredQuestions = new Set<string>();
  for (const entry of normalizeReportEntries([...entries])) {
    if (entry.type === "message" && isRecord(entry) && isRecord(entry.message)) {
      const message = entry.message;
      const answeredId = consumeQuestionAnswer(message, questionCalls);
      if (answeredId !== null && !answeredQuestions.has(answeredId)) {
        answeredQuestions.add(answeredId);
        if (state.awaitingUser) {
          state.hasUserReplySinceAwaiting = true;
          state.questionAnswerPending = true;
        }
      }
      if (message.role === "assistant" && message.stopReason !== "toolUse") state.questionAnswerPending = false;
    }
    if (entry.type === "custom" && entry.customType === GOAL_PROJECTION_ENTRY_TYPE && isGoalProjectionEvent(entry.data) && entry.data.goalId === goalId && entry.data.kind === "progress_reported" && !entry.data.reportAnchor) {
      state.lastReport = { ...entry.data.report };
      state.lastReportId = entry.data.reportId ?? null;
      state.lastReportAt = entry.data.createdAt ?? null;
      state.lastReportTurn = null;
      state.lastEventKind = normalizedGoalProgressEventKind(entry.data.report);
      if (entry.data.report.verification) state.latestUsefulVerification = entry.data.report.verification;
      applyReportHold(state, entry.data.report);
      continue;
    }
    if (entry.type !== "custom" || entry.customType !== GOAL_PROGRESS_ENTRY_TYPE || !isGoalReportEntry(entry.data)) {
      continue;
    }
    if (entry.data.goalId !== goalId) {
      continue;
    }
    if (entry.data.kind === "user_input") {
      if (state.awaitingUser) state.hasUserReplySinceAwaiting = true;
      continue;
    }
    if (entry.data.kind === "user_decision") {
      if (state.awaitingUser) {
        if (entry.data.confirmed === true) state.hasUserDecisionSinceAwaiting = true;
        else state.hasUserReplySinceAwaiting = true;
      }
      continue;
    }
    if (entry.data.kind === "assistant_turn") {
      state.assistantTurns = Math.max(state.assistantTurns, entry.data.assistantTurns);
      continue;
    }
    if (entry.data.kind === "due") {
      state.dueReason = entry.data.dueReason;
      state.dueReasons = entry.data.dueReasons?.length ? [...entry.data.dueReasons] : [entry.data.dueReason];
      if (entry.data.assistantTurns !== undefined) {
        state.assistantTurns = Math.max(state.assistantTurns, entry.data.assistantTurns);
      }
      continue;
    }
    if (entry.data.kind === "suppress") {
      const fingerprint = legacySuppressFingerprint(entry.data);
      if (fingerprint !== null) {
        if (legacySuppresses.has(fingerprint)) {
          continue;
        }
        legacySuppresses.add(fingerprint);
      }
      applyActionAnchor(state, entry.data);
      continue;
    }
    if (reportIds.has(entry.data.reportId)) {
      continue;
    }
    reportIds.add(entry.data.reportId);
    applyActionAnchor(state, entry.data);
    applyReportHold(state, entry.data.report);
    state.lastReportId = entry.data.reportId;
    state.lastReportAt = entry.data.createdAt;
    state.lastReportTurn = entry.data.turnIndex;
  }
  return state;
}

export function reportDueReasons(
  state: GoalReportState,
  goal: ThreadGoal | null,
  _turnIndex: number | null,
 ): GoalReportDueReason[] {
  if (!goal || goal.status !== "active" || state.dueReason !== null) {
    return [];
  }
  const reasons: GoalReportDueReason[] = [];
  if (goal.usage.activeSeconds - state.lastActionActiveSeconds >= state.policy.afterActiveSeconds) {
    reasons.push("periodic_time");
  }
  if (state.assistantTurns - state.lastActionTurn >= state.policy.afterAssistantTurns) {
    reasons.push("periodic_turns");
  }
  return reasons;
}


export function goalProgressInstruction(dueReason: GoalReportDueReason): string {
  return [
    say("Пора отчитаться о ходе активной цели.", "A progress report is due for the active goal."),
    say(`Вызови report_goal_progress с action \"publish\" или \"suppress\" до продолжения работы или вместе с ним (reason: ${dueReason}).`, `Call report_goal_progress with action \"publish\" or \"suppress\" before or alongside further work (reason: ${dueReason}).`),
    say("Сообщай только фактические изменения. summary пиши для вернувшегося пользователя: 1–3 связных предложения о том, что изменилось с прошлого отчёта, что это значит сейчас и что будет дальше. Не описывай работу инструментов и не повторяй цель. В phase коротко назови текущее содержательное действие в настоящем времени.", "Report only the factual delta. Write summary for the returning user: 1–3 connected sentences linking what changed since the previous report, what it means now, and what happens next. Do not include harness/tool activity or repeat the objective. Write phase as the short current meaningful action in present tense."),
    say("Для awaiting_user назови нужное решение. После обычного ответа пользователя при необходимости добавь согласованное изменение, затем опубликуй working; suppress и другие статусы не снимают удержание скрытого продолжения.", "For awaiting_user, state the needed decision. After an ordinary user answer, append an approved amendment if needed, then publish working; suppress and other statuses do not release the hidden-continuation hold."),
    say("Не пересказывай ход рассуждений и внутренние размышления.", "Do not include chain-of-thought, hidden reasoning, or a narrative of internal deliberation."),
    say("Это относится только к текущему моменту: если после этого сообщения отчёт уже опубликован, не обращай внимания.", "This applies to the current moment only: ignore it if a progress report was published after this message."),
  ].join(" ");
}

export function createGoalReports(pi: Pick<ExtensionAPI, "appendEntry">) {
  let state = createGoalReportState();
  let publishedReports = new Map<string, Extract<GoalReportEntry, { kind: "publish" }>>();
  const answeredQuestions = new Set<string>();

  const reload = (entries: Iterable<SessionEntryLike>, goalId: string | null): void => {
    const branch = [...entries];
    state = reconstructGoalReportState(branch, goalId, state.policy);
    answeredQuestions.clear();
    const questionCalls = new Set<string>();
    for (const entry of branch) {
      if (entry.type !== "message" || !isRecord(entry)) continue;
      const answeredId = consumeQuestionAnswer(entry.message, questionCalls);
      if (answeredId !== null) answeredQuestions.add(answeredId);
    }
    publishedReports = new Map();
    for (const entry of normalizeReportEntries(branch)) {
      if (entry.type !== "custom" || entry.customType !== GOAL_PROGRESS_ENTRY_TYPE || !isGoalReportEntry(entry.data) || entry.data.kind !== "publish" || entry.data.goalId !== goalId) continue;
      if (!publishedReports.has(entry.data.reportId)) publishedReports.set(entry.data.reportId, entry.data);
    }
  };

  const getState = (): GoalReportState => ({
    ...state,
    policy: { ...state.policy },
    dueReasons: [...state.dueReasons],
    recentReports: state.recentReports.map((item) => ({ ...item, report: { ...item.report } })),
  });

  const setPolicy = (policy: GoalReportPolicy): void => {
    state.policy = { ...policy };
  };

  const markDue = (
    reason: GoalReportDueReason,
    goal: ThreadGoal,
    turnIndex: number | null,
    dueReasons: GoalReportDueReason[] = [reason],
  ): boolean => {
    if (goal.status !== "active" || state.dueReason !== null) {
      return false;
    }
    pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, {
      version: 1,
      kind: "due",
      goalId: goal.goalId,
      createdAt: Date.now(),
      turnIndex,
      activeSeconds: goal.usage.activeSeconds,
      tokensUsed: goal.usage.tokensUsed,
      dueReason: reason,
      dueReasons: [...dueReasons],
      assistantTurns: state.assistantTurns,
    } satisfies GoalReportEntry);
    state.dueReason = reason;
    state.dueReasons = [...dueReasons];
    state.instructionInjected = false;
    return true;
  };

  const maybeMarkDue = (goal: ThreadGoal | null, turnIndex: number | null): GoalReportDueReason | null => {
    const reasons = reportDueReasons(state, goal, turnIndex);
    const reason = reasons[0];
    if (!reason || !goal) {
      return null;
    }
    return markDue(reason, goal, turnIndex, reasons) ? reason : null;
  };

  const markCompactionDue = (goal: ThreadGoal | null, turnIndex: number | null): void => {
    if (goal?.status === "active") {
      markDue("compaction", goal, turnIndex);
    }
  };

  const consumeInstruction = (goal: ThreadGoal | null): GoalReportDueReason | null => {
    if (
      goal?.status !== "active" ||
      state.dueReason === null ||
      state.instructionInjected
    ) {
      return null;
    }
    state.instructionInjected = true;
    return state.dueReason;
  };

  const completeAssistantTurn = (goal: ThreadGoal, turnIndex: number): void => {
    const assistantTurns = state.assistantTurns + 1;
    pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, {
      version: 1,
      kind: "assistant_turn",
      goalId: goal.goalId,
      createdAt: Date.now(),
      turnIndex,
      activeSeconds: goal.usage.activeSeconds,
      tokensUsed: goal.usage.tokensUsed,
      assistantTurns,
    } satisfies GoalReportEntry);
    state.assistantTurns = assistantTurns;
  };

  const resetInstructionForNextRun = (): void => {
    state.instructionInjected = false;
  };

  // A receipt is replayable data, not authorization or a confirmed answer.
  const noteOrdinaryUserInput = (goal: ThreadGoal | null): void => {
    if (!goal || !state.awaitingUser || state.hasUserReplySinceAwaiting) return;
    pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, { version: 1, kind: "user_input", goalId: goal.goalId, createdAt: Date.now() } satisfies GoalReportEntry);
    state.hasUserReplySinceAwaiting = true;
  };

  const noteOrdinaryUserDecision = (goal: ThreadGoal | null): void => {
    if (!goal || !state.awaitingUser || state.hasUserDecisionSinceAwaiting) {
      return;
    }
    pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, {
      version: 1,
      kind: "user_decision",
      confirmed: true,
      goalId: goal.goalId,
      createdAt: Date.now(),
    } satisfies GoalReportEntry);
    state.hasUserDecisionSinceAwaiting = true;
  };

  const noteQuestionAnswer = (goal: ThreadGoal | null, toolCallId: string): void => {
    if (answeredQuestions.has(toolCallId)) return;
    answeredQuestions.add(toolCallId);
    if (!goal || !state.awaitingUser) return;
    noteOrdinaryUserInput(goal);
    // Finish processing this actual user answer across compaction. A final
    // response without working closes this allowance instead of looping.
    state.questionAnswerPending = true;
  };

  const finishQuestionAnswer = (): void => { state.questionAnswerPending = false; };

  const publish = (
    goal: ThreadGoal,
    report: GoalProgressReport,
    turnIndex: number | null,
    artifactRefs: GoalArtifactRef[] = [],
    reportId: string = randomUUID(),
    options: { canonical?: boolean; createdAt?: number } = {},
  ): Extract<GoalReportEntry, { kind: "publish" }> => {
    const existing = publishedReports.get(reportId);
    if (existing) return existing;
    const entry: Extract<GoalReportEntry, { kind: "publish" }> = {
      version: 1,
      kind: "publish",
      goalId: goal.goalId,
      reportId,
      createdAt: options.createdAt ?? Date.now(),
      turnIndex,
      activeSeconds: goal.usage.activeSeconds,
      tokensUsed: goal.usage.tokensUsed,
      triggerReason: state.dueReason ?? "manual",
      report,
      ...(artifactRefs.length > 0 ? { artifactRefs: artifactRefs.map((ref) => ({ ...ref })) } : {}),
      assistantTurns: state.assistantTurns,
    };
    // New reports are persisted by the canonical projection event. Legacy direct
    // callers still use the v1 journal, which remains replayable.
    if (!options.canonical) pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, entry);
    publishedReports.set(entry.reportId, entry);
    applyActionAnchor(state, entry);
    applyReportHold(state, entry.report);
    state.lastReportId = entry.reportId;
    state.lastReportAt = entry.createdAt;
    state.lastReportTurn = entry.turnIndex;
    return entry;
  };

  const suppress = (goal: ThreadGoal, turnIndex: number | null): void => {
    const entry: GoalReportEntry = {
      version: 1,
      kind: "suppress",
      goalId: goal.goalId,
      createdAt: Date.now(),
      turnIndex,
      activeSeconds: goal.usage.activeSeconds,
      tokensUsed: goal.usage.tokensUsed,
      // Ход с report_goal_progress не входит в интервал между отчётами.
      assistantTurns: state.assistantTurns,
    };
    pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, entry);
    applyActionAnchor(state, entry);
  };

  return {
    completeAssistantTurn,
    consumeInstruction,
    getState,
    isContinuationHeld: () => (state.awaitingUser) && !state.questionAnswerPending,
    noteQuestionAnswer,
    finishQuestionAnswer,
    markCompactionDue,
    maybeMarkDue,
    noteOrdinaryUserInput,
    noteOrdinaryUserDecision,
    publish,
    reload,
    resetInstructionForNextRun,
    setPolicy,
    suppress,
  };
}


function reportLine(label: string, value: string | undefined): string | null {
  return value?.trim() ? `${label}: ${value.trim()}` : null;
}

function artifactFilePath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function formatGoalProgressReport(entry: GoalReportEntry, expanded: boolean): string[] | null {
  if (entry.kind !== "publish") {
    return null;
  }
  if (!expanded) {
    // Historical v1 reports have no model-authored summary; never expand their
    // internal field dump into the main transcript by default.
    const report = entry.report;
    const narrative = report.summary?.trim() ||
      (report.status === "awaiting_user" ? report.needUser?.trim() || say("Требуется решение пользователя.", "A user decision is required.") : undefined) ||
      report.completed?.trim() || report.changed?.trim() || report.problemOrDecision?.trim() ||
      report.verification?.trim() || report.phase.trim();
    return [stripGoalTerminalControls(narrative)];
  }
  const eventKind = normalizedGoalProgressEventKind(entry.report);
  const lines = [
    say(`Событие цели · ${goalProgressEventLabel(eventKind)} · ${entry.report.status} · ${entry.report.phase.trim()}`, `Goal event · ${goalProgressEventLabel(eventKind)} · ${entry.report.status} · ${entry.report.phase.trim()}`),
    reportLine(say("Изменения", "Changes"), entry.report.changed),
    reportLine(say("Готово", "Done"), entry.report.completed),
    reportLine(say("Решение или проблема", "Decision or problem"), entry.report.problemOrDecision),
    reportLine(say("Риск и сложность", "Risk and complexity"), entry.report.riskAndComplexity),
    reportLine(say("Проверка", "Verification"), entry.report.verification),
    reportLine(say("Следующий шаг", "Next step"), entry.report.nextStep),
    reportLine(say("Нужен пользователь", "User needed"), entry.report.needUser),
  ].filter((line): line is string => line !== null);
  if (entry.artifactRefs?.length) {
    lines.push(say("Артефакты:", "Artifacts:"));
    for (const ref of entry.artifactRefs) {
      lines.push(`  · ${ref.artifact} r${ref.revision}`);
      lines.push(`${ARTIFACT_PATH_INDENT}${artifactFilePath(ref.path)}`);
    }
  }
  if (expanded) {
    lines.push(
      `${say("Технические данные", "Technical data")}: reportId=${entry.reportId}, goalId=${entry.goalId}, trigger=${entry.triggerReason}, turn=${entry.turnIndex ?? "—"}, activeSeconds=${entry.activeSeconds}, tokensUsed=${entry.tokensUsed}, createdAt=${new Date(entry.createdAt).toISOString()}`,
    );
  }
  return lines;
}

function fitsDisplayWidth(value: string, width: number): boolean {
  return truncateToVisualLines(value, 1, width).skippedCount === 0;
}

function truncatePlainLine(line: string, width: number): string {
  if (fitsDisplayWidth(line, width)) return line;
  const ellipsis = "…";
  let prefix = "";
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(line);
  for (const { segment } of graphemes) {
    if (!fitsDisplayWidth(prefix + segment + ellipsis, width)) break;
    prefix += segment;
  }
  return prefix + ellipsis;
}

function truncateReportLine(line: string, width: number): string {
  return fitsDisplayWidth(line, width) ? line : truncatePlainLine(line, width);
}

export function createGoalProgressEntryComponent(lines: string[], preserveFileLinks = false): { render(width: number): string[]; invalidate(): void } {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;

  return {
    render(width) {
      const maxWidth = Math.max(1, width);
      if (cachedWidth === maxWidth && cachedLines) {
        return cachedLines;
      }
      cachedWidth = maxWidth;
      cachedLines = lines.flatMap((line) => truncateToVisualLines(stripGoalTerminalControls(line, preserveFileLinks), Number.MAX_SAFE_INTEGER, maxWidth).visualLines);
      return cachedLines;
    },
    invalidate() {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}
