import { cloneGoalWorkState, isGoalWorkState, type GoalWorkState } from "./goal-work-state.js";
import { diagnosticRepairForCode } from "./goal-language-quality.js";
import { isGoalProgressEventKind, normalizedGoalProgressEventKind, validateGoalProgressReport, validateNewGoalProgressReport, type GoalProgressReport } from "./report-schema.js";
import {
  cloneGoalProjectionState,
  cloneGoalForProjection,
  cloneProgressReport,
  createGoalProjectionState,
  type GoalDecisionEntry,
  type GoalPaperCutEntry,
  type GoalProgressEventRecord,
  type GoalProjectionLanguageRepair,
  type GoalProjectionState,
} from "./goal-projection-state.js";
import { GOAL_ARTIFACT_NAMES, type ThreadGoal } from "./types.js";
import type { GoalImportedDocument } from "./goal-projection-state.js";

export type GoalProjectionEvent =
  | { kind: "goal_created"; idempotencyKey: string; goalId: string; goal: ThreadGoal }
  | { kind: "goal_updated"; idempotencyKey: string; goalId: string; goal: ThreadGoal }
  | { kind: "goal_completed"; idempotencyKey: string; goalId: string; goal: ThreadGoal }
  | { kind: "progress_reported"; idempotencyKey: string; goalId: string; report: GoalProgressReport; reportId?: string; eventKind?: GoalProgressEventRecord["eventKind"]; createdAt?: number; reportAnchor?: { turnIndex: number | null; activeSeconds: number; tokensUsed: number; assistantTurns: number } }
  | { kind: "work_state_updated"; idempotencyKey: string; goalId: string; expectedRevision: number; workState: GoalWorkState }
  | { kind: "decision_recorded"; idempotencyKey: string; goalId: string; entry: GoalDecisionEntry }
  | { kind: "paper_cut_recorded"; idempotencyKey: string; goalId: string; entry: GoalPaperCutEntry }
  | { kind: "paper_cut_updated"; idempotencyKey: string; goalId: string; id: string; status: "resolved" | "wont_fix"; resolution?: string; expectedRevision?: number }
  | { kind: "legacy_migrated"; idempotencyKey: string; goalId: string; decisions: string | null; paperCuts: string | null }
  | { kind: "documents_imported"; idempotencyKey: string; goalId: string; documents: GoalImportedDocument[] }
  | { kind: "language_repair_required"; idempotencyKey: string; goalId: string; repair: GoalProjectionLanguageRepair }
  | { kind: "language_repair_cleared"; idempotencyKey: string; goalId: string; repairKey: string };

type GoalProjectionEventKind = GoalProjectionEvent["kind"];

function assertEventKey(event: GoalProjectionEvent): void {
  if (typeof event.idempotencyKey !== "string" || event.idempotencyKey.trim().length === 0) {
    throw new Error("Goal projection events require a non-empty idempotencyKey.");
  }
  if (typeof event.goalId !== "string" || event.goalId.trim().length === 0) {
    throw new Error("Goal projection events require a non-empty goalId.");
  }
}

