import { Type } from "typebox";
import assert from "node:assert/strict";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";

import { buildSessionProjection as buildProjection } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compose } from "../../src/index.js";
import { isContextOverflowError } from "../../src/goal/recovery.js";
import { isGoalCustomEntry, reconstructGoal } from "../../src/goal/state.js";
import { GOAL_PROJECTION_ENTRY_TYPE } from "../../src/goal/goal-reports.js";
import { CUSTOM_ENTRY_TYPE } from "../../src/goal/types.js";

type EventHandler = (event: object, ctx: ExtensionContext) => unknown | Promise<unknown>;

function unsupportedHarnessMethod(name: string): never {
  throw new Error(`${name} is not implemented in this test harness.`);
}

export interface SentMessage {
  message: Parameters<ExtensionAPI["sendMessage"]>[0];
  options: Parameters<ExtensionAPI["sendMessage"]>[1];
}

export interface SentUserMessage {
  content: Parameters<ExtensionAPI["sendUserMessage"]>[0];
  options: Parameters<ExtensionAPI["sendUserMessage"]>[1];
}

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionEventOptions {
  reason?: CompactionReason;
  willRetry?: boolean;
  summary?: string;
  tokensBefore?: number;
}

export function sessionBeforeCompactEvent(options: CompactionEventOptions = {}): object {
  return {
    type: "session_before_compact",
    preparation: {},
    branchEntries: [],
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
    signal: new AbortController().signal,
  };
}

export function sessionCompactEvent(options: CompactionEventOptions = {}): object {
  const summary = options.summary ?? "compact summary";
  const tokensBefore = options.tokensBefore ?? 100;
  return {
    type: "session_compact",
    compactionEntry: {
      type: "compaction",
      id: "compaction-entry",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      summary,
      firstKeptEntryId: "entry-1",
      tokensBefore,
    },
    fromExtension: false,
    reason: options.reason ?? "manual",
    willRetry: options.willRetry ?? false,
  };
}

export function sessionShutdownEvent(
  reason: "quit" | "reload" | "new" | "resume" | "fork" = "quit",
): object {
  return { type: "session_shutdown", reason };
}

/**
 * Загружает собранное расширение с пустым профилем Pi: настройки сжатия владельца
 * не должны влиять на тесты цели.
 */
