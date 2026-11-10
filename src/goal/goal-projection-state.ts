import { say } from "../language.js";
import { cloneGoalWorkState, type GoalWorkState } from "./goal-work-state.js";
import type { GoalProgressEventKind, GoalProgressReport } from "./report-schema.js";
import type { GoalArtifactName, GoalStatus, ThreadGoal } from "./types.js";

export interface GoalImportedDocument {
  artifact: GoalArtifactName;
  content: string;
}

export type ProjectionPaperCutSeverity = "low" | "medium" | "high";
export type ProjectionPaperCutStatus = "open" | "resolved" | "wont_fix";

export interface GoalDecisionEntry {
  id: string;
  title: string;
  decision: string;
  rationale: string;
  consequence?: string;
  createdAt: number;
  /** Approved contract text is quoted verbatim, not edited as generated prose. */
  source?: "approved-amendment";
}

export interface GoalPaperCutEntry {
  id: string;
  title: string;
  impact: string;
  severity: ProjectionPaperCutSeverity;
  revisit?: string;
  status: ProjectionPaperCutStatus;
  /** Derived from update events; historical creation records start at zero. */
  revision?: number;
  createdAt: number;
  resolution?: string;
}

export interface GoalProgressEventRecord {
  eventKind: GoalProgressEventKind;
  reportId: string | null;
  createdAt: number;
  report: GoalProgressReport;
}

export interface GoalProjectionLanguageDiagnostic {
  artifact: "CURRENT" | "TIMELINE" | "DECISIONS" | "PAPER-CUTS";
  code: string;
  field: string | null;
  length: number | null;
  limit: number | null;
  repair: string;
}

export interface GoalProjectionLanguageRepair {
  artifact: "CURRENT" | "TIMELINE" | "DECISIONS" | "PAPER-CUTS";
  findings: string[];
  fields: string[];
  diagnostics?: GoalProjectionLanguageDiagnostic[];
}

export interface GoalProjectionState {
  version: 1;
  goalId: string;
  goal: ThreadGoal;
  status: GoalStatus;
  stateSeq: number;
  currentProjectionSeq: number;
  latestProgress: GoalProgressReport | null;
  latestReportId: string | null;
  /** A contract change prevents replayed legacy reports from becoming current again. */
  progressInvalidated: boolean;
  workState: GoalWorkState | null;
  workRevision: number;
  workStateStale: boolean;
  verifiedWorkRevision: number | null;
  workVerification: string | null;
  progressEvents: readonly GoalProgressEventRecord[];
  decisions: readonly GoalDecisionEntry[];
  importedDocuments: readonly GoalImportedDocument[];
  /** Derived references to preserved source events; not a second event log. */
  preservedSourceIds?: readonly string[];
  paperCuts: readonly GoalPaperCutEntry[];
  /** User-authored v1 content preserved when managed projections take over. */
  legacyDecisions: string | null;
  legacyPaperCuts: string | null;
  languageRepair: GoalProjectionLanguageRepair | null;
  languageRepairKey: string | null;
  appliedEventKeys: readonly string[];
}

export interface GoalProjectionSnapshot {
  stateSeq: number;
  currentProjectionSeq: number;
  latestProgress: GoalProgressReport | null;
  latestReportId: string | null;
  workState: GoalWorkState | null;
  workRevision: number;
  workStateStale: boolean;
  progressEvents: readonly GoalProgressEventRecord[];
  decisions: readonly GoalDecisionEntry[];
  importedDocuments: readonly GoalImportedDocument[];
  preservedSourceIds?: readonly string[];
  paperCuts: readonly GoalPaperCutEntry[];
}

export function createGoalProjectionState(goal: ThreadGoal): GoalProjectionState {
  return {
    version: 1,
    goalId: goal.goalId,
    goal: cloneGoalForProjection(goal),
    status: goal.status,
    stateSeq: 0,
    currentProjectionSeq: 0,
    latestProgress: null,
    latestReportId: null,
    progressInvalidated: false,
    workState: null,
    workRevision: 0,
    workStateStale: false,
    verifiedWorkRevision: null,
    workVerification: null,
    progressEvents: [],
    decisions: [],
    importedDocuments: [],
    preservedSourceIds: [],
    paperCuts: [],
    legacyDecisions: null,
    legacyPaperCuts: null,
    languageRepair: null,
    languageRepairKey: null,
    appliedEventKeys: [],
  };
}

