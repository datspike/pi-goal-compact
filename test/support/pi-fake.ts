import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../src/index.js";

export interface FakeOptions {
  branch?: any[];
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
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, any>();
  const busListeners = new Map<string, Array<(data: unknown) => void>>();
  const renderers = new Map<string, any>();
  const tools = new Map<string, any>();
  let idle = false;
  let branch: any[] = options.branch ?? [{ id: "user-1", type: "message", message: { role: "user", content: "Начать работу" } }];
  let sessionId = options.sessionId ?? `session-${++sequence}`;
  let thinkingLevel = options.thinkingLevel ?? "low";
  let modelBarrier: (() => Promise<void>) | undefined;
  let pending = false;
  const entries: Array<{ type: string; data: any }> = [];
  const compactOptions: any[] = [];
  const sent: Array<{ message: any; options: any }> = [];
  const setModelCalls: any[] = [];
  const notices: Array<{ text: string; level: string }> = [];
  const footers: string[] = [];
  let aborts = 0;
  const provider = options.modelProvider ?? "openai";
  const id = options.modelId ?? "gpt-5.6-sol";
  const registryEntry = { provider, id, contextWindow: options.registryContextWindow ?? 600_000, cost: { tiers: options.registryTiers ?? [{ inputTokensAbove: options.registryContextWindow ?? 600_000 }] } };
  const ctx: any = {
    cwd: "/tmp/goal-compact-test",
    hasUI: true,
    ui: { notify(text: string, level: string) { notices.push({ text, level }); }, setStatus(_key: string, value?: string) { footers.push(value ?? ""); } },
    model: { provider, id, api: "openai-responses", contextWindow: 272_000, maxTokens: 128_000 },
    modelRegistry: { getAll: () => [registryEntry], find: (p: string, m: string) => p === provider && m === id ? registryEntry : undefined },
    sessionManager: { getEntries: () => branch, getBranch: () => branch, getSessionId: () => sessionId, getSessionFile: () => undefined },
    getContextUsage: () => ({ tokens: 1_000, contextWindow: ctx.model.contextWindow, percent: 1 }),
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort() { aborts++; },
    compact(value: any) { compactOptions.push(value); },
  };
  const pi: any = {
    registerTool(value: any) { tools.set(value.name, value); },
    registerCommand(name: string, value: any) {
      if (commands.has(name)) throw new Error(`вторая команда ${name}`);
      commands.set(name, { name, source: "extension", ...value });
    },
    getCommands() { return [...commands.values()]; },
    getAllTools() { return [...tools.keys()].map((name) => ({ name })); },
    // Как в Pi: обработчики одного события вызываются по порядку регистрации на одном объекте события.
    on(name: string, value: any) { handlers.set(name, [...(handlers.get(name) ?? []), value]); },
    events: {
      on(name: string, listener: (data: unknown) => void) {
        busListeners.set(name, [...(busListeners.get(name) ?? []), listener]);
        return () => busListeners.set(name, (busListeners.get(name) ?? []).filter((item) => item !== listener));
      },
      emit(name: string, data: unknown) { for (const listener of busListeners.get(name) ?? []) listener(data); },
    },
    registerEntryRenderer(type: string, renderer: any) { renderers.set(type, renderer); },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
      branch = [...branch, { id: `append-${entries.length}`, type: "custom", customType: type, data }];
    },
    async setModel(next: any) {
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
    sendMessage(message: any, sendOptions: any) { sent.push({ message, options: sendOptions }); },
  };
  // Результат — последний непустой ответ; `context` передаёт сообщения дальше по цепочке, как Pi.
  async function emit(name: string, event: any, context: any) {
    let result: any;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, context);
      if (value === undefined) continue;
      result = value;
      if (name === "context" && value?.messages) event = { ...event, messages: value.messages };
    }
    return result;
  }
  const agentDir = mkdtempSync(join(tmpdir(), "goal-compact-test-profile-"));
  const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: options.language ?? "ru" } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    extension(pi);
  } finally {
    if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  }
  return {
    ctx, tools, commands, command: commands.get("context")?.handler, entries, renderers, compactOptions, sent, notices, footers, setModelCalls,
    get aborts() { return aborts; },
    get thinkingLevel() { return thinkingLevel; },
    tool(name: string) { return tools.get(name); },
    setModelBarrier(value: () => Promise<void>) { modelBarrier = value; },
    setPending(value: boolean) { pending = value; },
    setBranch(value: any[]) { branch = value; },
    setSessionId(value: string) { sessionId = value; },
    audits(origin?: string) { return entries.filter((entry) => entry.type === "goal-compact-audit" && (!origin || entry.data.origin === origin)).map((entry) => entry.data); },
    async flush() { await new Promise<void>((resolve) => setImmediate(resolve)); },
    async event(name: string, event: any = {}, context: any = ctx) { return emit(name, event, context); },
    async settle(isNowIdle = true, aborted = false) { idle = isNowIdle; return emit("agent_settled", { aborted }, ctx); },
    emitBus(name: string, data: unknown) { pi.events.emit(name, data); },
  };
}

export type FakePi = ReturnType<typeof fakePi>;