function loadExtension(pi: ExtensionAPI) {
  const agentDir = mkdtempSync(join(tmpdir(), "goal-compact-harness-profile-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  try {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "ru" } }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return compose(pi).goal;
  } finally {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function toolInfo(name: string): ReturnType<ExtensionAPI["getAllTools"]>[number] {
  return {
    name,
    description: "",
    parameters: Type.Object({}),
    exposure: "direct",
    sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
  };
}

export function createRuntimeHarness(options: {
  idle?: boolean;
  mode?: "tui" | "rpc";
  /** Names reported by `pi.getAllTools()`; include `subagent` to simulate pi-subagents being installed. */
  tools?: string[];
  expandedWidget?: boolean;
  pendingMessages?: boolean;
  compactBehavior?: "success" | "error" | "unavailable";
  compactCompletion?: "immediate" | "manual";
  contextWindow?: number;
  contextUsage?: ReturnType<ExtensionContext["getContextUsage"]>;
  commands?: ReturnType<ExtensionAPI["getCommands"]>;
  failCanonicalCompletePersists?: number;
  failAmendmentProjectionPersists?: number;
  /** Optional real session storage; an exception must reach the public caller. */
  persistEntry?: (customType: string, data: unknown) => void;
  /** Project directory for `.pi/goal-reports.json`; defaults to `/tmp`. */
  cwd?: string;
} = {}) {
  const entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]> = [];
  const handlers = new Map<string, EventHandler[]>();
  const sentMessages: SentMessage[] = [];
  const sentUserMessages: SentUserMessage[] = [];
  const tools = new Map<string, (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>>();
  const toolMetadata = new Map<string, { parameters: unknown; description: string; exposure: Parameters<ExtensionAPI["registerTool"]>[0]["exposure"]; promptSnippet: string | undefined; promptGuidelines: string[] | undefined }>();
  const entryRenderers = new Map<string, Parameters<ExtensionAPI["registerEntryRenderer"]>[1]>();
  const widgets: Array<string[] | undefined> = [];
  const compactCalls: Array<{
    customInstructions?: string;
    onComplete?: (result: {
      summary: string;
      tokensBefore: number;
      firstKeptEntryId: string;
    }) => void;
    onError?: (error: Error) => void;
  }> = [];
  const footerStatuses: Array<string | undefined> = [];
  const runtime = {
    abortCount: 0,
    idle: options.idle ?? true,
    pendingMessages: options.pendingMessages ?? false,
    compactBehavior: options.compactBehavior ?? "success",
    compactCompletion: options.compactCompletion ?? "immediate",
    contextUsage: options.contextUsage,
    hostOverflowRecoveryAttempted: false,
  };
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const commandHandlers = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const notifications: string[] = [];
  const terminalInputs = new Set<Parameters<ExtensionContext["ui"]["onTerminalInput"]>[0]>();
  let ctx: ExtensionCommandContext & ExtensionToolContext;
  let entryIndex = 0;
  let canonicalCompleteFailures = options.failCanonicalCompletePersists ?? 0;
  let amendmentProjectionFailures = options.failAmendmentProjectionPersists ?? 0;

  const on = ((event: string, handler: EventHandler) => {
    const currentHandlers = handlers.get(event) ?? [];
    currentHandlers.push(handler);
    handlers.set(event, currentHandlers);
  }) as ExtensionAPI["on"];

  const registerCommand: ExtensionAPI["registerCommand"] = (name, options) => {
    commandHandlers.set(name, options);
  };

  const registerTool: ExtensionAPI["registerTool"] = (tool) => {
    toolMetadata.set(tool.name, { parameters: tool.parameters, description: tool.description, exposure: tool.exposure, promptSnippet: tool.promptSnippet, promptGuidelines: tool.promptGuidelines });
    tools.set(tool.name, (params, signal) =>
      tool.execute(
        "tool-call",
        params as Parameters<typeof tool.execute>[1],
        signal,
        undefined,
        ctx,
      ),
    );
  };

  const registerEntryRenderer: ExtensionAPI["registerEntryRenderer"] = (name, renderer) => {
    entryRenderers.set(name, renderer as Parameters<ExtensionAPI["registerEntryRenderer"]>[1]);
  };

  const pi = {
    appendEntry(customType: string, data: unknown) {
      options.persistEntry?.(customType, data);
      if (
        customType === GOAL_PROJECTION_ENTRY_TYPE &&
        amendmentProjectionFailures > 0 &&
        data && typeof data === "object" &&
        ((typeof (data as { idempotencyKey?: unknown }).idempotencyKey === "string" && (data as { idempotencyKey: string }).idempotencyKey.startsWith("amendment:")) ||
          ((data as { kind?: unknown }).kind === "decision_recorded" &&
            typeof (data as { entry?: { decision?: unknown } }).entry?.decision === "string"))
      ) {
        amendmentProjectionFailures -= 1;
        throw new Error("injected amendment projection persistence failure");
      }
      if (
        customType === CUSTOM_ENTRY_TYPE &&
        canonicalCompleteFailures > 0 &&
        data && typeof data === "object" &&
        (data as { kind?: unknown }).kind === "set" &&
        (data as { goal?: { status?: unknown } }).goal?.status === "complete"
      ) {
        canonicalCompleteFailures -= 1;
        throw new Error("injected canonical completion persistence failure");
      }
      entries.push({
        type: "custom",
        id: `entry-${++entryIndex}`,
        parentId: null,
        timestamp: new Date(0).toISOString(),
        customType,
        data,
      });
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) {
          handler(data);
        }
      },
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? [];
        handlers.push(handler);
        eventHandlers.set(channel, handlers);
        return () => {
          eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((item) => item !== handler));
        };
      },
    },
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    getActiveTools: () => [],
    getAllTools: () => (options.tools ?? []).map((name) => toolInfo(name)),
    getCommands: () => options.commands ?? [],
    getFlag: () => undefined,
    getSessionName: () => undefined,
    getThinkingLevel: () => "medium" as const,
    on,
    registerCommand,
    registerEntryRenderer,
    registerMarkdownTransformer(_transformer: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0]) {},
    registerToolRenderer(_resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0]) {},
    getSettings: () => ({}) as ReturnType<ExtensionAPI["getSettings"]>,
    registerMcpServer(_name: Parameters<ExtensionAPI["registerMcpServer"]>[0], _config: Parameters<ExtensionAPI["registerMcpServer"]>[1]) {},
    unregisterMcpServer(_name: Parameters<ExtensionAPI["unregisterMcpServer"]>[0]) {},
    getMcpServers: () => [],
    registerVirtualModel(_model: Parameters<ExtensionAPI["registerVirtualModel"]>[0]) {},
    unregisterVirtualModel(_provider: Parameters<ExtensionAPI["unregisterVirtualModel"]>[0], _id: Parameters<ExtensionAPI["unregisterVirtualModel"]>[1]) {},
    registerFlag() {
      unsupportedHarnessMethod("pi.registerFlag");
    },
    registerMessageRenderer() {
      unsupportedHarnessMethod("pi.registerMessageRenderer");
    },
    registerProvider() {
      unsupportedHarnessMethod("pi.registerProvider");
    },
    registerShortcut() {},
    registerTool,
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options: Parameters<ExtensionAPI["sendMessage"]>[1]) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(content: Parameters<ExtensionAPI["sendUserMessage"]>[0], options: Parameters<ExtensionAPI["sendUserMessage"]>[1]) {
      sentUserMessages.push({ content, options });
    },
    setActiveTools() {
      unsupportedHarnessMethod("pi.setActiveTools");
    },
    setLabel() {
      unsupportedHarnessMethod("pi.setLabel");
    },
    setModel: async () => false,
    setSessionName() {
      unsupportedHarnessMethod("pi.setSessionName");
    },
    setThinkingLevel() {
      unsupportedHarnessMethod("pi.setThinkingLevel");
    },
    unregisterProvider() {
      unsupportedHarnessMethod("pi.unregisterProvider");
    },
  };

  const sessionManager = {
    buildContextEntries: () => entries,
    getBranch: () => entries,
    getCwd: () => "/tmp",
    getEntries: () => entries,
    getEntry: () => undefined,
    getHeader: () => null,
    getLabel: () => undefined,
    getLeafEntry: () => undefined,
    getLeafId: () => null,
    getSessionDir: () => "/tmp",
    getSessionFile: () => undefined,
    getSessionId: () => "session",
    getSessionName: () => undefined,
    getTree: () => [],
    buildSessionProjection: () => buildProjection(entries),
  } as ExtensionCommandContext["sessionManager"];

  const ui: ExtensionCommandContext["ui"] = {
    addAutocompleteProvider() {},
    confirm: async () => true,
    custom: async () => {
      throw new Error("custom UI is not implemented in this test harness.");
    },
    editor: async () => undefined,
    getAllThemes: () => [],
    getEditorComponent: () => undefined,
    getEditorText: () => "",
    getTheme: () => undefined,
    getToolsExpanded: () => false,
    input: async () => undefined,
    notify(message) { notifications.push(message); },
    onTerminalInput: handler => { terminalInputs.add(handler); return () => { terminalInputs.delete(handler); }; },
    pasteToEditor() {},
    select: async () => undefined,
    setEditorComponent() {},
    setEditorText() {},
    setFooter() {},
    setHeader() {},
    setHiddenThinkingLabel() {},
    setStatus(_key, status) {
      footerStatuses.push(status);
    },
    setTheme: () => ({ success: false }),
    setTitle() {},
    setToolsExpanded() {},
    setWidget(_key, value) { widgets.push(Array.isArray(value) ? [...value] : undefined); },
    setWorkingIndicator() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    theme: {} as ExtensionCommandContext["ui"]["theme"],
  };

  ctx = {
    abort() {
      runtime.abortCount += 1;
    },
    cwd: options.cwd ?? "/tmp",
    fork: async () => ({ cancelled: false }),
    getContextUsage: () => runtime.contextUsage,
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: ctx.cwd }),
    hasUI: true,
    compact(options: Parameters<ExtensionContext["compact"]>[0]) {
      const call: (typeof compactCalls)[number] = {};
      if (options?.customInstructions !== undefined) {
        call.customInstructions = options.customInstructions;
      }
      if (options?.onComplete) {
        call.onComplete = (result) => options.onComplete?.(result);
      }
      if (options?.onError) {
        call.onError = (error) => options.onError?.(error);
      }
      compactCalls.push(call);
      if (runtime.compactBehavior === "unavailable") {
        unsupportedHarnessMethod("ctx.compact");
      }
      if (runtime.compactBehavior === "error") {
        options?.onError?.(new Error("compaction failed"));
        return;
      }
      if (runtime.compactCompletion === "immediate") {
        options?.onComplete?.({
          summary: "compact summary",
          tokensBefore: 100,
          firstKeptEntryId: "entry-1",
        });
      }
    },
    tools: [],
    executeTool: async () => { throw new Error("nested tool execution is not implemented in this test harness."); },
    hasPendingMessages: () => runtime.pendingMessages,
    isIdle: () => runtime.idle,
    isProjectTrusted: () => true,
    // This semantic harness records footer statuses; actual TUI rendering is covered separately.
    scopedModels: [],
    mode: options.mode ?? "rpc",
    model: undefined,
    modelRegistry: { getAll: () => [], find: () => undefined } as unknown as ExtensionCommandContext["modelRegistry"],
    navigateTree: async () => ({ cancelled: false }),
    newSession: async () => ({ cancelled: false }),
    reload: async () => {},
    sessionManager,
    shutdown() {},
    signal: undefined,
    switchSession: async () => ({ cancelled: false }),
    ui,
    waitForIdle: async () => {},
  } as ExtensionCommandContext & ExtensionToolContext;

  if (options.contextWindow !== undefined) {
    ctx.model = {
      id: "test-model",
      provider: "test",
      contextWindow: options.contextWindow,
    } as ExtensionCommandContext["model"];
  }

  let goalSession = loadExtension(pi as unknown as ExtensionAPI);

  function reloadExtension(): void {
    handlers.clear();
    commandHandlers.clear();
    eventHandlers.clear();
    entryRenderers.clear();
    tools.clear();
    goalSession = loadExtension(pi as unknown as ExtensionAPI);
  }

  async function reloadSession(reason: "startup" | "reload" | "resume" = "startup"): Promise<void> {
    reloadExtension();
    await emit("session_start", { type: "session_start", reason });
    await goalSession.waitForGoalProjection();
  }

  async function runSlashCommand(name: string, args = ""): Promise<void> {
    const command = commandHandlers.get(name);
    assert.ok(command, `Expected /${name} to be registered.`);
    await command.handler(args, ctx);
  }

  // Lifecycle fixture, not a slash parser: create the goal with the model tool,
  // then supply a queued continuation explicitly to exercise subsequent events.
  async function runCommand(args: string): Promise<void> {
    const trimmed = args.trim();
    const control = { pause: "gp", resume: "gr", clear: "gc" }[trimmed];
    if (control) {
      await runSlashCommand(control);
      return;
    }
    const before = reconstructGoal(entries).goal;
    await runTool("create_goal", {
      objective: trimmed,
      ...(before && before.status !== "complete" ? { replace_existing: true } : {}),
    });
  }

  async function emit(event: string, payload: object): Promise<unknown[]> {
    if (event === "message_start") {
      const message = (payload as { message?: { role?: string } }).message;
      if (message?.role === "user") {
        runtime.hostOverflowRecoveryAttempted = false;
      }
    }
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler(payload, ctx));
    }
    return results;
  }

  async function runTool(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const tool = tools.get(name);
    assert.ok(tool, `Expected tool ${name} to be registered.`);
    // Legacy test fixtures omit the new reader-facing narrative. Supply one at
    // this boundary; explicit summary values still exercise validation unchanged.
    const input = name === "report_goal_progress" && params.action === "publish" && !("summary" in params)
      ? { ...params, summary: "Проверил состояние цели. Продолжаю следующий шаг." }
      : params;
    return tool(input, signal);
  }

  return {
    getToolMetadata: (name: string) => toolMetadata.get(name),
    compactCalls,
    busListenerCount(channel: string): number {
      return eventHandlers.get(channel)?.length ?? 0;
    },
    onBusEvent(channel: string, handler: (data: unknown) => void) {
      return pi.events.on(channel, handler);
    },
    emitBusEvent(channel: string, data: unknown) {
      pi.events.emit(channel, data);
    },
    footerStatuses,
    goalNotice: () => footerStatuses.at(-1),
    widgetText: () => footerStatuses.at(-1) ?? "",
    widgets,
    emit,
    entries,
    renderEntry(type: string, data: unknown, expanded = false): string[] | null {
      const renderer = entryRenderers.get(type);
      if (!renderer) return null;
      const component = renderer({ type: "custom", customType: type, data } as Parameters<typeof renderer>[0], { expanded } as Parameters<typeof renderer>[1], {} as Parameters<typeof renderer>[2]);
      return component?.render(200) ?? null;
    },
    runCommand,
    waitForGoalProjection: () => goalSession.waitForGoalProjection(),
    runSlashCommand,
    commandNames: () => [...commandHandlers.keys()],
    commandContext: ctx,
    notifications,
    emitTerminalInput: (data: string) => [...terminalInputs].map(handler => handler(data)),
    runTool,
    reloadExtension,
    reloadSession,
    sentMessages,
    sentUserMessages,
    setIdle(idle: boolean) {
      runtime.idle = idle;
    },
    setPendingMessages(pendingMessages: boolean) {
      runtime.pendingMessages = pendingMessages;
    },
    setContextUsage(contextUsage: ReturnType<ExtensionContext["getContextUsage"]>) {
      runtime.contextUsage = contextUsage;
    },
    setContextWindow(contextWindow: number) {
      ctx.model = {
        id: "test-model",
        provider: "test",
        contextWindow,
      } as ExtensionCommandContext["model"];
    },
    get hostOverflowRecoveryAttempted() {
      return runtime.hostOverflowRecoveryAttempted;
    },
    setHostOverflowRecoveryAttempted(value: boolean) {
      runtime.hostOverflowRecoveryAttempted = value;
    },
    get abortCount() {
      return runtime.abortCount;
    },
    snapshot: () => reconstructGoal(entries),
  };
}

