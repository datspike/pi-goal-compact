import { say } from "../language.js";
import type { GoalHistoryPage, GoalHistoryQuery } from "./goal-projections.js";
import { stringEnum } from "./string-enum.js";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { goalActionWorkingState, goalStatusWorkingState, goalToolResponse, toToolGoal, toToolText, type GoalToolResponse, type GoalWorkingState } from "./format.js";
import { type GoalReportAction, type GoalReportState } from "./goal-reports.js";
import { MAX_REPORT_CHANGED_CHARS, MAX_REPORT_COMPLETED_CHARS, MAX_REPORT_NEED_USER_CHARS, MAX_REPORT_NEXT_STEP_CHARS, MAX_REPORT_PHASE_CHARS, MAX_REPORT_PROBLEM_CHARS, MAX_REPORT_RISK_CHARS, MAX_REPORT_SUMMARY_CHARS, MAX_REPORT_VERIFICATION_CHARS, type GoalProgressReport, type GoalProgressEventKind, type GoalProgressStatus, validateNewGoalProgressReport } from "./report-schema.js";
import { createGoal, replaceGoal, type AgreementInput } from "./state.js";
import { SELF_DECIDED_KINDS, renderAgreement, renderSelfDecided, unconfirmedSelfDecided, type SelfDecidedKind } from "./agreement.js";
import { DEFAULT_GOAL_FEATURES, type GoalFeatures } from "./goal-report-config.js";
import { amendedAfterCompactionNotice, goalAtCompaction, retainedAgreementNotice } from "./window.js";
import { GoalCanonicalWriteError } from "./goal-persistence.js";
import { doneCriterionGuidance, goalToolGuidelines } from "./prompts.js";
import type { GoalPaperCutUpdate } from "./goal-projections.js";
import { isGoalWorkState, type GoalWorkState, type GoalWorkUpdateResult } from "./goal-work-state.js";
import { type GoalArtifactRef, type GoalEntrySource, type GoalResult, type ThreadGoal } from "./types.js";

// Функция, а не константа: язык задаётся при загрузке расширения, после импорта модулей.
const emptyParams = () => Type.Object({});
const getGoalParams = () => Type.Object({
  view: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("status"), Type.Literal("history")], {
    description: say("full (по умолчанию) — договор, план, решения и ревизия; status — без них; history — указатель событий или исходная запись по event_id. Ни один вид не разрешает переход.", "full (default) — contract, plan, decisions and revision; status — without them; history — the event index or an original record by event_id. No view authorizes a transition."),
  })),
  event_id: Type.Optional(Type.String({ minLength: 1, description: say("ID события истории из указателя или ID заметки-решения. Возвращает исходный JSON постранично.", "History event id from the index, or a decision note id. Returns paged original JSON.") })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: say("Смещение в указателе истории; продолжай по nextOffset.", "History index offset; follow nextOffset.") })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  content_offset: Type.Optional(Type.Integer({ minimum: 0, description: say("Смещение в кодовых точках Unicode; продолжай по nextContentOffset.", "Unicode code point offset; follow nextContentOffset.") })),
  content_limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
}, { additionalProperties: false });
const resumeGoalParams = () => Type.Object({
  user_decision_confirmed: Type.Optional(Type.Boolean({
    description: say("true, если цель ждёт решения awaiting_user (get_goal.requiresUserDecision) и пользователь дал настоящий ответ на этот вопрос. Продолжения или вопроса о статусе недостаточно.", "true when the goal awaits an awaiting_user decision (get_goal.requiresUserDecision) and the user gave the actual answer to it. A continuation or status question is not enough."),
  })),
}, { additionalProperties: false });

const minimumActiveSecondsParam = () => Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), Type.Null()], { description: say("Только при явно заданном минимуме активной работы: передай его в секундах, а согласованные исключения сохрани в done_when. Если минимум задан, но Pi не может надёжно учесть его условия, передай null и сохрани исходное условие целиком в done_when. Без заданного минимума пропусти поле.", "Only for an explicit minimum of active work: pass it in seconds and keep agreed exclusions in done_when. If the minimum was stated but Pi cannot estimate it reliably under the agreed conditions, pass null and keep the original condition in done_when. Omit this field when no minimum is set.") }));

