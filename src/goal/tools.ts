import { say } from "../language.js";
import type { GoalHistoryPage, GoalHistoryQuery } from "./goal-projections.js";
import { stringEnum } from "./string-enum.js";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalActionWorkingState, goalStatusWorkingState, goalToolResponse, toToolGoal, toToolText, type GoalToolResponse, type GoalWorkingState } from "./format.js";
import { type GoalReportAction, type GoalReportState } from "./goal-reports.js";
import { MAX_REPORT_CHANGED_CHARS, MAX_REPORT_COMPLETED_CHARS, MAX_REPORT_NEED_USER_CHARS, MAX_REPORT_NEXT_STEP_CHARS, MAX_REPORT_PHASE_CHARS, MAX_REPORT_PROBLEM_CHARS, MAX_REPORT_RISK_CHARS, MAX_REPORT_SUMMARY_CHARS, MAX_REPORT_VERIFICATION_CHARS, type GoalProgressReport, type GoalProgressEventKind, type GoalProgressStatus, validateNewGoalProgressReport } from "./report-schema.js";
import { createGoal, replaceGoal, type AgreementInput } from "./state.js";
import { SELF_DECIDED_KINDS, renderSelfDecided, unconfirmedSelfDecided, type SelfDecidedKind } from "./agreement.js";
import { DEFAULT_GOAL_FEATURES, type GoalFeatures } from "./goal-report-config.js";
import { GoalCanonicalWriteError } from "./goal-persistence.js";
import { doneCriterionGuidance, goalToolGuidelines } from "./prompts.js";
import { MAX_GOAL_PROSE_PARAGRAPH_CHARS } from "./goal-language-quality.js";
import type { GoalPaperCutUpdate } from "./goal-projections.js";
import { isGoalWorkState, type GoalWorkState, type GoalWorkUpdateResult } from "./goal-work-state.js";
import { type GoalArtifactRef, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

// Функция, а не константа: язык задаётся при загрузке расширения, после импорта модулей.
const goalProseDescription = (): string => say(
  `Пиши прозу по-русски абзацами не длиннее ${MAX_GOAL_PROSE_PARAGRAPH_CHARS} знаков. Точные команды, пути, сообщения об ошибках, идентификаторы и значения статусов оставляй без изменений во встроенном или блочном коде.`,
  `Write English prose in paragraphs of at most ${MAX_GOAL_PROSE_PARAGRAPH_CHARS} characters. Keep exact commands, paths, error messages, identifiers and status values unchanged in inline or fenced code.`,
);

const emptyParams = () => Type.Object({});
const getGoalParams = () => Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("status"), Type.Literal("history")], {
    description: say("По умолчанию full включает неизменённый договор и рабочее состояние. status их не включает; history читает ограниченный указатель событий или точную запись. Ни один вид не разрешает переход.", "Default full includes the unchanged contract and work state. Status omits these; history reads a bounded event index or exact record. None authorizes a transition."),
  })),
  event_id: Type.Optional(Type.String({ minLength: 1, description: say("ID события истории из указателя или ID заметки-решения. Возвращает исходный JSON постранично.", "History event id from the index, or a decision note id. Returns paged original JSON.") })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: say("Смещение в указателе истории; продолжай по nextOffset.", "History index offset; follow nextOffset.") })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  content_offset: Type.Optional(Type.Integer({ minimum: 0, description: say("Смещение в кодовых точках Unicode; продолжай по nextContentOffset.", "Unicode code point offset; follow nextContentOffset.") })),
  content_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
}, { additionalProperties: false });
const resumeGoalParams = () => Type.Object({
  user_decision_confirmed: Type.Optional(Type.Boolean({
    description: say("Обязательно true при возобновлении цели на паузе с неподтверждённым решением awaiting_user: агент истолковал настоящий ответ как требуемый. Никогда не ставь для вопросов о статусе или продолжения без требуемого ответа.", "Required true when resuming a paused goal with an unconfirmed awaiting_user decision: the agent has interpreted the actual reply as the required answer. Never set for status questions or continuation without the required answer."),
  })),
}, { additionalProperties: false });