export interface TestAssistantUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export function countGoalSetEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "set" &&
      (goalId === undefined || entry.data.goal.goalId === goalId)
    );
  }).length;
}

export function countGoalUsageEntries(
  entries: ReturnType<ExtensionCommandContext["sessionManager"]["getBranch"]>,
  goalId?: string,
): number {
  return entries.filter((entry) => {
    return (
      entry.type === "custom" &&
      entry.customType === CUSTOM_ENTRY_TYPE &&
      isGoalCustomEntry(entry.data) &&
      entry.data.kind === "usage" &&
      (goalId === undefined || entry.data.goalId === goalId)
    );
  }).length;
}

export async function emitToolExecutionEnd(harness: ReturnType<typeof createRuntimeHarness>): Promise<void> {
  await harness.emit("tool_execution_end", {
    type: "tool_execution_end",
    toolCallId: "tool-call",
    toolName: "bash",
    args: {},
    result: {},
    isError: false,
  });
}

export type RuntimeHarness = ReturnType<typeof createRuntimeHarness>;

export function assistantMessage(
  stopReason: "stop" | "aborted" | "length" | "toolUse" | "error",
  usage: TestAssistantUsage,
  errorMessage?: string,
) {
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;

  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead,
      cacheWrite,
      totalTokens: usage.totalTokens ?? usage.input + usage.output + cacheRead + cacheWrite,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: errorMessage ?? "provider error" } : {}),
    timestamp: 1,
  };
}