const agreementParam = () => Type.Object({
  owner_wants: Type.String({ minLength: 1, description: say("Чего хочет владелец: результат и важные ему качества; там, где важна сама формулировка, кратко процитируй владельца.", "What the owner wants: the outcome and the qualities that matter to them, briefly quoting the owner where the wording itself matters.") }),
  minimum_active_seconds: minimumActiveSecondsParam(),
  done_when: Type.String({ minLength: 1, description: say("Готово, когда: критерий завершения, включая допустимый отрицательный итог. Минимум в секундах хранится отдельно. Исключения из учёта сохрани здесь; если оценка недоступна, сохрани всё условие. owner_wants и done_when вместе не длиннее 2000 знаков.", "Done when: the completion criterion, including an acceptable negative result. The numeric minimum is stored separately. Keep accounting exclusions here, or keep the whole condition if the estimate is unavailable. owner_wants and done_when together are at most 2000 characters.") }),
}, { additionalProperties: false, description: say("Договорённость, которую расширение дословно показывает в начале каждого контекстного окна, пока цель не изменится.", "The agreement the extension keeps verbatim at the start of every context window until the goal changes.") });
const selfDecidedParam = () => Type.Array(Type.Object({
  kind: stringEnum(SELF_DECIDED_KINDS, { description: say("assumption — твоё допущение; deferred_by_owner — владелец отложил вопрос; proposal — твоё собственное предложение.", "assumption — you assumed it; deferred_by_owner — the owner postponed the question; proposal — your own proposal.") }),
  text: Type.String({ minLength: 1, maxLength: 600 }),
}, { additionalProperties: false }), { description: say("Решения, которые владелец не подтверждал: охват, архитектура или приёмка, выбранные тобой. Список может быть пустым, но должен быть передан.", "Decisions the owner has not confirmed: scope, architecture or acceptance you chose yourself. May be empty, must be present.") });

const createGoalParams = () => Type.Object({
  mode: Type.Optional(stringEnum(["outcome", "research"], { description: say(
    "Выбери research, если владелец поручил выбирать, что исследовать дальше. Заданный минимум активной работы над исследованиями означает research, даже если в той же цели обязателен конкретный результат. В «Готово, когда» сохрани обязательный результат и проверяемое сравнение с рекомендацией. Иначе выбери outcome: в «Готово, когда» запиши только запрошенный итог и его проверку. Не требуй сравнения или выигрыша, если их не просили. Отложенное передай дальше и не жди.",
    "Choose research when the owner delegates what to investigate next. A stated minimum of active research means research even when the same goal also requires a concrete result. Keep the required result and a verified comparison with a recommendation in Done when. Otherwise choose outcome: in Done when include only the requested result and its verification. Do not require a comparison or improvement unless requested. Hand deferred work off without waiting.",
  ) })),
  objective: Type.String({
    description: `${say("Сохрани исходный запрос пользователя, одобренные результат и доказательства, то, что не входит, простейший путь, пределы сложности, критерий готовности и точки решений.", "Preserve the original user request, approved outcome and evidence, non-goals, simplest path, complexity bounds, done criterion and decision gates.")} ${doneCriterionGuidance()}`,
  }),
  token_budget: Type.Optional(
    Type.Union([
      Type.Integer({
        description: say("Бюджет токенов, только если его назвал пользователь; null — без ограничения.", "Token budget only if the user named one; null means no limit."),
        minimum: 1,
      }),
      Type.Null(),
    ]),
  ),
  replace_existing: Type.Optional(
    Type.Boolean({
      description:
        say("Заменить незавершённую цель — только по явной просьбе о новой цели. После закрытия цели не нужен.", "Replace a non-complete goal — only on an explicit new-goal request. Not needed once the goal is complete."),
    }),
  ),
  agreement: Type.Optional(agreementParam()),
  self_decided: Type.Optional(selfDecidedParam()),
});

const amendGoalParams = () => Type.Object({
  amendment: Type.Optional(Type.String({
    minLength: 1,
    description: say("Новое одобренное пользователем дополнение.", "New user-approved addition."),
  })),
  amendment_id: Type.Optional(Type.String({
    minLength: 1,
    description: say("Только для восстановления: ID уже применённой поправки. Восстанавливает её проекции, договор не меняется.", "Recovery only: the ID of an already applied amendment. Restores its projections without changing the contract."),
  })),
  agreement: Type.Optional(Type.Object({
    owner_wants: Type.String({ minLength: 1 }),
    done_when: Type.String({ minLength: 1 }),
    minimum_active_seconds: minimumActiveSecondsParam(),
  }, { additionalProperties: false, description: say("Обязательно вместе с amendment, если у цели есть договорённость: полная новая редакция, а не разница.", "Required with amendment when the goal has an agreement: the complete new edition, not a diff.") })),
  self_decided: Type.Optional(selfDecidedParam()),
}, { additionalProperties: false });

const updateGoalParams = () => Type.Object({
  status: stringEnum(["complete"] as const, {
    description: say("Принимается только complete. Не вызывай, пока остаётся обязательная работа.", "Only complete is accepted. Do not call this until no required work remains."),
  }),
  // Длина не ограничена схемой: отказ за лишние знаки стоил бы отдельного вызова, запись обрезает текст сама.
  verification: Type.Optional(Type.String({ minLength: 1, description: say("Чем сделанное отвечает каждому пункту «Готово, когда», кратко; засчитывается как отчёт verifying для текущих договорённости и плана. После возврата договорённости повторять не нужно.", "Briefly, how the work meets each \"Done when\" item; recorded as the verifying report for the current agreement and plan. No need to repeat it after the agreement is returned.") })),
});

