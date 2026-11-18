import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { compose } from "../../src/index.js";

const astra = "gpt-6.2-astra";
const sol = "gpt-6.2-sol";
const chosen = "manually-chosen-fixture";
const usage = { input: 12, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const objective = "Проверить восстановление запроса после сохранённого результата.";
const makeGoal = { objective, agreement: { owner_wants: objective, done_when: "Проверка прошла." }, self_decided: [] };
const hold = { action: "publish", status: "awaiting_user", phase: "Готово", summary: "Проверка пройдена.", nextStep: "Дождаться решения.", needUser: "Продолжить работу?" };
const newInput = "Новая реплика отменяет прежний запрос.";
const newAnswer = "Ответ только на новую реплику.";
const secondInput = "Следующая реплика с вложением.";
const attachment = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==" };

type Variant = "switch" | "disabled" | "escape" | "escape-during-selection" | "unknown-abort" | "plain-chat" | "chat-recovery" | "chat-manual" | "chat-manual-stale" | "chat-manual-unsafe" | "legacy-owner" | "retry-after" | "manual-after-admit" | "manual-during-selection" | "input-after-admit" | "input-after-send" | "input-after-escape" | "input-after-model-change" | "output-empty" | "output-length" | "output-cancel" | "output-mixed-cap" | "output-unsafe" | "output-goal-length" | "output-goal-empty" | "output-goal-cap";

async function run(variant: Variant) {
  const cwd = await mkdtemp(join(tmpdir(), "goal-provider-retry-"));
  const requests: { model: string; context: string }[] = [];
  const statuses: string[] = [];
  const terminals = new Set<Parameters<ExtensionUIContext["onTerminalInput"]>[0]>();
  const escape = () => { for (const listener of terminals) listener("\u001b"); };
  const failures: string[] = [];
  let standardRetries = 0;
  let toolExecutions = 0;
  const output = variant.startsWith("output-");
  const outputGoal = variant.startsWith("output-goal-");
  let goal: ReturnType<typeof compose>["goal"] | undefined;
  let submit: ((second?: boolean) => Promise<void>) | undefined;
  const manager = SessionManager.inMemory(cwd);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const models = [astra, sol, chosen].map(id => ({ id, name: id, reasoning: false, input: ["text" as const, "image" as const], cost: usage.cost, contextWindow: 64_000, maxTokens: 1024 }));
  const userModel = { ...models[2]!, provider: "openai" as const, api: "retry-probe", baseUrl: "http://127.0.0.1:1" };
  const loader = new DefaultResourceLoader({ cwd, agentDir: join(cwd, "agent"), noContextFiles: true, noExtensions: true, extensionFactories: [pi => {
    if (variant.startsWith("chat-manual") || output) pi.registerTool({ name: "retry_fixture", label: "Проверка", description: "Возвращает результат для теста повтора", parameters: Type.Object({}), async execute() {
      toolExecutions++;
      if (variant === "chat-manual-unsafe" || variant === "output-unsafe") throw new Error("Исход не подтверждён");
      return { content: [{ type: "text", text: "Сохранённый ответ инструмента." }], details: {} };
    } });
    pi.registerProvider("openai", { api: "retry-probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models, streamSimple(model, context, options) {
      const n = requests.length;
      requests.push({ model: model.id, context: JSON.stringify(context) });
      const unknownAbort = variant === "unknown-abort" && n === 1;
      const explicit = variant.startsWith("chat-manual");
      const plain = variant === "plain-chat" || variant === "chat-recovery" || explicit;
      const plainFailed = explicit ? n === 1 || n === 2 : n < (variant === "chat-recovery" ? 2 : 1);
      const fixtureTool = explicit && n === 0;
      const newTurn = variant.startsWith("input-") && JSON.stringify(context).includes(newInput);
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage,
        stopReason: newTurn ? "stop" : unknownAbort ? "aborted" : plain ? (fixtureTool ? "toolUse" : plainFailed ? "error" : "stop") : n === 1 || n === 2 ? "error" : n === 0 || n === 3 ? "toolUse" : "stop",
        content: newTurn ? [{ type: "text", text: newAnswer }] : plain ? (fixtureTool ? [{ type: "toolCall", id: "manual-fixture-tool", name: "retry_fixture", arguments: {} }]
          : plainFailed ? [] : [{ type: "text", text: "Обычный ответ после повтора." }])
          : n === 0 ? [{ type: "toolCall", id: "fixture-goal", name: "create_goal", arguments: makeGoal }]
          : n === 3 ? [{ type: "toolCall", id: "fixture-hold", name: "report_goal_progress", arguments: hold }]
          : n < 3 ? [] : [{ type: "text", text: "Готов полезный результат." }],
        ...(unknownAbort ? { errorMessage: "Operation aborted" } : (plain ? plainFailed : n === 1 || n === 2) ? {
          errorMessage: `${variant === "retry-after" ? "Server requested 60s retry delay (max: 15s). " : ""}503 {"error":{"code":"server_is_overloaded"}}`,
        } : {}) };
      if (output) {
        if (n === 0) {
          message.stopReason = "toolUse";
          message.content = outputGoal ? [{ type: "toolCall", id: "output-goal", name: "create_goal", arguments: makeGoal }]
            : [{ type: "toolCall", id: "output-fixture-tool", name: "retry_fixture", arguments: {} }];
        } else if (outputGoal && n === 3 && variant !== "output-goal-cap") {
          message.stopReason = "toolUse";
          message.content = [{ type: "toolCall", id: "output-goal-hold", name: "report_goal_progress", arguments: hold }];
        } else if (variant === "output-mixed-cap" && (n === 1 || n === 3) || n === 1 && (variant === "output-empty" || variant === "output-goal-empty" || variant === "output-unsafe")) {
          message.stopReason = "stop";
          message.content = [{ type: "thinking", thinking: "Без готового ответа." }];
        } else if (n === 1 || variant === "output-goal-cap" || variant === "output-mixed-cap" && n === 2) {
          message.stopReason = "length";
          message.content = [{ type: "text", text: "Начало оборванного ответа." }];
        } else {
          message.stopReason = "stop";
          message.content = [{ type: "text", text: variant === "output-cancel" ? newAnswer : "Окончание ответа." }];
        }
        delete message.errorMessage;
      }
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        await options?.onPayload?.({ model: model.id }, model);
        if (n === 3 && variant === "input-after-send") await submit?.();
        if (n === 3 && variant === "input-after-escape") {
          escape();
          await submit?.();
          await submit?.(true);
        }
        if (message.stopReason !== "error" && message.stopReason !== "aborted") await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: "start", partial: message });
        if (message.stopReason === "error" || message.stopReason === "aborted") stream.push({ type: "error", reason: message.stopReason, error: message });
        else if (message.stopReason !== "pending") stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    } });
    const api = variant === "escape-during-selection" || variant === "manual-during-selection" ? { ...pi, async setModel(model: Parameters<typeof pi.setModel>[0]) {
      if (model.id === sol && variant === "manual-during-selection") await pi.setModel(userModel);
      const ok = await pi.setModel(model);
      if (model.id === sol && variant === "escape-during-selection") escape();
      return ok;
    } } : pi;
    if (variant === "legacy-owner") pi.registerCommand("retry", { description: "Занятая старым расширением команда", handler: async () => {} });
    ({ goal } = compose(api, { enabled: true, windowMs: variant === "escape" ? 60_000 : 0, allowSwitch: variant !== "disabled" && !variant.startsWith("chat-manual") }));
    if (variant === "output-cancel") pi.on("agent_before_settle", async event => {
      if (event.continue) { escape(); await submit?.(); }
    });
    if (variant === "manual-after-admit") pi.on("agent_before_settle", async event => {
      if (event.continue) await pi.setModel(userModel);
    });
    if (variant === "input-after-admit" || variant === "input-after-model-change") pi.on("agent_before_settle", async event => {
      if (!event.continue) return;
      if (variant === "input-after-model-change") await pi.setModel(userModel);
      await submit?.();
    });
    if (variant === "input-after-admit" || variant === "input-after-send") pi.on("turn_end", (event, ctx) => {
      if (event.message.role === "assistant" && event.message.content.some(part => part.type === "text" && part.text === newAnswer)) goal?.pauseManually(ctx);
    });
  }] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: { ...models[0]!, provider: "openai", api: "retry-probe", baseUrl: "http://127.0.0.1:1" }, resourceLoader: loader, sessionManager: manager, noTools: "builtin", settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 }, compaction: { enabled: false } }) });
  submit = (second = false) => session.prompt(second ? secondInput : newInput, { streamingBehavior: "steer", ...(second ? { images: [attachment] } : {}) });
  try {
    session.subscribe(event => { if (event.type === "auto_retry_start") standardRetries++; });
    const methods: Partial<ExtensionUIContext> = {
      notify() {},
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
    if (variant === "chat-manual-stale") await session.prompt("Это другая просьба.");
    if (variant.startsWith("chat-manual")) {
      await session.prompt("/retry-request");
      await session.waitForIdle();
    }
    assert.deepEqual(failures, []);
    return { requests, statuses, rows: manager.getBranch(), toolExecutions, model: session.model?.id, standardRetries, pause: goal?.getGoal()?.pause };
  } finally {
    try {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await goal?.waitForGoalProjection();
    } finally {
      session.dispose();
      await rm(cwd, { recursive: true, force: true, maxRetries: 4 });
    }
  }
}