const agreementParam = () => Type.Object({
  owner_wants: Type.String({ minLength: 1, description: say("Чего хочет владелец: результат и важные ему качества; там, где важна сама формулировка, кратко процитируй владельца.", "What the owner wants: the outcome and the qualities that matter to them, briefly quoting the owner where the wording itself matters.") }),
  done_when: Type.String({ minLength: 1, description: say("Готово, когда: критерий завершения, в том числе когда допустим отрицательный результат. owner_wants и done_when вместе не длиннее 2000 знаков.", "Done when: the completion criterion, including when a negative result is acceptable. owner_wants and done_when together are at most 2000 characters.") }),
}, { additionalProperties: false, description: say("Договорённость, которую расширение дословно показывает в начале каждого контекстного окна, пока цель не изменится.", "The agreement the extension keeps verbatim at the start of every context window until the goal changes.") });
const selfDecidedParam = () => Type.Array(Type.Object({
  kind: stringEnum(SELF_DECIDED_KINDS, { description: say("assumption — твоё допущение; deferred_by_owner — владелец отложил вопрос; proposal — твоё собственное предложение.", "assumption — you assumed it; deferred_by_owner — the owner postponed the question; proposal — your own proposal.") }),
  text: Type.String({ minLength: 1, maxLength: 600 }),
}, { additionalProperties: false }), { description: say("Решения, которые владелец не подтверждал: охват, архитектура или приёмка, выбранные тобой. Список может быть пустым, но должен быть передан.", "Decisions the owner has not confirmed: scope, architecture or acceptance you chose yourself. May be empty, must be present.") });

const createGoalParams = () => Type.Object({
  objective: Type.String({
    description: `${say("Сохрани исходный запрос пользователя, одобренные результат и доказательства, то, что не входит, простейший путь, пределы сложности, критерий готовности и точки решений.", "Preserve the original user request, approved outcome and evidence, non-goals, simplest path, complexity bounds, done criterion and decision gates.")} ${doneCriterionGuidance()}`,
  }),
  token_budget: Type.Optional(
    Type.Union([
      Type.Integer({
        description: say("Необязательный бюджет токенов, целое положительное число; null — без ограничения.", "Optional positive integer token budget; null means no budget limit."),
        minimum: 1,
      }),
      Type.Null(),
    ]),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        say("Заменить существующую незавершённую цель, когда пользователь явно просит новую цель.", "Replace an existing non-complete goal when the user explicitly requests a new goal."),
    }),
  ),
  agreement: Type.Optional(agreementParam()),
  self_decided: Type.Optional(selfDecidedParam()),
});

const amendGoalParams = () => Type.Object({
  amendment: Type.Optional(Type.String({
    minLength: 1,
    description: say("Новое одобренное пользователем дополнение. Передай ровно одно из amendment и amendment_id. Никогда не отправляй исправленный текст повторно, чтобы восстановить применённую поправку.", "New user-approved addition. Supply exactly one of amendment or amendment_id. Never resend edited text to repair an applied amendment."),
  })),
  amendment_id: Type.Optional(Type.String({
    minLength: 1,
    description: say("Только для восстановления: ID, возвращённый для уже применённой поправки. Восстанавливает её проекции, не добавляя и не меняя сохранённый договор; amendment не передавай.", "Recovery only: the ID returned for an already applied amendment. Restores its projections without appending or changing the saved contract; omit amendment."),
  })),
  agreement: Type.Optional(Type.Object({
    owner_wants: Type.String({ minLength: 1 }),
    done_when: Type.String({ minLength: 1 }),
  }, { additionalProperties: false, description: say("Обязательно вместе с amendment, если у цели есть договорённость: полная новая редакция, а не разница.", "Required with amendment when the goal has an agreement: the complete new edition, not a diff.") })),
  self_decided: Type.Optional(selfDecidedParam()),
}, { additionalProperties: false });

const updateGoalParams = () => Type.Object({
  status: stringEnum(["complete"] as const, {
    description: say("Принимается только complete. Не вызывай, пока остаётся обязательная работа.", "Only complete is accepted. Do not call this until no required work remains."),
  }),
});

