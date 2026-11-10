import type { GoalHistoryPage, GoalHistoryQuery } from "./goal-projections.js";
import { stringEnum } from "./string-enum.js";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalActionWorkingState, goalStatusWorkingState, goalToolResponse, toToolGoal, toToolText, type GoalToolResponse, type GoalWorkingState } from "./format.js";
import { type GoalReportAction, type GoalReportState } from "./goal-reports.js";
import { MAX_REPORT_CHANGED_CHARS, MAX_REPORT_COMPLETED_CHARS, MAX_REPORT_NEED_USER_CHARS, MAX_REPORT_NEXT_STEP_CHARS, MAX_REPORT_PHASE_CHARS, MAX_REPORT_PROBLEM_CHARS, MAX_REPORT_RISK_CHARS, MAX_REPORT_SUMMARY_CHARS, MAX_REPORT_VERIFICATION_CHARS, type GoalProgressReport, type GoalProgressEventKind, type GoalProgressStatus, validateNewGoalProgressReport } from "./report-schema.js";
import { createGoal, replaceGoal } from "./state.js";
import { GoalCanonicalWriteError } from "./goal-persistence.js";
import { DONE_CRITERION_GUIDANCE, goalToolGuidelines } from "./prompts.js";
import { MAX_GOAL_PROSE_PARAGRAPH_CHARS } from "./goal-language-quality.js";
import type { GoalPaperCutUpdate } from "./goal-projections.js";
import { isGoalWorkState, type GoalWorkState, type GoalWorkUpdateResult } from "./goal-work-state.js";
import { type GoalArtifactRef, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

const GOAL_PROSE_DESCRIPTION = `Write Russian prose in paragraphs of at most ${MAX_GOAL_PROSE_PARAGRAPH_CHARS} characters. Keep exact commands, paths, error messages, identifiers and status values unchanged in inline or fenced code.`;

const EmptyParams = Type.Object({});
const GetGoalParams = Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("status"), Type.Literal("history")], {
    description: "Default full includes the unchanged contract and work state. Status omits these; history reads a bounded event index or exact record. None authorizes a transition.",
  })),
  event_id: Type.Optional(Type.String({ minLength: 1, description: "History event id from the index, or a decision note id. Returns paged original JSON." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "History index offset; follow nextOffset." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  content_offset: Type.Optional(Type.Integer({ minimum: 0, description: "Unicode code point offset; follow nextContentOffset." })),
  content_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
}, { additionalProperties: false });
const ResumeGoalParams = Type.Object({
  user_decision_confirmed: Type.Optional(Type.Boolean({
    description: "Required true when resuming a paused goal with an unconfirmed awaiting_user decision: the agent has interpreted the actual reply as the required answer. Never set for status questions or continuation without the required answer.",
  })),
}, { additionalProperties: false });

const CreateGoalParams = Type.Object({
  objective: Type.String({
    description: `Preserve the original user request, approved outcome and evidence, non-goals, simplest path, complexity bounds, done criterion and decision gates. ${DONE_CRITERION_GUIDANCE}`,
  }),
  token_budget: Type.Optional(
    Type.Union([
      Type.Integer({
        description: "Optional positive integer token budget; null means no budget limit.",
        minimum: 1,
      }),
      Type.Null(),
    ]),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        "Replace an existing non-complete goal when the user explicitly requests a new goal.",
    }),
  ),
});

const AmendGoalParams = Type.Object({
  amendment: Type.Optional(Type.String({
    minLength: 1,
    description: "New user-approved addition. Supply exactly one of amendment or amendment_id. Never resend edited text to repair an applied amendment.",
  })),
  amendment_id: Type.Optional(Type.String({
    minLength: 1,
    description: "Recovery only: the ID returned for an already applied amendment. Restores its projections without appending or changing the saved contract; omit amendment.",
  })),
}, { additionalProperties: false });

const UpdateGoalParams = Type.Object({
  status: stringEnum(["complete"] as const, {
    description: "Only complete is accepted. Do not call this until no required work remains.",
  }),
});

