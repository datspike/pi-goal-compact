import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Provider, type Context } from "@earendil-works/pi-ai";
import { SessionManager, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { AppendRoute } from "../../src/shell/append-route.js";
import { asPi } from "../support/as-pi.js";

function fixture() {
    const manager = SessionManager.inMemory("/workspace/project");
    const user = { role: "user" as const, content: "Сохранить предметный факт", timestamp: 1 };
    manager.appendMessage(user);
    const model = asPi<NonNullable<ExtensionContext["model"]>>({ provider: "fixture", id: "model", api: "openai-responses", baseUrl: "http://127.0.0.1:1", maxTokens: 8192, contextWindow: 272000 });
    const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "## Цель\nПродолжить работу" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 2,
        usage: { input: 100, output: 10, cacheRead: 90, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const sent: unknown[] = [];
    let mutation = false;
    let limitMutation = false;
    const base = asPi<Provider>({ id: "fixture", streamSimple(_model: unknown, context: Context, options: Parameters<Provider["streamSimple"]>[2]) {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(async () => {
            try {
                let payload: unknown = { model: model.id, input: context.messages, max_output_tokens: options?.maxTokens, instructions: "unchanged", tools: [{ name: "read" }] };
                payload = (await options?.onPayload?.(payload, model)) ?? payload;
                sent.push(payload);
                stream.push({ type: "done", reason: response.stopReason as "stop", message: response }); stream.end();
            } catch (error) {
                stream.push({ type: "error", reason: "error", error: { ...response, stopReason: "error", errorMessage: String(error) } }); stream.end();
            }
        });
        return stream;
    } });
    base.stream = (model, context, options) => base.streamSimple(model, context, { ...options, toolChoice: "none" });
    let registered: Provider | undefined = base;
    const registry = asPi<ExtensionContext["modelRegistry"]>({ getProvider: () => registered, getRegisteredNativeProvider: () => registered, getRegisteredProviderConfig: () => undefined,
        registerProvider: (provider: Provider) => { registered = provider; }, unregisterProvider: () => { registered = undefined; } });
    const ctx = asPi<ExtensionContext>({ model, modelRegistry: registry, sessionManager: manager });
    const records: unknown[] = [];
    const route = new AppendRoute(record => records.push(record));
    route.install(ctx);
    const controller = new AbortController();
    const event = asPi<SessionBeforeCompactEvent>({ signal: controller.signal });
    const warm = async (method: "stream" | "streamSimple" = "streamSimple", historyFirst = false) => {
        await registered![method](model, normalizeContext({ messages: historyFirst ? [user, { role: "system", content: "System", timestamp: 0 }] : [{ role: "system", content: "System", timestamp: 0 }, user] }), { sessionId: manager.getSessionId(), onPayload: (payload: unknown) => {
            if (mutation) (payload as { input: unknown[] }).input[0] = { changed: true };
            if (limitMutation) (payload as { max_output_tokens: number }).max_output_tokens = 128000;
            return payload;
        } }).result();
        manager.appendMessage(response);
    };
    return { route, ctx, event, warm, user, model, sent, manager, controller, records, mutate: () => { mutation = true; }, mutateLimit: () => { limitMutation = true; } };
}

test("append продолжает окончательный запрос и не повторяет полную историю в задании", async () => {
    const f = fixture(); await f.warm();
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    const task = transport.prompt([f.user], "Инструкции сводки", undefined, []);
    await transport.request(f.model, task, { maxTokens: 1024, signal: f.controller.signal });
    const [working, append] = f.sent as { input: unknown[]; tools: unknown }[];
    assert.deepEqual(append!.input.slice(0, working!.input.length), working!.input);
    assert.deepEqual(append!.tools, working!.tools);
    assert.equal(append!.input.length, 4);
    assert.match(task, /ordinal/);
    assert.match(task, /Инструкции сводки/);
    assert.equal(f.records.length, 2);
    f.route.dispose();
});

test("несовпадение префикса после последнего обработчика не отправляется", async () => {
    const f = fixture(); await f.warm();
    const transport = f.route.prepare(f.ctx, f.event, "en"); f.mutate();
    await assert.rejects(transport.request(f.model, "Summary", { maxTokens: 1024 }), /APPEND_PAYLOAD_MISMATCH/);
    assert.equal(f.sent.length, 1);
});

test("отмена и смена ветки не отправляют служебный запрос", async () => {
    const f = fixture(); await f.warm();
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    f.controller.abort();
    await assert.rejects(transport.request(f.model, "Summary", { maxTokens: 1024 }), /Aborted/);
    assert.equal(f.sent.length, 1);
    f.route.reset();
    assert.throws(() => f.route.prepare(f.ctx, f.event, "ru"), /APPEND_CAPTURE_UNAVAILABLE/);
});

test("позднее сообщение остаётся после границы и не отменяет уже назначенную сводку", async () => {
    const f = fixture(); await f.warm();
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    f.manager.appendMessage({ role: "user", content: "Позднее уточнение", timestamp: 3 });
    await transport.request(f.model, "Summary", { maxTokens: 1024 });
    assert.equal(f.sent.length, 2);
    assert.doesNotMatch(JSON.stringify(f.sent[1]), /Позднее уточнение/);
});

test("неизвестный источник не заменяется приблизительным совпадением", async () => {
    const f = fixture(); await f.warm();
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    assert.throws(() => transport.prompt([{ ...f.user, content: "Другой источник" }], "Summary", undefined, []), /APPEND_SOURCE_UNAVAILABLE/);
    assert.equal(f.sent.length, 1);
});

test("рабочий запрос через stream захватывается и продолжается тем же методом", async () => {
    const f = fixture(); await f.warm("stream");
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    const task = transport.prompt([f.user], "Сводка", undefined, []);
    await transport.request(f.model, task, { maxTokens: 1024 });
    assert.equal(f.sent.length, 2);
    const [previous, next] = f.sent as { input: unknown[] }[];
    assert.deepEqual(next!.input.slice(0, previous!.input.length), previous!.input);
    assert.equal(f.records.length, 2);
});

test("поздний обработчик не может увеличить разрешённый ответ сводчика", async () => {
    const f = fixture(); await f.warm("stream");
    const transport = f.route.prepare(f.ctx, f.event, "ru"); f.mutateLimit();
    await assert.rejects(transport.request(f.model, "Сводка", { maxTokens: 1024 }), /APPEND_OUTPUT_LIMIT_MISMATCH/);
    assert.equal(f.sent.length, 1);
});

test("окончательная проверка видит и подмену лимита вызывающей стороной", async () => {
    const f = fixture(); await f.warm("stream");
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    await assert.rejects(transport.request(f.model, "Сводка", { maxTokens: 1024, onPayload: (payload: unknown) => ({ ...payload as object, max_output_tokens: 128000 }) }), /APPEND_OUTPUT_LIMIT_MISMATCH/);
    assert.equal(f.sent.length, 1);
});

test("системное сообщение после восстановленной истории не мешает захвату рабочего запроса", async () => {
    const f = fixture(); await f.warm("streamSimple", true);
    const transport = f.route.prepare(f.ctx, f.event, "ru");
    await transport.request(f.model, transport.prompt([f.user], "Сводка", undefined, []), { maxTokens: 1024 });
    assert.equal(f.sent.length, 2);
});
