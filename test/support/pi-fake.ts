import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.js";
import { asPi } from "./as-pi.js";
import { withAgreementDefaults } from "./agreement-defaults.js";

/** Запись ветки в подделке: тест задаёт только нужные поля. */
export type FakeEntry = { id: string; type: string; [field: string]: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;
type Command = Omit<RegisteredCommand, "sourceInfo"> & { source: string };
type FakeModel = { provider: string; id: string; api?: string; baseUrl?: string; contextWindow: number; maxTokens?: number };

export interface FakeOptions {
  branch?: FakeEntry[];
  sessionId?: string;
  setModelResult?: boolean;
  setModelResults?: Array<boolean | "reject">;
  emitModelSelect?: boolean;
  thinkingLevel?: string;
  modelSwitchThinkingLevel?: string;
  language?: "ru" | "en";
  modelProvider?: string;
  modelId?: string;
  registryContextWindow?: number;
  registryTiers?: Array<{ inputTokensAbove: number }>;
}

let sequence = 0;

/**
 * Поддельный Pi для тестов обвязки: держит обработчики, журнал ветки и
 * отправленные сообщения. Записи appendEntry сразу попадают в ветку, как в Pi.
 */
export function fakePi(options: FakeOptions = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  const busListeners = new Map<string, Array<(data: unknown) => void>>();
  const renderers = new Map<string, Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>();
  const tools = new Map<string, ToolDefinition>();
  let idle = false;
  let branch: FakeEntry[] = options.branch ?? [{ id: "user-1", type: "message", message: { role: "user", content: "Начать работу" } }];
  let sessionId = options.sessionId ?? `session-${++sequence}`;
  let thinkingLevel = options.thinkingLevel ?? "low";
  let modelBarrier: (() => Promise<void>) | undefined;
  let pending = false;
  const entries: Array<{ type: string; data: unknown }> = [];
  const compactOptions: Array<Parameters<ExtensionContext["compact"]>[0]> = [];
  const sent: Array<{ message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }> = [];
  const setModelCalls: Array<Model<Api>> = [];
  const notices: Array<{ text: string; level: string }> = [];
  const footers: string[] = [];
  let aborts = 0;
  const provider = options.modelProvider ?? "openai";
  const id = options.modelId ?? "gpt-5.6-sol";
  const registryEntry = { provider, id, contextWindow: options.registryContextWindow ?? 600_000, cost: { tiers: options.registryTiers ?? [{ inputTokensAbove: options.registryContextWindow ?? 600_000 }] } };
  const initialModel: FakeModel = { provider, id, api: "openai-responses", contextWindow: 272_000, maxTokens: 128_000 };
  const noSignal = (): AbortSignal | undefined => undefined;
  const ctx = {
    cwd: "/tmp/goal-compact-test",
    signal: noSignal(),
    hasUI: true,
    ui: { notify(text: string, level: string) { notices.push({ text, level }); }, setStatus(_key: string, value?: string) { footers.push(value ?? ""); } },
    model: initialModel,
    modelRegistry: { getAll: () => [registryEntry], find: (p: string, m: string) => p === provider && m === id ? registryEntry : undefined },
    sessionManager: { getEntries: () => branch, getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined },
    getContextUsage: (): { tokens: number; contextWindow: number; percent: number } => ({ tokens: 1_000, contextWindow: ctx.model.contextWindow, percent: 1 }),
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort() { aborts++; },
    compact(value?: Parameters<ExtensionContext["compact"]>[0]) { compactOptions.push(value); },
  };
  const pi = {
    registerTool(value: ToolDefinition) { tools.set(value.name, value); },
    registerCommand(name: string, value: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      if (commands.has(name)) throw new Error(`вторая команда ${name}`);
      commands.set(name, { name, source: "extension", ...value });
    },
    getCommands() { return [...commands.values()]; },
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    // Как в Pi: обработчики одного события вызываются по порядку регистрации на одном объекте события.
    on(name: string, value: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), value]); },
    events: {
      on(name: string, listener: (data: unknown) => void) {
        busListeners.set(name, [...(busListeners.get(name) ?? []), listener]);
        return () => busListeners.set(name, (busListeners.get(name) ?? []).filter((item) => item !== listener));
      },
      emit(name: string, data: unknown) { for (const listener of busListeners.get(name) ?? []) listener(data); },
    },
    registerEntryRenderer(type: string, renderer: Parameters<ExtensionAPI["registerEntryRenderer"]>[1]) { renderers.set(type, renderer); },
    appendEntry(type: string, data?: unknown) {
      entries.push({ type, data });
      branch = [...branch, { id: `append-${entries.length}`, type: "custom", customType: type, data }];
    },
    async setModel(next: Model<Api>) {
      setModelCalls.push(next);
      const result = options.setModelResults?.shift() ?? options.setModelResult ?? true;
      if (result === false) return false;
      ctx.model = next;
      await modelBarrier?.();
      if (options.emitModelSelect) await emit("model_select", {}, ctx);
      if (result === "reject") throw new Error("session transcript write failed");
      if (options.modelSwitchThinkingLevel) thinkingLevel = options.modelSwitchThinkingLevel;
      return true;
    },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(value: string) { thinkingLevel = value; },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], sendOptions?: Parameters<ExtensionAPI["sendMessage"]>[1]) { sent.push({ message, options: sendOptions }); },
  };
  // Результат — последний непустой ответ; `context` передаёт сообщения дальше по цепочке, как Pi.
  async function emit(name: string, event: unknown, context: unknown): Promise<unknown> {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, context);
      if (value === undefined) continue;
      result = value;
      if (name === "context" && isRecord(value) && value.messages) event = { ...(isRecord(event) ? event : {}), messages: value.messages };
    }
    return result;
  }
  const agentDir = mkdtempSync(join(tmpdir(), "goal-compact-test-profile-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: options.language ?? "ru" } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    extension(asPi<ExtensionAPI>(pi));
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
  return {
    ctx, context: asPi<ExtensionContext>(ctx), tools, commands, entries, renderers, compactOptions, sent, notices, footers, setModelCalls,
    /** Команда `/context` с аргументами; контекст по умолчанию — подделка Pi. */
    async command(args: string, context: object = ctx) {
      const handler = commands.get("context")?.handler;
      if (!handler) throw new Error("команда context не зарегистрирована");
      await handler(args, asPi<ExtensionCommandContext>(context));
    },
    /** Вызывает инструмент как модель и отдаёт текст и детали ответа. */
    async runTool(name: string, params: unknown, id = "call", context: object = ctx) {
      const execute = () => this.tool(name).execute(id, withAgreementDefaults(name, params), undefined, undefined, asPi<ExtensionToolContext>(context));
      // Первую попытку закрытия, которая возвращает договорённость (Д3), обвязка проходит за прежние тесты.
      const result = name !== "update_goal" ? await execute() : await execute().catch((error: unknown) => {
        if (error instanceof Error && error.message.includes("\"agreement_check\"")) return execute();
        throw error;
      });
      const text = result.content.map((part) => part.type === "text" ? part.text : "").join("\n");
      return { text, details: isRecord(result.details) ? result.details : {}, result };
    },
    get aborts() { return aborts; },
    get thinkingLevel() { return thinkingLevel; },
    tool(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`нет инструмента ${name}`);
      return tool;
    },
    setModelBarrier(value: () => Promise<void>) { modelBarrier = value; },
    setPending(value: boolean) { pending = value; },
    setBranch(value: FakeEntry[]) { branch = value; },
    setSessionId(value: string) { sessionId = value; },
    audits(origin?: string) { return entries.flatMap((entry) => entry.type === "goal-compact-audit" && isRecord(entry.data) && (!origin || entry.data.origin === origin) ? [entry.data] : []); },
    async flush() { await new Promise<void>((resolve) => setImmediate(resolve)); },
    async event(name: string, event: unknown = {}, context: unknown = ctx) { return emit(name, event, context); },
    async settle(isNowIdle = true, aborted = false) { idle = isNowIdle; return emit("agent_settled", { aborted }, ctx); },
    emitBus(name: string, data: unknown) { pi.events.emit(name, data); },
  };
}

export type FakePi = ReturnType<typeof fakePi>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
