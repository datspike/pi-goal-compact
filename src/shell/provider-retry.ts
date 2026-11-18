import { randomUUID } from "node:crypto";
import { estimateTokens, type AgentBeforeSettleEvent, type BoundaryResult, type ExtensionAPI, type ExtensionContext, type InputEvent } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isProviderLimitError, isRetryableTransientError } from "../goal/recovery.js";
import type { ProviderRetryConfig } from "../goal/provider-retry-config.js";
import { decideProviderRetry, type ProviderRetryChain, type ProviderRetryErrorClass } from "../goal/provider-retry-policy.js";
import { say } from "../language.js";
import type { GoalSession } from "./goal-session.js";

const ASTRA = "openai/gpt-6.2-astra";
const modelRef = (model: ExtensionContext["model"]) => model ? `${model.provider}/${model.id}` : "";
type Failure = { entryId: string; at: number; notBefore: number; errorClass: ProviderRetryErrorClass; requestId: string | undefined; httpStatus: number | undefined };
type Chain = ProviderRetryChain & { sessionId: string; goalId: string; failure: Failure; abort: AbortController };

function classify(message: string | undefined, status: number | undefined): ProviderRetryErrorClass {
  if (isProviderLimitError(message)) return "not-admitted";
  // Шлюз иногда оборачивает перегрузку модели в auth_unavailable. Нужен внутренний код, а не догадка по 503.
  if ((status === 503 || /\b503\b/.test(message ?? "")) && /\bserver_is_overloaded\b/i.test(message ?? "")) return "model-temporary";
  if (status === 401 || status === 403 || status === 404 || /\b(unauthorized|invalid_api_key|auth_unavailable|model_not_found)\b/i.test(message ?? "")) return "not-admitted";
  return isRetryableTransientError(message) ? "unlocalized-temporary" : "not-admitted";
}

