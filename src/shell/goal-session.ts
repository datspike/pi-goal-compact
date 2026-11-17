import { language, say } from "../language.js";
import { createHash } from "node:crypto";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { goalWorkingState, type GoalWorkingState } from "../goal/format.js";
import { createAccountingState, createGoalAccounting } from "../goal/goal-accounting.js";
import { createGoalArtifacts } from "../goal/goal-artifacts.js";
import { appendAgreementEntry, appendGoalSnapshot } from "../goal/goal-observability.js";
import { GoalCanonicalWriteError, createGoalPersistence } from "../goal/goal-persistence.js";
import { createGoalProjections, readGoalHistory, type GoalHistoryPage, type GoalHistoryQuery, type GoalPaperCutUpdate } from "../goal/goal-projections.js";
import { goalFeatures, loadGoalReportPolicy, type GoalFeatures } from "../goal/goal-report-config.js";
import { completionFingerprint, completionReturnMessage, selfDecidedItemId, validateSelfDecidedText, MAX_SELF_DECIDED_ITEMS, type SelfDecidedKind } from "../goal/agreement.js";
import { createGoalReports, holdsContinuation, latestOwnerEntryId, type GoalReportAction, type GoalReportState } from "../goal/goal-reports.js";
import { createGoalRuntimeStatus, type GoalRuntimeActivity } from "../goal/goal-runtime-status.js";
import { applyGoalTransitionEffects, planGoalTransition, reloadGoalRuntimeEffects, type GoalTransitionEffectHandlers, type GoalTransitionRequest } from "../goal/goal-transition.js";
import type { GoalWorkState, GoalWorkUpdateResult } from "../goal/goal-work-state.js";
import { applyHostOverflowUserResetPersistence, beginHostOverflowRecovery, clearActiveHostOverflowRecovery, createGoalRecoveryMachine, requireHostOverflowUserReset, recoveryPhaseBlocksContinuation, resetRecoveryMachine, setRecoveryPausedAttention, syncHostOverflowUserResetFromSession } from "../goal/recovery-machine.js";
import { MAX_REPORT_SUMMARY_CHARS, MAX_REPORT_VERIFICATION_CHARS, type GoalProgressReport } from "../goal/report-schema.js";
import { amendGoal as appendAmendment, type AgreementInput, cloneGoal, goalsEquivalent, goalWithLiveUsage, hostOverflowCapResetEntry, nonDecreasingUpdatedAt, reconstructGoal, reconstructHostOverflowCapNeedsUserReset, updateGoalStatus } from "../goal/state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type GoalResult, type ThreadGoal } from "../goal/types.js";
import { createGoalContext } from "./goal-context.js";

/** Новая редакция договорённости, принятая по реплике владельца, несёт ссылку на эту реплику (Т7.1). */
function withOwnerReference(before: ThreadGoal, after: ThreadGoal, ownerEntryId: string | null): ThreadGoal {
  if (!ownerEntryId || !after.agreement || after.agreement.revision === before.agreement?.revision) return after;
  return { ...after, agreement: { ...after.agreement, ownerEntryId } };
}

// managedRefs отдаёт только GOAL; прочие имена показываются как есть.
const artifactLinkLabel = (artifact: string): string => artifact === "GOAL" ? say("Сводка", "Summary") : artifact;
const STALE_PROJECTION = /no longer current|belongs to goal|stale after session replacement/i;

/**
 * Связь модуля цели с продолжением работы и восстановлением после ошибок.
 * До подключения продолжения все удержания пусты: цель живёт, но сама не продолжается.
 */
export interface GoalRunHooks {
  /** Повтор PiRetry ещё не закончен — активировать цель нельзя. */
  externalRetryActive(): boolean;
  /** Сбросить ждущие продолжения: цель сменилась, ушла на паузу или закрылась. */
  clearContinuation(): void;
  /** Владелец или смена цели отменили ожидание повтора PiRetry. */
  invalidateExternalRetry(): void;
  /** Отменить отложенное автовозобновление после лимита провайдера. */
  cancelProviderLimitAutoResume(): void;
  isProviderLimitAutoResumeScheduled(goalId: string): boolean;
  /** Прогон прерван самим расширением (отказ устаревшему билету), а не владельцем. */
  ownAbort(): boolean;
  /** Новый обработчик отличает подтверждённую ручную отмену от технического обрыва. */
  ownsAbortHandling?(): boolean;
  /** Скрытые продолжения дошли до предела и ждут слова владельца. */
  isLimitHeld(): boolean;
}

const NO_RUN_HOOKS: GoalRunHooks = {
  externalRetryActive: () => false,
  clearContinuation: () => {},
  invalidateExternalRetry: () => {},
  cancelProviderLimitAutoResume: () => {},
  isProviderLimitAutoResumeScheduled: () => false,
  ownAbort: () => false,
  isLimitHeld: () => false,
};

type AmendmentOutcome = { state: { currentProjectionSeq: number; stateSeq: number } };

/**
 * Модуль цели: одна цель сессии, её журнал, документ `GOAL.md`, отчёты и правила доступа к операциям.
 *
 * Состояние восстанавливается из ветки журнала при старте и смене ветки.
 * Переходы статусов решает `planGoalTransition`; здесь — запись, документ и проверки допуска.
 */