export async function emitPersistentAssistantError(
  harness: ReturnType<typeof createRuntimeHarness>,
  turnIndex: number,
  errorMessage: string,
): Promise<void> {
  const message = assistantMessage("error", { input: 1, output: 1 }, errorMessage);
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  await harness.waitForGoalProjection();
  if (isContextOverflowError(errorMessage)) {
    harness.setHostOverflowRecoveryAttempted(true);
  }
}

export async function emitHostSessionCompact(
  harness: RuntimeHarness,
  options: CompactionEventOptions = {},
): Promise<void> {
  const eventOptions: CompactionEventOptions = { reason: "overflow", ...options };
  await harness.emit("session_before_compact", sessionBeforeCompactEvent(eventOptions));
  await harness.emit("session_compact", sessionCompactEvent(eventOptions));
}

export async function emitSilentContextOverflow(
  harness: RuntimeHarness,
  turnIndex: number,
  message: ReturnType<typeof assistantMessage>,
): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start", turnIndex, timestamp: turnIndex + 1 });
  await harness.emit("turn_end", {
    type: "turn_end",
    turnIndex,
    message,
    toolResults: [],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [message],
  });
  harness.setHostOverflowRecoveryAttempted(true);
}

/** Semantic recovery/links scenarios inspect details explicitly, rather than relying on the UI default. */
export function createExpandedRuntimeHarness(options: Parameters<typeof createRuntimeHarness>[0] = {}) {
  return createRuntimeHarness({ ...options, expandedWidget: true });
}