const recordGoalNoteParams = () => Type.Object({
  kind: stringEnum(["decision", "paper_cut"] as const, { description: say("Выбери ровно один вид заметки; decision использует decision и rationale, paper_cut — impact и severity.", "Select exactly one note branch; decision uses decision+rationale, paper_cut uses impact+severity.") }),
  action: Type.Optional(stringEnum(["record", "update", "repair"] as const, { description: say("По умолчанию record.", "Default record.") })),
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
  action: stringEnum(["publish", "suppress"] as const, { description: say("publish записывает отчёт; suppress не принимает других полей и не снимает удержание.", "publish records a report; suppress accepts no fields besides action.") }),
  status: Type.Optional(stringEnum(["working", "verifying", "blocked", "awaiting_user"] as const, { description: say("Обязательно для publish. working требует содержательного изменения и продолжает независимую работу, даже если один пункт заблокирован. verifying требует verification. blocked требует problemOrDecision и означает, что у всей цели нет безопасного следующего действия; awaiting_user требует needUser для настоящего решения. Оба удерживают продолжение до ответа пользователя и отчёта working.", "Required for publish. working needs a meaningful delta and continues independent work despite one blocked item. verifying needs verification. blocked needs problemOrDecision and means the whole goal has no safe next action; awaiting_user needs needUser for a real decision. Both hold continuation until a user answer and working report.") })),
  phase: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_PHASE_CHARS, description: say("Обязательно для publish; короткое текущее содержательное действие в настоящем времени.", "Required for publish; short current meaningful action in present tense.") })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_SUMMARY_CHARS, description: say("Обязательно для publish; 1–3 связных предложения: что изменилось, что это значит и что дальше.", "Required for publish; 1-3 connected sentences describing change, meaning and next step.") })),
  changed: Type.Optional(Type.String({ maxLength: MAX_REPORT_CHANGED_CHARS, description: say("Что изменилось; обязательность — в eventKind и status.", "What changed; requirements are in eventKind and status.") })),
  completed: Type.Optional(Type.String({ maxLength: MAX_REPORT_COMPLETED_CHARS, description: say("Что завершено; обязательность — в eventKind.", "What completed; requirements are in eventKind.") })),
  problemOrDecision: Type.Optional(Type.String({ maxLength: MAX_REPORT_PROBLEM_CHARS, description: say("Проблема или решение; обязательность — в eventKind и status.", "Problem or decision; requirements are in eventKind and status.") })),
  riskAndComplexity: Type.Optional(Type.String({ maxLength: MAX_REPORT_RISK_CHARS })),
  verification: Type.Optional(Type.String({ maxLength: MAX_REPORT_VERIFICATION_CHARS, description: say("Доказательства проверки; обязательность — в eventKind и status.", "Verification evidence; requirements are in eventKind and status.") })),
  nextStep: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEXT_STEP_CHARS })),
  needUser: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REPORT_NEED_USER_CHARS, description: say("Обязательно для статуса awaiting_user; конкретное решение, нужное от пользователя.", "Required for awaiting_user status; concrete decision needed from the user.") })),
}, { additionalProperties: false });

/** Отчёт о том же рубеже внутри update_goal_work. Смысл полей описывает report_goal_progress: повтор описаний удвоил бы схему. */
const workReportParams = () => {
  const { action: _action, ...fields } = progressReportParams().properties;
  for (const field of Object.values(fields)) delete (field as { description?: string }).description;
  return Type.Optional(Type.Object(fields, { additionalProperties: false, description: say("Необязательный отчёт о том же рубеже: поля report_goal_progress(publish) без action.", "Optional report for the same milestone: report_goal_progress(publish) fields without action.") }));
};

