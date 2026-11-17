import { estimateTokens, type AgentBeforeSettleEvent, type BoundaryResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { isProviderLimitError, isRetryableTransientError } from "../goal/recovery.js";
import type { ProviderRetryConfig } from "../goal/provider-retry-config.js";
import { decideProviderRetry, type ProviderRetryChain, type ProviderRetryErrorClass } from "../goal/provider-retry-policy.js";
import { say } from "../language.js";
import type { GoalSession } from "./goal-session.js";

const ASTRA = "openai/gpt-6.2-astra";
const modelRef = (model: ExtensionContext["model"]) => model ? `${model.provider}/${model.id}` : "";
type Failure = { entryId: string; at: number; notBefore: number; errorClass: ProviderRetryErrorClass };
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
  let response: { status: number; notBefore: number } | undefined;
  let unbind: (() => void) | undefined;

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
    // Служебная запись не попадает в запрос к модели. В ней нет сообщений, аргументов или HTTP-заголовков.
    try { pi.appendEntry("pi-goal-provider-retry", { kind, reason, sessionId: ctx.sessionManager.getSessionId(), goalId: current?.goalId, model: current?.model, attempt: current?.attemptsIssued, class: current?.failure.errorClass, at: Date.now() }); }
    catch { /* Запись диагностики не владеет прогоном. */ }
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
  pi.on("session_before_switch", () => clear());
  pi.on("session_before_fork", () => clear());
  pi.on("session_before_tree", () => clear());
  pi.on("session_shutdown", (_event, ctx) => {
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
  });
  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || !chain) return;
    diagnostic(ctx, "cancelled", chain, "input");
    clear();
    setActivity(ctx, null);
  });
  pi.on("turn_start", () => { response = undefined; });
  pi.on("after_provider_response", (event, ctx) => {
    if (!canRecover(ctx) || modelRef(ctx.model) !== ASTRA) return;
    const raw = event.headers["retry-after"];
    const ms = raw?.trim() ? (/^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 0;
    response = { status: event.status, notBefore: performance.now() + (Number.isFinite(ms) ? Math.max(ms, 0) : 0) };
  });
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message;
    if (!enabled() || message.role !== "assistant") return;
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
    const failure = { entryId: event.messageEntryId, at, notBefore, errorClass };
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
      let selected = false;
      try { selected = await pi.setModel(target); } catch { /* Ошибка модели уйдёт в нормализованный статус. */ }
      // Служебные записи меняют leaf, но не последний ответ этой ветки.
      if (!valid()) {
        if (sameBranch() && modelRef(ctx.model) === decision.model) {
          try {
            if (!await pi.setModel(original)) throw new Error("model rollback failed");
            pi.setThinkingLevel(originalThinking);
          } catch { diagnostic(ctx, "stopped", current, "model-rollback-failed"); }
        }
        setActivity(ctx, null);
        return;
      }
      if (!selected || modelRef(ctx.model) !== decision.model) { stop(ctx, "sol-selection-failed"); return; }
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
    if (!requestAdmitted || chain !== requestAdmitted) return;
    diagnostic(ctx, "request-prepared", requestAdmitted);
    requestAdmitted = undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!enabled()) return;
    if ((event.aborted || seenAbort) && !ownAbort() && currentGoal() && !session.runIsForeign()) {
      diagnostic(ctx, "cancelled", chain, manual ? "escape" : "unknown");
      if (manual) session.pauseManually(ctx);
      else session.pauseForRecovery(ctx, say("Прогон прерван, источник отмены неизвестен. Перед продолжением проверь последнее действие.", "Run aborted; cancellation source unknown. Check the last action before resuming."));
    }
    requestAdmitted = undefined;
    clear();
    setActivity(ctx, null);
  });

  return { enabled, active: () => chain !== undefined, clear, owns, boundary };
}