const recordGoalNoteParams = () => Type.Object({
  kind: stringEnum(["decision", "paper_cut"] as const, { description: say("Выбери ровно один вид заметки; decision использует decision и rationale, paper_cut — impact и severity.", "Select exactly one note branch; decision uses decision+rationale, paper_cut uses impact+severity.") }),
  action: Type.Optional(stringEnum(["record", "update", "repair"] as const, { description: say("По умолчанию record. update закрывает существующий paper_cut; repair пересобирает документ уже сохранённой заметки без нового события.", "Default record. update closes an existing paper_cut; repair rebuilds the document for an already saved note without another event.") })),
  note_id: Type.Optional(Type.String({ minLength: 1, description: say("Обязательно для update и repair; бери noteId из квитанции или paperCuts[].id из get_goal.", "Required for update/repair; use noteId from the receipt or paperCuts[].id from get_goal.") })),
  expected_revision: Type.Optional(Type.Integer({ minimum: 0, description: say("Обязательно для update: ревизия этой записи paperCuts, а не workRevision.", "Required for update: use that paperCuts entry revision, not workRevision.") })),
  status: Type.Optional(stringEnum(["resolved", "wont_fix"] as const, { description: say("Обязательно для update. wont_fix не одобряет изменение охвата и не отменяет обязательную работу.", "Required for update. wont_fix does not approve a scope change or cancel required work.") })),
  resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: say("Обязательно для update: доказательство исправления или причина принять риск.", "Required for update: evidence of the fix or reason for accepting the risk.") })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 240, description: say("Обязательно только для record.", "Required for record only.") })),
  decision: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: say("Обязательно для record с kind=decision; устойчивый выбор.", "Required for record with kind=decision; the durable choice.") })),
  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: say("Обязательно только для kind=decision; почему сделан такой выбор.", "Required only for kind=decision; why the choice was made.") })),
  consequence: Type.Optional(Type.String({ maxLength: 1200 })),
  impact: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: say("Обязательно только для kind=paper_cut; последствие откладывания проблемы.", "Required only for kind=paper_cut; consequence of deferring the issue.") })),
  severity: Type.Optional(stringEnum(["low", "medium", "high"] as const, { description: say("Обязательно только для kind=paper_cut.", "Required only for kind=paper_cut.") })),
  revisit: Type.Optional(Type.String({ maxLength: 1200 })),
  self_decided: Type.Optional(stringEnum(SELF_DECIDED_KINDS, { description: say("С record kind=decision: добавить решение и в список «Решаю сам» с этим видом. Используй для заметного выбора охвата, архитектуры или приёмки, который владелец не подтверждал.", "With record kind=decision: also add the decision to the Self-decided list as this kind. Use for a notable choice about scope, architecture or acceptance the owner has not confirmed.") })),
  confirmation: Type.Optional(stringEnum(["confirmed", "rejected"] as const, { description: say("С update kind=decision и note_id=S-…: вердикт владельца по пункту «Решаю сам». Принимается только в ходе, начатом настоящей репликой владельца.", "With update kind=decision and note_id=S-…: the owner's verdict on a Self-decided item. Accepted only in a turn started by a real owner reply.") })),
}, { additionalProperties: false });