const RecordGoalNoteParams = Type.Object({
  kind: stringEnum(["decision", "paper_cut"] as const, { description: "Select exactly one note branch; decision uses decision+rationale, paper_cut uses impact+severity." }),
  action: Type.Optional(stringEnum(["record", "update", "repair"] as const, { description: "Default record. update closes an existing paper_cut; repair rebuilds the document for an already saved note without another event." })),
  note_id: Type.Optional(Type.String({ minLength: 1, description: "Required for update/repair; use noteId from the receipt or paperCuts[].id from get_goal." })),
  expected_revision: Type.Optional(Type.Integer({ minimum: 0, description: "Required for update: use that paperCuts entry revision, not workRevision." })),
  status: Type.Optional(stringEnum(["resolved", "wont_fix"] as const, { description: "Required for update. wont_fix does not approve a scope change or cancel required work." })),
  resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required for update: evidence of the fix or reason for accepting the risk." })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: "Required for record only." })),
  decision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required for record with kind=decision; the durable choice." })),
  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required only for kind=decision; why the choice was made." })),
  consequence: Type.Optional(Type.String({ maxLength: 1200 })),
  impact: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "Required only for kind=paper_cut; consequence of deferring the issue." })),
  severity: Type.Optional(stringEnum(["low", "medium", "high"] as const, { description: "Required only for kind=paper_cut." })),
  revisit: Type.Optional(Type.String({ maxLength: 1200 })),
}, { additionalProperties: false });

export const ProgressReportParams = Type.Object({
  eventKind: Type.Optional(stringEnum(["goal_started", "phase_changed", "progress_checkpoint", "verification", "blocker_opened", "blocker_resolved", "decision_recorded", "artifact_updated", "goal_completed"] as const, { description: "Select one semantic delta. Required alternatives: goal_started changed or completed; phase_changed changed; verification verification; blocker_opened problemOrDecision; blocker_resolved problemOrDecision or completed; decision_recorded problemOrDecision; artifact_updated changed or completed; goal_completed verification or completed; progress_checkpoint none." })),
  action: stringEnum(["publish", "suppress"] as const, { description: "publish records a report; suppress accepts no fields besides action." }),
  status: Type.Optional(stringEnum(["working", "verifying", "blocked", "awaiting_user"] as const, { description: "Required for publish. working needs a meaningful delta and continues independent work despite one blocked item. verifying needs verification. blocked needs problemOrDecision and means the whole goal has no safe next action; awaiting_user needs needUser for a real decision. Both hold continuation until a user answer and working report." })),
  phase: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_PHASE_CHARS, description: "Required for publish; short current meaningful action in present tense." })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_SUMMARY_CHARS, description: "Required for publish; 1-3 connected sentences describing change, meaning and next step." })),
  changed: Type.Optional(Type.String({ maxLength: MAX_REPORT_CHANGED_CHARS, description: "Use as the changed alternative for goal_started or artifact_updated; required for phase_changed. working needs any meaningful delta." })),
  completed: Type.Optional(Type.String({ maxLength: MAX_REPORT_COMPLETED_CHARS, description: "Use as the completed alternative for goal_started, blocker_resolved, artifact_updated or goal_completed." })),
  problemOrDecision: Type.Optional(Type.String({ maxLength: MAX_REPORT_PROBLEM_CHARS, description: "Required for blocker_opened, decision_recorded, or blocked status; blocker_resolved accepts this or completed." })),
  riskAndComplexity: Type.Optional(Type.String({ maxLength: MAX_REPORT_RISK_CHARS })),
  verification: Type.Optional(Type.String({ maxLength: MAX_REPORT_VERIFICATION_CHARS, description: "Required for verification; one alternative for goal_completed; also required for verifying status." })),
  nextStep: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEXT_STEP_CHARS })),
  needUser: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEED_USER_CHARS, description: "Required for awaiting_user status; concrete decision needed from the user." })),
}, { additionalProperties: false });

