import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.js";

const usage = { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function response(message: AssistantMessage) {
 const stream = createAssistantMessageEventStream();
 queueMicrotask(() => {
  stream.push({ type: "start", partial: message });
  if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
  else stream.push({ type: "done", reason: "stop", message });
  stream.end();
 });
 return stream;
}
test("настоящий SDK при overflow сжимает старой моделью и повторяет запрос только новой", { timeout: 20000 }, async () => {
 const cwd = await mkdtemp(join(tmpdir(), "model-transfer-sdk-"));
 const trace: string[] = [];
 let work = 0;
 const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
 const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
 const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noContextFiles: true, noExtensions: true, extensionFactories: [pi => {
  extension({ ...pi, registerCommand(name, options) { commands.set(name, options); pi.registerCommand(name, options); } });
  pi.registerProvider("transfer-probe", { api: "transfer-probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: ["old", "small"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: id === "old" ? 272000 : 64000, maxTokens: 1024 })),
   streamSimple(model, context) {
    const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage };
    const isSummary = JSON.stringify(context).includes("context summarization assistant");
    trace.push(`${model.id}:${isSummary ? "summary" : "work"}`);
    if (isSummary) return response({ ...base, stopReason: "stop", content: [{ type: "text", text: "## Цель\nПродолжить проверку.\n\n## Исходный запрос\nСохранить решение и закончить проверку." }] });
    work++;
    if (work === 1) return response({ ...base, stopReason: "error", errorMessage: "maximum context length exceeded", content: [] });
    return response({ ...base, stopReason: "stop", content: [{ type: "text", text: "DONE" }] });
   },
  });
  pi.on("session_start", async (_event, ctx) => { await commands.get("model-next")?.handler("transfer-probe/small", ctx as ExtensionCommandContext); });
 }] });
 await loader.reload();
 const manager = SessionManager.create(cwd, join(cwd, "sessions"));
 for (let i = 0; i < 3; i++) manager.appendMessage({ role: "user", content: "Offline fixture ".repeat(2000), timestamp: Date.now() });
 const oldModel = { provider: "transfer-probe", id: "old", name: "Old", api: "transfer-probe", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1024 };
 const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: oldModel, resourceLoader: loader, sessionManager: manager, noTools: "builtin", settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 } }) });
 try {
  await session.bindExtensions({});
  await session.prompt("Continue the fixture.");
  assert.equal(session.model?.id, "small");
  assert.equal(trace[0], "old:work");
  assert.equal(trace.at(-1), "small:work");
  assert.ok(trace.length >= 3 && trace.slice(1, -1).every(item => item === "old:summary"));
  assert.equal(manager.getBranch().filter(entry => entry.type === "compaction").length, 1);
 } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