test("SDK: пустой ответ повторяет запрос, не перезапуская инструмент", async () => {
  for (const variant of ["output-empty", "output-goal-empty"] as const) {
    const { requests, toolExecutions } = await run(variant);
    assert.equal(toolExecutions, variant === "output-empty" ? 1 : 0);
    assert.equal(requests.length, variant === "output-empty" ? 3 : 5);
    assert.equal(requests[1]?.context, requests[2]?.context);
  }
});

test("SDK: продолжение после предела сохраняет текст в чате и у цели", async () => {
  for (const variant of ["output-length", "output-goal-length"] as const) {
    const { requests, rows } = await run(variant);
    assert.equal(requests.length, variant === "output-length" ? 3 : 5);
    assert.match(requests[2]!.context, /Начало оборванного ответа/);
    assert.ok(rows.some(row => row.type === "message" && row.message.role === "assistant" && row.message.content.some(part => part.type === "text" && part.text === "Окончание ответа.")));
  }
});

test("SDK: после трёх продолжений усечённого ответа цель не запускает ещё один запрос", async () => {
  const { requests, pause, rows } = await run("output-goal-cap");
  assert.equal(requests.length, 5);
  assert.equal(pause?.kind, "recovery");
  assert.ok(rows.some(row => row.type === "custom" && (row.data as { reason?: string } | undefined)?.reason === "length-limit"));
});