const GoalWorkParams = Type.Object({
  goal_id: Type.String({ minLength: 1 }),
  expected_revision: Type.Integer({ minimum: 0, description: "Use workRevision from get_goal. A stale revision requires reading the current state before retrying." }),
  state: Type.Object({
    outcome: Type.String({ description: "Concise user result; does not replace or amend the approved objective." }),
    doneWhen: Type.String({ description: "Concise explanation of the agreed completion criterion." }),
    summary: Type.String({ description: "Current whole-task position, not just the latest delta." }),
    items: Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.String(),
      status: stringEnum(["planned", "active", "blocked", "done", "cancelled"] as const),
      source: stringEnum(["user", "agent"] as const),
      result: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }, { additionalProperties: false })),
    activeDecisionIds: Type.Array(Type.String({ minLength: 1 }), { description: "IDs of existing decision records that still determine the current path." }),
    nextItemId: Type.Optional(Type.String({ minLength: 1, description: "Next useful active or planned item. Check dependencies and authority; blocked, done, cancelled and unknown IDs are rejected." })),
    verification: Type.Optional(Type.String()),
    risks: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export interface ToolHost {
  getGoal(): ThreadGoal | null;
  getGoalWorkingState(ctx: ExtensionContext): GoalWorkingState;
  getGoalHistory?(query: GoalHistoryQuery, ctx: ExtensionContext): GoalHistoryPage;
  updateGoalWork(goalId: string, workState: GoalWorkState, expectedRevision: number, ctx: ExtensionContext, callId: string): Promise<GoalWorkUpdateResult>;
  getReportState(): GoalReportState;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void;
  waitForGoalProjection?: () => Promise<void>;
  resumeGoal?(ctx: ExtensionContext, signal?: AbortSignal, userDecisionConfirmed?: boolean): Promise<GoalResult>;
  amendGoal(amendment: string, source: GoalEntrySource, ctx: ExtensionContext, amendmentId?: string): Promise<GoalResult>;
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext): Promise<GoalResult>;
  reportGoal(
    action: GoalReportAction,
    report: GoalProgressReport | null,
    ctx: ExtensionContext,
    toolCallId?: string,
  ): Promise<{ reportId: string | null; state: GoalReportState; projection?: unknown }>;
  recordGoalDecision(input: { title: string; decision: string; rationale: string; consequence?: string }, ctx: ExtensionContext, callId: string): Promise<unknown>;
  recordGoalPaperCut(input: { title: string; impact: string; severity: "low" | "medium" | "high"; revisit?: string }, ctx: ExtensionContext, callId: string): Promise<unknown>;
  updateGoalPaperCut?(input: GoalPaperCutUpdate, ctx: ExtensionContext, callId: string): Promise<unknown>;
  repairGoalNote?(kind: "decision" | "paper_cut", noteId: string, ctx: ExtensionContext): Promise<unknown>;
  loadGoalLanguageGuide(): unknown;
}

function textResult(
  text: string,
  goal: ThreadGoal | null,
  includeCompletionBudgetReport = false,
): AgentToolResult<GoalToolResponse & { error: string | null }> {
  return {
    content: [{ type: "text", text }],
    details: { ...goalToolResponse(goal, includeCompletionBudgetReport), error: null },
  };
}

function throwToolError(message: string, details?: Record<string, unknown>): never {
  if (!details) throw new Error(message);
  throw new Error(JSON.stringify({ ...details, message }));
}

function isProjectionRepairResult(value: unknown): value is {
  language: { verdict: "repair_required"; errors?: readonly { message?: string }[] };
  state?: { languageRepair?: { diagnostics?: readonly unknown[] } | null };
} {
  if (!value || typeof value !== "object") return false;
  const language = (value as { language?: unknown }).language;
  return Boolean(language && typeof language === "object" && (language as { verdict?: unknown }).verdict === "repair_required");
}

function projectionRepairMessage(value: { language: { errors?: readonly { message?: string }[] }; state?: { languageRepair?: { diagnostics?: readonly unknown[] } | null } }): string {
  const findings = value.language.errors?.map((item) => item.message).filter((item): item is string => Boolean(item)) ?? [];
  const diagnostics = value.state?.languageRepair?.diagnostics;
  const suffix = diagnostics?.length ? ` diagnostics=${JSON.stringify(diagnostics)}` : "";
  return `Goal projection language repair required${findings.length ? `: ${findings.join("; ")}` : "."}${suffix}`;
}

