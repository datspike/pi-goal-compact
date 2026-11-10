import type { CustomMessageEntryDraft, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CoreEffect, GoalGate } from "../core/model.js";
import { createExternalRetryRecovery } from "../goal/external-retry-recovery.js";
import { compactContinuationPrompt, continuationGoalIdFromPrompt } from "../goal/prompts.js";
import { createProviderLimitAutoResumeScheduler } from "../goal/provider-limit-auto-resume.js";
import { recoveryPhaseBlocksContinuation, setRecoveryPendingAttention } from "../goal/recovery-machine.js";
import { createGoalRecoveryRuntime } from "../goal/recovery-runtime.js";
import {
  isAssistantContextOverflow,
  isContextOverflowError,
  isErrorAssistantMessage,
  isProviderLimitError,
  isRecoveryPendingAttention,
  isSuccessfulAssistantTurn,
  type AssistantErrorMessage,
} from "../goal/recovery.js";
import { createSubagentWatch } from "../goal/subagent-watch.js";
import { CUSTOM_ENTRY_TYPE, type ThreadGoal } from "../goal/types.js";
import type { CoreDriver } from "./driver.js";
import type { GoalRunHooks, GoalSession } from "./goal-session.js";
import type { Tickets } from "./tickets.js";

/** Скрытые сообщения PiRetry: допускаются только как повтор этой сессии и цели (Ц37). */
const RETRY_CARRIERS = new Set(["pi-retry:retry", "pi-retry:continue"]);

/** Почему цель сейчас не работает без владельца; `subagents` — ждёт фоновых сабагентов. */
type HoldReason = GoalGate | "subagents";

const asGate = (reason: HoldReason): GoalGate => reason === "subagents" ? "held" : reason;

/**
 * Продолжение цели без владельца (решение 0002, строки реестра Ц22–Ц37).
 *
 * Обычное продолжение — ответ на границе `agent_before_settle`: запись продолжения и `continue: true`.
 * Из простоя работа начинается только билетом: сабагент закончил, автовозобновление после лимита
 * провайдера, удачный повтор PiRetry, запуск сессии, смена ветки, сжатие. Решает, продолжать ли,
 * ядро; здесь — разрешение цели, тексты и связь с Pi.
 */