export const progressReportParams = () => Type.Object({
  eventKind: Type.Optional(stringEnum(["goal_started", "phase_changed", "progress_checkpoint", "verification", "blocker_opened", "blocker_resolved", "decision_recorded", "artifact_updated", "goal_completed"] as const, { description: say("Выбери одно смысловое изменение. Обязательные поля: goal_started — changed или completed; phase_changed — changed; verification — verification; blocker_opened — problemOrDecision; blocker_resolved — problemOrDecision или completed; decision_recorded — problemOrDecision; artifact_updated — changed или completed; goal_completed — verification или completed; progress_checkpoint — ничего.", "Select one semantic delta. Required alternatives: goal_started changed or completed; phase_changed changed; verification verification; blocker_opened problemOrDecision; blocker_resolved problemOrDecision or completed; decision_recorded problemOrDecision; artifact_updated changed or completed; goal_completed verification or completed; progress_checkpoint none.") })),
  action: stringEnum(["publish", "suppress"] as const, { description: say("publish записывает отчёт; suppress не принимает полей, кроме action.", "publish records a report; suppress accepts no fields besides action.") }),
  status: Type.Optional(stringEnum(["working", "verifying", "blocked", "awaiting_user"] as const, { description: say("Обязательно для publish. working требует содержательного изменения и продолжает независимую работу, даже если один пункт заблокирован. verifying требует verification. blocked требует problemOrDecision и означает, что у всей цели нет безопасного следующего действия; awaiting_user требует needUser для настоящего решения. Оба удерживают продолжение до ответа пользователя и отчёта working.", "Required for publish. working needs a meaningful delta and continues independent work despite one blocked item. verifying needs verification. blocked needs problemOrDecision and means the whole goal has no safe next action; awaiting_user needs needUser for a real decision. Both hold continuation until a user answer and working report.") })),
  phase: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_PHASE_CHARS, description: say("Обязательно для publish; короткое текущее содержательное действие в настоящем времени.", "Required for publish; short current meaningful action in present tense.") })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_SUMMARY_CHARS, description: say("Обязательно для publish; 1–3 связных предложения: что изменилось, что это значит и что дальше.", "Required for publish; 1-3 connected sentences describing change, meaning and next step.") })),
  changed: Type.Optional(Type.String({ maxLength: MAX_REPORT_CHANGED_CHARS, description: say("Вариант changed для goal_started или artifact_updated; обязательно для phase_changed. working требует любого содержательного изменения.", "Use as the changed alternative for goal_started or artifact_updated; required for phase_changed. working needs any meaningful delta.") })),
  completed: Type.Optional(Type.String({ maxLength: MAX_REPORT_COMPLETED_CHARS, description: say("Вариант completed для goal_started, blocker_resolved, artifact_updated или goal_completed.", "Use as the completed alternative for goal_started, blocker_resolved, artifact_updated or goal_completed.") })),
  problemOrDecision: Type.Optional(Type.String({ maxLength: MAX_REPORT_PROBLEM_CHARS, description: say("Обязательно для blocker_opened, decision_recorded или статуса blocked; blocker_resolved принимает это поле или completed.", "Required for blocker_opened, decision_recorded, or blocked status; blocker_resolved accepts this or completed.") })),
  riskAndComplexity: Type.Optional(Type.String({ maxLength: MAX_REPORT_RISK_CHARS })),
  verification: Type.Optional(Type.String({ maxLength: MAX_REPORT_VERIFICATION_CHARS, description: say("Обязательно для verification; один из вариантов для goal_completed; также обязательно для статуса verifying.", "Required for verification; one alternative for goal_completed; also required for verifying status.") })),
  nextStep: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEXT_STEP_CHARS })),
  needUser: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEED_USER_CHARS, description: say("Обязательно для статуса awaiting_user; конкретное решение, нужное от пользователя.", "Required for awaiting_user status; concrete decision needed from the user.") })),
}, { additionalProperties: false });

