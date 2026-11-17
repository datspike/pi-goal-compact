import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { compose } from "../../src/index.js";

const astra = "gpt-6.2-astra";
const sol = "gpt-6.2-sol";
const usage = { input: 12, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const objective = "Проверить восстановление запроса после сохранённого результата.";
const makeGoal = { objective, agreement: { owner_wants: objective, done_when: "Проверка прошла." }, self_decided: [] };
const hold = { action: "publish", status: "awaiting_user", phase: "Готово", summary: "Проверка пройдена.", nextStep: "Дождаться решения.", needUser: "Продолжить работу?" };

type Variant = "switch" | "disabled" | "escape" | "escape-during-selection";

async function run(variant: Variant) {
  const cwd = await mkdtemp(join(tmpdir(), "goal-provider-retry-"));
  const requests: { model: string; context: string }[] = [];
  const statuses: string[] = [];
  const terminals = new Set<Parameters<ExtensionUIContext["onTerminalInput"]>[0]>();
  const escape = () => { for (const listener of terminals) listener("\u001b"); };
  const failures: string[] = [];
  let standardRetries = 0;
  const manager = SessionManager.inMemory(cwd);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const models = [astra, sol].map(id => ({ id, name: id, reasoning: false, input: ["text" as const], cost: usage.cost, contextWindow: 64_000, maxTokens: 1024 }));
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noContextFiles: true, noExtensions: true, extensionFactories: [pi => {
    pi.registerProvider("openai", { api: "retry-probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models, streamSimple(model, context) {
      const n = requests.length;
      requests.push({ model: model.id, context: JSON.stringify(context) });
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage,
        stopReason: n === 1 || n === 2 ? "error" : n === 0 || n === 3 ? "toolUse" : "stop",
        content: n === 0 ? [{ type: "toolCall", id: "fixture-goal", name: "create_goal", arguments: makeGoal }]
          : n === 3 ? [{ type: "toolCall", id: "fixture-hold", name: "report_goal_progress", arguments: hold }]
          : n < 3 ? [] : [{ type: "text", text: "Готов полезный результат." }],
        ...(n === 1 || n === 2 ? { errorMessage: '503 {"error":{"code":"server_is_overloaded"}}' } : {}) };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
        else stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      });
      return stream;
    } });
    const api = variant === "escape-during-selection" ? { ...pi, async setModel(model: Parameters<typeof pi.setModel>[0]) {
      const ok = await pi.setModel(model);
      if (model.id === sol) escape();
      return ok;
    } } : pi;
    compose(api, { enabled: true, windowMs: variant === "escape" ? 60_000 : 0, allowSwitch: variant !== "disabled" });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: { ...models[0]!, provider: "openai", api: "retry-probe", baseUrl: "http://127.0.0.1:1" }, resourceLoader: loader, sessionManager: manager, noTools: "builtin", settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }) });
  try {
    session.subscribe(event => { if (event.type === "auto_retry_start") standardRetries++; });
    const methods: Partial<ExtensionUIContext> = {
      onTerminalInput(handler) { terminals.add(handler); return () => { terminals.delete(handler); }; },
      setStatus(_key, value) {
        if (!value) return;
        statuses.push(value);
        if (variant === "escape" && value.includes("Esc")) setImmediate(escape);
      },
    };
    const ui = new Proxy(methods as ExtensionUIContext, { get(target, name) { return Reflect.get(target, name) ?? (() => {}); } });
    await session.bindExtensions({ uiContext: ui, mode: "tui", abortHandler: () => { void session.abort(); }, onError(error) { failures.push(error.error); } });
    await session.prompt("Проверь восстановление.");
    assert.deepEqual(failures, []);
    return { requests, statuses, rows: manager.getBranch(), model: session.model?.id, standardRetries };
  } finally {
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
    finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
  }
}

test("SDK: после штатного повтора Astra передаёт тот же запрос на Sol", { timeout: 8_000 }, async () => {
  const { requests, rows, standardRetries } = await run("switch");
  assert.equal(standardRetries, 1);
  assert.deepEqual(requests.map(request => request.model), [astra, astra, astra, sol, sol]);
  assert.equal(requests[1]?.context, requests[2]?.context);
  assert.equal(requests[1]?.context, requests[3]?.context);
  assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "create_goal").length, 1);
  assert.ok(rows.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === "Готов полезный результат.")));
});

for (const variant of ["disabled", "escape", "escape-during-selection"] as const) {
  test(`SDK: не отправляет повтор после остановки (${variant})`, { timeout: 8_000 }, async () => {
    const { requests, statuses, model, standardRetries } = await run(variant);
    assert.equal(standardRetries, 1);
    assert.deepEqual(requests.map(request => request.model), [astra, astra, astra]);
    assert.equal(model, astra);
    if (variant === "escape") assert.ok(statuses.some(status => status.includes("Esc")));
  });
}