export function registerGoalContinuation(pi: ExtensionAPI, session: GoalSession, driver: CoreDriver, tickets: Tickets) {
  // Контекст для будильников из таймеров и событий шины: у них своего контекста нет.
  let wakeContext: ExtensionContext | null = null;
  // Скрытые продолжения подряд без реплики владельца (Ц27).
  let hidden: { goalId: string; count: number } | null = null;
  let limitNoticeFor: string | null = null;
  let agentEndHandled = false;

  const isLimitHeld = (): boolean => {
    const goal = session.getGoal();
    const limit = session.reports.getState().policy.maxHiddenContinuations ?? 0;
    return Boolean(goal && limit > 0 && hidden?.goalId === goal.goalId && hidden.count >= limit);
  };

  const subagents = createSubagentWatch({ onRelease: () => { if (wakeContext) wake(wakeContext); } });

  /**
   * explicit — возобновление по решению владельца или по таймеру лимита: оно ждёт только
   * известных работающих сабагентов, а не ответа на запрос статуса.
   */
  const holdReason = (explicit = false): HoldReason => {
    const goal = session.getGoal();
    if (!goal || goal.status === "complete") return "absent";
    if (goal.status !== "active") return "held";
    if (session.hasUnconfirmedWrite() || session.isContinuationHeld() || externalRetry.active() || isLimitHeld() ||
      isRecoveryPendingAttention(session.recovery.attention) || recoveryPhaseBlocksContinuation(session.recovery.phase)) return "held";
    return (explicit ? subagents.hasActiveRuns() : subagents.mustHold()) ? "subagents" : "runs";
  };

  const noticeIfLimitHeld = (): void => {
    const goal = session.getGoal();
    if (goal?.status !== "active" || !isLimitHeld() || session.isContinuationHeld() || limitNoticeFor === goal.goalId) return;
    limitNoticeFor = goal.goalId;
    const count = hidden?.count ?? 0;
    pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: `Скрытые продолжения цели остановлены: ${count} подряд без сообщения пользователя. Цель ждёт ответа пользователя: продолжить, сузить задачу или остановиться.`,
        display: true,
        details: { kind: "continuation_limit", goalId: goal.goalId, count },
      },
      { triggerTurn: false },
    );
  };

  const countHidden = (goal: ThreadGoal): void => {
    if (hidden?.goalId !== goal.goalId) hidden = { goalId: goal.goalId, count: 0 };
    hidden.count++;
  };

  const continuationText = (goal: ThreadGoal): string => compactContinuationPrompt(goal, session.continuationSnapshot());

  /** Повод начать работу из простоя. Во время прогона и при сообщениях в очереди решит граница перед простоем. */
  const wake = (ctx: ExtensionContext): void => {
    wakeContext = ctx;
    noticeIfLimitHeld();
    const reason = holdReason();
    if (reason === "subagents") {
      subagents.hold();
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    driver.dispatch({ type: "wake", gate: reason }, ctx);
  };

  /** Будит после текущего события: Pi ещё держит блокировку сжатия или переключения. */
  const wakeLater = (ctx: ExtensionContext): void => {
    const timer = setTimeout(() => wake(ctx), 0);
    timer.unref?.();
  };

  /**
   * Возобновление с продолжением: согласие владельца при открытии сессии или таймер лимита
   * провайдера. Продолжение уходит обычной репликой, как в прежнем расширении: она видна
   * владельцу и снимает предел восстановления Pi после переполнения окна. Пока работает
   * сабагент, цель ждёт его и продолжится билетом.
   */
  const resumeWithContinuation = (ctx: ExtensionContext): string | null => {
    const blocked = session.resumeGateFailure();
    if (blocked) return blocked.message;
    providerLimit.clear();
    session.resumePausedGoal(ctx);
    const goal = session.getGoal();
    if (goal?.status !== "active") return null;
    wakeContext = ctx;
    if (subagents.hasActiveRuns()) subagents.hold();
    else pi.sendUserMessage(continuationText(goal), { deliverAs: "followUp" });
    return null;
  };

  const providerLimit = createProviderLimitAutoResumeScheduler({
    onTimer(goalId) {
      const ctx = wakeContext;
      if (session.isContinuationHeld() || !ctx || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
      if (session.getGoal()?.goalId === goalId) resumeWithContinuation(ctx);
      return true;
    },
  });

  const externalRetry = createExternalRetryRecovery({
    getGoal: session.getGoal,
    isAvailable: () => pi.getCommands().some((command) => command.name === "retry"),
    now: () => Date.now(),
    canRecover: () => session.canRecover(),
    clearContinuation: () => subagents.cancelWait(),
    resume: (ctx) => session.resumePausedGoal(ctx),
    pauseManual: (ctx) => session.pauseManually(ctx),
    pause: (ctx, reason) => session.pauseForRecovery(ctx, reason),
    pending: (ctx, reason) => {
      subagents.cancelWait();
      setRecoveryPendingAttention(session.recovery, reason);
      session.status.refreshUi(ctx);
    },
    settled: (ctx) => {
      session.resetRecovery();
      session.status.refreshUi(ctx);
      wakeLater(ctx);
    },
  });

  const recoveryRuntime = createGoalRecoveryRuntime<ExtensionContext>({
    getGoal: session.getGoal,
    getRecoveryState: () => session.recovery,
    externalRetryError: (ctx, message) => {
      if (isProviderLimitError(message.errorMessage)) { externalRetry.invalidate(); return false; }
      return externalRetry.error(ctx, message.errorMessage ?? "unknown provider error");
    },
    clearContinuationState: () => subagents.cancelWait(),
    pauseGoalForRecovery: (ctx, reason) => session.pauseForRecovery(ctx, reason),
    refreshUi: (ctx) => session.status.refreshUi(ctx),
    // Удачный ход продолжается на границе перед простоем, а не отсюда.
    maybeContinue: () => {},
    scheduleProviderLimitAutoResume(goalId, ctx) {
      wakeContext = ctx;
      providerLimit.schedule(goalId);
      session.status.refreshUi(ctx);
    },
  });

  /** Переполнение окна: Pi сожмёт и повторит сам, цель ждёт его итога. */
  const recordOverflow = (message: AssistantErrorMessage, ctx: ExtensionContext): boolean => {
    if (!isAssistantContextOverflow(message, ctx.model?.contextWindow ?? 0)) return false;
    session.beginOverflowRecovery(ctx);
    if (isErrorAssistantMessage(message)) recoveryRuntime.handlePersistentAssistantError(message, ctx);
    else recoveryRuntime.handleSilentContextOverflow(ctx);
    return true;
  };

  const rebind = (ctx: ExtensionContext): void => {
    wakeContext = ctx;
    agentEndHandled = false;
    providerLimit.clear();
    externalRetry.detach();
    subagents.clear();
    subagents.watch(pi.events, ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(), pi.getAllTools().some((tool) => tool.name === "subagent"));
    externalRetry.bind(ctx);
  };

  pi.on("session_start", async (event, ctx) => {
    rebind(ctx);
    const goal = session.getGoal();
    // При возобновлении сессии приостановленная цель сама не оживает: владелец решает в диалоге (Ц35).
    if (event.reason === "resume" && goal?.status === "paused" && ctx.hasUI) {
      if (!(await ctx.ui.confirm("Resume paused goal?", `Goal: ${goal.objective}`))) return;
      try { await session.waitForGoalProjection(); }
      catch { ctx.ui.notify("Goal projection synchronization failed; inspect get_goal before resuming.", "warning"); return; }
      const failure = resumeWithContinuation(ctx);
      if (failure) ctx.ui.notify(failure, "warning");
      return;
    }
    wake(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    rebind(ctx);
    wake(ctx);
  });
  pi.on("session_shutdown", () => {
    providerLimit.clear();
    subagents.clear();
    externalRetry.detach();
  });

  pi.on("input", (event, ctx) => {
    externalRetry.observe(ctx);
    if (event.source === "extension") {
      // Реплика-продолжение от расширения проходит, только если её цель всё ещё активна и не ждёт владельца.
      const continuationGoalId = continuationGoalIdFromPrompt(event.text);
      if (continuationGoalId === null) return undefined;
      const goal = session.getGoal();
      if (!session.isContinuationHeld() && goal?.status === "active" && goal.goalId === continuationGoalId) return { action: "continue" as const };
      session.status.refreshUi(ctx);
      return { action: "handled" as const };
    }
    providerLimit.clear();
    // Реплика владельца снимает предел скрытых продолжений и начинает счёт заново.
    hidden = null;
    limitNoticeFor = null;
    return undefined;
  });

  pi.on("agent_start", () => { agentEndHandled = false; });
  pi.on("turn_start", (_event, ctx) => {
    // Каждый ход заканчивается своим agent_end; повтор отбрасывается только внутри хода.
    agentEndHandled = false;
    if (!session.runIsForeign()) externalRetry.observe(ctx);
  });
  pi.on("message_start", (event, ctx) => {
    if (session.runIsForeign()) return;
    const message = event.message;
    if (message.role !== "custom" || !RETRY_CARRIERS.has(message.customType) || !externalRetry.ownsContext(ctx)) return;
    if (session.getGoal() && !externalRetry.admit(ctx, message.timestamp)) ctx.abort();
  });
  pi.on("turn_end", (event, ctx) => {
    if (session.runIsForeign()) return;
    const message = event.message as AssistantErrorMessage;
    externalRetry.result(ctx, message as Parameters<typeof externalRetry.result>[1]);
    // Удачный ход закрывает восстановление; продолжит его граница перед простоем.
    if (isSuccessfulAssistantTurn(message) && !isAssistantContextOverflow(message, ctx.model?.contextWindow ?? 0)) {
      recoveryRuntime.finishSuccessfulAssistantTurn(message, ctx, { continueGoal: false });
    }
  });

  // Итог прогона для восстановления: ошибка, переполнение окна или удачный ход.
  pi.on("agent_end", (event, ctx) => {
    if (session.runIsForeign() || agentEndHandled) return;
    agentEndHandled = true;
    externalRetry.observe(ctx);
    const messages = event.messages as AssistantErrorMessage[];
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) externalRetry.result(ctx, lastAssistant as Parameters<typeof externalRetry.result>[1]);
    if (!messages.some((message) => message.role === "assistant" && message.stopReason === "aborted")) {
      const lastError = messages.filter(isErrorAssistantMessage).at(-1);
      if (lastError) {
        recordOverflow(lastError, ctx);
        if (!isContextOverflowError(lastError.errorMessage)) recoveryRuntime.handlePersistentAssistantError(lastError, ctx);
      } else if (!lastAssistant || !recordOverflow(lastAssistant, ctx)) {
        session.resetRecovery();
      }
    }
    externalRetry.finish(ctx, lastAssistant as Parameters<typeof externalRetry.finish>[1]);
  });

  pi.on("agent_before_settle", (event, ctx) => {
    wakeContext = ctx;
    if (session.runIsForeign()) return undefined;
    noticeIfLimitHeld();
    const reason = holdReason();
    const effects = driver.dispatch({ type: "before_settle", gate: asGate(reason), outcome: event.outcome, pendingMessages: event.context.pendingMessages.length > 0 }, ctx);
    const goal = session.getGoal();
    if (!goal || !effects.some((effect) => effect.type === "continue_goal")) {
      // Завершение сабагента разбудит цель само.
      if (reason === "subagents" && event.outcome === "completed") subagents.hold();
      return undefined;
    }
    countHidden(goal);
    const entry: CustomMessageEntryDraft = {
      type: "custom_message", customType: CUSTOM_ENTRY_TYPE, content: continuationText(goal), display: false,
      details: { kind: "continuation", goalId: goal.goalId },
    };
    return { entries: [...event.entries, entry], continue: true };
  });

  pi.on("session_compact", (event, ctx) => {
    recoveryRuntime.onSessionCompact();
    // Pi повторит прерванный запрос сам; ход после сжатия по запросу агента продолжит билет контрольной точки.
    if (!event.willRetry && !recoveryPhaseBlocksContinuation(session.recovery.phase)) wakeLater(ctx);
  });

  const hooks: GoalRunHooks = {
    externalRetryActive: () => externalRetry.active(),
    clearContinuation: () => subagents.cancelWait(),
    invalidateExternalRetry: () => externalRetry.invalidate(),
    cancelProviderLimitAutoResume: () => providerLimit.clear(),
    isProviderLimitAutoResumeScheduled: (goalId) => providerLimit.isScheduledFor(goalId),
    ownAbort: () => driver.state.selfAbort,
    isLimitHeld,
  };

  return {
    hooks,
    /** Разрешение цели для сверки билета при доставке: уже выданный билет ждёт только известных работающих сабагентов. */
    gate: (): GoalGate => asGate(holdReason(true)),
    execute(effect: CoreEffect, ctx: ExtensionContext): void {
      if (effect.type !== "send_ticket" || effect.ticket.kind !== "goal") return;
      const goal = session.getGoal();
      if (!goal) return;
      countHidden(goal);
      if (!tickets.send(effect, continuationText(goal)) && ctx.hasUI) ctx.ui.notify("Не удалось поставить продолжение цели", "error");
    },
  };
}
