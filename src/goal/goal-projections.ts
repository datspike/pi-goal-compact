import { GoalCanonicalWriteError } from "./goal-persistence.js";
import type { GoalWorkState, GoalWorkUpdateResult } from "./goal-work-state.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalArtifactRef, SessionEntryLike, ThreadGoal } from "./types.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "./goal-reports.js";
import type { GoalProgressReport } from "./report-schema.js";
import type { GoalArtifactContext, GoalArtifacts } from "./goal-artifacts.js";
import { lintGoalMarkdown, type LanguageLintResult } from "./goal-language-quality.js";
import { renderGoalDocument, renderCurrentProjection, renderDecisions, renderPaperCuts, renderTimeline, sanitizeMarkdownBlock, sanitizeTitle } from "./goal-projection-renderer.js";
import { applyGoalProjectionEvent, isGoalProjectionEvent, type GoalProjectionEvent } from "./goal-projection-reducer.js";
import {
  createGoalProjectionState,
  type GoalDecisionEntry,
  type GoalImportedDocument,
  type GoalPaperCutEntry,
  type GoalProjectionLanguageDiagnostic,
  type GoalProjectionLanguageRepair,
  type GoalProjectionState,
} from "./goal-projection-state.js";
import { say } from "../language.js";



export type GoalLanguageRepair = GoalProjectionLanguageRepair;

export interface GoalPaperCutUpdate {
  id: string;
  expectedRevision: number;
  status: "resolved" | "wont_fix";
  resolution: string;
}

export type GoalProjectionOutcome = {
  state: GoalProjectionState;
  refs: GoalArtifactRef[];
  language: LanguageLintResult;
  eventApplied?: boolean;
  entryId?: string;
};

const PROGRESS_CONTENT_FIELDS = ["status", "phase", "summary", "changed", "completed", "problemOrDecision", "riskAndComplexity", "verification", "nextStep", "needUser"] as const;
function sameProgressContent(left: GoalProgressReport, right: GoalProgressReport): boolean {
  return PROGRESS_CONTENT_FIELDS.every((field) => left[field] === right[field]);
}

function branchEvents(entries: Iterable<SessionEntryLike>, goalId: string, normalizeLegacy = true): GoalProjectionEvent[] {
  const result: GoalProjectionEvent[] = [];
  let entryIndex = 0;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== GOAL_PROJECTION_ENTRY_TYPE) continue;
    const raw = entry.data;
    const rawGoalId = raw && typeof raw === "object" && typeof (raw as { goalId?: unknown }).goalId === "string"
      ? (raw as { goalId: string }).goalId
      : null;
    if (rawGoalId !== null && rawGoalId !== goalId) continue;
    if (!isGoalProjectionEvent(raw)) {
      throw new Error("Malformed goal projection event encountered during replay.");
    }
    const event = raw;
    // v1 projection events predate createdAt. Use their stable branch order
    // as a deterministic fallback instead of Date.now().
    const normalizedEvent = normalizeLegacy && event.kind === "progress_reported" && event.createdAt === undefined
      ? { ...event, createdAt: entryIndex }
      : event;
    entryIndex += 1;
    // A shared branch legitimately contains events for several goals. Foreign
    // events are excluded here; applying one directly to a state still fails closed.
    if (normalizedEvent.goalId !== goalId) continue;
    result.push(normalizedEvent);
  }
  return result;
}

export interface GoalHistoryQuery {
  event_id?: string;
  offset?: number;
  limit?: number;
  content_offset?: number;
  content_limit?: number;
}

export interface GoalHistoryPage {
  source: "session-events";
  goalId: string;
  total: number;
  records?: { id: string; kind: GoalProjectionEvent["kind"]; noteId?: string }[];
  nextOffset?: number | null;
  eventId?: string;
  content?: string;
  contentChars?: number;
  nextContentOffset?: number | null;
}