function projectionArtifactRefs(value: unknown): GoalArtifactRef[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { refs?: unknown }).refs)) return [];
  return (value as { refs: unknown[] }).refs
    .filter((ref): ref is GoalArtifactRef => Boolean(ref && typeof ref === "object" && typeof (ref as { goalId?: unknown }).goalId === "string" && typeof (ref as { artifact?: unknown }).artifact === "string" && typeof (ref as { revision?: unknown }).revision === "number" && typeof (ref as { path?: unknown }).path === "string"))
    .map((ref) => ({ ...ref }));
}

function compactReportState(state: GoalReportState): Pick<GoalReportState, "dueReason" | "dueReasons" | "awaitingUser" | "hasUserDecisionSinceAwaiting" | "questionAnswerPending"> {
  return {
    dueReason: state.dueReason,
    dueReasons: [...state.dueReasons],
    awaitingUser: state.awaitingUser,
    hasUserDecisionSinceAwaiting: state.hasUserDecisionSinceAwaiting,
    questionAnswerPending: state.questionAnswerPending,
  };
}

function requiredReport(params: {
  eventKind?: GoalProgressEventKind;
  status?: GoalProgressStatus;
  phase?: string;
  summary?: string;
  nextStep?: string;
  changed?: string;
  completed?: string;
  problemOrDecision?: string;
  riskAndComplexity?: string;
  verification?: string;
  needUser?: string;
}): GoalProgressReport {
  if (!params.status || !params.phase?.trim() || !params.summary?.trim() || !params.nextStep?.trim()) {
    throwToolError("publish requires status, phase, summary, and nextStep.");
  }
  const result: GoalProgressReport = {
    ...(params.eventKind ? { eventKind: params.eventKind } : {}),
    status: params.status,
    phase: params.phase.trim(),
    summary: params.summary.trim(),
    nextStep: params.nextStep.trim(),
  };
  const optionalFields: Array<[keyof Omit<GoalProgressReport, "eventKind" | "status" | "phase" | "nextStep">, string | undefined]> = [
    ["changed", params.changed],
    ["completed", params.completed],
    ["problemOrDecision", params.problemOrDecision],
    ["riskAndComplexity", params.riskAndComplexity],
    ["verification", params.verification],
    ["needUser", params.needUser],
  ];
  for (const [field, value] of optionalFields) {
    const trimmed = value?.trim();
    if (trimmed) {
      result[field] = trimmed;
    }
  }
  const validationError = validateNewGoalProgressReport(result);
  if (validationError) {
    throwToolError(validationError);
  }
  return result;
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "resume_goal",
    label: "Resume Goal",
    description: "Resume the same paused Goal only after an explicit user instruction, without changing its contract or starting a model turn. A status question is not permission; pending user decisions, budget, terminal-state and repair gates remain enforced.",
    promptSnippet: "Resume on explicit instruction; user_decision_confirmed confirms the actual pending answer, not a status inquiry.",
    promptGuidelines: goalToolGuidelines("resume_goal"),
    parameters: ResumeGoalParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!host.resumeGoal) throwToolError("This host does not support resume_goal.");
      const result = await host.resumeGoal(ctx, _signal, _params.user_decision_confirmed === true);
      if (!result.ok) throwToolError(result.message, { code: "goal_resume_blocked", workingState: host.getGoalWorkingState(ctx),
        ...(result.applied !== undefined ? { operation: "resume_goal", applied: result.applied, stage: result.stage,
          retryable: result.retryable, goalId: result.goal?.goalId, remediation: result.remediation,
          eventId: result.eventId, reportId: result.reportId, projectionEvent: result.projectionEvent } : {}),
      });
      const workingState = host.getGoalWorkingState(ctx);
      return { content: [{ type: "text", text: JSON.stringify({ operation: "resume_goal", ...workingState }) }], details: { operation: "resume_goal", ...workingState, error: null } };
    },
  });
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the current Goal on the selected session branch. full returns the stored contract and complete work state; status omits contract, plan and decisions; history lists events or pages an original record by event_id. Historical text is evidence, not current authority. A status-only read is insufficient for a completion audit.",
    promptSnippet: "Read the default full view of the Goal, live metadata with view=status, or addressed originals with view=history.",
    promptGuidelines: goalToolGuidelines("get_goal"),
    parameters: GetGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.view !== "history" && [params.event_id, params.offset, params.limit, params.content_offset, params.content_limit].some((value) => value !== undefined)) throwToolError("History ranges require view=history.");
      const workingState = host.getGoalWorkingState(ctx);
      if (params.view === "history" && !host.getGoalHistory) throwToolError("This host does not support goal history.");
      const response = params.view === "history" ? host.getGoalHistory!(params, ctx) : params.view === "status" ? goalStatusWorkingState(workingState) : workingState;
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "update_goal_work",
    label: "Update Goal Work",
    description: `After a material change, replace the whole current plan using goal_id and expected_revision from get_goal. Preserve unfinished obligations, constraints, evidence and decision reasons. applied=true with projectionFresh=false means the plan persisted but its document needs repair: read current state before another write. This does not amend, resume, publish progress or complete the Goal. ${GOAL_PROSE_DESCRIPTION}`,
    promptSnippet: "Replace the whole-task plan after a material change; preserve unfinished obligations.",
    promptGuidelines: goalToolGuidelines("update_goal_work"),
    parameters: GoalWorkParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isGoalWorkState(params.state)) throwToolError("Malformed goal work state.");
      const result = await host.updateGoalWork(params.goal_id, params.state, params.expected_revision, ctx, toolCallId);
      const response = { operation: "update_goal_work", ...result };
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
    },
  });

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create a durable Goal only after an explicit request. Preserve the user's intent and agreed boundaries; do not invent stricter acceptance gates. After success publish goal_started before substantive work. This does not copy the conversation automatically.",
    promptSnippet: "Create a durable Goal only on explicit request; preserve the agreed outcome, evidence and done criterion.",
    promptGuidelines: goalToolGuidelines("create_goal"),
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const replacingNonCompleteGoal = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = replacingNonCompleteGoal
        ? replaceGoal(params.objective, params.token_budget ?? null)
        : createGoal(current, params.objective, params.token_budget ?? null);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      let acknowledged = false;
      try {
        host.setGoal(result.goal, "tool", ctx);
        acknowledged = true;
        await host.waitForGoalProjection?.();
      } catch (error) {
        throwToolError(error instanceof Error ? error.message : String(error), {
          operation: "create_goal", applied: acknowledged ? true : null,
          goalId: result.goal.goalId, stage: acknowledged ? "projection" : "canonical",
          retryable: acknowledged && host.getGoal()?.goalId === result.goal.goalId,
          remediation: acknowledged
            ? "Read get_goal. The Goal already exists: do not create it again. Once storage is available, the next authorized Goal write rebuilds its document."
            : "Write acknowledgement is unknown. Reopen the saved session file and selected branch and reconcile the canonical Goal before creating another one; SDK memory and extension reload do not prove persistence.",
          ...(error instanceof GoalCanonicalWriteError ? { ...error.details, operation: "create_goal",
            applied: acknowledged ? true : null, stage: acknowledged ? "projection" : "canonical" } : {}),
        });
      }
      return textResult(toToolText(result.goal), result.goal);
    },
  });

  pi.registerTool({
    name: "amend_goal",
    label: "Amend Goal",
    description: "Append a user-approved amendment, or recover an already applied amendment by amendment_id without changing the contract. Supply exactly one input. A paused goal resumes only after successful projection recovery.",
    promptSnippet: "Append an approved change, or repair its already applied write by amendment_id.",
    promptGuidelines: goalToolGuidelines("amend_goal"),
    parameters: AmendGoalParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if ((params.amendment !== undefined) === (params.amendment_id !== undefined)) {
        throwToolError("Supply exactly one of amendment or amendment_id.");
      }
      const result = await host.amendGoal(params.amendment ?? "", "tool", ctx, params.amendment_id);
      const receipt = {
        operation: result.operation ?? "amend_goal", applied: result.applied === undefined ? result.ok : result.applied,
        ...(result.goal ? { goalId: result.goal.goalId } : {}),
        stage: result.stage ?? "canonical", retryable: result.retryable ?? false,
        ...(result.amendmentId ? { amendment_id: result.amendmentId } : {}),
        eventId: result.eventId, reportId: result.reportId, projectionEvent: result.projectionEvent,
        ...(result.remediation ? { remediation: result.remediation } : {}),
      };
      if (!result.ok || !result.goal) throwToolError(result.message, receipt);
      const response = { ...goalToolResponse(result.goal, true), ...receipt, goal: toToolGoal(result.goal) };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "load_goal_language_guide",
    label: "Load Goal Language Guide",
    description: "Load the structured language-repair diagnostics and concise repair guidance after a goal projection is rejected. Diagnostics contain artifact, code, field, length, limit, and repair without raw sensitive excerpts.",
    promptSnippet: "After rejected Goal text, read diagnostics and repair the affected data safely.",
    promptGuidelines: goalToolGuidelines("load_goal_language_guide"),
    parameters: EmptyParams,
    async execute() {
      const result = host.loadGoalLanguageGuide();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { result, error: null } };
    },
  });

  pi.registerTool({
    name: "record_goal_note",
    label: "Record Goal Note",
    description: `Record a durable decision or deferred risk. Default action=record requires title and kind-specific fields. action=update closes a paper_cut by note_id with expected_revision, status and resolution; it does not approve scope changes. action=repair rebuilds the document for an existing note by kind and note_id without appending another note. Read IDs and note revisions via get_goal(view=full). ${GOAL_PROSE_DESCRIPTION}`,
    promptSnippet: "Record a decision or risk, close a paper cut, or repair an already saved note by ID.",
    promptGuidelines: goalToolGuidelines("record_goal_note"),
    parameters: RecordGoalNoteParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "record";
      let result: unknown;
      if (action === "update" || action === "repair") {
        const allowed = new Set(action === "repair" ? ["kind", "action", "note_id"] : ["kind", "action", "note_id", "expected_revision", "status", "resolution"]);
        if (Object.keys(params).some((key) => !allowed.has(key))) throwToolError("Unexpected note fields for " + action + "; use note_id and only the fields for this action.");
        if (!params.note_id?.trim()) throwToolError("note_id is required for update/repair.");
        if (action === "update") {
          if (params.kind !== "paper_cut") throwToolError("Only paper_cut supports update.");
          if (!params.resolution?.trim()) throwToolError("resolution is required for update.");
          if (params.expected_revision === undefined || !Number.isSafeInteger(params.expected_revision) || params.expected_revision < 0) throwToolError("expected_revision is required; use the note revision from get_goal.");
          if (params.status !== "resolved" && params.status !== "wont_fix") throwToolError("update requires status=resolved or wont_fix.");
          if (!host.updateGoalPaperCut) throwToolError("Paper-cut updates are unavailable.");
          result = await host.updateGoalPaperCut({ id: params.note_id, expectedRevision: params.expected_revision, status: params.status, resolution: params.resolution.trim() }, ctx, toolCallId);
        } else {
          if (!host.repairGoalNote) throwToolError("Note projection repair is unavailable.");
          result = await host.repairGoalNote(params.kind, params.note_id, ctx);
        }
      } else {
        if (action !== "record") throwToolError("Unknown note action.");
        if (["note_id", "expected_revision", "status", "resolution"].some((key) => key in params)) throwToolError("record does not accept update/repair fields.");
        if (!params.title?.trim()) throwToolError("title is required for record.");
        if (params.kind === "decision") {
          if (["impact", "severity", "revisit"].some((key) => key in params)) throwToolError("decision accepts only kind, title, decision, rationale, and optional consequence.");
          if (!params.decision?.trim() || !params.rationale?.trim()) throwToolError("decision requires decision and rationale.");
          result = await host.recordGoalDecision({ title: params.title, decision: params.decision, rationale: params.rationale, ...(params.consequence === undefined ? {} : { consequence: params.consequence }) }, ctx, toolCallId);
        } else {
          if (params.kind !== "paper_cut") throwToolError("Unknown note kind.");
          if (["decision", "rationale", "consequence"].some((key) => key in params)) throwToolError("paper_cut accepts only kind, title, impact, severity, and optional revisit.");
          if (!params.impact?.trim() || !params.severity) throwToolError("paper_cut requires impact and severity.");
          result = await host.recordGoalPaperCut({ title: params.title, impact: params.impact, severity: params.severity, ...(params.revisit === undefined ? {} : { revisit: params.revisit }) }, ctx, toolCallId);
        }
      }
      const noteId = result && typeof result === "object" && "entryId" in result && typeof result.entryId === "string" ? result.entryId : null;
      if (isProjectionRepairResult(result)) throwToolError(projectionRepairMessage(result), {
        operation: "record_goal_note", action, kind: params.kind, noteId: noteId ?? params.note_id ?? null,
        applied: noteId !== null, stage: noteId ? "projection" : "canonical", retryable: true,
        remediation: noteId ? "Read get_goal and load_goal_language_guide; repair existing data, then use action=repair with note_id. Do not record another note." : "Fix rejected fields using load_goal_language_guide, then retry this unapplied request.",
      });
      const fullState = host.getGoalWorkingState(ctx);
      const note = fullState.paperCuts?.find((entry) => entry.id === noteId);
      const artifactRefs = projectionArtifactRefs(result);
      const response = { operation: "record_goal_note", action, noteId, kind: params.kind, applied: true,
        stage: "complete", retryable: false, ...(note ? { noteRevision: note.revision, status: note.status } : {}),
        state: compactReportState(host.getReportState()), workingState: goalActionWorkingState(fullState),
        ...(artifactRefs.length > 0 ? { artifactRefs } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "report_goal_progress",
    label: "Report Goal Progress",
    description: `Publish a user-facing result delta, not internal activity. Publish needs status, phase, summary, nextStep and its status-specific delta; suppress takes only action. If one item is blocked but other safe work remains, report working. Separate independent facts with blank lines. ${GOAL_PROSE_DESCRIPTION}`,
    promptSnippet: "Report a meaningful result change, or suppress a due reminder with action only.",
    promptGuidelines: goalToolGuidelines("report_goal_progress"),
    parameters: ProgressReportParams,
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "suppress" && Object.keys(params).some((key) => key !== "action")) {
        throwToolError("suppress accepts only action; use publish for report fields.");
      }
      const report = params.action === "publish" ? requiredReport(params) : null;
      const result = await host.reportGoal(params.action, report, ctx, toolCallId);
      const workingState = goalActionWorkingState(host.getGoalWorkingState(ctx));
      const artifactRefs = report?.eventKind === "artifact_updated" ? projectionArtifactRefs(result.projection) : [];
      const response = { operation: "report_goal_progress", action: params.action, applied: true, reportId: result.reportId, state: compactReportState(result.state), workingState, ...(artifactRefs.length > 0 ? { artifactRefs } : {}) };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: { ...response, error: null },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Complete the current Goal only after the agreed outcome and required evidence are satisfied. First read get_goal(view=full), then publish report_goal_progress(status=verifying) and await success before a separate completion call. A working goal_completed event is insufficient. If a write fails, inspect persisted state before retrying; neither elapsed effort nor a risk label replaces required proof.",
    promptSnippet: "Complete the Goal only after the agreed result and required evidence are satisfied.",
    promptGuidelines: goalToolGuidelines("update_goal"),
    parameters: UpdateGoalParams,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await host.completeGoal("tool", ctx);
      if (!result.ok || !result.goal) {
        throwToolError(result.message, {
          operation: "update_goal", applied: result.applied === undefined ? false : result.applied,
          goalId: result.goal?.goalId ?? null, stage: result.stage ?? "canonical", retryable: result.retryable ?? false,
          remediation: result.remediation ?? "Read get_goal before another completion attempt.",
          eventId: result.eventId, reportId: result.reportId, projectionEvent: result.projectionEvent,
        });
      }
      const response = {
        operation: "update_goal" as const,
        applied: true,
        stage: "complete",
        retryable: false,
        status: result.goal.status,
        goalId: result.goal.goalId,
        remainingTokens: goalToolResponse(result.goal, true).remainingTokens,
        completionBudgetReport: goalToolResponse(result.goal, true).completionBudgetReport,
      };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });
}