export function cloneGoalForProjection(goal: ThreadGoal): ThreadGoal {
  return { ...goal, usage: { ...goal.usage } };
}

export function cloneProgressReport(report: GoalProgressReport | null): GoalProgressReport | null {
  return report ? { ...report } : null;
}

export function snapshotGoalProjection(state: GoalProjectionState): GoalProjectionSnapshot {
  return {
    stateSeq: state.stateSeq,
    currentProjectionSeq: state.currentProjectionSeq,
    latestProgress: cloneProgressReport(state.latestProgress),
    latestReportId: state.latestReportId,
    workState: cloneGoalWorkState(state.workState),
    workRevision: state.workRevision,
    workStateStale: state.workStateStale,
    progressEvents: state.progressEvents.map((entry) => ({ ...entry, report: { ...entry.report } })),
    decisions: state.decisions.map((entry) => ({ ...entry })),
    importedDocuments: state.importedDocuments.map((entry) => ({ ...entry })),
    preservedSourceIds: [...(state.preservedSourceIds ?? [])],
    paperCuts: state.paperCuts.map((entry) => ({ ...entry })),
  };
}

export function isCurrentProjectionFresh(state: GoalProjectionState): boolean {
  return state.currentProjectionSeq === state.stateSeq;
}

export function markCurrentProjectionFresh(state: GoalProjectionState): GoalProjectionState {
  return { ...state, currentProjectionSeq: state.stateSeq };
}

export function markCurrentProjectionStale(state: GoalProjectionState): GoalProjectionState {
  return { ...state, currentProjectionSeq: Math.max(0, Math.min(state.currentProjectionSeq, state.stateSeq - 1)) };
}

/** Возвращает независимую копию состояния для безопасного reducer-перехода. */
export function cloneGoalProjectionState(state: GoalProjectionState): GoalProjectionState {
  return {
    ...state,
    goal: cloneGoalForProjection(state.goal),
    latestProgress: cloneProgressReport(state.latestProgress),
    workState: cloneGoalWorkState(state.workState),
    progressEvents: state.progressEvents.map((entry) => ({ ...entry, report: { ...entry.report } })),
    decisions: state.decisions.map((entry) => ({ ...entry })),
    importedDocuments: state.importedDocuments.map((entry) => ({ ...entry })),
    preservedSourceIds: [...(state.preservedSourceIds ?? [])],
    paperCuts: state.paperCuts.map((entry) => ({ ...entry })),
    legacyDecisions: state.legacyDecisions,
    legacyPaperCuts: state.legacyPaperCuts,
    languageRepair: state.languageRepair ? {
      artifact: state.languageRepair.artifact,
      findings: [...state.languageRepair.findings],
      fields: [...state.languageRepair.fields],
      ...(state.languageRepair.diagnostics ? { diagnostics: state.languageRepair.diagnostics.map((diagnostic) => ({ ...diagnostic })) } : {}),
    } : null,
    languageRepairKey: state.languageRepairKey,
    appliedEventKeys: [...state.appliedEventKeys],
  };
}

/** Identify context that a current snapshot must not silently claim to have classified. */
export function goalPreservedContext(state: GoalProjectionState) {
  const unclassifiedDecisionIds = state.workState ? [] : state.decisions.map(entry => entry.id);
  if (!state.importedDocuments.length && !state.legacyDecisions && !state.legacyPaperCuts && !unclassifiedDecisionIds.length) return null;
  return {
    notice: say("Исходные записи сохранены для адресной проверки. Рабочий снимок не заменяет полный договор и источники и сам по себе не подтверждает полноту контекста. Если в текущем плане есть пробел или противоречие, откройте нужный источник через `get_goal` и уточните действующее через `update_goal_work`; повторно читать уже проверенное не требуется.", "Original records are kept for addressed checks. The work snapshot does not replace the full contract and sources and does not by itself prove the context is complete. If the current plan has a gap or contradiction, open the needed source with `get_goal` and clarify what applies with `update_goal_work`; there is no need to reread what was already checked."),
    sourceEventIds: [...new Set([...(state.preservedSourceIds ?? []), ...unclassifiedDecisionIds])],
    documents: [...new Set(state.importedDocuments.map(entry => entry.artifact))],
    unclassifiedDecisionIds,
  };
}
