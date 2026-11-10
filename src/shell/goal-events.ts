import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerGoalCommand } from "../goal/commands.js";
import { assistantTurnTokens, hasGoalProgressToolCall, isAbortedAssistantMessage, isToolUseAssistantMessage, type AssistantTurnMessage } from "../goal/goal-accounting.js";
import { filterGoalCompactionInput } from "../goal/goal-compaction.js";
import { GOAL_OBSERVABILITY_ENTRY_TYPE, renderGoalObservabilityEntry } from "../goal/goal-observability.js";
import { isGoalProjectionEvent } from "../goal/goal-projection-reducer.js";
import {
  answeredQuestionCallIds,
  createGoalProgressEntryComponent,
  formatGoalProgressReport,
  goalProgressInstruction,
  GOAL_PROGRESS_DUE_CUSTOM_TYPE,
  GOAL_PROGRESS_ENTRY_TYPE,
  GOAL_PROGRESS_INSTRUCTION_CUSTOM_TYPE,
  GOAL_PROJECTION_ENTRY_TYPE,
  isGoalReportEntry,
} from "../goal/goal-reports.js";
import { onRecoverySuccessfulTurn, onRecoveryUserInput, recoveryPhaseBlocksContinuation } from "../goal/recovery-machine.js";
import { isAssistantContextOverflow, isErrorAssistantMessage, reasonFromRecoveryPendingAttention } from "../goal/recovery.js";
import { registerGoalTools } from "../goal/tools.js";
import { CUSTOM_ENTRY_TYPE } from "../goal/types.js";
import { LEGACY_RECORD_NAMES, RECORD } from "../records.js";
import type { GoalSession } from "./goal-session.js";
import { assembleWindow, compactedOwnerReplies } from "../goal/window.js";

/** Скрытые сообщения PiRetry продолжают работу цели и не считаются чужим запуском. */
const RETRY_CARRIERS = new Set(["pi-retry:retry", "pi-retry:continue"]);

/** Запуск от чужого расширения: его не учитывают в цели и не продолжают (строка реестра Ц31). */
function isForeignRun(event: BeforeAgentStartEvent): boolean {
  if (event.messageType === "user" || "prompt" in event) return false;
  const type = event.message.customType;
  return type !== CUSTOM_ENTRY_TYPE && type !== RECORD.ticket && !RETRY_CARRIERS.has(type);
}

/** Регистрирует для каждой записи ленты рисовальщик под новым и прежним именем. */
function registerEntryRenderers(pi: ExtensionAPI): void {
  const renderers: Record<string, Parameters<ExtensionAPI["registerEntryRenderer"]>[1]> = {
    // Отчёты первой версии остаются читаемыми; новые рисуются один раз из события документа.
    [GOAL_PROGRESS_ENTRY_TYPE]: (entry, options) => {
      if (!isGoalReportEntry(entry.data)) return undefined;
      const lines = formatGoalProgressReport(entry.data, options.expanded);
      return lines ? createGoalProgressEntryComponent(lines) : undefined;
    },
    [GOAL_OBSERVABILITY_ENTRY_TYPE]: renderGoalObservabilityEntry,
    [GOAL_PROJECTION_ENTRY_TYPE]: (entry) => {
      if (!isGoalProjectionEvent(entry.data)) return undefined;
      switch (entry.data.kind) {
        case "goal_created": return createGoalProgressEntryComponent([`★ Цель создана: ${entry.data.goal.objective}`]);
        case "goal_completed": return createGoalProgressEntryComponent([`✓ Цель завершена: ${entry.data.goal.objective}`]);
        case "progress_reported": {
          const summary = entry.data.report.summary?.trim();
          return summary ? createGoalProgressEntryComponent(summary.split("\n")) : undefined;
        }
        case "decision_recorded": return createGoalProgressEntryComponent([`◆ Решение: ${entry.data.entry.title}`, entry.data.entry.decision]);
        default: return undefined;
      }
    },
  };
  for (const [type, render] of Object.entries(renderers)) pi.registerEntryRenderer(type, render);
  for (const [legacy, current] of Object.entries(LEGACY_RECORD_NAMES)) {
    const render = renderers[current];
    if (render) pi.registerEntryRenderer(legacy, render);
  }
}

/**
 * Обвязка цели: инструменты, команды, лента и события Pi, которые ведут жизнь цели —
 * восстановление из журнала, ввод владельца, учёт времени и токенов, отчёты, пауза по обрыву.
 */
