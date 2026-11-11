import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
import type { GoalGate } from "../core/model.js";
import { say } from "../language.js";
import { RECORD } from "../records.js";
import type { CoreDriver } from "./driver.js";
import { chooseModel, modelCompletions } from "./model-choice.js";
import { notice } from "./notice.js";

type PendingTransfer = { version: 1; id: string; sessionId: string; provider: string; model: string; phase: "queued" | "applying" | "failed"; immediate?: boolean; thinking?: ThinkingLevel; compactId?: string };
const LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function pendingRecord(data: unknown): PendingTransfer | undefined {
 if (!data || typeof data !== "object") return undefined;
 const value = data as Partial<PendingTransfer>;
 if (value.version !== 1 || !value.id || !value.sessionId || !value.provider || !value.model || !["queued", "applying", "failed"].includes(value.phase ?? "")) return undefined;
 if (value.thinking !== undefined && !LEVELS.includes(value.thinking)) return undefined;
 return value as PendingTransfer;
}

/** Восстанавливает только последнюю запись текущей ветки, без переноса в другую сессию. */
export function restoreTransfer(entries: readonly SessionEntry[], sessionId: string): PendingTransfer | undefined {
 for (const entry of [...entries].reverse()) {
  if (entry.type !== "custom" || entry.customType !== RECORD.transfer) continue;
  const pending = pendingRecord(entry.data);
  return pending?.sessionId === sessionId ? pending : undefined;
 }
 return undefined;
}