test("SDK: чередование причин не возвращает право ещё раз повторять пустой ответ", async () => {
  const { requests, rows } = await run("output-mixed-cap");
  assert.equal(requests.length, 4);
  assert.ok(rows.some(row => row.type === "custom" && (row.data as { reason?: string } | undefined)?.reason === "empty-limit"));
});

test("SDK: после отмены скрытая просьба дописать не попадает в новую реплику", async () => {
  const { requests, rows } = await run("output-cancel");
  assert.equal(requests.length, 3);
  assert.match(requests[2]!.context, new RegExp(newInput.replace(/\.$/, "")));
  assert.doesNotMatch(requests[2]!.context, /Продолжи ответ с места остановки|Continue the answer from where it stopped/);
  assert.equal(rows.filter(row => row.type === "message" && row.message.role === "user" && JSON.stringify(row.message.content).includes(newInput)).length, 1);
});

test("SDK: пустой ответ не перезапускает работу, если исход инструмента неизвестен", async () => {
  const { requests, toolExecutions, rows } = await run("output-unsafe");
  assert.equal(requests.length, 2);
  assert.equal(toolExecutions, 1);
  assert.ok(rows.some(row => row.type === "custom" && (row.data as { reason?: string } | undefined)?.reason === "unsafe-tool-result"));
});

