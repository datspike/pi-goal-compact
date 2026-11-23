import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../src/index.js";

const FREE_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function usageOf(input: number, output: number): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: FREE_COST };
}
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
/** Ответ без полей модели: маршрут и время подставляет подставной провайдер. */
type Reply = Omit<AssistantMessage, "api" | "provider" | "model" | "timestamp">;

const OVERFLOW = "This model's maximum context length is 1048576 tokens; the prompt has 1050780 tokens (max_model_len)";
const AGREEMENT = { owner_wants: "Проверить восстановление после переполнения.", done_when: "Цель стоит на паузе без скрытого продолжения." };

/** Модель реестра: объявленное окно, которое режим economy урезает до 272 000. */
function modelOf(provider: string, id: string, contextWindow: number) {
  return { id, name: id, reasoning: false, input: ["text" as const], cost: FREE_COST, contextWindow, maxTokens: 4096 };
}

async function withSession(
  name: string,
  contextWindow: number,
  script: (step: number) => Reply,
  run: (fixture: { session: Awaited<ReturnType<typeof createAgentSession>>["session"]; entries: () => readonly unknown[]; api: ExtensionAPI; requests: number[] }) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), `recovery-${name}-`));
  const provider = `${name}-probe`;
  const requests: number[] = [];
  let step = 0;
  let api: ExtensionAPI | undefined;
  const models = [modelOf(provider, "big", contextWindow)];
  const config = {
    api: provider,
    baseUrl: "http://127.0.0.1:1",
    apiKey: "offline",
    models,
    streamSimple(model: { api: string; provider: string; id: string; contextWindow?: number }) {
      requests.push(model.contextWindow ?? 0);
      const planned = script(++step);
      const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
      return response({ ...base, ...planned });
    },
  };
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noContextFiles: true, noExtensions: true, extensionFactories: [pi => {
    api = pi;
    extension(pi);
    pi.registerProvider(provider, config);
  }] });
  await loader.reload();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const declared = { provider, api: provider, baseUrl: "http://127.0.0.1:1", id: "big", name: "big", reasoning: false, input: ["text" as const], cost: FREE_COST, contextWindow, maxTokens: 4096 };
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: declared, resourceLoader: loader, sessionManager: manager, noTools: "builtin",
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }) });
  const close = async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    session.dispose();
    // Pi дописывает свои файлы после dispose: ждём освобождения каталога.
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  };
  try {
    await session.bindExtensions({});
    assert.ok(api, "расширение получило API Pi");
    await run({ session, entries: () => manager.getEntries(), api, requests });
  } finally { await close(); }
}

test("настоящий SDK возвращает окно режима после тихой пересборки модели хостом", { timeout: 30_000 }, async () => {
  await withSession("window", 600_000, () => ({
    role: "assistant", stopReason: "stop", usage: usageOf(10, 1), content: [{ type: "text", text: "Готово" }],
  }), async ({ session, api, requests }) => {
    assert.equal(session.model?.contextWindow, 272_000, "economy применил окно режима");
    await session.prompt("Первый ход");
    // Повторная регистрация провайдера пересобирает текущую модель из реестра без события model_select.
    api.registerProvider("window-probe", { api: "window-probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: [modelOf("window-probe", "big", 600_000)] });
    assert.equal(session.model?.contextWindow, 600_000, "окно молча откатилось к объявленному");
    await session.prompt("Второй ход");
    await session.waitForIdle();
    assert.deepEqual(requests, [272_000, 272_000], "запрос снова идёт в окне режима");
    assert.equal(session.model?.contextWindow, 272_000, "окно режима восстановлено");
  });
});

test("настоящий SDK останавливает цель после переполнения и обрыва по length", { timeout: 30_000 }, async () => {
  const overflow = (): Reply => ({ role: "assistant", stopReason: "error", errorMessage: OVERFLOW, usage: usageOf(70_000, 0), content: [] });
  const plan: Record<number, () => Reply> = {
    1: () => ({ role: "assistant", stopReason: "toolUse", usage: usageOf(100, 20),
      content: [{ type: "toolCall", id: "call-goal", name: "create_goal", arguments: { objective: "Довести проверку переполнения до паузы.", agreement: AGREEMENT, self_decided: [] } }] }),
    2: overflow,
    3: () => ({ role: "assistant", stopReason: "length", usage: usageOf(1_000, 4_096), content: [{ type: "text", text: "Ответ оборван по пределу вывода" }] }),
    4: overflow,
  };
  await withSession("recovery", 64_000, step => (plan[step] ?? overflow)(), async ({ session, entries, requests }) => {
    await session.prompt("Поставь цель и начни проверку.");
    await session.prompt("Продолжай после ошибки.", { source: "extension" });
    await session.prompt("Продолжай после второго переполнения.", { source: "extension" });
    // Дожидаемся покоя: позднее скрытое продолжение тоже попадёт в счётчик запросов.
    await session.waitForIdle();
    const goals = entries().flatMap(entry => {
      const row = entry as { customType?: string; data?: { goal?: { status?: string } } };
      return row.customType === "goal-compact-goal" && row.data?.goal ? [row.data.goal] : [];
    });
    assert.equal(goals.at(-1)?.status, "paused", `цель остановлена после двух переполнений: ${JSON.stringify(goals)}`);
    assert.equal(requests.length, 4, "после паузы нет скрытого продолжения");
  });
});