/** Команды и операции Pi; право продолжения остаётся у чистого ядра. */
export function registerModelTransfer(pi: ExtensionAPI, driver: CoreDriver, gate: () => GoalGate) {
 let pending: PendingTransfer | undefined;
 let applying = false;
 let generation = 0;
 const footer = (ctx: ExtensionContext) => {
  if (ctx.hasUI) ctx.ui.setStatus("goal-compact-model-next", pending ? `${say("После сжатия", "After compaction")}: ${pending.provider}/${pending.model}${pending.phase === "failed" ? " !" : ""}` : undefined);
 };
 const save = (ctx: ExtensionContext) => { pi.appendEntry(RECORD.transfer, pending ?? { version: 1, phase: "none" }); footer(ctx); };
 const clear = (ctx: ExtensionContext, persist = true, cancelCheckpoint = true) => {
  ++generation;
  if (pending?.immediate && cancelCheckpoint) driver.dispatch({ type: "checkpoint_cancel_requested" }, ctx);
  pending = undefined;
  driver.dispatch({ type: "transfer_cancelled" }, ctx);
  if (persist) save(ctx); else footer(ctx);
 };
 const fail = (ctx: ExtensionContext, message: string) => {
  if (!pending) return;
  pending = { ...pending, phase: "failed" };
  driver.dispatch({ type: "transfer_applied", ok: false }, ctx);
  save(ctx);
  ctx.abort();
  notice(ctx, `${say("Передача модели остановлена", "Model transfer stopped")}: ${message}`, "error");
 };
 const afterSaved = async (ctx: ExtensionContext, compactId: string): Promise<void> => {
  if (!pending || pending.phase !== "queued") return;
  const current = pending;
  const token = generation;
  const sessionId = ctx.sessionManager.getSessionId();
  pending = { ...current, phase: "applying", compactId };
  driver.dispatch({ type: "transfer_saved" }, ctx);
  save(ctx);
  try {
   const model = ctx.modelRegistry.find(current.provider, current.model);
   if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(say("Модель или авторизация недоступна", "Model or authentication unavailable"));
   // После compact usage неизвестен: считаем сохранённую проекцию, а не старый ответ модели.
   const measured = ctx.getContextUsage()?.tokens;
   const history = measured ?? ctx.sessionManager.buildSessionProjection().messages.reduce((sum, message) => sum + estimateTokens(message), 0);
   const envelope = Math.ceil((ctx.getSystemPrompt().length + JSON.stringify(pi.getAllTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).length) / 4);
   const input = history + envelope;
   if (input + Math.max(model.maxTokens, 16384) > model.contextWindow) throw new Error(say("Сжатый контекст не помещается в новую модель", "Compacted context does not fit the target model"));
   applying = true;
   if (!await pi.setModel(model)) throw new Error("setModel returned false");
   if (generation !== token || sessionId !== ctx.sessionManager.getSessionId()) return;
   if (current.thinking !== undefined) pi.setThinkingLevel(current.thinking);
   if (ctx.model?.provider !== current.provider || ctx.model.id !== current.model) throw new Error(say("Модель не применилась", "Model was not applied"));
   clear(ctx, true, false);
   notice(ctx, `${say("Работа передана", "Work transferred")}: ${current.provider}/${current.model}; thinking=${pi.getThinkingLevel()}`);
  } catch (error) {
   if (generation === token && sessionId === ctx.sessionManager.getSessionId()) fail(ctx, error instanceof Error ? error.message : String(error));
  } finally { applying = false; }
 };
 for (const command of ["model-next", "model-next-now"] as const) {
  pi.registerCommand(command, {
   description: command === "model-next" ? say("Выбрать модель после следующего сжатия; status, cancel", "Choose a model after next compaction; status, cancel") : say("Сжать и переключить модель после текущего хода", "Compact and switch model after the current turn"),
   getArgumentCompletions(prefix) {
    const ctx = lastContext;
    if (!ctx) return null;
    const models = ctx.scopedModels.length ? ctx.scopedModels.map(item => item.model) : ctx.modelRegistry.getAvailable();
    const actions = command === "model-next" ? ["status", "cancel"].filter(item => item.startsWith(prefix)).map(value => ({ value, label: value, description: say("Передача модели", "Model transfer") })) : [];
    const choices = modelCompletions(models, prefix) ?? [];
    return choices.length || actions.length ? [...actions, ...choices] : null;
   },
   handler: async (args, ctx) => {
    lastContext = ctx;
    if (command === "model-next" && args.trim() === "status") {
     const status = pending?.phase === "queued" ? say("ожидает сжатия", "waiting for compaction") : pending?.phase === "applying" ? say("модель применяется", "applying model") : say("ошибка; повторите выбор или отмените передачу", "failed; select again or cancel the transfer");
     notice(ctx, pending ? `${pending.provider}/${pending.model}: ${status}` : say("Переключение не запланировано", "No model switch scheduled")); return;
    }
    if (command === "model-next" && args.trim() === "cancel") {
     if (applying) { notice(ctx, say("Модель уже применяется; дождитесь результата", "The model is being applied; wait for the result"), "warning"); return; }
     clear(ctx); notice(ctx, say("Переключение отменено", "Model switch cancelled")); return;
    }
    const match = args.match(/^(.*?)(?:\s+--thinking\s+(\S+))?\s*$/);
    const query = match?.[1]?.trim() ?? args.trim();
    const thinking = match?.[2];
    if (thinking && !LEVELS.includes(thinking)) { notice(ctx, say("Неизвестный уровень рассуждения", "Unknown thinking level"), "error"); return; }
    const token = generation;
    const sessionId = ctx.sessionManager.getSessionId();
    const model = await chooseModel(ctx, query);
    if (!model || token !== generation || sessionId !== ctx.sessionManager.getSessionId()) return;
    if (!ctx.modelRegistry.hasConfiguredAuth(model)) { notice(ctx, say("Для модели нет авторизации", "No authentication for the model"), "error"); return; }
    if (applying || driver.state.checkpoint.phase !== "none") { notice(ctx, say("Передача или сжатие уже выполняется", "Transfer or compaction already in progress"), "warning"); return; }
    const savedCompact = pending?.phase === "failed" ? pending.compactId : undefined;
    ++generation;
    pending = { version: 1, id: randomUUID(), sessionId, provider: model.provider, model: model.id, phase: "queued", immediate: command === "model-next-now", thinking: thinking ? thinking as ThinkingLevel : pi.getThinkingLevel() };
    driver.dispatch({ type: "transfer_queued" }, ctx);
    save(ctx);
    notice(ctx, `${say("После сжатия", "After compaction")}: ${model.provider}/${model.id}`);
    if (savedCompact && ctx.sessionManager.getBranch().some(entry => entry.type === "compaction" && entry.id === savedCompact)) {
     await afterSaved(ctx, savedCompact);
     return;
    }
    if (command === "model-next-now") {
     driver.dispatch({ type: "checkpoint_requested", alreadyCompacted: false, continueAfter: !ctx.isIdle() || gate() === "runs", request: {
      mainObjective: say("Продолжить текущую незавершённую работу", "Continue the current unfinished task"),
      completedCheckpoint: say("Передать текущие решения и состояние новой модели", "Transfer current decisions and state to the next model"),
      continuationTarget: say("Продолжить с последнего незавершённого шага; не начинать новую задачу", "Resume the last unfinished step; do not start a new task"),
     } }, ctx);
     if (ctx.isIdle()) driver.dispatch({ type: "settled", aborted: false }, ctx);
    }
   },
  });
 }
 let lastContext: ExtensionContext | undefined;
 return {
  afterSaved,
  ownsModelChange: (ctx: ExtensionContext) => applying && ctx.model?.provider === pending?.provider && ctx.model?.id === pending?.model,
  cancel: clear,
  failed: () => pending?.phase === "failed",
  compactFailed: (ctx: ExtensionContext) => fail(ctx, say("Не удалось сжать контекст", "Compaction failed")),
  restore(ctx: ExtensionContext) {
   ++generation;
   lastContext = ctx;
   pending = restoreTransfer(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
   driver.dispatch({ type: "transfer_cancelled" }, ctx);
   if (pending) {
    driver.dispatch({ type: "transfer_queued" }, ctx);
    if (pending.phase !== "queued") {
     const saved = pending.compactId && ctx.sessionManager.getBranch().some(entry => entry.type === "compaction" && entry.id === pending?.compactId);
     if (pending.phase === "applying" && saved && ctx.model?.provider === pending.provider && ctx.model.id === pending.model && (pending.thinking === undefined || pi.getThinkingLevel() === pending.thinking)) clear(ctx);
     else fail(ctx, say("Передача прервалась; повторите выбор модели", "Transfer interrupted; select the model again"));
    }
   }
   footer(ctx);
  },
 };
}