export function registerGoal(pi: ExtensionAPI, session: GoalSession): void {
  registerEntryRenderers(pi);
  registerGoalTools(pi, {
    getGoal: () => session.goalForDisplay(),
    getGoalWorkingState: session.getGoalWorkingState,
    getGoalHistory: session.getGoalHistory,
    updateGoalWork: session.updateGoalWork,
    getReportState: session.getReportState,
    setGoal: session.setGoal,
    waitForGoalProjection: session.waitForGoalProjection,
    resumeGoal: session.resumeGoal,
    amendGoal: session.amendGoal,
    completeGoal: session.completeGoal,
    reportGoal: session.reportGoal,
    recordGoalDecision: session.recordGoalDecision,
    getFeatures: session.getFeatures,
    addSelfDecided: session.addSelfDecided,
    setSelfDecidedState: session.setSelfDecidedState,
    recordGoalPaperCut: session.recordGoalPaperCut,
    updateGoalPaperCut: session.updateGoalPaperCut,
    repairGoalNote: session.repairGoalNote,
    loadGoalLanguageGuide: session.loadGoalLanguageGuide,
  });
  registerGoalCommand(pi, {
    getGoal: () => session.goalForDisplay(),
    setGoal: session.setGoal,
    waitForGoalProjection: session.waitForGoalProjection,
    clearGoal: session.clearGoal,
    showGoalSnapshot: session.showGoalSnapshot,
    getGoalResumeFailure: session.getGoalResumeFailure,
    getGoalResumeEpoch: session.getGoalResumeEpoch,
    invalidateResumeInstructions: session.invalidateResumeInstructions,
    cancelProviderLimitAutoResume: (_goalId, ctx) => session.cancelProviderLimitAutoResume(ctx),
  });

  let terminalUsageAccounted = false;
  let terminalFallbackHandled = false;
  let agentEndHandled = false;
  const activeToolCalls = new Map<string, string>();

  const refreshToolActivity = (): void => {
    const name = [...activeToolCalls.values()].at(-1);
    session.status.setActivity(name ? { label: `инструмент: ${name}` } : null);
  };
  const resetRun = (): void => {
    session.markRun(false);
    activeToolCalls.clear();
  };
  const reload = async (ctx: ExtensionContext): Promise<void> => {
    resetRun();
    session.status.setActivity(null, { refresh: false });
    await session.reloadFromSession(ctx);
    session.accountingState.activeGoalId = null;
    session.accountingState.lastAccountedAt = null;
    if (!ctx.isIdle()) session.accounting.beginAccounting();
  };

  pi.on("session_start", async (_event, ctx) => { await reload(ctx); });
  pi.on("session_tree", async (_event, ctx) => { await reload(ctx); });

  pi.on("input", async (event, ctx) => {
    // Слово владельца снимает накопленные попытки восстановления после ошибок.
    if (event.source !== "extension") {
      session.status.dismissCompletedGoal(ctx);
      onRecoveryUserInput(session.recovery);
    }
    session.noteInput(event.text, event.source === "extension");
    if (event.source !== "extension") session.status.refreshUi(ctx);
    // Одно слово «продолжи» — явное разрешение возобновить цель на паузе (Ц06).
    if (event.source !== "extension" && /^продолжи$/i.test(event.text.trim()) && session.getGoal()?.status === "paused") {
      const resumed = await session.resumeGoal(ctx);
      if (!resumed.ok && ctx.hasUI) ctx.ui.notify(resumed.message, "warning");
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    session.markRun(isForeignRun(event));
    if (session.runIsForeign()) return undefined;
    // Напоминание об отчёте уходит в ход между вызовами инструментов, а не в системный промпт:
    // изменённый префикс сбросил бы кэш провайдера для всего запроса.
    session.reports.maybeMarkDue(session.getGoal(), session.getTurnIndex());
    return undefined;
  });

  // Напоминание действует один запуск; в следующем окне оно гасится.
  // Начало окна собирается здесь же: договорённость или реплики владельца после сводки сжатия.
  pi.on("context", async (event, ctx) => {
    if (session.runIsForeign()) return undefined;
    let changed = false;
    const messages = event.messages.map((message) => {
      if (message.role !== "custom" || message.customType !== GOAL_PROGRESS_INSTRUCTION_CUSTOM_TYPE) return message;
      changed = true;
      return { ...message, content: "This expired run-scoped progress reminder must be ignored.", display: false };
    });
    const assembled = assembleWindow(messages, {
      goal: session.getGoal(),
      features: session.getFeatures(),
      ownerReplies: compactedOwnerReplies(ctx.sessionManager.getBranch()),
    });
    if (assembled) return { messages: assembled };
    return changed ? { messages } : undefined;
  });

  pi.on("agent_start", async () => {
    if (session.runIsForeign()) return;
    session.noteAgentRun();
    terminalUsageAccounted = false;
    terminalFallbackHandled = false;
    agentEndHandled = false;
  });

  pi.on("turn_start", async (event, ctx) => {
    if (session.runIsForeign()) return;
    session.setTurnIndex(event.turnIndex);
    terminalUsageAccounted = false;
    terminalFallbackHandled = false;
    agentEndHandled = false;
    activeToolCalls.clear();
    session.accounting.beginAccounting();
    session.status.setActivity({ label: "модель формирует ответ" });
    session.status.refreshUi(ctx);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    if (session.runIsForeign()) return;
    activeToolCalls.set(event.toolCallId ?? `${event.toolName}:${session.getTurnIndex() ?? "unknown"}`, event.toolName);
    refreshToolActivity();
    session.status.refreshUi(ctx);
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    if (session.runIsForeign()) return;
    activeToolCalls.delete(event.toolCallId ?? `${event.toolName}:${session.getTurnIndex() ?? "unknown"}`);
    if (activeToolCalls.size === 0) session.status.setActivity({ label: event.isError ? `ошибка инструмента: ${event.toolName}` : `завершён инструмент: ${event.toolName}` });
    else refreshToolActivity();
    session.status.refreshUi(ctx);
    session.accounting.accountProgress(ctx, !session.isContinuationHeld(), 0, true);
    session.maybeFlushRuntime("runtime");
  });

  pi.on("turn_end", async (event, ctx) => {
    if (session.runIsForeign()) return;
    activeToolCalls.clear();
    session.status.setActivity(null);
    if (terminalFallbackHandled) return;
    const message = event.message as AssistantTurnMessage;
    for (const id of answeredQuestionCallIds(event.message, event.toolResults)) {
      session.noteOwnerAnswer();
      session.reports.noteQuestionAnswer(session.getGoal(), id);
    }
    if (!isToolUseAssistantMessage(message)) session.reports.finishQuestionAnswer();
    session.accounting.accountProgress(ctx, !session.isContinuationHeld(), assistantTurnTokens(message));
    terminalUsageAccounted = true;
    session.flush("runtime");
    if (isAbortedAssistantMessage(message)) {
      session.pauseForAbort(ctx);
      return;
    }
    // Ошибку разбирает конец прогона, когда Pi закончит свои повторы.
    if (isErrorAssistantMessage(message as Parameters<typeof isErrorAssistantMessage>[0])) return;
    if (isAssistantContextOverflow(message as Parameters<typeof isAssistantContextOverflow>[0], ctx.model?.contextWindow ?? 0)) {
      session.beginOverflowRecovery(ctx);
      return;
    }
    // Удачный ход обнуляет счётчики повторов, внимание к ошибке остаётся до слова владельца.
    onRecoverySuccessfulTurn(session.recovery, event.message as Parameters<typeof onRecoverySuccessfulTurn>[1]);
    const goal = session.getGoal();
    if (goal?.status === "active" && !hasGoalProgressToolCall(message)) session.reports.completeAssistantTurn(goal, event.turnIndex);
    session.reports.maybeMarkDue(goal, event.turnIndex);
    // Напоминание подхватывается перед следующим запросом к модели. После финального ответа
    // его не шлём: оно вызвало бы лишний ход.
    if (goal && isToolUseAssistantMessage(message) && !session.isContinuationHeld() && !recoveryPhaseBlocksContinuation(session.recovery.phase)) {
      const reason = session.reports.consumeInstruction(goal);
      if (reason) {
        pi.sendMessage(
          { customType: GOAL_PROGRESS_DUE_CUSTOM_TYPE, content: goalProgressInstruction(reason), display: false, details: { kind: "progress_due", goalId: goal.goalId, reason } },
          { deliverAs: "steer" },
        );
      }
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    if (session.runIsForeign()) {
      session.endUserTurn();
      return;
    }
    activeToolCalls.clear();
    session.status.setActivity(null);
    if (agentEndHandled) return;
    agentEndHandled = true;
    session.reports.resetInstructionForNextRun();
    const messages = event.messages as AssistantTurnMessage[];
    const aborted = messages.filter(isAbortedAssistantMessage);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant && lastAssistant.stopReason !== "toolUse") session.reports.finishQuestionAnswer();
    // Ход, оборванный до turn_end, и ход под удержанием учитываются здесь, один раз.
    const held = session.isContinuationHeld();
    const fallback = !terminalUsageAccounted && ((held && lastAssistant !== undefined) || aborted.length > 0);
    const tokens = !fallback ? 0 : held && lastAssistant ? assistantTurnTokens(lastAssistant) : aborted.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
    if (!terminalFallbackHandled) {
      session.accounting.accountProgress(ctx, false, tokens, true);
      if (fallback) {
        terminalUsageAccounted = true;
        terminalFallbackHandled = true;
      }
      session.flush("runtime");
    }
    session.accountingState.activeGoalId = null;
    session.accountingState.lastAccountedAt = null;
    if (aborted.length > 0) session.pauseForAbort(ctx);
    session.endUserTurn();
  });

  pi.on("session_before_compact", async (event, ctx) => {
    filterGoalCompactionInput(event.preparation);
    session.accounting.accountProgress(ctx, false, 0, true);
    session.flush("runtime");
  });

  pi.on("session_compact", async (_event, ctx) => {
    session.flush("runtime");
    session.reports.markCompactionDue(session.getGoal(), session.getTurnIndex());
    session.status.refreshUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    resetRun();
    session.endUserTurn();
    session.accounting.accountProgress(ctx, false, 0, true);
    session.flush("runtime");
    // Незавершённое восстановление не переживает закрытие: цель уходит на техническую паузу,
    // а строка статуса очищается уже после неё.
    const pending = session.getGoal()?.status === "active" ? reasonFromRecoveryPendingAttention(session.recovery.attention) : null;
    if (pending) session.pauseForShutdown(ctx, pending);
    else session.resetRecovery();
    session.status.stopStatusRefresh(true);
  });
}