function assertGoalMatches(state: GoalProjectionState, goalId: string): void {
  if (goalId !== state.goalId) {
    throw new Error(`Projection event belongs to goal ${goalId}, expected ${state.goalId}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;
function isValidDateTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_TIMESTAMP;
}

function isGoal(value: unknown): value is ThreadGoal {
  return isRecord(value) && typeof value.goalId === "string" && typeof value.objective === "string" &&
    (value.status === "active" || value.status === "paused" || value.status === "budgetLimited" || value.status === "complete") &&
    (value.tokenBudget === null || typeof value.tokenBudget === "number") && isRecord(value.usage) &&
    typeof value.usage.tokensUsed === "number" && typeof value.usage.activeSeconds === "number" &&
    typeof value.createdAt === "number" && typeof value.updatedAt === "number";
}

function isDecisionEntry(value: unknown): value is GoalDecisionEntry {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" &&
    typeof value.decision === "string" && typeof value.rationale === "string" && typeof value.createdAt === "number" &&
    (value.consequence === undefined || typeof value.consequence === "string") &&
    (value.source === undefined || value.source === "approved-amendment");
}

function isPaperCutEntry(value: unknown): value is GoalPaperCutEntry {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" &&
    typeof value.impact === "string" && (value.severity === "low" || value.severity === "medium" || value.severity === "high") &&
    (value.status === "open" || value.status === "resolved" || value.status === "wont_fix") && typeof value.createdAt === "number" &&
    (value.revision === undefined || (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0)) &&
    (value.revisit === undefined || typeof value.revisit === "string") && (value.resolution === undefined || typeof value.resolution === "string");
}

const DIAGNOSTIC_FIELDS: Readonly<Record<GoalProjectionLanguageRepair["artifact"], ReadonlySet<string>>> = {
  CURRENT: new Set(["projection", "phase", "summary", "changed", "completed", "problemOrDecision", "riskAndComplexity", "verification", "nextStep", "needUser"]),
  TIMELINE: new Set(["timeline", "event", "phase", "summary", "changed", "completed", "problemOrDecision", "riskAndComplexity", "verification", "nextStep", "needUser"]),
  DECISIONS: new Set(),
  "PAPER-CUTS": new Set(),
};

const REPAIR_FIELDS: Readonly<Record<GoalProjectionLanguageRepair["artifact"], ReadonlySet<string>>> = {
  CURRENT: new Set(["current", "projection", "phase", "summary", "changed", "completed", "problemOrDecision", "riskAndComplexity", "verification", "nextStep", "needUser"]),
  TIMELINE: new Set(["timeline", "event", "phase", "summary", "changed", "completed", "problemOrDecision", "riskAndComplexity", "verification", "nextStep", "needUser"]),
  DECISIONS: new Set(["decisions", "decision"]),
  "PAPER-CUTS": new Set(["paperCuts", "paperCut"]),
};

const SAFE_FINDINGS = new Set([
  "артефакт цитирования чат-бота",
  "служебная метка чат-бота",
  "хвост ссылки чат-бота",
  "шаблонная концовка чат-бота",
  "негативное противопоставление из шаблонов LLM",
  "служебный знак в обычной прозе",
  "предложение в основном написано по-английски",
  "русская и английская лексика смешаны в одном предложении",
  "текст представляет собой слишком длинную строку без структуры",
  "абзац слишком длинный; разделите независимые мысли",
  "незакрытый fenced code block скрывает остаток Markdown-текста",
]);

function isSafeFinding(value: unknown): value is string {
  return typeof value === "string" && (SAFE_FINDINGS.has(value) || /^обнаружен кластер из \d+ семейств шаблонной лексики$/.test(value));
}

function isLanguageDiagnostic(value: unknown, artifact: GoalProjectionLanguageRepair["artifact"]): boolean {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["artifact", "code", "field", "length", "limit", "repair"]);
  if (!Object.keys(value).every((key) => allowedKeys.has(key)) || value.artifact !== artifact || typeof value.code !== "string") return false;
  const repair = diagnosticRepairForCode(value.code);
  if (repair === null || value.repair !== repair) return false;
  if (value.field !== null && (typeof value.field !== "string" || !DIAGNOSTIC_FIELDS[artifact].has(value.field))) return false;
  if (value.code === "one-line-dump" || value.code === "long-paragraph") {
    const expectedLimit = value.code === "one-line-dump" ? 320 : 700;
    return typeof value.length === "number" && Number.isSafeInteger(value.length) && value.length > expectedLimit &&
      value.limit === expectedLimit;
  }
  return value.length === null && value.limit === null;
}

function isLanguageRepair(value: unknown): value is GoalProjectionLanguageRepair {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set(["artifact", "findings", "fields", "diagnostics"]);
  if (!Object.keys(value).every((key) => allowedKeys.has(key))) return false;
  if (value.artifact !== "CURRENT" && value.artifact !== "TIMELINE" && value.artifact !== "DECISIONS" && value.artifact !== "PAPER-CUTS") return false;
  const artifact = value.artifact;
  return Array.isArray(value.findings) && value.findings.every(isSafeFinding) &&
    Array.isArray(value.fields) && value.fields.every((item) => typeof item === "string" && REPAIR_FIELDS[artifact].has(item)) &&
    (value.diagnostics === undefined || (Array.isArray(value.diagnostics) &&
      value.diagnostics.every((item) => isLanguageDiagnostic(item, artifact))));
}

function isProjectionReport(value: unknown): value is GoalProgressReport {
  return validateGoalProgressReport(value) === null;
}

function nextState(state: GoalProjectionState, event: GoalProjectionEvent): GoalProjectionState {
  const result = cloneGoalProjectionState(state);
  result.stateSeq += 1;
  result.appliedEventKeys = [...result.appliedEventKeys, event.idempotencyKey];
  return result;
}

/** Применяет одно событие к состоянию; повтор idempotencyKey не меняет состояние. */
export function reduceGoalProjection(state: GoalProjectionState, event: GoalProjectionEvent): GoalProjectionState {
  assertEventKey(event);
  if (state.appliedEventKeys.includes(event.idempotencyKey)) {
    return state;
  }

  switch (event.kind) {
    case "goal_created":
    case "goal_updated":
    case "goal_completed": {
      assertGoalMatches(state, event.goalId);
      if (event.goal.goalId !== event.goalId) {
        throw new Error(`Projection event goalId ${event.goalId} does not match its goal payload ${event.goal.goalId}.`);
      }
      const result = nextState(state, event);
      result.goal = cloneGoalForProjection(event.goal);
      result.status = event.goal.status;
      // Only an amendment invalidates completion evidence. Runtime lifecycle
      // transitions (pause, resume, accounting) must retain the latest report.
      const completionContractChanged = state.stateSeq > 0 && (state.goal.objective !== event.goal.objective ||
        state.goal.tokenBudget !== event.goal.tokenBudget);
      if (completionContractChanged && result.workState) result.workStateStale = true;
      if (completionContractChanged) {
        result.workRevision += 1;
        result.progressInvalidated = true;
        result.latestProgress = null;
        result.latestReportId = null;
        result.verifiedWorkRevision = null;
        result.workVerification = null;
      } else if (state.stateSeq > 0 && agreementKey(state.goal) !== agreementKey(event.goal)) {
        // П8: новая редакция договорённости или смена пунктов «Решаю сам» требует новой проверки.
        // План при этом остаётся действующим, поэтому его версия не меняется.
        result.progressInvalidated = true;
        result.latestProgress = null;
        result.latestReportId = null;
        result.verifiedWorkRevision = null;
        result.workVerification = null;
      }
      return result;
    }
    case "work_state_updated": {
      assertGoalMatches(state, event.goalId);
      if (!isGoalWorkState(event.workState)) throw new Error("Malformed goal work state.");
      if (!Number.isSafeInteger(event.expectedRevision) || event.expectedRevision !== state.workRevision) {
        throw new Error(`Stale goal work revision: expected ${state.workRevision}, received ${event.expectedRevision}.`);
      }
      if (event.workState.activeDecisionIds.some((id) => !state.decisions.some((entry) => entry.id === id))) {
        throw new Error("Goal work state references an unknown decision.");
      }
      const nextItems = new Map(event.workState.items.map((item) => [item.id, item]));
      for (const previous of state.workState?.items ?? []) {
        if (previous.source !== "user") continue;
        const next = nextItems.get(previous.id);
        if (next && next.source !== "user") throw new Error("User work provenance cannot change to agent; retain the user source.");
        if (previous.status !== "done" && previous.status !== "cancelled" && !next) {
          throw new Error("Unfinished user work cannot disappear; retain it or record its disposition.");
        }
      }
      const result = nextState(state, event);
      result.workState = cloneGoalWorkState(event.workState);
      result.workRevision = state.workRevision + 1;
      result.workStateStale = false;
      return result;
    }
    case "progress_reported": {
      assertGoalMatches(state, event.goalId);
      const result = nextState(state, event);
      const eventKind = event.eventKind ?? normalizedGoalProgressEventKind(event.report);
      const report = event.report.eventKind === undefined ? event.report : { ...event.report, eventKind };
      result.latestProgress = cloneProgressReport(event.report);
      result.progressInvalidated = false;
      result.latestReportId = event.reportId ?? null;
      if (event.report.verification) {
        result.verifiedWorkRevision = result.workRevision;
        result.workVerification = event.report.verification;
      }
      result.progressEvents = [...result.progressEvents, {
        eventKind,
        reportId: event.reportId ?? null,
        createdAt: event.createdAt ?? state.stateSeq,
        report: { ...report, eventKind },
      }];
      return result;
    }
    case "decision_recorded": {
      assertGoalMatches(state, event.goalId);
      if (state.decisions.some((entry) => entry.id === event.entry.id)) {
        return state;
      }
      const result = nextState(state, event);
      result.decisions = [...result.decisions, { ...event.entry }];
      return result;
    }
    case "paper_cut_recorded": {
      assertGoalMatches(state, event.goalId);
      if (state.paperCuts.some((entry) => entry.id === event.entry.id)) {
        return state;
      }
      const result = nextState(state, event);
      result.paperCuts = [...result.paperCuts, { ...event.entry }];
      return result;
    }
    case "documents_imported": {
      assertGoalMatches(state, event.goalId);
      const result = nextState(state, event);
      const documents = [...state.importedDocuments];
      for (const document of event.documents) {
        if (!documents.some((entry) => entry.artifact === document.artifact && entry.content === document.content)) documents.push({ ...document });
      }
      result.importedDocuments = documents;
      result.preservedSourceIds = [...(state.preservedSourceIds ?? []), event.idempotencyKey];
      return result;
    }
    case "legacy_migrated": {
      assertGoalMatches(state, event.goalId);
      const result = nextState(state, event);
      result.preservedSourceIds = [...(state.preservedSourceIds ?? []), event.idempotencyKey];
      result.legacyDecisions = event.decisions;
      result.legacyPaperCuts = event.paperCuts;
      return result;
    }
    case "language_repair_required": {
      assertGoalMatches(state, event.goalId);
      const result = nextState(state, event);
      result.languageRepair = {
        artifact: event.repair.artifact,
        findings: [...event.repair.findings],
        fields: [...event.repair.fields],
        ...(event.repair.diagnostics ? {
          diagnostics: event.repair.diagnostics.map((diagnostic) => ({
            artifact: diagnostic.artifact,
            code: diagnostic.code,
            field: diagnostic.field,
            length: diagnostic.length,
            limit: diagnostic.limit,
            repair: diagnostic.repair,
          })),
        } : {}),
      };
      result.languageRepairKey = event.idempotencyKey;
      return result;
    }
    case "language_repair_cleared": {
      assertGoalMatches(state, event.goalId);
      const result = nextState(state, event);
      if (state.languageRepairKey === event.repairKey) {
        result.languageRepair = null;
        result.languageRepairKey = null;
      }
      return result;
    }
    case "paper_cut_updated": {
      assertGoalMatches(state, event.goalId);
      const index = state.paperCuts.findIndex((entry) => entry.id === event.id);
      if (index < 0) {
        throw new Error(`Unknown paper cut ${event.id}.`);
      }
      if (event.expectedRevision !== undefined && event.expectedRevision !== (state.paperCuts[index]!.revision ?? 0)) {
        throw new Error(`Stale note revision: expected ${event.expectedRevision}, current ${state.paperCuts[index]!.revision ?? 0}. Read get_goal before retrying.`);
      }
      const result = nextState(state, event);
      result.paperCuts = result.paperCuts.map((entry) =>
        entry.id === event.id
          ? { ...entry, status: event.status, revision: (entry.revision ?? 0) + 1, ...(event.resolution === undefined ? {} : { resolution: event.resolution }) }
          : entry,
      );
      return result;
    }
    default:
      throw new Error(`Unknown goal projection event kind: ${String((event as { kind?: unknown }).kind)}.`);
  }
}

export function replayGoalProjection(
  goal: ThreadGoal,
  events: Iterable<GoalProjectionEvent>,
): GoalProjectionState {
  let state = createGoalProjectionState(goal);
  for (const event of events) {
    state = reduceGoalProjection(state, event);
  }
  return state;
}

export function applyGoalProjectionEvent(
  state: GoalProjectionState,
  event: GoalProjectionEvent,
): GoalProjectionState {
  return reduceGoalProjection(state, event);
}

export function isGoalProjectionEvent(value: unknown): value is GoalProjectionEvent {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.idempotencyKey !== "string" ||
      value.idempotencyKey.trim().length === 0 || typeof value.goalId !== "string" || value.goalId.trim().length === 0) {
    return false;
  }
  switch (value.kind) {
    case "goal_created":
    case "goal_updated":
      return isGoal(value.goal) && value.goal.goalId === value.goalId;
    case "goal_completed":
      return isGoal(value.goal) && value.goal.goalId === value.goalId && value.goal.status === "complete";
    case "progress_reported": {
      const reportEventKind = isRecord(value.report) && isGoalProgressEventKind(value.report.eventKind) ? value.report.eventKind : undefined;
      const selectedEventKind = value.eventKind ?? reportEventKind;
      const typedEvent = selectedEventKind !== undefined;
      const normalizedReport = isProjectionReport(value.report) && selectedEventKind !== undefined
        ? { ...value.report, eventKind: selectedEventKind }
        : value.report;
      return isProjectionReport(value.report) &&
        (value.reportId === undefined || typeof value.reportId === "string") &&
        (value.eventKind === undefined || isGoalProgressEventKind(value.eventKind)) &&
        (reportEventKind === undefined || value.eventKind === undefined || reportEventKind === value.eventKind) &&
        (value.createdAt === undefined || isValidDateTimestamp(value.createdAt)) &&
        (value.reportAnchor === undefined || (isRecord(value.reportAnchor) &&
          (value.reportAnchor.turnIndex === null || (Number.isSafeInteger(value.reportAnchor.turnIndex) && Number(value.reportAnchor.turnIndex) >= 0)) &&
          Number.isSafeInteger(value.reportAnchor.activeSeconds) && Number(value.reportAnchor.activeSeconds) >= 0 &&
          Number.isSafeInteger(value.reportAnchor.tokensUsed) && Number(value.reportAnchor.tokensUsed) >= 0 &&
          Number.isSafeInteger(value.reportAnchor.assistantTurns) && Number(value.reportAnchor.assistantTurns) >= 0 &&
          typeof value.reportId === "string" && typeof value.report.summary === "string" && value.report.summary.trim().length > 0)) &&
        (!typedEvent || validateNewGoalProgressReport(normalizedReport) === null);
    }
    case "work_state_updated":
      return Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) >= 0 && isGoalWorkState(value.workState);
    case "decision_recorded":
      return isDecisionEntry(value.entry);
    case "paper_cut_recorded":
      return isPaperCutEntry(value.entry);
    case "paper_cut_updated":
      return typeof value.id === "string" && value.id.trim().length > 0 &&
        (value.status === "resolved" || value.status === "wont_fix") &&
        (value.expectedRevision === undefined || (typeof value.expectedRevision === "number" && Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0)) &&
        (value.resolution === undefined || typeof value.resolution === "string");
    case "documents_imported":
      return Array.isArray(value.documents) && value.documents.every((entry) => isRecord(entry) &&
        typeof entry.artifact === "string" && (GOAL_ARTIFACT_NAMES as readonly string[]).includes(entry.artifact) && typeof entry.content === "string");
    case "legacy_migrated":
      return (value.decisions === null || typeof value.decisions === "string") &&
        (value.paperCuts === null || typeof value.paperCuts === "string");
    case "language_repair_required":
      return isLanguageRepair(value.repair);
    case "language_repair_cleared":
      return typeof value.repairKey === "string" && value.repairKey.trim().length > 0;
    default:
      return false;
  }
}

export function projectionEventKey(goalId: string, sequence: string): string {
  return `${goalId}:${sequence}`;
}

function agreementKey(goal: ThreadGoal): string {
  return JSON.stringify({ agreement: goal.agreement ?? null, items: (goal.selfDecided ?? []).map((item) => [item.id, item.state, item.text]) });
}