const goalWorkParams = () => Type.Object({
  goal_id: Type.String({ minLength: 1 }),
  expected_revision: Type.Integer({ minimum: 0, description: say("workRevision из ответа последнего вызова цели или из get_goal; для первого плана 0. При устаревшей ревизии перечитай состояние.", "workRevision from the latest Goal tool response or get_goal; 0 for the first plan. Re-read state after a stale revision.") }),
  report: workReportParams(),
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
    activeDecisionIds: Type.Array(Type.String({ minLength: 1 }), { description: say("noteId записей решений из record_goal_note, которые всё ещё определяют текущий путь.", "noteId values of decision records from record_goal_note that still determine the current path.") }),
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
  completeGoal(source: GoalEntrySource, ctx: ExtensionContext, verification?: string): Promise<GoalResult>;
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

/** Языковые замечания к принятой записи (решение 0014): не больше пяти, без цитат из текста. */
function languageNotes(value: unknown): unknown[] {
  const diagnostics = (value as { language?: { diagnostics?: unknown } } | null | undefined)?.language?.diagnostics;
  return Array.isArray(diagnostics) ? diagnostics.slice(0, 5) : [];
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
    throwToolError(say("publish требует status, phase, summary и nextStep.", "publish requires status, phase, summary, and nextStep."));
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

/**
 * Инструменты, которые объявлены модели только при цели в работе или на паузе (решение 0013).
 * Без цели модель видит один `create_goal`.
 */
export const OPEN_GOAL_TOOLS = ["resume_goal", "get_goal", "update_goal_work", "amend_goal", "record_goal_note", "report_goal_progress", "update_goal"] as const;

/**
 * Набор активных инструментов для этого состояния цели; чужие инструменты не трогаются.
 * Добавление нужно сразу. Снятие (`allowRemoval`) переписывает начало окна, если Pi сворачивает
 * системные сообщения, поэтому его делают только там, где окно и так собирается заново.
 */
export function goalToolLoadout(active: readonly string[], goalOpen: boolean, allowRemoval: boolean): string[] {
  const own = new Set<string>(OPEN_GOAL_TOOLS);
  const kept = allowRemoval && !goalOpen ? active.filter((name) => !own.has(name)) : [...active];
  return goalOpen ? [...kept, ...OPEN_GOAL_TOOLS.filter((name) => !kept.includes(name))] : kept;
}

export function registerGoalTools(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "resume_goal",
    defaultActive: false,
    label: say("Возобновить цель", "Resume Goal"),
    description: say("Возобновляет цель на паузе только по явному указанию пользователя; вопрос о статусе или фоновое событие — не разрешение. Договор не меняет и ход модели не начинает; ожидающие решения, бюджет, конечные состояния и восстановление по-прежнему проверяются. Если возобновлению мешает удержание или восстановление, изучи get_goal, а не делай поправку.", "Resume a paused Goal only on an explicit user instruction; a status question or background event is not permission. It does not change the contract or start a model turn; pending decisions, budget, terminal-state and repair gates remain enforced. If a hold or repair blocks resumption, inspect get_goal instead of amending."),
    promptSnippet: say("Возобновить цель на паузе.", "Resume a paused Goal."),
    promptGuidelines: goalToolGuidelines("resume_goal"),
    parameters: resumeGoalParams(),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!host.resumeGoal) throwToolError(say("Эта среда не поддерживает resume_goal.", "This host does not support resume_goal."));
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
    defaultActive: false,
    label: say("Прочитать цель", "Get Goal"),
    description: say("Читает цель на текущей ветке сессии. Сохранённый договор — не дословная копия разговора: противоречия разрешай по фактическому запросу пользователя и одобренным уточнениям. Для сверки перед закрытием одного status мало. view=status показывает оценку остатка времени; запрашивай её между подсказками, только если свежая оценка изменит следующий шаг.", "Read the Goal on the current session branch. The stored contract is not a verbatim copy of the conversation: resolve conflicts against the actual user request and approved clarifications. A status-only read is not enough for a completion audit. view=status shows the remaining time estimate; request it between prompts only if a fresh estimate changes the next step."),
    promptSnippet: say("Прочитать цель или её историю.", "Read the Goal or its history."),
    promptGuidelines: goalToolGuidelines("get_goal"),
    parameters: getGoalParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.view !== "history" && [params.event_id, params.offset, params.limit, params.content_offset, params.content_limit].some((value) => value !== undefined)) throwToolError(say("Диапазон истории требует view=history.", "History ranges require view=history."));
      const workingState = host.getGoalWorkingState(ctx);
      if (params.view === "history" && !host.getGoalHistory) throwToolError(say("Эта среда не поддерживает историю цели.", "This host does not support goal history."));
      const response = params.view === "history" ? host.getGoalHistory!(params, ctx) : params.view === "status" ? goalStatusWorkingState(workingState) : workingState;
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "update_goal_work",
    defaultActive: false,
    label: say("Обновить план цели", "Update Goal Work"),
    description: say("После существенного изменения заменяет весь план. goal_id и workRevision бери из ответа последнего вызова цели. Сохраняй устойчивые ID, незавершённую работу пользователя, ограничения, доказательства и причины решений; отмена пункта требует одобрения пользователя. Необязательный report публикует отчёт о том же рубеже. applied=true с projectionFresh=false: план сохранён, а документ нет — перечитай состояние и повтори тот же сверенный план с текущей ревизией, новой ревизии это не создаст. Это не поправка, не возобновление и не закрытие цели.", "After a material change, replace the whole plan. Take goal_id and workRevision from the latest Goal tool response. Preserve stable IDs, unfinished user work, constraints, evidence and decision reasons; cancelling an item needs user approval. The optional report publishes progress for the same milestone. applied=true with projectionFresh=false: the plan persisted but its document did not — re-read state and resubmit the same reconciled plan with the current revision; that adds no new revision. This does not amend, resume or complete the Goal."),
    promptSnippet: say("Заменить полный план задачи.", "Replace the whole-task plan."),
    promptGuidelines: goalToolGuidelines("update_goal_work"),
    parameters: goalWorkParams(),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isGoalWorkState(params.state)) throwToolError("Malformed goal work state.");
      // Отчёт проверяется до записи плана, чтобы ошибка в нём не оставила план без отчёта.
      const report = params.report ? requiredReport(params.report) : null;
      if (report && host.getGoal()?.status !== "active") throwToolError(say("Отчёт в update_goal_work требует активной цели; план не записан.", "A report in update_goal_work requires an active goal; the plan was not written."));
      const result = await host.updateGoalWork(params.goal_id, params.state, params.expected_revision, ctx, toolCallId);
      let reported: { reportId: string | null; languageNotes?: unknown[] } | null = null;
      if (report) {
        try {
          const published = await host.reportGoal("publish", report, ctx, toolCallId);
          const notes = languageNotes(published.projection);
          reported = { reportId: published.reportId, ...(notes.length > 0 ? { languageNotes: notes } : {}) };
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          // Квитанция reportGoal различает «отчёт в журнале, документ не пересобран» и «запись не подтверждена»: повтор сохранённого отчёта дал бы второй отчёт того же рубежа.
          let receipt: { applied?: boolean | null; reportId?: string | null; remediation?: string } = {};
          try { receipt = JSON.parse(text) as typeof receipt; } catch { /* не квитанция */ }
          if (receipt.applied === true) throwToolError(say("План и отчёт сохранены, документ цели не пересобран. Не повторяй ни update_goal_work, ни отчёт.", "The plan and the report were saved; the goal document was not rebuilt. Repeat neither update_goal_work nor the report."),
            { operation: "update_goal_work", ...result, report: { applied: true, reportId: receipt.reportId ?? null, remediation: receipt.remediation ?? null, error: text } });
          if (receipt.applied === null) throwToolError(say("План сохранён; неизвестно, записан ли отчёт. Не повторяй update_goal_work и не публикуй отчёт, пока get_goal не покажет, что его нет.", "The plan was saved; it is unknown whether the report was. Do not repeat update_goal_work or publish the report until get_goal shows it is missing."),
            { operation: "update_goal_work", ...result, report: { applied: null, remediation: receipt.remediation ?? null, error: text } });
          throwToolError(say("План сохранён, отчёт не записан. Не повторяй update_goal_work: опубликуй отчёт через report_goal_progress.", "The plan was saved but the report was not. Do not repeat update_goal_work: publish the report with report_goal_progress."),
            { operation: "update_goal_work", ...result, report: { applied: false, error: text } });
        }
      }
      const response = { operation: "update_goal_work", ...result, ...(reported ? { report: reported } : {}) };
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
    },
  });

  registerCreateGoalTool(pi, host, DEFAULT_GOAL_FEATURES);

  pi.registerTool({
    name: "amend_goal",
    defaultActive: false,
    label: say("Дополнить цель", "Amend Goal"),
    description: say("Дописывает одобренную поправку только в ходе после настоящей реплики владельца или восстанавливает уже применённую по amendment_id; передай ровно одно из двух. Если applied=true, а проекция не обновилась, восстанавливай по amendment_id: сохранённый текст не отправляй повторно и не правь. Цель на паузе возобновляется только после восстановления, без нового хода модели.", "Append a user-approved amendment only in a turn after a real owner reply, or recover an applied one by amendment_id; supply exactly one. After applied=true with a projection failure, recover by amendment_id: never resend or edit the saved text. A paused goal resumes only after recovery, without another model turn."),
    promptSnippet: say("Дополнить договор или восстановить поправку.", "Amend the contract or recover an amendment."),
    promptGuidelines: goalToolGuidelines("amend_goal"),
    parameters: amendGoalParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if ((params.amendment !== undefined) === (params.amendment_id !== undefined)) {
        throwToolError(say("Передай ровно одно из полей: amendment или amendment_id.", "Supply exactly one of amendment or amendment_id."));
      }
      if (params.amendment_id !== undefined && (params.agreement || params.self_decided)) throwToolError(say("amendment_id исправляет уже применённое изменение; не передавай agreement и self_decided.", "amendment_id repairs an applied amendment; omit agreement and self_decided."));
      if (params.amendment !== undefined && host.getGoal()?.agreement && !params.agreement) throwToolError(say("У цели есть договорённость: вместе с amendment передай agreement с полными новыми owner_wants и done_when.", "This goal has an agreement: pass agreement with the complete new owner_wants and done_when together with amendment."));
      const agreement: AgreementInput | undefined = params.agreement ? { ownerWants: params.agreement.owner_wants, doneWhen: params.agreement.done_when,
        ...(params.agreement.minimum_active_seconds !== undefined ? { minimumActiveSeconds: params.agreement.minimum_active_seconds } : {}),
        ...(params.self_decided ? { selfDecided: params.self_decided } : {}) } : undefined;
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
      const response = { ...goalToolResponse(result.goal, true), ...receipt, workRevision: host.getGoalWorkingState(ctx).workRevision, goal: toToolGoal(result.goal) };
      // Начало окна держит редакцию на момент сжатия (решение 0012): действующая редакция идёт в конце окна.
      const head = goalAtCompaction(ctx.sessionManager.getBranch(), result.goal);
      const stale = head?.goalId === result.goal.goalId && renderAgreement(head) !== renderAgreement(result.goal);
      const text = JSON.stringify(response, null, 2) + (stale ? `\n\n${amendedAfterCompactionNotice(result.goal)}` : "");
      return { content: [{ type: "text", text }], details: { ...response, error: null } };
    },
  });

  pi.registerTool({
    name: "record_goal_note",
    defaultActive: false,
    label: say("Записать заметку цели", "Record Goal Note"),
    description: say("Записывает устойчивое решение или отложенный риск, а не одобрение охвата. action=record требует title и поля своего вида; update закрывает paper_cut по note_id с expected_revision, status и resolution; repair пересобирает документ сохранённой заметки по kind и note_id без новой записи. ID и ревизии заметок — в get_goal.paperCuts.", "Record a durable decision or deferred risk, not scope approval. action=record needs title and kind-specific fields; update closes a paper_cut by note_id with expected_revision, status and resolution; repair rebuilds a saved note's document by kind and note_id without a new note. Note IDs and revisions are in get_goal.paperCuts."),
    promptSnippet: say("Записать, обновить или восстановить заметку.", "Record, update or repair a note."),
    promptGuidelines: goalToolGuidelines("record_goal_note"),
    parameters: recordGoalNoteParams(),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const action = params.action ?? "record";
      let result: unknown;
      let selfDecidedId: string | null = null;
      if (action === "update" || action === "repair") {
        const selfDecidedUpdate = action === "update" && params.kind === "decision";
        const allowed = new Set(action === "repair" ? ["kind", "action", "note_id"] : selfDecidedUpdate ? ["kind", "action", "note_id", "confirmation"] : ["kind", "action", "note_id", "expected_revision", "status", "resolution"]);
        if (Object.keys(params).some((key) => !allowed.has(key))) throwToolError(say(`Лишние поля записи для ${action}; передай note_id и только поля этого действия.`, `Unexpected note fields for ${action}; use note_id and only the fields for this action.`));
        if (!params.note_id?.trim()) throwToolError(say("Для update и repair нужен note_id.", "note_id is required for update/repair."));
        if (selfDecidedUpdate) {
          if (params.confirmation !== "confirmed" && params.confirmation !== "rejected") throwToolError(say("update kind=decision требует confirmation=confirmed или rejected для пункта «Решаю сам».", "update kind=decision requires confirmation=confirmed or rejected for a Self-decided item."));
          if (!host.setSelfDecidedState) throwToolError(say("Изменение пунктов «Решаю сам» недоступно.", "Self-decided updates are unavailable."));
          const outcome = await host.setSelfDecidedState(params.note_id, params.confirmation, ctx);
          if (!outcome.ok) throwToolError(outcome.message, { operation: "record_goal_note", action, kind: params.kind, noteId: params.note_id, applied: false, retryable: false });
          const response = { operation: "record_goal_note", action, noteId: params.note_id, kind: params.kind, applied: true, stage: "complete", retryable: false, confirmation: params.confirmation };
          return { content: [{ type: "text", text: JSON.stringify(response) }], details: response };
        }
        if (action === "update") {
          if (params.kind !== "paper_cut") throwToolError(say("update поддерживает только paper_cut.", "Only paper_cut supports update."));
          if (!params.resolution?.trim()) throwToolError(say("Для update нужно поле resolution.", "resolution is required for update."));
          if (params.expected_revision === undefined || !Number.isSafeInteger(params.expected_revision) || params.expected_revision < 0) throwToolError(say("Нужен expected_revision — ревизия записи из get_goal.", "expected_revision is required; use the note revision from get_goal."));
          if (params.status !== "resolved" && params.status !== "wont_fix") throwToolError(say("update требует status=resolved или wont_fix.", "update requires status=resolved or wont_fix."));
          if (!host.updateGoalPaperCut) throwToolError(say("Изменение отложенных рисков недоступно.", "Paper-cut updates are unavailable."));
          result = await host.updateGoalPaperCut({ id: params.note_id, expectedRevision: params.expected_revision, status: params.status, resolution: params.resolution.trim() }, ctx, toolCallId);
        } else {
          if (!host.repairGoalNote) throwToolError(say("Исправление документа записи недоступно.", "Note projection repair is unavailable."));
          result = await host.repairGoalNote(params.kind, params.note_id, ctx);
        }
      } else {
        if (action !== "record") throwToolError(say("Неизвестное действие с записью.", "Unknown note action."));
        if (["note_id", "expected_revision", "status", "resolution", "confirmation"].some((key) => key in params)) throwToolError(say("record не принимает поля update и repair.", "record does not accept update/repair fields."));
        if (!params.title?.trim()) throwToolError(say("Для record нужно поле title.", "title is required for record."));
        if (params.kind === "decision") {
          if (["impact", "severity", "revisit"].some((key) => key in params)) throwToolError(say("decision принимает только kind, title, decision, rationale и необязательные consequence и self_decided.", "decision accepts only kind, title, decision, rationale, and optional consequence and self_decided."));
          if (!params.decision?.trim() || !params.rationale?.trim()) throwToolError(say("decision требует decision и rationale.", "decision requires decision and rationale."));
          if (params.self_decided) {
            if (!host.addSelfDecided) throwToolError(say("Пункты «Решаю сам» недоступны.", "Self-decided items are unavailable."));
            const added = await host.addSelfDecided(params.self_decided, `${params.title.trim()}: ${params.decision.trim()}`, ctx);
            if (!added.ok) throwToolError(added.message);
            selfDecidedId = added.itemId ?? null;
          }
          result = await host.recordGoalDecision({ title: params.title, decision: params.decision, rationale: params.rationale, ...(params.consequence === undefined ? {} : { consequence: params.consequence }) }, ctx, toolCallId);
        } else {
          if (params.kind !== "paper_cut") throwToolError(say("Неизвестный вид записи.", "Unknown note kind."));
          if (["decision", "rationale", "consequence", "self_decided"].some((key) => key in params)) throwToolError(say("paper_cut принимает только kind, title, impact, severity и необязательное revisit.", "paper_cut accepts only kind, title, impact, severity, and optional revisit."));
          if (!params.impact?.trim() || !params.severity) throwToolError(say("paper_cut требует impact и severity.", "paper_cut requires impact and severity."));
          result = await host.recordGoalPaperCut({ title: params.title, impact: params.impact, severity: params.severity, ...(params.revisit === undefined ? {} : { revisit: params.revisit }) }, ctx, toolCallId);
        }
      }
      const noteId = result && typeof result === "object" && "entryId" in result && typeof result.entryId === "string" ? result.entryId : null;
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
    defaultActive: false,
    label: say("Отчёт о ходе цели", "Report Goal Progress"),
    description: say("Публикует изменение результата для пользователя, а не внутреннюю активность. Обычный ход отчитывается текстом в чате; инструмент нужен для blocked, awaiting_user и verifying. publish требует status, phase, summary, nextStep и поле изменения для своего статуса. Независимые факты разделяй пустыми строками.", "Publish a user-facing result delta, not internal activity. A normal turn reports in chat text; use this tool for blocked, awaiting_user and verifying. Publish needs status, phase, summary, nextStep and its status-specific delta. Separate independent facts with blank lines."),
    promptSnippet: say("Сообщай о содержательном изменении результата или гаси напоминание одним action.", "Report a meaningful result change, or suppress a due reminder with action only."),
    promptGuidelines: goalToolGuidelines("report_goal_progress"),
    parameters: progressReportParams(),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "suppress" && Object.keys(params).some((key) => key !== "action")) {
        throwToolError(say("suppress принимает только action; поля отчёта передавай с publish.", "suppress accepts only action; use publish for report fields."));
      }
      const report = params.action === "publish" ? requiredReport(params) : null;
      const result = await host.reportGoal(params.action, report, ctx, toolCallId);
      const workingState = goalActionWorkingState(host.getGoalWorkingState(ctx));
      const artifactRefs = report?.eventKind === "artifact_updated" ? projectionArtifactRefs(result.projection) : [];
      const notes = languageNotes(result.projection);
      const response = { operation: "report_goal_progress", action: params.action, applied: true, reportId: result.reportId, state: compactReportState(result.state), workingState, ...(artifactRefs.length > 0 ? { artifactRefs } : {}), ...(notes.length > 0 ? { languageNotes: notes } : {}) };
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: { ...response, error: null },
      };
    },
  });

  pi.registerTool({
    name: "update_goal",
    defaultActive: false,
    label: say("Закрыть цель", "Update Goal"),
    description: say("Закрывает цель, когда согласованный результат и обязательные доказательства готовы. Передай verification — это отчёт verifying. Первая попытка при этих договорённости и плане возвращает договорённость для сверки, вторая без правок закрывает цель. Если запись не удалась, перед повтором изучи сохранённое состояние; ни затраченные усилия, ни пометка риска не заменяют обязательное доказательство.", "Complete the Goal once the agreed outcome and required evidence are satisfied. Pass verification; it is the verifying report. The first attempt for this agreement and plan returns the agreement for a check; a second one without edits closes the Goal. If a write fails, inspect persisted state before retrying; neither elapsed effort nor a risk label replaces required proof."),
    promptSnippet: say("Закрыть проверенную цель.", "Complete a verified Goal."),
    promptGuidelines: goalToolGuidelines("update_goal"),
    parameters: updateGoalParams(),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await host.completeGoal("tool", ctx, _params.verification);
      if (!result.ok || !result.goal) {
        throwToolError(result.message, {
          operation: "update_goal", applied: result.applied === undefined ? false : result.applied,
          goalId: result.goal?.goalId ?? null, stage: result.stage ?? "canonical", retryable: result.retryable ?? false,
          remediation: result.remediation ?? say("Перед новой попыткой завершения прочитай get_goal.", "Read get_goal before another completion attempt."),
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
      // Договорённость закрытой цели стоит в начале окна до следующего сжатия (решение 0012): модели нужно знать, что она больше не действует.
      const retained = goalAtCompaction(ctx.sessionManager.getBranch(), result.goal)?.goalId === result.goal.goalId;
      const text = JSON.stringify(response, null, 2)
        + (unconfirmed.length > 0 ? `\n\n${say("Не подтверждено владельцем:", "Not confirmed by the owner:")}\n${renderSelfDecided(unconfirmed)}` : "")
        + (retained ? `\n\n${retainedAgreementNotice()}` : "");
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
    description: `${say("Создаёт долгую цель только после явной просьбы запустить работу. Если просят показать промпт цели, дай черновик и не запускай её. Сохрани замысел и согласованные границы; не добавляй условий приёмки. При автономной работе обращайся к прошлым решениям, когда от них зависит выбор; они не дают новых полномочий.", "Create a durable goal only on an explicit request to start. If asked to show a goal prompt, give a draft without starting. Preserve intent and agreed boundaries; do not add acceptance gates. When working autonomously, consult past decisions when they affect the choice; they grant no new authority.")}${rules.askBeforeGoal ? ` ${askBeforeGoalRule()}` : ""}`,
    promptSnippet: say("Создать долгую цель.", "Create a durable Goal."),
    promptGuidelines: goalToolGuidelines("create_goal"),
    parameters: createGoalParams(),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getGoal();
      const features = host.getFeatures?.() ?? DEFAULT_GOAL_FEATURES;
      if (!params.agreement) throwToolError(say("create_goal требует agreement с owner_wants и done_when.", "create_goal requires agreement with owner_wants and done_when."));
      if (features.selfDecidedList && !params.self_decided) throwToolError(say("create_goal требует self_decided: перечисли, что решил сам; если владелец подтвердил всё, передай [].", "create_goal requires self_decided: list what you decided yourself; pass [] when the owner confirmed everything."));
      const agreement: AgreementInput = { ownerWants: params.agreement.owner_wants, doneWhen: params.agreement.done_when,
        ...(params.agreement.minimum_active_seconds !== undefined ? { minimumActiveSeconds: params.agreement.minimum_active_seconds } : {}),
        ...(features.selfDecidedList && params.self_decided ? { selfDecided: params.self_decided } : {}) };
      const replacingNonCompleteGoal = params.replace_existing === true && current !== null && current.status !== "complete";
      const result = replacingNonCompleteGoal
        ? replaceGoal(params.objective, params.token_budget ?? null, agreement)
        : createGoal(current, params.objective, params.token_budget ?? null, agreement);
      if (!result.ok || !result.goal) {
        throwToolError(result.message);
      }
      if (params.mode !== undefined) result.goal.mode = params.mode;
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
            ? say("Прочитай get_goal. Цель уже существует, не создавай её снова. Когда хранилище станет доступно, следующая разрешённая запись цели пересоберёт её документ.", "Read get_goal. The Goal already exists: do not create it again. Once storage is available, the next authorized Goal write rebuilds its document.")
            : say("Неизвестно, сохранилась ли запись. Прежде чем создавать другую цель, заново открой сохранённый файл сессии и выбранную ветку и сверь цель; память SDK и перезагрузка расширения не доказывают сохранения.", "Write acknowledgement is unknown. Reopen the saved session file and selected branch and reconcile the canonical Goal before creating another one; SDK memory and extension reload do not prove persistence."),
          ...(error instanceof GoalCanonicalWriteError ? { ...error.details, operation: "create_goal",
            applied: acknowledged ? true : null, stage: acknowledged ? "projection" : "canonical" } : {}),
        });
      }
      return textResult(toToolText(result.goal), result.goal);
    },
  });
}