const goalWorkParams = () => Type.Object({
  goal_id: Type.String({ minLength: 1 }),
  expected_revision: Type.Integer({ minimum: 0, description: say("Бери workRevision из get_goal. При устаревшей ревизии перед повтором прочитай текущее состояние.", "Use workRevision from get_goal. A stale revision requires reading the current state before retrying.") }),
  state: Type.Object({
    outcome: Type.String({ description: say("Краткий результат для пользователя; не заменяет и не меняет одобренную цель.", "Concise user result; does not replace or amend the approved objective.") }),
    doneWhen: Type.String({ description: say("Краткое объяснение согласованного критерия завершения.", "Concise explanation of the agreed completion criterion.") }),
    summary: Type.String({ description: say("Текущее положение всей задачи, а не только последнее изменение.", "Current whole-task position, not just the latest delta.") }),
    items: Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.String(),
      status: stringEnum(["planned", "active", "blocked", "done", "cancelled"] as const),
      source: stringEnum(["user", "agent"] as const),
      result: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }, { additionalProperties: false })),
    activeDecisionIds: Type.Array(Type.String({ minLength: 1 }), { description: say("ID существующих записей решений, которые всё ещё определяют текущий путь.", "IDs of existing decision records that still determine the current path.") }),
    nextItemId: Type.Optional(Type.String({ minLength: 1, description: say("Следующий полезный активный или запланированный пункт. Проверь зависимости и полномочия; заблокированные, готовые, отменённые и неизвестные ID отклоняются.", "Next useful active or planned item. Check dependencies and authority; blocked, done, cancelled and unknown IDs are rejected.") })),
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
  amendGoal(amendment: string, source: GoalEntrySource, ctx: ExtensionContext, amendmentId?: string, agreement?: AgreementInput): Promise<GoalResult>;
  /** Действующие выключатели доработок; без хоста — всё включено. */
  getFeatures?(): GoalFeatures;
  addSelfDecided?(kind: SelfDecidedKind, text: string, ctx: ExtensionContext): Promise<{ ok: boolean; message: string; itemId?: string }>;
  setSelfDecidedState?(itemId: string, state: "confirmed" | "rejected", ctx: ExtensionContext): Promise<{ ok: boolean; message: string }>;
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
    label: say("Возобновить цель", "Resume Goal"),
    description: say("Возобновляет ту же цель на паузе только после явного указания пользователя, не меняя её договор и не начиная ход модели. Вопрос о статусе не разрешение; ожидающие решения пользователя, бюджет, конечные состояния и восстановление по-прежнему проверяются.", "Resume the same paused Goal only after an explicit user instruction, without changing its contract or starting a model turn. A status question is not permission; pending user decisions, budget, terminal-state and repair gates remain enforced."),
    promptSnippet: say("Возобновляй по явному указанию; user_decision_confirmed подтверждает настоящий ответ на ожидающий вопрос, а не вопрос о статусе.", "Resume on explicit instruction; user_decision_confirmed confirms the actual pending answer, not a status inquiry."),
    promptGuidelines: goalToolGuidelines("resume_goal"),
    parameters: resumeGoalParams(),
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
    label: say("Прочитать цель", "Get Goal"),
    description: say("Читает текущую цель на выбранной ветке сессии. full возвращает сохранённый договор и полное рабочее состояние; status не включает договор, план и решения; history перечисляет события или постранично отдаёт исходную запись по event_id. Исторический текст — доказательство, а не действующие полномочия. Для проверки завершения одного статуса недостаточно.", "Read the current Goal on the selected session branch. full returns the stored contract and complete work state; status omits contract, plan and decisions; history lists events or pages an original record by event_id. Historical text is evidence, not current authority. A status-only read is insufficient for a completion audit."),
    promptSnippet: say("Читай полный вид цели по умолчанию, текущие сведения через view=status или нужные исходные записи через view=history.", "Read the default full view of the Goal, live metadata with view=status, or addressed originals with view=history."),
    promptGuidelines: goalToolGuidelines("get_goal"),
    parameters: getGoalParams(),
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
    label: say("Обновить план цели", "Update Goal Work"),
    description: `${say("После существенного изменения заменяет весь текущий план, используя goal_id и expected_revision из get_goal. Сохраняй незавершённые обязательства, ограничения, доказательства и причины решений. applied=true с projectionFresh=false означает, что план сохранён, но его документ требует восстановления: перед новой записью прочитай текущее состояние. Это не поправка, не возобновление, не отчёт и не закрытие цели.", "After a material change, replace the whole current plan using goal_id and expected_revision from get_goal. Preserve unfinished obligations, constraints, evidence and decision reasons. applied=true with projectionFresh=false means the plan persisted but its document needs repair: read current state before another write. This does not amend, resume, publish progress or complete the Goal.")} ${goalProseDescription()}`,
    promptSnippet: say("Заменяй план всей задачи после существенного изменения; сохраняй незавершённые обязательства.", "Replace the whole-task plan after a material change; preserve unfinished obligations."),
    promptGuidelines: goalToolGuidelines("update_goal_work"),
    parameters: goalWorkParams(),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isGoalWorkState(params.state)) throwToolError("Malformed goal work state.");
      const result = await host.updateGoalWork(params.goal_id, params.state, params.expected_revision, ctx, toolCallId);
      const response = { operation: "update_goal_work", ...result };
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
    },
  });

  registerCreateGoalTool(pi, host, DEFAULT_GOAL_FEATURES);

  pi.registerTool({
    name: "amend_goal",
    label: say("Дополнить цель", "Amend Goal"),
    description: say("Добавляет одобренную пользователем поправку или восстанавливает уже применённую поправку по amendment_id, не меняя договор. Передай ровно одно из двух. Цель на паузе возобновляется только после успешного восстановления проекции.", "Append a user-approved amendment, or recover an already applied amendment by amendment_id without changing the contract. Supply exactly one input. A paused goal resumes only after successful projection recovery."),
    promptSnippet: say("Добавляй одобренное изменение или восстанавливай уже применённую запись по amendment_id.", "Append an approved change, or repair its already applied write by amendment_id."),
    promptGuidelines: goalToolGuidelines("amend_goal"),
    parameters: amendGoalParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if ((params.amendment !== undefined) === (params.amendment_id !== undefined)) {
        throwToolError("Supply exactly one of amendment or amendment_id.");
      }
      if (params.amendment_id !== undefined && (params.agreement || params.self_decided)) throwToolError("amendment_id repairs an applied amendment; omit agreement and self_decided.");
      if (params.amendment !== undefined && host.getGoal()?.agreement && !params.agreement) throwToolError("This goal has an agreement: pass agreement with the complete new owner_wants and done_when together with amendment.");
      const agreement: AgreementInput | undefined = params.agreement ? { ownerWants: params.agreement.owner_wants, doneWhen: params.agreement.done_when, ...(params.self_decided ? { selfDecided: params.self_decided } : {}) } : undefined;
      const result = await host.amendGoal(params.amendment ?? "", "tool", ctx, params.amendment_id, agreement);
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
    label: say("Языковая справка цели", "Load Goal Language Guide"),
    description: say("Загружает структурированную языковую диагностику и краткие указания по исправлению после отклонения проекции цели. Диагностика содержит artifact, code, field, length, limit и repair без исходных чувствительных выдержек.", "Load the structured language-repair diagnostics and concise repair guidance after a goal projection is rejected. Diagnostics contain artifact, code, field, length, limit, and repair without raw sensitive excerpts."),
    promptSnippet: say("После отклонённого текста цели прочитай диагностику и безопасно исправь затронутые данные.", "After rejected Goal text, read diagnostics and repair the affected data safely."),
    promptGuidelines: goalToolGuidelines("load_goal_language_guide"),
    parameters: emptyParams(),
    async execute() {
      const result = host.loadGoalLanguageGuide();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: { result, error: null } };
    },
  });

  pi.registerTool({
    name: "record_goal_note",
    label: say("Записать заметку цели", "Record Goal Note"),
    description: `${say("Записывает устойчивое решение или отложенный риск. По умолчанию action=record требует title и поля своего вида. action=update закрывает paper_cut по note_id с expected_revision, status и resolution; изменения охвата это не одобряет. action=repair пересобирает документ существующей заметки по kind и note_id, не добавляя новой. ID и ревизии заметок читай через get_goal(view=full).", "Record a durable decision or deferred risk. Default action=record requires title and kind-specific fields. action=update closes a paper_cut by note_id with expected_revision, status and resolution; it does not approve scope changes. action=repair rebuilds the document for an existing note by kind and note_id without appending another note. Read IDs and note revisions via get_goal(view=full).")} ${goalProseDescription()}`,
    promptSnippet: say("Записывай решение или риск, закрывай мелкий недочёт или восстанавливай уже сохранённую заметку по ID.", "Record a decision or risk, close a paper cut, or repair an already saved note by ID."),
    promptGuidelines: goalToolGuidelines("record_goal_note"),
    parameters: recordGoalNoteParams(),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "record";
      let result: unknown;
      let selfDecidedId: string | null = null;
      if (action === "update" || action === "repair") {
        const selfDecidedUpdate = action === "update" && params.kind === "decision";
        const allowed = new Set(action === "repair" ? ["kind", "action", "note_id"] : selfDecidedUpdate ? ["kind", "action", "note_id", "confirmation"] : ["kind", "action", "note_id", "expected_revision", "status", "resolution"]);
        if (Object.keys(params).some((key) => !allowed.has(key))) throwToolError("Unexpected note fields for " + action + "; use note_id and only the fields for this action.");
        if (!params.note_id?.trim()) throwToolError("note_id is required for update/repair.");
        if (selfDecidedUpdate) {
          if (params.confirmation !== "confirmed" && params.confirmation !== "rejected") throwToolError("update kind=decision requires confirmation=confirmed or rejected for a Self-decided item.");
          if (!host.setSelfDecidedState) throwToolError("Self-decided updates are unavailable.");
          const outcome = await host.setSelfDecidedState(params.note_id, params.confirmation, ctx);
          if (!outcome.ok) throwToolError(outcome.message, { operation: "record_goal_note", action, kind: params.kind, noteId: params.note_id, applied: false, retryable: false });
          const response = { operation: "record_goal_note", action, noteId: params.note_id, kind: params.kind, applied: true, stage: "complete", retryable: false, confirmation: params.confirmation };
          return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
        }
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
        if (["note_id", "expected_revision", "status", "resolution", "confirmation"].some((key) => key in params)) throwToolError("record does not accept update/repair fields.");
        if (!params.title?.trim()) throwToolError("title is required for record.");
        if (params.kind === "decision") {
          if (["impact", "severity", "revisit"].some((key) => key in params)) throwToolError("decision accepts only kind, title, decision, rationale, and optional consequence and self_decided.");
          if (!params.decision?.trim() || !params.rationale?.trim()) throwToolError("decision requires decision and rationale.");
          if (params.self_decided) {
            if (!host.addSelfDecided) throwToolError("Self-decided items are unavailable.");
            const added = await host.addSelfDecided(params.self_decided, `${params.title.trim()}: ${params.decision.trim()}`, ctx);
            if (!added.ok) throwToolError(added.message);
            selfDecidedId = added.itemId ?? null;
          }
          result = await host.recordGoalDecision({ title: params.title, decision: params.decision, rationale: params.rationale, ...(params.consequence === undefined ? {} : { consequence: params.consequence }) }, ctx, toolCallId);
        } else {
          if (params.kind !== "paper_cut") throwToolError("Unknown note kind.");
          if (["decision", "rationale", "consequence", "self_decided"].some((key) => key in params)) throwToolError("paper_cut accepts only kind, title, impact, severity, and optional revisit.");
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
        ...(selfDecidedId ? { selfDecidedId } : {}),
        state: compactReportState(host.getReportState()), workingState: goalActionWorkingState(fullState),
        ...(artifactRefs.length > 0 ? { artifactRefs } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "report_goal_progress",
    label: say("Отчёт о ходе цели", "Report Goal Progress"),
    description: `${say("Публикует изменение результата для пользователя, а не внутреннюю активность. publish требует status, phase, summary, nextStep и поле изменения для своего статуса; suppress принимает только action. Если один пункт заблокирован, но остаётся другая безопасная работа, сообщай working. Независимые факты разделяй пустыми строками.", "Publish a user-facing result delta, not internal activity. Publish needs status, phase, summary, nextStep and its status-specific delta; suppress takes only action. If one item is blocked but other safe work remains, report working. Separate independent facts with blank lines.")} ${goalProseDescription()}`,
    promptSnippet: say("Сообщай о содержательном изменении результата или гаси напоминание одним action.", "Report a meaningful result change, or suppress a due reminder with action only."),
    promptGuidelines: goalToolGuidelines("report_goal_progress"),
    parameters: progressReportParams(),
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
    label: say("Закрыть цель", "Update Goal"),
    description: say("Завершает текущую цель только после того, как согласованный результат и обязательные доказательства выполнены. Сначала прочитай get_goal(view=full), затем опубликуй report_goal_progress(status=verifying) и дождись успеха перед отдельным вызовом закрытия. Событие goal_completed со статусом working недостаточно. Если запись не удалась, перед повтором изучи сохранённое состояние; ни затраченные усилия, ни пометка риска не заменяют обязательное доказательство.", "Complete the current Goal only after the agreed outcome and required evidence are satisfied. First read get_goal(view=full), then publish report_goal_progress(status=verifying) and await success before a separate completion call. A working goal_completed event is insufficient. If a write fails, inspect persisted state before retrying; neither elapsed effort nor a risk label replaces required proof."),
    promptSnippet: say("Закрывай цель только после выполнения согласованного результата и обязательных доказательств.", "Complete the Goal only after the agreed result and required evidence are satisfied."),
    promptGuidelines: goalToolGuidelines("update_goal"),
    parameters: updateGoalParams(),
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
      // При закрытии владелец видит, что агент решил сам без его слова (Т6.4).
      const unconfirmed = unconfirmedSelfDecided(result.goal);
      const text = JSON.stringify(response, null, 2) + (unconfirmed.length > 0 ? `\n\n${say("Не подтверждено владельцем:", "Not confirmed by the owner:")}\n${renderSelfDecided(unconfirmed)}` : "");
      return { content: [{ type: "text", text }], details: { ...response, ...(unconfirmed.length > 0 ? { unconfirmedSelfDecided: unconfirmed } : {}), error: null } };
    },
  });
}

/** Д5: вопросы до цели. Выключенная доработка возвращает прежнее описание `create_goal`. */
export const askBeforeGoalRule = (): string => say("Перед create_goal спроси владельца одним пакетом ask_user обо всём, что меняет охват, архитектуру или приёмку и ещё не решено в разговоре, файлах или памяти. Если владелец сказал работать без вопросов, не спрашивай, а запиши свои допущения в self_decided.", "Before create_goal, ask the owner in one ask_user batch everything that changes scope, architecture or acceptance and is not already settled in the conversation, files or memory. If the owner said to work without questions, do not ask; record your assumptions in self_decided instead.");

/** Регистрирует `create_goal`; повторная регистрация после загрузки настроек меняет описание в той же сессии. */
export function registerCreateGoalTool(pi: ExtensionAPI, host: ToolHost, rules: Pick<GoalFeatures, "askBeforeGoal">): void {
  pi.registerTool({
    name: "create_goal",
    label: say("Создать цель", "Create Goal"),
    description: `${say("Создаёт долгую цель только после явной просьбы. Сохрани замысел пользователя и согласованные границы; не придумывай более строгих условий приёмки. После успеха опубликуй goal_started до основной работы. Разговор автоматически не копируется.", "Create a durable Goal only after an explicit request. Preserve the user's intent and agreed boundaries; do not invent stricter acceptance gates. After success publish goal_started before substantive work. This does not copy the conversation automatically.")}${rules.askBeforeGoal ? ` ${askBeforeGoalRule()}` : ""}`,
    promptSnippet: say("Создавай долгую цель только по явной просьбе; сохраняй согласованный результат, доказательства и критерий готовности.", "Create a durable Goal only on explicit request; preserve the agreed outcome, evidence and done criterion."),
    promptGuidelines: goalToolGuidelines("create_goal"),
    parameters: createGoalParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const features = host.getFeatures?.() ?? DEFAULT_GOAL_FEATURES;
      if (!params.agreement) throwToolError("create_goal requires agreement with owner_wants and done_when.");
      if (features.selfDecidedList && !params.self_decided) throwToolError("create_goal requires self_decided: list what you decided yourself; pass [] when the owner confirmed everything.");
      const agreement: AgreementInput = { ownerWants: params.agreement.owner_wants, doneWhen: params.agreement.done_when,
        ...(features.selfDecidedList && params.self_decided ? { selfDecided: params.self_decided } : {}) };
      const replacingNonCompleteGoal = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = replacingNonCompleteGoal
        ? replaceGoal(params.objective, params.token_budget ?? null, agreement)
        : createGoal(current, params.objective, params.token_budget ?? null, agreement);
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
}