test("SDK: после штатного повтора Astra передаёт тот же запрос на Sol", { timeout: 8_000 }, async () => {
  const { requests, rows, standardRetries } = await run("switch");
  assert.equal(standardRetries, 1);
  assert.deepEqual(requests.map(request => request.model), [astra, astra, astra, sol, sol]);
  assert.equal(requests[1]?.context, requests[2]?.context);
  assert.equal(requests[1]?.context, requests[3]?.context);
  assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "create_goal").length, 1);
  assert.ok(rows.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === "Готов полезный результат.")));
  const trace = rows.flatMap(entry => entry.type === "custom" && entry.customType === "pi-goal-provider-retry" ? [entry.data as Record<string, unknown>] : []);
  const prepared = trace.find(entry => entry.kind === "request-prepared");
  const result = trace.find(entry => entry.kind === "request-result");
  assert.ok(prepared?.runId && prepared.failureEntryId && prepared.failureRequestId);
  assert.equal(prepared.branchEntryId, prepared.failureEntryId);
  assert.notEqual(prepared.requestId, prepared.failureRequestId);
  assert.equal(prepared.requestStage, "prepared-unconfirmed");
  assert.equal(result?.requestId, prepared.requestId);
  assert.notEqual(result?.branchEntryId, prepared.branchEntryId);
  assert.equal(result?.reason, "toolUse");
  assert.equal(result?.requestStage, "response-observed");
  assert.equal(result?.httpStatus, 200);
  assert.ok(!JSON.stringify(trace).includes("server_is_overloaded"));
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

test("SDK: отмена без Esc не повторяется и не записывается как ручная", { timeout: 8_000 }, async () => {
  const { requests, pause, standardRetries, rows } = await run("unknown-abort");
  assert.equal(standardRetries, 0);
  assert.equal(requests.length, 2);
  assert.equal(pause?.kind, "recovery");
  assert.match(pause?.reason ?? "", /источник отмены неизвестен|cancellation source unknown/);
  const cancelled = rows.flatMap(entry => entry.type === "custom" && entry.customType === "pi-goal-provider-retry" ? [entry.data as Record<string, unknown>] : []).filter(data => data.kind === "cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.reason, "unknown");
  assert.equal(cancelled[0]?.requestStage, "prepared-unconfirmed");
  assert.ok(cancelled[0]?.requestId && cancelled[0]?.branchEntryId);
});

test("SDK: успех штатного повтора в обычном чате не запускает дополнительный", { timeout: 8_000 }, async () => {
  const { requests, standardRetries, rows } = await run("plain-chat");
  assert.equal(standardRetries, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.context, requests[1]?.context);
  assert.ok(!rows.some(entry => entry.type === "custom" && entry.customType === "pi-goal-provider-retry"));
});

test("SDK: обычный чат после штатного отказа продолжает тот же ход на Sol", { timeout: 8_000 }, async () => {
  const { requests, rows, standardRetries, pause } = await run("chat-recovery");
  assert.equal(standardRetries, 1);
  assert.deepEqual(requests.map(request => request.model), [astra, astra, sol]);
  assert.ok(requests.every(request => request.context === requests[0]?.context));
  assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
  assert.ok(rows.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === "Обычный ответ после повтора.")));
  assert.equal(pause, undefined);
});

test("SDK: при наличии старого владельца новая смена модели не запускается", { timeout: 8_000 }, async () => {
  const { requests, model } = await run("legacy-owner");
  assert.equal(requests.length, 3);
  assert.equal(model, astra);
});