export function createGoalSession(pi: ExtensionAPI) {
  const goalContext = createGoalContext(pi);
  let hooks: GoalRunHooks = NO_RUN_HOOKS;
  const recovery = createGoalRecoveryMachine();
  const accountingState = createAccountingState();
  let activity: GoalRuntimeActivity | null = null;
  let agentRunSequence = 0;
  let currentTurnIndex: number | null = null;
  // Запуск от чужого расширения: его не учитывают и не продолжают (Ц31). Держится до следующего допуска.
  let foreignRun = false;

  // Пока документ не синхронизирован или запись не подтверждена, внешние записи запрещены.
  const persistence = createGoalPersistence({ pi, assertExternalWrite: () => projections.assertWritable() });
  const reports = createGoalReports(pi);
  const getGoal = (): ThreadGoal | null => persistence.getGoal();
  const artifacts = createGoalArtifacts({ appendEntry: pi.appendEntry.bind(pi), getCurrentGoal: getGoal });
  const projections = createGoalProjections(pi, artifacts, getGoal);

  // Документ цели строится асинхронно. Закрытие, возобновление и план ждут этот барьер,
  // иначе отставший снимок активной цели перепишет документ уже закрытой.
  let bootstrapGoalId: string | null = null;
  let bootstrap: Promise<void> = Promise.resolve();
  let reloadGeneration = 0;
  let amendmentProjectionPending = false;

  // Возобновление разрешает только явное слово владельца в текущем ходе.
  let userInstructionGoalId: string | null = null;
  let userInputGeneration = 0;
  let awaitingInputGeneration = 0;
  let remoteInput: { goalId: string; reportId: string | null; text: string; commandId: string } | null = null;
  // Настоящие реплики владельца для правки цели (Д8) и состояния пунктов «Решаю сам» (Д4):
  // сообщение владельца, ответ `ask_user`, принятый ответ из Recall. После перезагрузки счёт
  // начинается заново — правка и подтверждение ждут новую реплику.
  let ownerReplySeq = 0;
  let ownerReplySeqAtGoalChange = 0;
  let ownerTurnOpen = false;
  const noteOwnerReply = (): void => { ownerReplySeq++; ownerTurnOpen = true; };
  const features = (): GoalFeatures => goalFeatures(reports.getState().policy);

  const goalForDisplay = (): ThreadGoal | null =>
    goalWithLiveUsage(persistence.getGoal(), accountingState.activeGoalId, accountingState.lastAccountedAt);

  const status = createGoalRuntimeStatus({
    getGoalForDisplay: goalForDisplay,
    getGoalStatus: () => persistence.getGoal()?.status ?? null,
    getRecoveryAttention: () => recovery.attention,
    isProviderLimitAutoResumeScheduled: (goalId) => hooks.isProviderLimitAutoResumeScheduled(goalId),
    getReportState: reports.getState,
    getAgentRunSequence: () => agentRunSequence,
    getActivity: () => activity,
    getArtifactRefs: (goal, ctx) => {
      if (!ctx.cwd || !ctx.sessionManager) return [];
      const projected = projections.current();
      if (!projected || projected.goalId !== goal.goalId) return [];
      return artifacts.managedRefs(goal, { cwd: ctx.cwd, sessionManager: ctx.sessionManager }, ctx.sessionManager.getBranch())
        .map((ref) => ({ label: artifactLinkLabel(ref.artifact), path: ref.path }));
    },
    setActivity: (next) => { activity = next; },
  });

  const effectHandlers: GoalTransitionEffectHandlers = {
    clearContinuation: () => hooks.clearContinuation(),
    clearActiveAccounting: () => {
      accountingState.activeGoalId = null;
      accountingState.lastAccountedAt = null;
    },
    resetRecovery: () => resetRecoveryMachine(recovery),
    clearBudgetWarning: () => { accountingState.budgetWarningSentFor = null; },
    clearHostOverflowRecovery: () => clearActiveHostOverflowRecovery(recovery),
    setRecoveryPausedAttention: (reason) => { setRecoveryPausedAttention(recovery, reason); },
    // Продолжения в очереди больше нет (решение 0002): отмечать нечего.
    markContinuationQueued: () => {},
    stopStatusRefresh: () => status.stopStatusRefresh(),
  };

  const watchBootstrap = (goalId: string, barrier: Promise<void>, label: string): void => {
    bootstrapGoalId = goalId;
    bootstrap = barrier;
    void barrier.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!STALE_PROJECTION.test(message)) console.error(`Goal projection ${label} failed: ${message}`);
    });
  };

  const refreshAfterBootstrap = (goalId: string, ctx: ExtensionContext, generation: number): void => {
    if (generation !== reloadGeneration || getGoal()?.goalId !== goalId || projections.current()?.goalId !== goalId) return;
    try { status.refreshUi(ctx); } catch (error) { console.error(`Goal status refresh failed: ${String(error)}`); }
  };

  const initializeDocument = (goal: ThreadGoal, ctx: ExtensionContext): Promise<void> => {
    const generation = reloadGeneration;
    return projections.initialize(goal, goalContext(ctx)).then(() => { refreshAfterBootstrap(goal.goalId, ctx, generation); });
  };

  const onUserBoundaryChange = (previous: ThreadGoal | null, next: ThreadGoal): void => {
    const terminalOrManual = next.status === "complete" || next.status === "budgetLimited" || (next.status === "paused" && next.pause?.kind === "manual");
    if (previous?.goalId !== next.goalId || terminalOrManual) {
      userInstructionGoalId = null;
      userInputGeneration++;
    }
    if (previous?.goalId !== next.goalId || terminalOrManual || (next.status === "paused" && next.pause?.kind !== "recovery")) hooks.invalidateExternalRetry();
  };

  /** Применяет переход статуса: план, запись в журнал, действия и обновление документа. */
  const applyTransition = (request: GoalTransitionRequest, ctx: ExtensionContext | null, options: { refreshUi?: boolean } = {}): boolean => {
    const previous = getGoal();
    const plan = planGoalTransition(previous, request);
    if (plan.persist !== "skip" && plan.persist !== "defer") persistence.assertWritable();
    applyGoalTransitionEffects(plan.beforePersist, effectHandlers);
    const refresh = (): void => { if (ctx && options.refreshUi !== false) status.refreshUi(ctx); };
    if (plan.persist === "clear") {
      persistence.appendClearEntry(previous?.goalId ?? null, plan.source);
      applyGoalTransitionEffects(plan.afterPersist, effectHandlers);
      refresh();
      return true;
    }
    if (plan.persist === "skip") {
      applyGoalTransitionEffects(plan.afterPersist, effectHandlers);
      refresh();
      return false;
    }
    persistence.setGoalSnapshot(plan.nextGoal);
    if (plan.persist === "defer") {
      refresh();
      return false;
    }
    const persisted = persistence.flushGoalPersistence(plan.source);
    applyGoalTransitionEffects(plan.afterPersist, effectHandlers);
    onUserBoundaryChange(previous, plan.nextGoal);
    if (ctx && previous && previous.goalId === plan.nextGoal.goalId && plan.nextGoal.status !== "complete" && JSON.stringify(previous) !== JSON.stringify(plan.nextGoal)) {
      const key = createHash("sha256").update(JSON.stringify(plan.nextGoal)).digest("hex").slice(0, 24);
      watchBootstrap(plan.nextGoal.goalId, projections.updateGoal(plan.nextGoal, goalContext(ctx), `transition:${key}`).then(() => undefined), "transition");
    }
    refresh();
    return persisted;
  };

  const accounting = createGoalAccounting({
    getGoal,
    getAccounting: () => accountingState,
    applyRuntimeAccountingTransition: (ctx, nextGoal) => { applyTransition({ kind: "runtime_accounting", nextGoal }, ctx); },
    sendMessage: pi.sendMessage.bind(pi),
  });

  const reloadReportPolicy = async (ctx: ExtensionContext): Promise<void> => {
    const result = await loadGoalReportPolicy({ cwd: goalContext(ctx).cwd });
    reports.setPolicy(result.policy);
    for (const warning of result.warnings) {
      const message = `Goal reports configuration: ${warning}`;
      console.warn(message);
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
    }
  };

  /** Восстанавливает цель, отчёты и документ из текущей ветки журнала. */
  const reloadFromSession = async (ctx: ExtensionContext): Promise<void> => {
    const view = goalContext(ctx);
    const branch = view.sessionManager.getBranch();
    const previousGoalId = getGoal()?.goalId ?? null;
    const goal = reconstructGoal(branch).goal;
    persistence.setGoalSnapshot(goal);
    persistence.syncPersistedSnapshot(goal);
    syncHostOverflowUserResetFromSession(recovery, reconstructHostOverflowCapNeedsUserReset(branch));
    applyGoalTransitionEffects(reloadGoalRuntimeEffects(previousGoalId, goal), effectHandlers);
    const generation = ++reloadGeneration;
    projections.reload(branch, goal);
    reports.reload(branch, goal?.goalId ?? null);
    userInstructionGoalId = null;
    userInputGeneration++;
    remoteInput = null;
    ownerReplySeq = 0;
    ownerReplySeqAtGoalChange = 0;
    ownerTurnOpen = false;
    await reloadReportPolicy(ctx);
    if (goal) watchBootstrap(goal.goalId, projections.initialize(goal, view).then(() => { refreshAfterBootstrap(goal.goalId, ctx, generation); }), "recovery");
    status.refreshUi(ctx);
  };

  const canonicalFailure = (operation: NonNullable<GoalResult["operation"]>, error: GoalCanonicalWriteError, applied: true | null = null): GoalResult => ({
    ok: false, ...error.details, operation, applied, stage: applied ? "projection" : "canonical", goal: getGoal(),
  });
  const unconfirmedWrite = (): GoalCanonicalWriteError | null => persistence.getUnconfirmedWrite() ?? projections.getUnconfirmedWrite();

  const awaitingDecision = (state: GoalReportState): boolean =>
    state.awaitingUser && state.requiresUserDecision !== false && !state.hasUserDecisionSinceAwaiting;

  /** Можно ли снять паузу: нет неизвестной записи, удержания, починки и блокирующего восстановления. */
  const canRecover = (allowAnsweredUserHold = false, lifecycleOnly = false): boolean => {
    const state = reports.getState();
    return !unconfirmedWrite() &&
      (!reports.isContinuationHeld() || state.hasUserDecisionSinceAwaiting || allowAnsweredUserHold) &&
      !amendmentProjectionPending &&
      (lifecycleOnly || !recoveryPhaseBlocksContinuation(recovery.phase));
  };

  // Каждый путь активации держит те же ворота, что и инструмент модели.
  const resumeGateFailure = (allowAnsweredUserHold = false, lifecycleOnly = false): GoalResult | null => {
    const goal = getGoal();
    if (awaitingDecision(reports.getState()) && !allowAnsweredUserHold) return { ok: false, message: say("Цель ждёт обычного решения пользователя и без него не продолжится.", "Goal is awaiting an ordinary user decision before it can continue."), goal };
    const projected = projections.current();
    if (!canRecover(allowAnsweredUserHold, lifecycleOnly) || !projected || projected.goalId !== goal?.goalId || projected.stateSeq !== projected.currentProjectionSeq) {
      return { ok: false, message: say("Перед возобновлением состояние цели нужно восстановить или синхронизировать документ. Посмотри get_goal.", "Goal state requires recovery or projection synchronization before activation. Inspect get_goal."), goal };
    }
    return null;
  };

  const resumePausedGoal = (ctx: ExtensionContext): void => {
    if (getGoal()?.status === "paused") applyTransition({ kind: "resume_active" }, ctx);
  };

  const answeredBlockedHold = (): boolean => {
    const state = reports.getState();
    return state.awaitingUser && state.requiresUserDecision === false && state.hasUserReplySinceAwaiting === true && userInputGeneration > awaitingInputGeneration;
  };

  /** Возобновляет цель по явному слову владельца, не меняя договор и не запуская запрос к модели. */
  const resumeGoal = async (ctx: ExtensionContext, signal?: AbortSignal, userDecisionConfirmed = false): Promise<GoalResult> => {
    const original = getGoal();
    const pending = unconfirmedWrite();
    if (pending) return canonicalFailure("resume_goal", pending);
    const inputGeneration = userInputGeneration;
    const decisionReportId = reports.getState().lastReportId;
    const failure = (message: string): GoalResult => ({ ok: false, message, goal: getGoal() });
    const cancelled = (): boolean => Boolean(signal?.aborted || ctx.signal?.aborted);
    if (cancelled()) return failure(say("Возобновление отменено до запуска.", "Resume cancelled before activation."));
    if (!original || original.status === "complete") return failure(say("Нет цели, которую можно возобновить: завершённые и очищенные цели окончательны.", "No resumable goal exists; completed and cleared goals are terminal."));
    if (original.status === "budgetLimited" || (original.tokenBudget !== null && original.usage.tokensUsed >= original.tokenBudget)) return failure(say("Бюджет токенов цели исчерпан; resume_goal не может его обойти.", "Goal token budget is exhausted; resume_goal cannot override it."));
    if (original.status === "active") return { ok: true, message: say("Цель уже активна.", "Goal already active."), goal: original };
    if (userInstructionGoalId !== original.goalId) return failure(say("resume_goal требует явного указания пользователя в текущем ходе; фоновые повторы не считаются согласием пользователя.", "resume_goal requires an explicit user instruction in the current user turn; background retries are not user approval."));
    const unconfirmedDecision = (): boolean => !userDecisionConfirmed || (userInputGeneration <= awaitingInputGeneration && !reports.getState().questionAnswerPending);
    if (awaitingDecision(reports.getState()) && unconfirmedDecision()) return failure(say("Ожидаемое решение пользователя не подтверждено. Ставь user_decision_confirmed только после того, как истолковал нужный ответ, и никогда — ради вопроса о статусе или простого продолжения.", "The pending user decision is not confirmed. Set user_decision_confirmed only after interpreting the required answer, never for a status inquiry or continuation alone."));
    if (!canRecover(userDecisionConfirmed || answeredBlockedHold())) return failure(say("Продолжение цели удерживает решение пользователя, восстановление или синхронизация документа. Посмотри get_goal.", "Goal continuation is held by a user decision, recovery gate, or projection synchronization. Inspect get_goal."));
    await bootstrap;
    if (cancelled()) return failure(say("Возобновление отменено до запуска.", "Resume cancelled before activation."));
    if (getGoal()?.goalId !== original.goalId || userInputGeneration !== inputGeneration || userInstructionGoalId !== original.goalId) return failure(say("Указание возобновить устарело: сессия или цель сменились.", "Resume instruction is stale after session or goal replacement."));
    if (awaitingDecision(reports.getState()) && (unconfirmedDecision() || reports.getState().lastReportId !== decisionReportId)) return failure(say("Ожидаемое решение изменилось до запуска.", "The pending decision changed before activation."));
    if (userDecisionConfirmed && awaitingDecision(reports.getState()) && reports.getState().lastReportId !== decisionReportId) return failure(say("Подтверждение решения устарело: после него вышел новый отчёт.", "Decision confirmation is stale after a newer report."));
    const blocked = resumeGateFailure(userDecisionConfirmed || answeredBlockedHold());
    if (blocked) return blocked;
    if (awaitingDecision(reports.getState()) && userDecisionConfirmed) reports.noteOrdinaryUserDecision(original);
    hooks.cancelProviderLimitAutoResume();
    try { resumePausedGoal(ctx); }
    catch (error) {
      if (error instanceof GoalCanonicalWriteError) return canonicalFailure("resume_goal", error);
      throw error;
    }
    try { await bootstrap; }
    catch (error) {
      if (error instanceof GoalCanonicalWriteError) return canonicalFailure("resume_goal", error, true);
      return { ok: false, operation: "resume_goal", applied: true, stage: "projection", retryable: true,
        message: say(`Цель возобновлена, но документ не обновился: ${error instanceof Error ? error.message : String(error)}`, `Goal resumed but projection failed: ${error instanceof Error ? error.message : String(error)}`), goal: getGoal(),
        remediation: say("Прочитай get_goal и исправь сохранённый документ цели; не заменяй её контракт и не запускай новый запрос к модели.", "Read get_goal and repair the saved Goal document; do not replace its contract or start another model request.") };
    }
    return { ok: true, message: say("Цель возобновлена без изменения контракта и без нового запроса к модели.", "Goal resumed without changing its contract or sending another model request."), goal: getGoal() };
  };

  const amendmentIdFor = (key: string): string => `amendment-${createHash("sha256").update(key).digest("hex")}`;
  const amendmentRemediation = (): string => say("Поправка уже сохранена. Проверь get_goal, затем вызови amend_goal только с amendment_id из ответа, без amendment.", "The amendment is already saved. Check get_goal, then call amend_goal with only the amendment_id from the response, without amendment.");
  const needsRepair = (outcome: AmendmentOutcome): boolean => outcome.state.currentProjectionSeq !== outcome.state.stateSeq;
  const amendmentProjectionFailure = (goal: ThreadGoal, outcome: AmendmentOutcome, amendmentId: string): GoalResult => ({
    ok: false, operation: "amend_goal", applied: true, stage: "projection", retryable: true, amendmentId, remediation: amendmentRemediation(),
    message: say(`Изменение цели уже применено; документ всё ещё нужно обновить (stateSeq=${outcome.state.stateSeq}, currentProjectionSeq=${outcome.state.currentProjectionSeq}).`, `Goal amendment already applied; projection update remains pending (stateSeq=${outcome.state.stateSeq}, currentProjectionSeq=${outcome.state.currentProjectionSeq}).`), goal,
  });

  /**
   * Дописывает одобренную поправку к договору и записывает её решением в документ.
   * Повтор по `amendmentId` только восстанавливает документ, текст договора не меняется.
   */
  const amendGoal = async (amendment: string, source: GoalEntrySource, ctx: ExtensionContext, recoveryId?: string, agreement?: AgreementInput): Promise<GoalResult> => {
    const current = getGoal();
    const pending = unconfirmedWrite();
    if (pending) return canonicalFailure("amend_goal", pending);
    if (!current || (current.status !== "active" && current.status !== "paused")) return appendAmendment(current, amendment, agreement);
    // Восстановление по `amendment_id` цель не меняет, поэтому реплики владельца не требует (Т7.3).
    if (recoveryId === undefined && features().amendNeedsOwner && ownerReplySeq <= ownerReplySeqAtGoalChange) {
      return { ok: false, message: say("amend_goal нужен настоящий ответ владельца после создания цели или прошлого изменения. Спроси владельца; не меняй цель сам.", "amend_goal needs a real owner reply after the goal was created or last amended. Ask the owner; do not change the goal on your own."), goal: current };
    }
    if (current.status === "paused" && reports.isContinuationHeld()) {
      return { ok: false, message: say("Цель ждёт обычного решения пользователя и без него не продолжится.", "Goal is awaiting an ordinary user decision before it can continue."), goal: current };
    }
    let text = amendment.trim();
    let key = `${current.goalId}\u0000${text}`;
    if (recoveryId !== undefined) {
      const saved = current.appliedAmendments?.find((item) => item.startsWith(`${current.goalId}\u0000`) && amendmentIdFor(item) === recoveryId);
      if (!saved) return { ok: false, message: say("В текущей цели нет изменения с таким ID.", "Amendment ID not found in the current goal."), goal: current };
      key = saved;
      text = saved.slice(current.goalId.length + 1);
    } else if (text.length === 0) {
      return appendAmendment(current, amendment, agreement);
    }
    const amendmentId = amendmentIdFor(key);
    const alreadyApplied = current.appliedAmendments?.includes(key) === true;
    let goal = current;
    if (!alreadyApplied) {
      const validation = appendAmendment(current, amendment, agreement);
      if (!validation.ok || !validation.goal) return validation;
      accounting.accountProgress(ctx, false);
      const result = appendAmendment(getGoal(), amendment, agreement);
      if (!result.ok || !result.goal) return result;
      goal = withOwnerReference(current, result.goal, latestOwnerEntryId(goalContext(ctx).sessionManager.getBranch()));
      ownerReplySeqAtGoalChange = ownerReplySeq;
      try { applyTransition({ kind: "set", nextGoal: goal, source }, ctx); }
      catch (error) {
        if (error instanceof GoalCanonicalWriteError) return { ...canonicalFailure("amend_goal", error), amendmentId };
        throw error;
      }
      announceAgreement(goal, ctx);
    }
    if (projections.isManaged()) {
      amendmentProjectionPending = true;
      try {
        const updated = await projections.updateGoal(goal, goalContext(ctx), `amend:${goal.updatedAt}`);
        if (needsRepair(updated)) return amendmentProjectionFailure(goal, updated, amendmentId);
        const decision = await projections.recordDecision(goal, {
          title: say("Изменение цели", "Goal change"), decision: text, source: "approved-amendment",
          rationale: say("Изменение добавлено пользователем в договорённость о завершении цели.", "The user added this change to the goal completion contract."), createdAt: goal.updatedAt,
        }, goalContext(ctx), `amendment:${key}`);
        if (needsRepair(decision)) return amendmentProjectionFailure(goal, decision, amendmentId);
      } catch (error) {
        if (error instanceof GoalCanonicalWriteError) return { ...canonicalFailure("amend_goal", error, true), amendmentId,
          remediation: say(`${error.details.remediation} Когда сохранённый контракт подтверждён, исправляй только через amendment_id=${amendmentId}; не переформулируй и не отправляй изменение заново.`, `${error.details.remediation} Once the saved contract is confirmed, repair with only amendment_id=${amendmentId}; never reword or resend the amendment.`) };
        return { ok: false, operation: "amend_goal", applied: true, stage: "projection", retryable: true, amendmentId,
          remediation: amendmentRemediation(), message: say(`Изменение цели применено, но документ нужно обновить повторно: ${error instanceof Error ? error.message : String(error)}`, `Goal amendment applied but projection retryable: ${error instanceof Error ? error.message : String(error)}`), goal };
      } finally {
        amendmentProjectionPending = false;
      }
    }
    if (current.status === "paused") {
      hooks.cancelProviderLimitAutoResume();
      try { resumePausedGoal(ctx); }
      catch (error) {
        if (error instanceof GoalCanonicalWriteError) return { ...canonicalFailure("amend_goal", error), amendmentId };
        throw error;
      }
      goal = getGoal() ?? goal;
    }
    return { ok: true, operation: "amend_goal", applied: true, stage: "projection", retryable: false, amendmentId,
      message: alreadyApplied ? say("Документы изменения цели восстановлены; сохранённый контракт не изменился.", "Goal amendment projections restored; saved contract unchanged.") : "Goal amended.", goal };
  };

  /** Записывает закрытие; неудачная запись оставляет снимок, и повтор пишет именно его. */
  const persistCompletion = (source: GoalEntrySource, ctx: ExtensionContext): GoalResult => {
    const goal = getGoal();
    const result = updateGoalStatus(goal, "complete");
    if (!result.ok || !result.goal) return result;
    if (goal && goalsEquivalent(goal, result.goal)) {
      persistence.flushGoalPersistence(source);
      return result;
    }
    applyTransition({ kind: "set", nextGoal: result.goal, source }, ctx);
    return result;
  };

  /** Закрывает цель только после свежего отчёта `verifying`; документ закрытия чинится без отката. */
  /** Текст проверки из `update_goal` становится отчётом verifying для текущих договорённости и плана (решение 0016). */
  const recordCompletionVerification = async (goal: ThreadGoal, verification: string, fingerprint: string, ctx: ExtensionContext): Promise<GoalResult | null> => {
    const chars = [...verification.trim()];
    const report: GoalProgressReport = {
      status: "verifying", eventKind: "verification",
      phase: say("Сверяю результат с договорённостью", "Checking the result against the agreement"),
      summary: chars.length <= MAX_REPORT_SUMMARY_CHARS ? chars.join("") : `${chars.slice(0, MAX_REPORT_SUMMARY_CHARS - 1).join("")}…`,
      verification: chars.length <= MAX_REPORT_VERIFICATION_CHARS ? chars.join("") : `${chars.slice(0, MAX_REPORT_VERIFICATION_CHARS - 1).join("")}…`, nextStep: say("Закрыть цель.", "Close the goal."),
    };
    try {
      await reportGoal("publish", report, ctx, `update_goal:${fingerprint}`);
      return null;
    } catch (error) {
      return { ok: false, operation: "update_goal", applied: false, stage: "canonical", retryable: false, goal,
        message: say(`Текст проверки не записан: ${error instanceof Error ? error.message : String(error)}`, `The verification text was not recorded: ${error instanceof Error ? error.message : String(error)}`),
        remediation: say("Прочитай get_goal; цель не закрыта.", "Read get_goal; the goal is not closed.") };
    }
  };

  const completeGoal = async (source: GoalEntrySource, ctx: ExtensionContext, verification?: string): Promise<GoalResult> => {
    const pending = unconfirmedWrite();
    if (pending) return canonicalFailure("update_goal", pending);
    hooks.cancelProviderLimitAutoResume();
    const initialGoal = getGoal();
    if (initialGoal && bootstrapGoalId === initialGoal.goalId) {
      try { await bootstrap; }
      catch (error) {
        if (initialGoal.status !== "complete") return { ok: false, operation: "update_goal", applied: false, stage: "projection", retryable: true,
          message: say(`Не удалось построить документ цели: ${error instanceof Error ? error.message : String(error)}`, `Goal projection bootstrap failed: ${error instanceof Error ? error.message : String(error)}`), goal: getGoal(),
          remediation: say("Прочитай get_goal и исправь документ до завершения.", "Read get_goal and repair the document before completing.") };
      }
    }
    const goal = getGoal();
    if (initialGoal?.goalId !== goal?.goalId) return { ok: false, operation: "update_goal", applied: false, stage: "canonical", retryable: false,
      message: "Goal changed while waiting for completion.", goal, remediation: say("Прочитай текущий контракт; не завершай другую цель по старому запросу.", "Read the current contract; do not complete a different goal from an old request.") };
    if (goal && goal.status !== "complete" && amendmentProjectionPending) {
      return { ok: false, operation: "update_goal", applied: false, stage: "canonical", retryable: false,
        message: say("Поправка цели ещё не записана в документ; закрывать рано.", "The goal amendment is not yet in the document; it is too early to close."), goal,
        remediation: say("Восстанови поправку через amend_goal(amendment_id), затем повтори закрытие.", "Repair the amendment with amend_goal(amendment_id), then retry completion.") };
    }
    const fingerprint = goal ? completionFingerprint(goal, projections.current()?.goalId === goal.goalId ? projections.current()!.workRevision : 0) : "";
    // Первая попытка при этих договорённости и плане возвращает договорённость (Д3, решение 0005). Правка любого
    // из них меняет отпечаток, и сверка нужна заново (Т6.3). Текст проверки из того же вызова засчитывается этой паре.
    let returned: GoalResult | null = null;
    if (goal && goal.status !== "complete" && features().completionReturn && goal.completionCheck !== fingerprint) {
      const checked = cloneGoal(goal);
      checked.completionCheck = fingerprint;
      try { await saveGoalChange(checked, source, ctx); }
      catch (error) {
        if (error instanceof GoalCanonicalWriteError) return canonicalFailure("update_goal", error);
        throw error;
      }
      returned = { ok: false, operation: "update_goal", applied: false, stage: "agreement_check", retryable: true, goal: checked,
        message: completionReturnMessage(checked),
        remediation: say("Сверь работу с договорённостью. Если чего-то не хватает, продолжай работу; иначе снова вызови update_goal(complete), не меняя договорённость и план.", "Check the work against the agreement. If something is missing, keep working; otherwise call update_goal(complete) again without changing the agreement or the plan.") };
    }
    if (goal && goal.status !== "complete" && verification?.trim()) {
      const failure = await recordCompletionVerification(goal, verification, fingerprint, ctx);
      if (failure) return failure;
    }
    // Цель без отчётов и плана и раньше закрывалась без verifying; для неё ничего не добавляем.
    const managed = projections.isManaged();
    const verified = !managed || projections.isCompletionReady();
    if (returned) {
      const note = !managed ? ""
        : verified ? say("Проверка для этой редакции и плана записана.", "The verification for this agreement and plan is recorded.")
          : say("Во втором вызове передай verification: чем сделанное отвечает каждому пункту «Готово, когда».", "In the second call pass verification: how the work meets each \"Done when\" item.");
      return note ? { ...returned, message: `${returned.message}\n\n${note}` } : returned;
    }
    if (goal && goal.status !== "complete" && !verified) {
      return { ok: false, operation: "update_goal", applied: false, stage: "canonical", retryable: false,
        message: say("Для закрытия нужен свежий отчёт со статусом verifying для этой редакции и плана.", "Completion needs a fresh verifying progress report for this agreement and plan."), goal,
        remediation: say("Передай verification в update_goal(complete): чем сделанное отвечает каждому пункту «Готово, когда».", "Pass verification to update_goal(complete): how the work meets each \"Done when\" item.") };
    }
    if (goal?.status !== "complete") accounting.accountProgress(ctx, false, 0, true);
    let persisted: GoalResult;
    try { persisted = persistCompletion(source, ctx); }
    catch (error) {
      if (error instanceof GoalCanonicalWriteError) return canonicalFailure("update_goal", error);
      return { ok: false, operation: "update_goal", applied: null, stage: "canonical", retryable: false,
        message: say(`Не удалось сохранить завершение цели: ${error instanceof Error ? error.message : String(error)}`, `Goal completion persistence failed: ${error instanceof Error ? error.message : String(error)}`), goal: getGoal(),
        remediation: say("Неизвестно, сохранилась ли запись. Перед повтором перезагрузи сессию и сверь сохранённую ветку; статус complete в памяти не доказывает сохранения.", "Canonical write acknowledgement is unknown. Reload the session to reconcile the persisted branch before retrying; an in-memory complete status is not proof of persistence.") };
    }
    if (!persisted.ok || !persisted.goal) return { ...persisted, operation: "update_goal", applied: false, stage: "canonical", retryable: false };
    try {
      const projection = await projections.completeGoal(persisted.goal, goalContext(ctx), `complete:${persisted.goal.updatedAt}`);
      if (projection.state.currentProjectionSeq !== projection.state.stateSeq) {
        return { ok: false, operation: "update_goal", applied: true, stage: "projection", retryable: true, goal: persisted.goal,
          message: say("Завершение цели сохранено, но её документ ещё нужно обновить.", "Goal completion was saved, but its document still needs an update."),
          remediation: say("Прочитай get_goal и повтори update_goal, не отменяя завершения.", "Read get_goal and retry update_goal without undoing completion.") };
      }
    } catch (error) {
      if (error instanceof GoalCanonicalWriteError) return canonicalFailure("update_goal", error, true);
      return { ok: false, operation: "update_goal", applied: true, stage: "projection", retryable: true,
        message: say(`Не удалось обновить документ завершённой цели: ${error instanceof Error ? error.message : String(error)}`, `Goal completion projection failed: ${error instanceof Error ? error.message : String(error)}`), goal: persisted.goal,
        remediation: say("Завершение уже сохранено. Исправь документ и повтори update_goal; не создавай заново, не меняй и не возобновляй эту завершённую цель.", "Completion is already saved. Repair the document and retry update_goal; do not recreate, amend or resume this completed goal.") };
    }
    return { ...persisted, operation: "update_goal", applied: true, stage: "complete", retryable: false };
  };

  /** Идентификатор отчёта: повтор той же доставки даёт тот же id, разные отчёты — разные. */
  const reportIdFor = (goalId: string, action: GoalReportAction, toolCallId: string | undefined, report: GoalProgressReport): string => {
    const hash = createHash("sha256").update(JSON.stringify({ goalId, action, toolCallId: toolCallId ?? null, report })).digest("hex").slice(0, 32);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
  };

  const reportGoal = async (action: GoalReportAction, report: GoalProgressReport | null, ctx: ExtensionContext, toolCallId?: string):
  Promise<{ reportId: string | null; state: GoalReportState; projection?: unknown }> => {
    accounting.accountProgress(ctx, false, 0, true);
    const goal = getGoal();
    const publicationInputGeneration = userInputGeneration;
    const state = reports.getState();
    // Ответ владельца на удержание при исчерпанном бюджете снимается отчётом `working`.
    const releasesBudgetHold = goal?.status === "budgetLimited" && action === "publish" && report?.status === "working" &&
      state.awaitingUser && (state.hasUserDecisionSinceAwaiting || state.hasUserReplySinceAwaiting === true);
    if (!goal || (goal.status !== "active" && !releasesBudgetHold)) {
      throw new Error(JSON.stringify({
        code: "goal_not_active", lifecycle: goal?.status ?? null, pause: goal?.pause ?? null,
        message: say("Отчёт о ходе требует активной цели; исключение — отчёт working после ответа на awaiting_user.", "Progress reports require an active goal, except the working release after an answered awaiting_user hold."),
        nextStep: goal?.status === "paused" ? say("Используй resume_goal после явного указания пользователя; не меняй контракт только ради возобновления. Посмотри в get_goal, нет ли исправлений или удержаний.", "Use resume_goal after an explicit user instruction; do not amend the contract just to resume. Inspect get_goal for repair or hold gates.") : say("Посмотри get_goal: завершённые цели и цели с исчерпанным бюджетом не возобновляются.", "Inspect get_goal; terminal goals and exhausted budgets cannot be resumed."),
      }));
    }
    if (action === "suppress") {
      reports.suppress(goal, currentTurnIndex);
      return { reportId: null, state: reports.getState() };
    }
    if (!report) throw new Error("publish requires a report.");
    const reportId = reportIdFor(goal.goalId, action, toolCallId, report);
    const anchor = { turnIndex: currentTurnIndex, activeSeconds: goal.usage.activeSeconds, tokensUsed: goal.usage.tokensUsed, assistantTurns: state.assistantTurns };
    let acknowledged = false;
    try {
      const projection = await projections.publish(goal, report, reportId, goalContext(ctx), anchor);
      acknowledged = projection.state.progressEvents.some((entry) => entry.reportId === reportId);
      if (projection.eventApplied === false) return { reportId: null, state: reports.getState(), projection };
      if (holdsContinuation(report.status)) awaitingInputGeneration = publicationInputGeneration;
      const entry = reports.publish(goal, report, currentTurnIndex, [], reportId, { canonical: true, createdAt: projection.state.progressEvents.at(-1)!.createdAt });
      if (reports.isContinuationHeld()) hooks.clearContinuation();
      return { reportId: entry.reportId, state: reports.getState(), projection };
    } catch (error) {
      if (error instanceof GoalCanonicalWriteError) throw new Error(JSON.stringify({ ...error.details, operation: "report_goal_progress" }));
      const sameGoal = getGoal()?.goalId === goal.goalId;
      const saved = acknowledged || Boolean(sameGoal && projections.current()?.progressEvents.some((entry) => entry.reportId === reportId));
      if (saved && sameGoal) {
        // Хронология берётся из журнала: повторная публикация приняла бы новый ответ владельца за разрешение старого отчёта.
        reports.reload(goalContext(ctx).sessionManager.getBranch(), goal.goalId);
        if (reports.getState().lastReportId === reportId && holdsContinuation(report.status)) awaitingInputGeneration = publicationInputGeneration;
        if (reports.isContinuationHeld()) hooks.clearContinuation();
      }
      throw new Error(JSON.stringify({
        operation: "report_goal_progress", goalId: goal.goalId,
        applied: saved ? true : null,
        reportId: saved ? reportId : null, stage: saved ? "projection" : "canonical",
        retryable: saved && sameGoal,
        message: error instanceof Error ? error.message : String(error),
        remediation: saved
          ? say("Перед исправлением прочитай get_goal и сверь goalId. Не публикуй этот сохранённый отчёт повторно. Документ пересоберёт такой же сверенный update_goal_work или record_goal_note action=repair для существующей записи; иначе его исправит следующая разрешённая запись цели.", "Read get_goal and verify goalId before repair. Do not republish this saved report. An identical reconciled update_goal_work or record_goal_note action=repair for an existing note can rebuild the document; otherwise the next authorized Goal write repairs it.")
          : say("Неизвестно, сохранилась ли запись. Перед сверкой этого отчёта заново открой сохранённый файл сессии и выбранную ветку. Память SDK и перезагрузка расширения не доказывают сохранения; не публикуй повторно, пока не подтверждено, что отчёта нет.", "Write acknowledgement is unknown. Reopen the saved session file and selected branch before reconciling this report. SDK memory and extension reload are not persistence proof; do not republish until its absence is confirmed."),
      }));
    }
  };

  const getGoalWorkingState = (ctx: ExtensionContext): GoalWorkingState => {
    const goal = goalForDisplay();
    const current = projections.current();
    const projection = goal && current?.goalId === goal.goalId ? current : null;
    const view = goalContext(ctx);
    const refs = goal && projection ? artifacts.managedRefs(goal, view, view.sessionManager.getBranch()) : [];
    return goalWorkingState(goal, projection, reports.getState(), refs);
  };

  const announceAgreement = (goal: ThreadGoal, ctx: ExtensionContext): void => {
    if (goal.status === "complete") return;
    appendAgreementEntry(pi, goalContext(ctx).sessionManager.getBranch(), goal);
  };

  /** Ставит новую цель или новый снимок той же цели; документ строится заново при смене цели. */
  const setGoal = (nextGoal: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): void => {
    const previous = getGoal();
    const sameGoalChanged = previous !== null && previous.goalId === nextGoal.goalId && JSON.stringify(previous) !== JSON.stringify(nextGoal);
    hooks.cancelProviderLimitAutoResume();
    applyTransition({ kind: "set", nextGoal, source }, ctx, { refreshUi: previous?.goalId === nextGoal.goalId });
    // Снимок документа прежней цели не должен разрешить закрытие новой.
    if (previous?.goalId !== nextGoal.goalId) {
      ownerReplySeqAtGoalChange = ownerReplySeq;
      const branch = goalContext(ctx).sessionManager.getBranch();
      projections.reload(branch, nextGoal);
      reports.reload(branch, getGoal()?.goalId ?? null);
      status.refreshUi(ctx);
    }
    if (!sameGoalChanged) watchBootstrap(nextGoal.goalId, initializeDocument(nextGoal, ctx), "bootstrap");
    announceAgreement(nextGoal, ctx);
  };

  const clearGoal = (source: GoalEntrySource, ctx: ExtensionContext): void => {
    userInstructionGoalId = null;
    hooks.invalidateExternalRetry();
    hooks.cancelProviderLimitAutoResume();
    applyTransition({ kind: "clear", source }, ctx);
    const branch = goalContext(ctx).sessionManager.getBranch();
    projections.reload(branch, null);
    reports.reload(branch, null);
  };

  /** Пишет изменённую цель и ждёт обновления документа, которое запускает сам переход. */
  const saveGoalChange = async (next: ThreadGoal, source: GoalEntrySource, ctx: ExtensionContext): Promise<void> => {
    applyTransition({ kind: "set", nextGoal: next, source }, ctx);
    // Сбой документа здесь не отменяет сохранённую цель: его покажет следующее действие, которое ждёт документ.
    await bootstrap.catch(() => undefined);
  };

  /** Агент добавляет пункт «Решаю сам» в любой момент; подтвердить его за владельца нельзя (Т4.5). */
  const addSelfDecided = async (kind: SelfDecidedKind, text: string, ctx: ExtensionContext): Promise<{ ok: boolean; message: string; itemId?: string }> => {
    const goal = getGoal();
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) return { ok: false, message: say("Пункты «Решаю сам» требуют активной цели или цели на паузе.", "Self-decided items need an active or paused goal.") };
    const error = validateSelfDecidedText(text);
    if (error) return { ok: false, message: error };
    const id = selfDecidedItemId(goal.goalId, kind, text);
    if (goal.selfDecided?.some((item) => item.id === id)) return { ok: true, message: say("Этот пункт «Решаю сам» уже записан.", "Self-decided item already recorded."), itemId: id };
    if ((goal.selfDecided?.length ?? 0) >= MAX_SELF_DECIDED_ITEMS) return { ok: false, message: say(`В списке «Решаю сам» уже ${MAX_SELF_DECIDED_ITEMS} пунктов.`, `The Self-decided list already has ${MAX_SELF_DECIDED_ITEMS} items.`) };
    const next = cloneGoal(goal);
    next.selfDecided = [...(goal.selfDecided ?? []), { id, kind, text: text.trim(), state: "unconfirmed", createdAt: Date.now() }];
    next.updatedAt = nonDecreasingUpdatedAt(goal);
    await saveGoalChange(next, "tool", ctx);
    return { ok: true, message: say("Пункт «Решаю сам» записан.", "Self-decided item recorded."), itemId: id };
  };

  /**
   * Состояние пункта меняет только ход, открытый настоящей репликой владельца (Т4.4).
   * Ссылку на реплику ставит расширение по ветке журнала, а не модель.
   */
  const setSelfDecidedState = async (itemId: string, state: "confirmed" | "rejected", ctx: ExtensionContext): Promise<{ ok: boolean; message: string }> => {
    const goal = getGoal();
    const item = goal?.selfDecided?.find((candidate) => candidate.id === itemId);
    if (!goal || !item) return { ok: false, message: say(`Нет пункта «Решаю сам» ${itemId}; список — в get_goal.`, `Unknown Self-decided item ${itemId}; read get_goal for the list.`) };
    if (features().selfDecidedList && !ownerTurnOpen) return { ok: false, message: say("Подтверждает или отклоняет пункт «Решаю сам» только владелец, а этот ход начат не его ответом. Спроси владельца.", "Only the owner confirms or rejects a Self-decided item: this turn was not started by a real owner reply. Ask the owner.") };
    if (item.state === state) return { ok: true, message: say("У пункта «Решаю сам» уже такое состояние.", "Self-decided item already has this state.") };
    const ownerEntryId = latestOwnerEntryId(goalContext(ctx).sessionManager.getBranch());
    const next = cloneGoal(goal);
    next.selfDecided = (goal.selfDecided ?? []).map((candidate) => candidate.id !== itemId ? { ...candidate }
      : { ...candidate, state, ...(ownerEntryId ? { ownerEntryId } : {}) });
    next.updatedAt = nonDecreasingUpdatedAt(goal);
    await saveGoalChange(next, "tool", ctx);
    return { ok: true, message: state === "confirmed" ? say("Пункт «Решаю сам» подтверждён владельцем.", "Self-decided item confirmed.") : say("Пункт «Решаю сам» отклонён владельцем.", "Self-decided item rejected.") };
  };

  const requireGoal = (): ThreadGoal => {
    const goal = getGoal();
    if (!goal) throw new Error(say("Активной цели нет.", "No active goal exists."));
    return goal;
  };

  /** Слэш-шаблон промпта или навыка — не реплика владельца о цели. */
  const isSlashWorkflow = (text: string): boolean => {
    if (!text.startsWith("/")) return false;
    const commands = pi.getCommands();
    const prompt = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    if (prompt && commands.some((command) => command.name === prompt[1] && command.source === "prompt")) return true;
    const skill = /^\/([^ ]+)(?: ([\s\S]*))?$/.exec(text);
    return skill !== null && commands.some((command) => command.name === skill[1] && command.source === "skill");
  };

  /**
   * Ввод владельца: запоминает разрешение на возобновление этой цели и квитанцию ответа.
   * Ответ из Recall засчитывается, только если совпал текст и цель всё ещё ждёт ответа.
   */
  const noteInput = (text: string, fromExtension: boolean): void => {
    const goal = getGoal();
    const instructionFor = (current: ThreadGoal | null): string | null => !isSlashWorkflow(text) && !text.startsWith("/") ? current?.goalId ?? null : null;
    if (!fromExtension) {
      hooks.invalidateExternalRetry();
      userInputGeneration++;
      userInstructionGoalId = instructionFor(goal);
      if (!text.startsWith("/") || isSlashWorkflow(text)) noteOwnerReply();
      if (!isSlashWorkflow(text)) reports.noteOrdinaryUserInput(goal);
      return;
    }
    const pending = remoteInput;
    if (!pending) return;
    remoteInput = null;
    if (goal?.goalId === pending.goalId && reports.getState().awaitingUser && reports.getState().lastReportId === pending.reportId && text === pending.text) {
      hooks.invalidateExternalRetry();
      userInputGeneration++;
      userInstructionGoalId = instructionFor(goal);
      noteOwnerReply();
      if (userInstructionGoalId) reports.noteOrdinaryUserInput(goal);
    }
  };

  pi.events.on("pi-recall:goal-reply", (raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const input = raw as { goalId?: unknown; text?: unknown; commandId?: unknown; cancel?: unknown };
    if (input.cancel === true) {
      if (remoteInput?.commandId === input.commandId) remoteInput = null;
      return;
    }
    const goal = getGoal();
    const state = reports.getState();
    if (!goal || goal.goalId !== input.goalId || !state.awaitingUser || typeof input.text !== "string" || !input.text || typeof input.commandId !== "string" || !input.commandId) return;
    remoteInput = { goalId: goal.goalId, reportId: state.lastReportId, text: input.text, commandId: input.commandId };
  });

  return {
    bindRunHooks(next: GoalRunHooks): void { hooks = next; },
    recovery,
    reports,
    accounting,
    accountingState,
    status,
    getGoal,
    goalForDisplay,
    getActivity: () => activity,
    setTurnIndex(turnIndex: number | null): void { currentTurnIndex = turnIndex; },
    getTurnIndex: () => currentTurnIndex,
    noteAgentRun(): void { agentRunSequence += 1; },
    getAgentRunSequence: () => agentRunSequence,
    waitForGoalProjection: () => bootstrap,
    reloadFromSession,
    applyTransition,
    flush: (source: GoalEntrySource) => persistence.flushGoalPersistence(source),
    maybeFlushRuntime: (source: GoalEntrySource) => persistence.maybeFlushRuntimePersistence(source),
    pauseForAbort(ctx: ExtensionContext): void {
      if (hooks.ownsAbortHandling?.()) return;
      // Свой отказ устаревшему билету — не обрыв владельцем (решение 0002).
      if (getGoal()?.status === "active" && !hooks.ownAbort()) applyTransition({ kind: "abort_pause" }, ctx);
    },
    /** Техническая пауза: восстановление после ошибки исчерпано или повтор PiRetry не удался. */
    pauseForRecovery(ctx: ExtensionContext, recoveryReason: string): void {
      if (getGoal()?.status === "active") applyTransition({ kind: "recovery_pause", recoveryReason }, ctx);
    },
    /** Esc во время ожидания повтора PiRetry: техническая пауза становится ручной. */
    pauseManually(ctx: ExtensionContext): void {
      const goal = getGoal();
      if (goal?.status !== "paused" || goal.pause?.kind !== "recovery") {
        if (goal?.status === "active" && !hooks.ownAbort()) applyTransition({ kind: "abort_pause" }, ctx);
        return;
      }
      const nextGoal = cloneGoal(goal);
      nextGoal.pause = { kind: "manual", reason: "Assistant execution was interrupted by user." };
      nextGoal.updatedAt = nonDecreasingUpdatedAt(goal);
      applyTransition({ kind: "set", nextGoal, source: "runtime" }, ctx);
    },
    /** При закрытии сессии с незавершённым восстановлением цель уходит на техническую паузу. */
    pauseForShutdown(ctx: ExtensionContext, recoveryReason: string): void {
      if (getGoal()?.status === "active") applyTransition({ kind: "recovery_shutdown_pause", recoveryReason }, ctx);
    },
    /**
     * Ход упёрся в окно контекста: Pi сожмёт и повторит сам. Пока он это делает, продолжение цели
     * не нужно. Новый старт цели после переполнения требует обычной реплики владельца — отметка
     * об этом пишется в журнал, чтобы пережить перезагрузку.
     */
    beginOverflowRecovery(ctx: ExtensionContext): void {
      const active = getGoal()?.status === "active";
      const persist = active ? beginHostOverflowRecovery(recovery).persistHostOverflowCapReset : requireHostOverflowUserReset(recovery);
      if (active) status.refreshUi(ctx);
      if (persist) pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(true));
    },
    /**
     * Обычная реплика пользователя снимает предел восстановления Pi после переполнения окна.
     * Снятие пишется в журнал, иначе отметка вернётся после перезагрузки.
     */
    clearHostOverflowUserReset(): void {
      if (applyHostOverflowUserResetPersistence(recovery, false)) pi.appendEntry(CUSTOM_ENTRY_TYPE, hostOverflowCapResetEntry(false));
    },
    resetRecovery(): void { resetRecoveryMachine(recovery); },
    hasUnconfirmedWrite: () => unconfirmedWrite() !== null,
    markRun(foreign: boolean): void { foreignRun = foreign; },
    runIsForeign: () => foreignRun,
    /** Данные цели для текста продолжения: план, следующий шаг, удержания. */
    continuationSnapshot() {
      const goal = getGoal();
      const current = projections.current();
      const projection = goal && current?.goalId === goal.goalId ? current : null;
      const reportState = reports.getState();
      if (!projection && !reportState.lastReport) return undefined;
      const working = goalWorkingState(goal, projection, reportState);
      return {
        stateSeq: projection?.stateSeq ?? 0, currentProjectionSeq: projection?.currentProjectionSeq ?? 0,
        status: working.progressStatus ?? undefined, currentStep: working.currentStep ?? undefined, nextStep: working.nextStep ?? undefined,
        verification: working.latestUsefulVerification ?? undefined, blockers: working.blocker ?? undefined, needUser: working.needUser ?? undefined,
        workState: working.workState, workRevision: working.workRevision, workStateStale: working.workStateStale, activeDecisions: working.activeDecisions,
        openPaperCuts: projection?.paperCuts.filter((item) => item.status === "open").length ?? 0,
        awaitingUser: reportState.awaitingUser,
        continuationHeld: reports.isContinuationHeld() || hooks.isLimitHeld(), userAnswerReceived: reportState.hasUserDecisionSinceAwaiting,
        // Пока договорённость стоит в окне, продолжение не повторяет её результат и критерий.
        agreementOwnsContract: features().singleFactOwner && features().agreementInWindow,
      };
    },
    resumePausedGoal,
    resumeGateFailure,
    canRecover,
    isContinuationHeld: () => reports.isContinuationHeld(),
    noteInput,
    isSlashWorkflow,
    /** Владелец остановил работу или сменил контекст: прежнее слово о возобновлении больше не действует. */
    invalidateResumeInstructions(): void {
      userInputGeneration++;
      userInstructionGoalId = null;
      hooks.invalidateExternalRetry();
    },
    /** Конец прогона: слово владельца относилось только к этому ходу. */
    endUserTurn(): void { userInstructionGoalId = null; ownerTurnOpen = false; },
    /** Ответ владельца на `ask_user` внутри прогона — тоже настоящая реплика. */
    noteOwnerAnswer: noteOwnerReply,
    getFeatures: features,
    addSelfDecided,
    setSelfDecidedState,
    getGoalResumeEpoch: () => userInputGeneration,
    getGoalResumeFailure: () => resumeGateFailure(false, true),
    cancelProviderLimitAutoResume(ctx: ExtensionContext): void {
      hooks.cancelProviderLimitAutoResume();
      status.refreshUi(ctx);
    },
    getGoalWorkingState,
    getGoalHistory(query: GoalHistoryQuery, ctx: ExtensionContext): GoalHistoryPage {
      const goal = goalForDisplay();
      if (!goal) throw new Error(say("Активной цели нет.", "No active goal exists."));
      return readGoalHistory(goalContext(ctx).sessionManager.getBranch(), goal.goalId, query);
    },
    async updateGoalWork(goalId: string, workState: GoalWorkState, expectedRevision: number, ctx: ExtensionContext, callId: string): Promise<GoalWorkUpdateResult> {
      try { await bootstrap; }
      catch (error) {
        const goal = getGoal();
        if (!goal || goal.goalId !== goalId) throw error;
        bootstrap = initializeDocument(goal, ctx);
        await bootstrap;
      }
      return projections.updateWork(goalId, workState, expectedRevision, goalContext(ctx), callId);
    },
    showGoalSnapshot(ctx: ExtensionContext, mode: "status" | "details"): void {
      appendGoalSnapshot(pi, ctx as ExtensionCommandContext, getGoalWorkingState(ctx), mode, activity?.kind === "provider-retry" ? activity.label : undefined);
    },
    setGoal,
    clearGoal,
    amendGoal,
    completeGoal,
    resumeGoal,
    reportGoal,
    getReportState: reports.getState,
    async recordGoalDecision(input: { title: string; decision: string; rationale: string; consequence?: string }, ctx: ExtensionContext, callId: string): Promise<unknown> {
      const goal = requireGoal();
      if (!projections.isManaged()) await projections.initialize(goal, goalContext(ctx));
      return projections.recordDecision(goal, { ...input, createdAt: Date.now() }, goalContext(ctx), callId);
    },
    async recordGoalPaperCut(input: { title: string; impact: string; severity: "low" | "medium" | "high"; revisit?: string }, ctx: ExtensionContext, callId: string): Promise<unknown> {
      const goal = requireGoal();
      if (!projections.isManaged()) await projections.initialize(goal, goalContext(ctx));
      return projections.recordPaperCut(goal, { ...input, createdAt: Date.now() }, goalContext(ctx), callId);
    },
    async updateGoalPaperCut(input: GoalPaperCutUpdate, ctx: ExtensionContext, callId: string): Promise<unknown> {
      return projections.updatePaperCut(requireGoal(), input, goalContext(ctx), callId);
    },
    async repairGoalNote(kind: "decision" | "paper_cut", id: string, ctx: ExtensionContext): Promise<unknown> {
      return projections.repairNote(requireGoal(), kind, id, goalContext(ctx));
    },
    projections,
  };
}

export type GoalSession = ReturnType<typeof createGoalSession>;