/** Читает исходные события текущей ветки адресно; текстовые страницы соединяются без потерь. */
export function readGoalHistory(entries: Iterable<SessionEntryLike>, goalId: string, query: GoalHistoryQuery): GoalHistoryPage {
  const integer = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const n = value ?? fallback;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error("Invalid goal history range.");
    return n;
  };
  const offset = integer(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(query.limit, 10, 1, 20);
  const contentOffset = integer(query.content_offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const contentLimit = integer(query.content_limit, 8000, 1, 8000);
  const events = [...new Map(branchEvents(entries, goalId, false).map((event) => [event.idempotencyKey, event])).values()];
  const base = { source: "session-events" as const, goalId, total: events.length };
  if (query.event_id !== undefined) {
    const event = events.find((entry) => entry.idempotencyKey === query.event_id ||
      ((entry.kind === "decision_recorded" || entry.kind === "paper_cut_recorded") && entry.entry.id === query.event_id));
    if (!event) throw new Error("Goal history event not found on this branch.");
    const chars = Array.from(JSON.stringify(event));
    if (contentOffset > chars.length) throw new Error("Invalid goal history content offset.");
    const end = Math.min(chars.length, contentOffset + contentLimit);
    return { ...base, eventId: event.idempotencyKey, content: chars.slice(contentOffset, end).join(""), contentChars: chars.length, nextContentOffset: end < chars.length ? end : null };
  }
  if (contentOffset !== 0) throw new Error("Goal history content_offset requires event_id.");
  const page = events.slice(offset, offset + limit);
  return { ...base, records: page.map((event) => ({ id: event.idempotencyKey, kind: event.kind,
    ...((event.kind === "decision_recorded" || event.kind === "paper_cut_recorded") ? { noteId: event.entry.id } : {}),
  })), nextOffset: offset + page.length < events.length ? offset + page.length : null };
}

export function reconstructGoalProjectionState(entries: Iterable<SessionEntryLike>, goal: ThreadGoal): GoalProjectionState {
  let state = createGoalProjectionState(goal);
  for (const event of branchEvents(entries, goal.goalId)) state = applyGoalProjectionEvent(state, event);
  return state;
}

function renderCurrentFor(state: GoalProjectionState): string {
  return renderCurrentProjection(state);
}

function renderTimelineFor(state: GoalProjectionState): string {
  return renderTimeline(state.progressEvents);
}

function lintTimeline(state: GoalProjectionState): LanguageLintResult {
  // TIMELINE is append-only. Lint only the newest event here so warnings
  // accumulated by older entries cannot permanently block future reports; the
  // new report itself is already checked through CURRENT before append().
  const latestEvent = state.progressEvents.at(-1);
  return lintGoalMarkdown(renderTimeline(latestEvent ? [latestEvent] : []));
}

function lintCurrent(state: GoalProjectionState): LanguageLintResult {
  return lintGoalMarkdown(renderCurrentFor(state));
}

function noteSemanticHash(entry: Record<string, unknown>): string {
  const { id: _id, createdAt: _createdAt, status: _status, ...semantic } = entry;
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex").slice(0, 16);
}

function noteEventKey(kind: "decision" | "paper_cut", callId: string, entry: Record<string, unknown>): string {
  return `note:${kind}:${callId}:${noteSemanticHash(entry)}`;
}

function noteEntryId(kind: "decision" | "paper_cut", callId: string, entry: Record<string, unknown>): string {
  return `${kind === "decision" ? "D" : "PC"}-${noteSemanticHash({ callId, ...entry })}`;
}

export function createGoalProjections(
  pi: Pick<ExtensionAPI, "appendEntry">,
  artifacts: GoalArtifacts,
  getCurrentGoal: () => ThreadGoal | null,
) {
  let state: GoalProjectionState | null = null;
  let unconfirmedWrite: GoalCanonicalWriteError | null = null;
  const assertWritable = (): void => { if (unconfirmedWrite) throw unconfirmedWrite; };
  let tail = Promise.resolve();
  let branchGeneration = 0;

  const enqueue = async <T>(ctx: GoalArtifactContext, operation: (ctx: GoalArtifactContext) => Promise<T>): Promise<T> => {
    const generation = branchGeneration;
    const assertCurrent = (): void => {
      ctx.assertCurrent?.();
      if (generation !== branchGeneration) throw new Error("Goal projection is stale after session replacement.");
    };
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { assertCurrent(); const result = await operation({ ...ctx, assertCurrent }); assertCurrent(); return result; } finally { release(); }
  };

  const current = (): GoalProjectionState => {
    const goal = getCurrentGoal();
    if (!goal) throw new Error(say("Активной цели нет.", "No active goal exists."));
    if (!state || state.goalId !== goal.goalId) {
      state = createGoalProjectionState(goal);
    }
    return state;
  };

  const restore = (entries: Iterable<SessionEntryLike>, goal: ThreadGoal | null): void => {
    assertWritable();
    const reconstructed = goal ? reconstructGoalProjectionState(entries, goal) : null;
    const previous = state;
    const sameEventLog = previous !== null && reconstructed !== null && previous.goalId === reconstructed.goalId &&
      previous.stateSeq === reconstructed.stateSeq &&
      previous.appliedEventKeys.length === reconstructed.appliedEventKeys.length &&
      previous.appliedEventKeys.every((key, index) => key === reconstructed.appliedEventKeys[index]);
    state = sameEventLog && previous && reconstructed
      ? { ...reconstructed, currentProjectionSeq: previous.currentProjectionSeq }
      : reconstructed;
  };

  const reload = (entries: Iterable<SessionEntryLike>, goal: ThreadGoal | null): void => {
    unconfirmedWrite = null;
    branchGeneration += 1;
    restore(entries, goal);
  };

  const append = (event: GoalProjectionEvent): GoalProjectionState => {
    assertWritable();
    if (!isGoalProjectionEvent(event)) throw new Error("Refusing to append malformed goal projection event.");
    const next = applyGoalProjectionEvent(current(), event);
    if (next !== state) {
      try { pi.appendEntry(GOAL_PROJECTION_ENTRY_TYPE, event); }
      catch (error) {
        // The SDK changes its memory branch before file persistence. A thrown
        // append cannot prove either rollback or a durable commit.
        const note = event.kind === "decision_recorded"
          ? { noteId: event.entry.id, kind: "decision" as const }
          : event.kind === "paper_cut_recorded" ? { noteId: event.entry.id, kind: "paper_cut" as const }
          : event.kind === "paper_cut_updated" ? { noteId: event.id, kind: "paper_cut" as const } : null;
        const operation = note ? "record_goal_note" : event.kind === "work_state_updated" ? "update_goal_work"
          : event.kind === "progress_reported" ? "report_goal_progress" : undefined;
        unconfirmedWrite = new GoalCanonicalWriteError({
          ...(operation ? { operation } : {}), applied: null, stage: "canonical", retryable: false,
          goalId: event.goalId, eventId: event.idempotencyKey, projectionEvent: event.kind, ...note,
          ...(event.kind === "progress_reported" ? { reportId: event.reportId } : {}),
          message: error instanceof Error ? error.message : String(error),
          remediation: say("Неизвестно, сохранилась ли запись. Заново открой сохранённый файл сессии и выбранную ветку, затем сверь eventId через get_goal(view=history). Память SDK, get_goal до повторного открытия и перезагрузка расширения не доказывают сохранения в файле. До сверки не повторяй и не продолжай записи цели. Если запись сохранена, пересобери документы, не публикуя отчёт повторно и не дублируя запись или изменение; согласованную операцию повторяй, только убедившись, что её нет.", "Write acknowledgement is unknown. Reopen the saved session file and selected branch, then reconcile eventId with get_goal(view=history). SDK memory, get_goal before reopening and extension reload do not prove file persistence. Do not repeat or continue Goal writes before reconciliation. If saved, rebuild projections without republishing a report or duplicating a note or amendment; retry an approved operation only after confirming its absence."),
        });
        throw unconfirmedWrite;
      }
      state = next;
    }
    return state!;
  };

  const setRepair = (goal: ThreadGoal, repair: GoalLanguageRepair, key: string): GoalProjectionState => {
    const event = {
      kind: "language_repair_required" as const,
      idempotencyKey: `repair:${goal.goalId}:${key}`,
      goalId: goal.goalId,
      repair,
    };
    if (!current().appliedEventKeys.includes(event.idempotencyKey)) append(event);
    return current();
  };

  const clearRepair = (goal: ThreadGoal, key: string): GoalProjectionState => {
    const repairKey = current().languageRepairKey;
    if (!repairKey) return current();
    const event = {
      kind: "language_repair_cleared" as const,
      idempotencyKey: `repair-cleared:${goal.goalId}:${key}:${repairKey}`,
      goalId: goal.goalId,
      repairKey,
    };
    if (!current().appliedEventKeys.includes(event.idempotencyKey)) append(event);
    return current();
  };

  const repairFromLanguage = (
    artifact: GoalLanguageRepair["artifact"],
    fields: string[],
    language: LanguageLintResult,
    diagnosticFields: readonly (string | null)[] = [],
  ): GoalLanguageRepair => ({
    artifact,
    fields,
    findings: language.errors.map((finding) => finding.message),
    diagnostics: language.diagnostics.map((diagnostic, index): GoalProjectionLanguageDiagnostic => ({
      artifact,
      code: diagnostic.code,
      field: diagnosticFields[index] ?? diagnostic.field,
      length: diagnostic.length,
      limit: diagnostic.limit,
      repair: diagnostic.repair,
    })),
  });

  const reportDiagnosticFields = (report: GoalProgressReport, language: LanguageLintResult): readonly (string | null)[] => {
    const candidates = [
      "phase",
      "summary",
      "changed",
      "completed",
      "problemOrDecision",
      "riskAndComplexity",
      "verification",
      "nextStep",
      "needUser",
    ] as const;
    const matches = new Map<string, string[]>();
    for (const field of candidates) {
      const value = report[field];
      if (!value?.trim()) continue;
      const renderedValue = field === "phase" ? sanitizeTitle(value) : sanitizeMarkdownBlock(value);
      const fieldLanguage = lintGoalMarkdown(renderedValue);
      for (const diagnostic of fieldLanguage.diagnostics) {
        const existing = matches.get(diagnostic.code) ?? [];
        existing.push(field);
        matches.set(diagnostic.code, existing);
      }
    }
    return language.diagnostics.map((diagnostic) => matches.get(diagnostic.code)?.shift() ?? "projection");
  };

  /** Текст `GOAL.md` на диске: перезапись идёт только поверх того, что прочитано под блокировкой. */
  const readGoalFile = (goal: ThreadGoal, ctx: GoalArtifactContext): Promise<string | null> =>
    artifacts.readExisting(goal, "GOAL", { cwd: ctx.cwd });

  const syncProjections = async (goal: ThreadGoal, ctx: GoalArtifactContext, clearLanguageRepair = false): Promise<GoalProjectionOutcome> => {
    assertWritable();
    ctx.assertCurrent?.();
    restore(ctx.sessionManager.getBranch(), goal);
    await artifacts.bootstrapManaged(goal, ctx);
    ctx.assertCurrent?.();
    let captured = await artifacts.withArtifactLock(goal, { cwd: ctx.cwd }, () => readGoalFile(goal, ctx));
    ctx.assertCurrent?.();
    const currentState = current();
    const refs = () => artifacts.managedRefs(goal, ctx, ctx.sessionManager.getBranch());
    const currentLanguage = lintCurrent(currentState);
    if (currentLanguage.verdict === "repair_required") {
      const repair = repairFromLanguage("CURRENT", ["current"], currentLanguage);
      const repairedState = setRepair(goal, repair, `sync:CURRENT:${currentState.stateSeq}`);
      return { state: repairedState, refs: refs(), language: currentLanguage };
    }
    const checks = [
      { artifact: "TIMELINE", field: "timeline", language: lintTimeline(currentState) },
      { artifact: "DECISIONS", field: "decisions", language: lintGoalMarkdown(renderDecisions(currentState.decisions, currentState.legacyDecisions)) },
      { artifact: "PAPER-CUTS", field: "paperCuts", language: lintGoalMarkdown(renderPaperCuts(currentState.paperCuts, currentState.legacyPaperCuts)) },
    ] as const;
    for (const check of checks) {
      if (check.language.verdict !== "repair_required") continue;
      const repair = repairFromLanguage(check.artifact, [check.field], check.language);
      const repairedState = setRepair(goal, repair, `sync:${check.artifact}:${currentState.stateSeq}`);
      return { state: repairedState, refs: artifacts.managedRefs(goal, ctx, ctx.sessionManager.getBranch()), language: check.language };
    }
    if (clearLanguageRepair && currentState.languageRepair) clearRepair(goal, `clean-retry:${currentState.latestReportId ?? currentState.stateSeq}`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = current();
      const ref = artifacts.managedRefs(goal, ctx, ctx.sessionManager.getBranch()).find((item) => item.artifact === "GOAL");
      if (!ref) throw new Error("Managed GOAL artifact ref is unavailable.");
      try {
        await artifacts.write(goal, "GOAL", renderGoalDocument(snapshot), ref.revision, { ...ctx, allowTerminal: true, expectedContent: captured });
        break;
      } catch (error) {
        if (attempt === 0 && error instanceof Error && /Stale artifact revision|Artifact changed after capture/.test(error.message)) {
          ctx.assertCurrent?.();
          restore(ctx.sessionManager.getBranch(), goal);
          captured = await artifacts.withArtifactLock(goal, { cwd: ctx.cwd }, () => readGoalFile(goal, ctx));
          continue;
        }
        throw error;
      }
    }
    ctx.assertCurrent?.();
    const synchronizedResult = current();
    state = { ...synchronizedResult, currentProjectionSeq: synchronizedResult.stateSeq };
    return { state, refs: refs(), language: currentLanguage };
  };

  const initialize = (goal: ThreadGoal, ctx: GoalArtifactContext): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    const liveGoal = getCurrentGoal();
    if (!liveGoal || liveGoal.goalId !== goal.goalId || liveGoal.status !== goal.status || liveGoal.updatedAt !== goal.updatedAt) {
      const stale = createGoalProjectionState(goal);
      return { state: stale, refs: [], language: lintCurrent(stale) };
    }
    current();
    if (state!.stateSeq === 0) append({ kind: "goal_created", idempotencyKey: `init:${goal.goalId}`, goalId: goal.goalId, goal });
    await artifacts.bootstrapManaged(goal, ctx);
    ctx.assertCurrent?.();
    return syncProjections(goal, ctx);
  });

  const updateGoal = (goal: ThreadGoal, ctx: GoalArtifactContext, key: string): Promise<GoalProjectionOutcome> => goal.status === "complete"
    ? completeGoal(goal, ctx, `complete:${goal.updatedAt}`)
    : enqueue(ctx, async (ctx) => {
    const liveGoal = getCurrentGoal();
    if (!liveGoal || liveGoal.goalId !== goal.goalId) {
      const stale = createGoalProjectionState(goal);
      return { state: stale, refs: [], language: lintCurrent(stale) };
    }
    if (liveGoal.status !== goal.status || liveGoal.updatedAt !== goal.updatedAt) {
      const currentState = current();
      return { state: currentState, refs: [], language: lintCurrent(currentState) };
    }
    if (current().stateSeq === 0) append({ kind: "goal_created", idempotencyKey: `init:${goal.goalId}`, goalId: goal.goalId, goal });
    else append({ kind: goal.status === "complete" ? "goal_completed" : "goal_updated", idempotencyKey: `goal:${goal.goalId}:${key}`, goalId: goal.goalId, goal });
    return syncProjections(goal, ctx, false);
  });

  const completeGoal = (goal: ThreadGoal, ctx: GoalArtifactContext, key: string): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    if (getCurrentGoal()?.goalId !== goal.goalId) throw new Error("Goal changed while completing projection.");
    const event = { kind: "goal_completed", idempotencyKey: `complete:${goal.goalId}:${key}`, goalId: goal.goalId, goal } as const;
    if (!current().appliedEventKeys.includes(event.idempotencyKey)) append(event);
    return syncProjections(goal, ctx, false);
  });

  const updateWork = (goalId: string, workState: GoalWorkState, expectedRevision: number, ctx: GoalArtifactContext, callId: string): Promise<GoalWorkUpdateResult> => enqueue(ctx, async (ctx) => {
    const goal = getCurrentGoal();
    if (!goal || goal.goalId !== goalId) throw new Error("Goal changed while updating work state.");
    if (goal.status !== "active" && goal.status !== "paused") throw new Error(say("У завершённой цели нельзя менять план работы.", "Terminal goals cannot update work state."));
    restore(ctx.sessionManager.getBranch(), goal);
    const key = createHash("sha256").update(JSON.stringify({ callId, goalId, expectedRevision, workState })).digest("hex");
    const event = { kind: "work_state_updated" as const, idempotencyKey: `work:${key}`, goalId, expectedRevision, workState };
    if (!isGoalProjectionEvent(event)) throw new Error("Refusing to append malformed goal projection event.");
    const before = current();
    const candidate = applyGoalProjectionEvent(before, event);
    // Rewriting an identical, reconciled plan only repairs its document. Keep
    // the reducer validation and stale-plan acknowledgement for real updates.
    if (before.workStateStale || !isDeepStrictEqual(before.workState, candidate.workState)) append(event);
    const accepted = current();
    let snapshot = accepted;
    let error: string | null = null;
    try {
      const synchronized = await syncProjections(goal, ctx, true);
      snapshot = synchronized.state;
      if (synchronized.language.verdict === "repair_required") error = synchronized.language.errors.map((item) => item.message).join("; ");
    }
    catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    const projectionFresh = error === null && snapshot.currentProjectionSeq === snapshot.stateSeq && snapshot.languageRepair === null;
    return { applied: true, goalId, workRevision: snapshot.workRevision, workStateStale: snapshot.workStateStale,
      projectionFresh, stage: projectionFresh ? "complete" : "projection",
      retryable: !projectionFresh && getCurrentGoal()?.goalId === goalId, error };
  });

  const publish = (goal: ThreadGoal, report: GoalProgressReport, reportId: string, ctx: GoalArtifactContext, reportAnchor?: { turnIndex: number | null; activeSeconds: number; tokensUsed: number; assistantTurns: number }): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    const liveGoal = getCurrentGoal();
    if (!liveGoal || liveGoal.goalId !== goal.goalId || liveGoal.objective !== goal.objective || liveGoal.tokenBudget !== goal.tokenBudget) {
      throw new Error(say("Контракт цели изменился во время обновления документа; перед отчётом прочитай текущую цель.", "Goal contract changed while publishing projection; read the current goal before reporting."));
    }
    const eventKey = `report:${reportId}`;
    let currentState = current();
    if (currentState.stateSeq === 0) {
      append({ kind: "goal_created", idempotencyKey: `init:${goal.goalId}`, goalId: goal.goalId, goal });
      currentState = current();
    }
    const eventKind = report.eventKind ?? "progress_checkpoint";
    const workChangedSinceVerification = currentState.workState !== null && currentState.verifiedWorkRevision !== currentState.workRevision;
    if (!workChangedSinceVerification && eventKind === "progress_checkpoint" && currentState.latestProgress && !currentState.appliedEventKeys.includes(eventKey) && sameProgressContent(currentState.latestProgress, report)) {
      const outcome = await syncProjections(goal, ctx, false);
      return { ...outcome, eventApplied: false };
    }
    const candidate = applyGoalProjectionEvent(currentState, {
      kind: "progress_reported",
      idempotencyKey: eventKey,
      report: { ...report, eventKind },
      reportId,
      eventKind,
      createdAt: Date.now(),
      ...(reportAnchor ? { reportAnchor } : {}),
      goalId: goal.goalId,
    });
    const language = lintGoalMarkdown(renderCurrentProjection(candidate));
    if (language.verdict === "repair_required") {
      const diagnosticFields = reportDiagnosticFields(report, language);
      const reportFields = [...new Set(diagnosticFields.filter((field): field is string => field !== null && field !== "projection"))];
      const repair = repairFromLanguage("CURRENT", reportFields.length > 0 ? reportFields : ["projection"], language, diagnosticFields);
      const repairedState = setRepair(goal, repair, eventKey);
      return { state: repairedState, refs: artifacts.managedRefs(goal, ctx, ctx.sessionManager.getBranch()), language };
    }
    if (!current().appliedEventKeys.includes(eventKey)) {
      append({ kind: "progress_reported", idempotencyKey: eventKey, report: { ...report, eventKind }, reportId, eventKind, createdAt: Date.now(), goalId: goal.goalId, ...(reportAnchor ? { reportAnchor } : {}) });
    }
    const outcome = await syncProjections(goal, ctx, true);
    return { ...outcome, eventApplied: true };
  });

  // Canonical note events survive a failed document write. Keep their address
  // in the failure so the caller repairs the projection, not the note itself.
  const syncNoteProjection = async (goal: ThreadGoal, kind: "decision" | "paper_cut", id: string, ctx: GoalArtifactContext): Promise<GoalProjectionOutcome> => {
    try { return { ...await syncProjections(goal, ctx, true), entryId: id }; }
    catch (error) {
      ctx.assertCurrent?.();
      throw new Error(JSON.stringify({
        operation: "record_goal_note", applied: true, stage: "projection",
        retryable: getCurrentGoal()?.goalId === goal.goalId, goalId: goal.goalId,
        noteId: id, kind, message: error instanceof Error ? error.message : String(error),
        remediation: say("Прочитай get_goal. Исправь существующий документ через record_goal_note(action=repair, kind, note_id); новую запись не создавай. Для замечаний к тексту сначала открой load_goal_language_guide и исправь названные данные.", "Read get_goal. Repair the existing document via record_goal_note(action=repair, kind, note_id); do not record another note. For text diagnostics use load_goal_language_guide and repair the named data first."),
      }));
    }
  };

  const recordDecision = (goal: ThreadGoal, entry: Omit<GoalDecisionEntry, "id">, ctx: GoalArtifactContext, callId: string): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    if (getCurrentGoal()?.goalId !== goal.goalId) throw new Error("Goal changed while recording projection note.");
    const approvedAmendment = entry.source === "approved-amendment";
    // Older sessions keyed amendment decisions by the complete entry. Reuse
    // that proven event rather than creating a second decision after upgrade.
    const legacyEntry = approvedAmendment ? current().decisions.find((item) =>
      current().appliedEventKeys.includes(noteEventKey("decision", callId, { ...item }))) : undefined;
    const id = legacyEntry?.id ?? (approvedAmendment ? `D-${noteSemanticHash({ callId })}` : noteEntryId("decision", callId, entry));
    const eventEntry = { ...(legacyEntry ?? entry), id };
    const eventKey = legacyEntry ? noteEventKey("decision", callId, { ...legacyEntry }) :
      approvedAmendment ? `decision:${callId}` : noteEventKey("decision", callId, eventEntry);
    const event = { kind: "decision_recorded", idempotencyKey: eventKey, goalId: goal.goalId, entry: eventEntry } as const;
    const candidate = applyGoalProjectionEvent(current(), event);
    const text = renderDecisions(candidate.decisions);
    const language = lintGoalMarkdown(text);
    if (language.verdict === "repair_required") {
      const repair = repairFromLanguage("DECISIONS", ["decision"], language);
      const repairedState = setRepair(goal, repair, event.idempotencyKey);
      return { state: repairedState, refs: [], language };
    }
    append(event);
    return syncNoteProjection(goal, "decision", id, ctx);
  });

  const recordPaperCut = (goal: ThreadGoal, entry: Omit<GoalPaperCutEntry, "id" | "status">, ctx: GoalArtifactContext, callId: string): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    if (getCurrentGoal()?.goalId !== goal.goalId) throw new Error("Goal changed while recording projection note.");
    const id = noteEntryId("paper_cut", callId, entry);
    const eventEntry = { ...entry, id, status: "open" as const };
    const event = { kind: "paper_cut_recorded", idempotencyKey: noteEventKey("paper_cut", callId, eventEntry), goalId: goal.goalId, entry: eventEntry } as const;
    const candidate = applyGoalProjectionEvent(current(), event);
    const text = renderPaperCuts(candidate.paperCuts);
    const language = lintGoalMarkdown(text);
    if (language.verdict === "repair_required") {
      const repair = repairFromLanguage("PAPER-CUTS", ["paperCut"], language);
      const repairedState = setRepair(goal, repair, event.idempotencyKey);
      return { state: repairedState, refs: [], language };
    }
    append(event);
    return syncNoteProjection(goal, "paper_cut", id, ctx);
  });

  const updatePaperCut = (goal: ThreadGoal, update: GoalPaperCutUpdate, ctx: GoalArtifactContext, callId: string): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    if (getCurrentGoal()?.goalId !== goal.goalId) throw new Error("Goal changed while updating projection note.");
    const stored = current().paperCuts.find((entry) => entry.id === update.id);
    if (!stored) throw new Error(say(`Нет отложенного риска ${update.id}.`, `Unknown paper cut ${update.id}.`));
    if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision < 0) throw new Error(say("expected_revision — неотрицательная ревизия записи из get_goal.", "expected_revision must be a non-negative note revision from get_goal."));
    if (!update.resolution.trim()) throw new Error(say("Чтобы закрыть отложенный риск, нужно поле resolution.", "resolution is required when closing a paper cut."));
    const revision = stored.revision ?? 0;
    const unchanged = stored.status === update.status && stored.resolution === update.resolution;
    // A retry may carry the previous revision after the canonical event was
    // saved. Accept only the exact effect, never overwrite a newer verdict.
    if (update.expectedRevision !== revision && !(unchanged && update.expectedRevision + 1 === revision)) {
      throw new Error(say(`Ревизия записи устарела: ожидалась ${update.expectedRevision}, текущая ${revision}. Перед повтором прочитай get_goal.`, `Stale note revision: expected ${update.expectedRevision}, current ${revision}. Read get_goal before retrying.`));
    }
    if (unchanged) return syncNoteProjection(goal, "paper_cut", update.id, ctx);
    const key = createHash("sha256").update(JSON.stringify({ callId, update })).digest("hex");
    const event = { kind: "paper_cut_updated" as const, idempotencyKey: `note-update:${key}`, goalId: goal.goalId,
      id: update.id, expectedRevision: update.expectedRevision, status: update.status, resolution: update.resolution };
    const candidate = applyGoalProjectionEvent(current(), event);
    const language = lintGoalMarkdown(renderPaperCuts(candidate.paperCuts));
    if (language.verdict === "repair_required") {
      return { state: setRepair(goal, repairFromLanguage("PAPER-CUTS", ["paperCut"], language), event.idempotencyKey), refs: [], language };
    }
    append(event);
    return syncNoteProjection(goal, "paper_cut", update.id, ctx);
  });

  const repairNote = (goal: ThreadGoal, kind: "decision" | "paper_cut", id: string, ctx: GoalArtifactContext): Promise<GoalProjectionOutcome> => enqueue(ctx, async (ctx) => {
    if (getCurrentGoal()?.goalId !== goal.goalId) throw new Error("Goal changed while repairing projection note.");
    const notes = kind === "decision" ? current().decisions : current().paperCuts;
    if (!notes.some((entry) => entry.id === id)) throw new Error(`Unknown ${kind} note ${id}.`);
    return syncNoteProjection(goal, kind, id, ctx);
  });

  return {
    current: () => state,
    assertWritable,
    getUnconfirmedWrite: () => unconfirmedWrite,
    reload,
    initialize,
    updateGoal,
    publish,
    updateWork,
    recordDecision,
    recordPaperCut,
    updatePaperCut,
    repairNote,
    completeGoal,
    repair: () => state?.languageRepair ?? null,
    // Bootstrap and lifecycle status events do not make a goal managed. The
    // managed contract starts with a durable v2 projection payload (or a
    // preserved legacy payload), not with pause/resume bookkeeping.
    isManaged: () => Boolean(state?.appliedEventKeys.some((key) =>
      key.startsWith("report:") || key.startsWith("work:") || key.startsWith("note:") || key.startsWith("legacy:") || key.startsWith("documents:")
    )), 
    isCompletionReady: (report?: GoalProgressReport | null) => {
      if (!state || state.stateSeq === 0 || state.languageRepair || state.currentProjectionSeq !== state.stateSeq) return false;
      if (state.workState && (state.workStateStale || state.verifiedWorkRevision !== state.workRevision)) return false;
      return report?.status === "verifying" || state.latestProgress?.status === "verifying";
    },
  };
}