test("SDK: Retry-After за пределом окна не допускает даже штатный ранний повтор", { timeout: 8_000 }, async () => {
  const { requests, model, pause, standardRetries } = await run("retry-after");
  assert.equal(standardRetries, 0);
  assert.deepEqual(requests.map(request => request.model), [astra, astra]);
  assert.equal(model, astra);
  assert.equal(pause?.kind, "recovery");
  assert.match(pause?.reason ?? "", /Провайдер просит ждать|Provider asks to wait/);
});

for (const variant of ["manual-after-admit", "manual-during-selection"] as const) {
  test(`SDK: ручной выбор модели отменяет старую отправку (${variant})`, { timeout: 8_000 }, async () => {
    const { requests, model, pause } = await run(variant);
    assert.deepEqual(requests.map(request => request.model), [astra, astra, astra]);
    assert.equal(model, chosen);
    assert.equal(pause?.kind, "recovery");
    assert.match(pause?.reason ?? "", /Модель изменена вручную|Model changed manually/);
  });
}

for (const variant of ["input-after-admit", "input-after-send"] as const) {
  test(`SDK: новая реплика отменяет прежний повтор (${variant})`, { timeout: 8_000 }, async () => {
    const { requests, rows } = await run(variant);
    assert.equal(requests.length, variant === "input-after-admit" ? 4 : 5);
    assert.equal(requests.filter(request => request.context.includes(newInput)).length, 1);
    assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(newInput)).length, 1);
    assert.ok(rows.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === newAnswer)));
    assert.ok(!rows.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "fixture-hold" && !entry.message.isError));
  });
}

test("SDK: после Esc новый ввод с вложением приходит по порядку, а цель остаётся на ручной паузе", { timeout: 8_000 }, async () => {
  const { requests, rows, pause } = await run("input-after-escape");
  assert.equal(pause?.kind, "manual");
  assert.deepEqual(requests.map(request => request.model), [astra, astra, astra, sol, sol, sol]);
  assert.ok(requests[4]?.context.includes(newInput) && !requests[4].context.includes(secondInput));
  assert.ok(requests[5]?.context.includes(secondInput));
  const users = rows.flatMap(entry => entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []);
  assert.deepEqual(users.slice(1), [[{ type: "text", text: newInput }], [{ type: "text", text: secondInput }, attachment]]);
  assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === newAnswer)).length, 2);
  assert.ok(!rows.some(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "fixture-hold" && !entry.message.isError));
});

test("SDK: после ручной смены модели новая реплика идёт в выбранную модель, не возобновляя цель", { timeout: 8_000 }, async () => {
  const { requests, rows, pause } = await run("input-after-model-change");
  assert.deepEqual(requests.map(request => request.model), [astra, astra, astra, chosen]);
  assert.equal(pause?.kind, "recovery");
  assert.equal(requests.filter(request => request.context.includes(newInput)).length, 1);
  assert.ok(rows.some(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some(part => part.type === "text" && part.text === newAnswer)));
});

test("SDK: явный повтор чата сохраняет запрос и не повторяет принятый инструмент", async () => {
  const { requests, rows, toolExecutions } = await run("chat-manual");
  assert.equal(toolExecutions, 1);
  assert.deepEqual(requests.map(request => request.model), [astra, astra, astra, astra]);
  assert.equal(requests[1]?.context, requests[3]?.context);
  const marker = rows.find(entry => entry.type === "custom_message" && entry.customType === "pi-goal-provider-retry-request");
  assert.ok(marker && rows.some(entry => entry.type === "context_edit" && entry.targetId === marker.id && entry.replacement === null));
  assert.equal(rows.filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
});

test("SDK: явный повтор не берёт неизвестное действие или ошибку старого хода", async () => {
  for (const [variant, count] of [["chat-manual-unsafe", 2], ["chat-manual-stale", 4]] as const) {
    const { requests, rows, toolExecutions } = await run(variant);
    assert.equal(requests.length, count);
    assert.equal(toolExecutions, 1);
    assert.ok(!rows.some(entry => entry.type === "custom_message" && entry.customType === "pi-goal-provider-retry-request"));
  }
});