function delayUntil(until: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, Math.ceil(until - performance.now())));
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** Продлевает только ту же цепочку после штатного retry, не подставляя новую реплику или результат инструмента. */
export function registerProviderRetry(pi: ExtensionAPI, session: GoalSession, config: ProviderRetryConfig, ownAbort: () => boolean) {
  let chain: Chain | undefined;
  let manual = false;
  let seenAbort = false;
  let unsafeToolResult = false;
  let requestAdmitted: Chain | undefined;
  type Model = NonNullable<ExtensionContext["model"]>;
  let selection: { from: string; to: string; observed: boolean; manualChoice?: { model: Model; thinking: ReturnType<ExtensionAPI["getThinkingLevel"]> } } | undefined;
  let modelChangeCancelled = false;
  let response: { status: number; notBefore: number } | undefined;
  let unbind: (() => void) | undefined;
  let runId: string | undefined;
  let requestCount = 0;
  let request: { id: string; status?: number; retry?: Chain } | undefined;
  let lastAssistantEntryId: string | undefined;
  let loggedCancellation = false;
  const runningTools = new Set<string>();
  let pendingInput: { sessionId: string; messages: Array<Pick<InputEvent, "text" | "images">> } | undefined;

  const enabled = () => config.enabled && !pi.getCommands().some(command => command.name === "retry");
  const clear = () => { chain?.abort.abort(); chain = undefined; };
  const currentGoal = () => session.getGoal()?.status === "active" ? session.getGoal() : null;
  const canRecover = (ctx: ExtensionContext) => enabled() && ctx.mode === "tui" && !session.runIsForeign() && currentGoal() && session.canRecover() && !session.isContinuationHeld();
  const owns = (id: string | undefined) => Boolean(chain && id && chain.failure.entryId === id);
  const setActivity = (ctx: ExtensionContext, label: string | null) => {
    session.status.setActivity(label === null ? null : { label, kind: "provider-retry" });
    session.status.refreshUi(ctx);
  };
  const diagnostic = (ctx: ExtensionContext, kind: string, current?: Chain, reason?: string) => {
    if (kind === "cancelled") {
      if (loggedCancellation) return;
      loggedCancellation = true;
    }
    const at = Date.now();
    const mono = performance.now();
    // Подготовка не доказывает отправку. Сохраняем подтверждение только от события ответа Pi.
    const requestStage = request?.status !== undefined ? "response-observed" : request ? "prepared-unconfirmed" : "not-prepared";
    const failure = current?.failure;
    try { pi.appendEntry("pi-goal-provider-retry", {
      kind, reason, at, sessionId: ctx.sessionManager.getSessionId(), runId, goalId: current?.goalId ?? currentGoal()?.goalId,
      model: current?.model ?? modelRef(ctx.model), attempt: current?.attemptsIssued, class: failure?.errorClass,
      branchEntryId: lastAssistantEntryId, failureEntryId: failure?.entryId, failureRequestId: failure?.requestId,
      requestId: request?.id, requestStage, httpStatus: request?.status, failureHttpStatus: failure?.httpStatus,
      retryAfterAt: failure && failure.notBefore > failure.at ? at + Math.round(failure.notBefore - mono) : undefined,
      deadlineAt: current ? at + Math.round(current.startedAtMs + config.windowMs - mono) : undefined,
      stage: runningTools.size ? "tool" : requestStage, toolCallIds: runningTools.size ? [...runningTools] : undefined,
    }); } catch { /* Запись диагностики не владеет прогоном. */ }
  };
  const stop = (ctx: ExtensionContext, reason: string) => {
    diagnostic(ctx, "stopped", chain, reason);
    clear();
    setActivity(ctx, null);
    const detail = reason === "retry-after-outside-window" ? say("Провайдер просит ждать дольше заданного срока", "Provider asks to wait beyond the allowed window")
      : reason === "sol-unavailable" || reason === "sol-selection-failed" ? say("Не удалось выбрать Sol", "Could not select Sol")
      : reason === "sol-window" ? say("Сохранённое окно не помещается в Sol", "Saved context does not fit Sol")
      : reason === "unsafe-tool-result" ? say("Исход инструмента надо проверить вручную", "The tool outcome needs a manual check")
      : say("Срок повторов исчерпан", "Retry window exhausted");
    session.pauseForRecovery(ctx, `Astra: ${detail}.`);
  };
  const bind = (ctx: ExtensionContext) => {
    clear();
    unbind?.();
    unbind = undefined;
    manual = seenAbort = false;
    if (enabled() && ctx.mode === "tui") unbind = ctx.ui.onTerminalInput(data => {
      if (!matchesKey(data, "escape") || ctx.isIdle()) return;
      manual = true;
      if (chain) {
        diagnostic(ctx, "cancelled", chain, "escape");
        clear();
        setActivity(ctx, null);
        session.pauseManually(ctx);
        ctx.abort();
      }
    });
  };

  pi.on("session_start", (_event, ctx) => bind(ctx));
  pi.on("session_tree", (_event, ctx) => bind(ctx));
  const leaveSession = () => { pendingInput = undefined; requestAdmitted = undefined; request = undefined; clear(); };
  pi.on("session_before_switch", leaveSession);
  pi.on("session_before_fork", leaveSession);
  pi.on("session_before_tree", leaveSession);
  pi.on("session_shutdown", (_event, ctx) => {
    pendingInput = undefined;
    if (chain && currentGoal()) session.pauseForShutdown(ctx, "Provider recovery was interrupted by session shutdown.");
    clear();
    unbind?.();
    unbind = undefined;
  });
  pi.on("before_agent_start", () => {
    clear();
    manual = seenAbort = unsafeToolResult = false;
    requestAdmitted = undefined;
    response = undefined;
    modelChangeCancelled = false;
    runId = randomUUID();
    requestCount = 0;
    request = undefined;
    lastAssistantEntryId = undefined;
    loggedCancellation = false;
    runningTools.clear();
  });
  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || ctx.mode !== "tui") return;
    const sessionId = ctx.sessionManager.getSessionId();
    const own = chain ?? requestAdmitted ?? request?.retry;
    if (!own && pendingInput?.sessionId !== sessionId) return;
    if (pendingInput?.sessionId !== sessionId) pendingInput = { sessionId, messages: [] };
    pendingInput.messages.push({ text: event.text, ...(event.images ? { images: event.images } : {}) });
    // Очередь штатного run не исполняется после abort. Передаём ровно ту же реплику после его остановки.
    diagnostic(ctx, "cancelled", own, "input");
    requestAdmitted = undefined;
    clear();
    setActivity(ctx, null);
    ctx.abort();
    return { action: "handled" };
  });
  pi.on("turn_start", () => { response = undefined; });
  pi.on("model_select", (event, ctx) => {
    if (selection && !selection.observed && event.source === "set" &&
        modelRef(event.previousModel) === selection.from && modelRef(event.model) === selection.to) {
      selection.observed = true;
      return;
    }
    if (selection && !modelChangeCancelled) selection.manualChoice = { model: event.model, thinking: pi.getThinkingLevel() };
    if (!chain && !requestAdmitted) return;
    diagnostic(ctx, "cancelled", chain ?? requestAdmitted, "model-selection");
    modelChangeCancelled = true;
    clear();
    requestAdmitted = undefined;
    setActivity(ctx, null);
    session.pauseForRecovery(ctx, say("Модель изменена вручную. Старый повтор отменён.", "Model changed manually. The pending retry was cancelled."));
    if (!ctx.isIdle()) ctx.abort();
  });

  async function select(ctx: ExtensionContext, target: Model) {
    const attempt: NonNullable<typeof selection> = { from: modelRef(ctx.model), to: modelRef(target), observed: false };
    selection = attempt;
    let ok = false;
    try { ok = await pi.setModel(target); }
    finally { if (selection === attempt) selection = undefined; }
    return { ok, manualChoice: attempt.manualChoice };
  }
  pi.on("tool_execution_start", (event, ctx) => {
    if (enabled() && ctx.mode === "tui") runningTools.add(event.toolCallId);
  });
  pi.on("tool_execution_end", event => { runningTools.delete(event.toolCallId); });
  pi.on("after_provider_response", (event, ctx) => {
    if (request) request.status = event.status;
    if (!canRecover(ctx) || modelRef(ctx.model) !== ASTRA) return;
    const raw = event.headers["retry-after"];
    const ms = raw?.trim() ? (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 0;
    response = { status: event.status, notBefore: performance.now() + (Number.isFinite(ms) ? Math.max(ms, 0) : 0) };
  });
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (!enabled() || message.role !== "assistant") return;
    lastAssistantEntryId = event.messageEntryId;
    if (request?.retry) {
      diagnostic(ctx, "request-result", request.retry, message.stopReason);
      delete request.retry;
    }
    if (message.stopReason === "aborted") { seenAbort = true; return; }
    if (message.stopReason !== "error") {
      unsafeToolResult = event.toolResults.some(result => result.isError);
      clear();
      return;
    }
    const goal = currentGoal();
    if (!goal || !canRecover(ctx) || manual || modelRef(ctx.model) !== ASTRA || `${message.provider}/${message.model}` !== ASTRA) return;
    const errorClass = classify(message.errorMessage, response?.status);
    if (errorClass !== "not-admitted" && (unsafeToolResult || event.toolResults.length || message.content.some(part => part.type === "toolCall"))) {
      stop(ctx, "unsafe-tool-result");
      ctx.abort();
      return;
    }
    if (errorClass === "not-admitted") { clear(); return; }
    const at = performance.now();
    // Responses передаёт число секунд в ошибке, если задержка превышает лимит транспорта.
    const refusedDelay = /\bServer requested (\d+)s retry delay \(max: \d+s\)/i.exec(message.errorMessage ?? "");
    const notBefore = Math.max(at, response?.notBefore ?? at, at + Number(refusedDelay?.[1] ?? 0) * 1000);
    const failure = { entryId: event.messageEntryId, at, notBefore, errorClass, requestId: request?.id, httpStatus: response?.status };
    const sessionId = ctx.sessionManager.getSessionId();
    if (chain?.goalId !== goal.goalId || chain.sessionId !== sessionId) {
      clear();
      chain = { startedAtMs: at, attemptsIssued: 0, switched: false, model: ASTRA, goalId: goal.goalId, sessionId, failure, abort: new AbortController() };
    } else chain.failure = failure;
    // Нельзя дать короткому retry Pi отправить запрос раньше сообщённого сервером срока.
    const signal = ctx.signal;
    if (failure.notBefore > at && (failure.notBefore > chain.startedAtMs + config.windowMs || !signal)) {
      stop(ctx, "retry-after-outside-window");
      ctx.abort();
    } else if (failure.notBefore > at && signal) {
      setActivity(ctx, say(`Astra недоступна · провайдер просит ждать ${Math.ceil((failure.notBefore - at) / 1000)} с · Esc — остановить`, `Astra unavailable · provider asks to wait ${Math.ceil((failure.notBefore - at) / 1000)} s · Esc to stop`));
      const waitSignal = AbortSignal.any([chain.abort.signal, signal]);
      await delayUntil(failure.notBefore, waitSignal);
      if (waitSignal.aborted && !signal.aborted && !ctx.hasPendingMessages()) ctx.abort();
      setActivity(ctx, null);
    }
  });

  async function boundary(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
    const current = chain;
    if (!current || event.outcome !== "error") return;
    const failure = current.failure;
    const sameBranch = () => ctx.sessionManager.getSessionId() === current.sessionId && ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "assistant")?.id === failure.entryId;
    const valid = () => chain === current && !manual && canRecover(ctx) && currentGoal()?.goalId === current.goalId && sameBranch() && !ctx.hasPendingMessages();
    if (!valid() || event.continue || event.context.pendingMessages.length) { clear(); return; }
    const decide = () => decideProviderRetry({ chain: current, nowMs: performance.now(), failedAtMs: failure.at, notBeforeMs: failure.notBefore, errorClass: failure.errorClass, windowMs: config.windowMs, allowSwitch: config.allowSwitch });
    let decision = decide();
    if (decision.type === "wait") {
      diagnostic(ctx, "waiting", current);
      setActivity(ctx, say(`Astra недоступна · следующая попытка через ${Math.ceil((decision.untilMs - performance.now()) / 1000)} с · Esc — остановить`, `Astra unavailable · next attempt in ${Math.ceil((decision.untilMs - performance.now()) / 1000)} s · Esc to stop`));
      while (valid() && decision.type === "wait") {
        await delayUntil(decision.untilMs, current.abort.signal);
        if (!valid()) break;
        decision = decide();
      }
    }
    if (!valid()) { setActivity(ctx, null); if (chain === current) clear(); return; }
    if (decision.type === "stop") { stop(ctx, decision.reason); return; }
    if (decision.type === "wait") return;
    if (modelRef(ctx.model) !== ASTRA) { clear(); setActivity(ctx, null); return; }
    // Убираем только неудавшийся ответ. Сохраняем полную пару предыдущего вызова и результата.
    const entries: BoundaryResult["entries"] = [...event.entries, { type: "context_edit", targetId: failure.entryId, replacement: null }];
    if (decision.type === "switch") {
      const original = ctx.model;
      const originalThinking = pi.getThinkingLevel();
      const [provider, id] = decision.model.split("/") as [string, string];
      const scoped = ctx.scopedModels;
      const target = scoped.length ? scoped.find(item => modelRef(item.model) === decision.model)?.model : ctx.modelRegistry.find(provider, id);
      if (!original || !target || !ctx.modelRegistry.hasConfiguredAuth(target)) { stop(ctx, "sol-unavailable"); return; }
      const history = event.context.contextMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
      const tools = pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name));
      const overhead = Math.ceil((ctx.getSystemPrompt().length + JSON.stringify(tools).length) / 4);
      if (history + overhead + Math.max(target.maxTokens, 16384) > target.contextWindow) { stop(ctx, "sol-window"); return; }
      setActivity(ctx, say("Astra недоступна · переключение на Sol", "Astra unavailable · switching to Sol"));
      let selected: Awaited<ReturnType<typeof select>> | undefined;
      try { selected = await select(ctx, target); } catch { /* Ошибка модели уйдёт в нормализованный статус. */ }
      // Служебные записи меняют leaf, но не последний ответ этой ветки.
      if (!valid()) {
        if (sameBranch() && modelRef(ctx.model) === decision.model) {
          try {
            const restore = selected?.manualChoice ?? { model: original, thinking: originalThinking };
            if (modelRef(restore.model) !== modelRef(ctx.model) && !(await select(ctx, restore.model)).ok) throw new Error("model rollback failed");
            pi.setThinkingLevel(restore.thinking);
          } catch { diagnostic(ctx, "stopped", current, "model-rollback-failed"); }
        }
        setActivity(ctx, null);
        return;
      }
      if (!selected?.ok || modelRef(ctx.model) !== decision.model) { stop(ctx, "sol-selection-failed"); return; }
      current.switched = true;
      current.model = decision.model;
      diagnostic(ctx, "switched", current);
    } else {
      current.attemptsIssued++;
      diagnostic(ctx, "admitted", current);
    }
    requestAdmitted = current;
    return { entries, continue: true };
  }

  pi.on("before_provider_request", (_event, ctx) => {
    if (runId && enabled() && ctx.mode === "tui" && !session.runIsForeign()) request = { id: `${runId}:${++requestCount}` };
    const admitted = requestAdmitted;
    if (!admitted) return;
    requestAdmitted = undefined;
    if (chain !== admitted || !canRecover(ctx) || modelRef(ctx.model) !== admitted.model || ctx.sessionManager.getSessionId() !== admitted.sessionId) {
      ctx.abort();
      return;
    }
    if (request) request.retry = admitted;
    diagnostic(ctx, "request-prepared", admitted);
  });
  pi.on("agent_settled", (event, ctx) => {
    const input = pendingInput;
    pendingInput = undefined;
    if (!enabled() && !input) return;
    if ((event.aborted || seenAbort) && !input && !modelChangeCancelled && !ownAbort() && currentGoal() && !session.runIsForeign()) {
      diagnostic(ctx, "cancelled", chain, manual ? "escape" : "unknown");
      if (manual) session.pauseManually(ctx);
      else session.pauseForRecovery(ctx, say("Прогон прерван, источник отмены неизвестен. Перед продолжением проверь последнее действие.", "Run aborted; cancellation source unknown. Check the last action before resuming."));
    }
    requestAdmitted = undefined;
    request = undefined;
    clear();
    setActivity(ctx, null);
    if (input?.sessionId === ctx.sessionManager.getSessionId() && !manual && !session.runIsForeign()) {
      for (const message of input.messages) {
        const content = message.images?.length ? [{ type: "text" as const, text: message.text }, ...message.images] : message.text;
        pi.sendUserMessage(content, { expandPromptTemplates: true });
      }
    }
  });

  return { enabled, active: () => chain !== undefined, clear, owns, boundary };
}
