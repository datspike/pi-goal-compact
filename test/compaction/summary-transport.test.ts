import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { compactWith, type FakeCompactEvent, type FakeContext } from "../support/compaction.js";
import type { SummaryTransport } from "../../src/compaction/summary.js";

function fixture() {
    const controller = new AbortController();
    const message = { role: "user" as const, content: "Предметный факт", timestamp: 1 };
    const event: FakeCompactEvent = { signal: controller.signal, branchEntries: [], preparation: { settings: { reserveTokens: 8192 }, isSplitTurn: false, messagesToSummarize: [message], turnPrefixMessages: [], fileOps: { read: new Set(), edited: new Set() }, firstKeptEntryId: "tail", tokensBefore: 100 } };
    const ctx: FakeContext = { model: { provider: "fixture", id: "model", maxTokens: 8192 }, modelRegistry: { complete: async () => { throw Error("ordinary transport must not run"); } } };
    const response: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "## Цель\nПродолжить задачу" }], stopReason: "stop", api: "openai-responses", provider: "fixture", model: "model", timestamp: 2, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    let calls = 0;
    const transport: SummaryTransport = { prompt: (_messages, instructions) => instructions, inputTokens: () => 100, request: async (_model, _prompt, options) => {
        calls++; await options.onPayload?.({ input: [] }, _model); return response;
    } };
    const capability = { window: 272000, source: "fixture", outputLimitEnforced: true };
    return { controller, event, ctx, response, transport, capability, calls: () => calls };
}

test("особый способ отправки использует общую сборку и сохранённую границу", async () => {
    const f = fixture();
    const result = await compactWith(f.event, f.ctx, { transport: f.transport, capability: f.capability });
    assert.ok("compaction" in result);
    assert.equal(result.compaction.firstKeptEntryId, "tail");
    assert.equal(f.calls(), 1);
});

test("бюджет считает весь вход append, а не короткое служебное задание", async () => {
    const f = fixture(); f.transport.inputTokens = () => 300000;
    assert.deepEqual(await compactWith(f.event, f.ctx, { transport: f.transport, capability: f.capability }), { cancel: true });
    assert.equal(f.calls(), 0);
});

test("общий обработчик не принимает вызов инструмента из служебного ответа", async () => {
    const f = fixture(); f.response.content = [{ type: "toolCall", id: "not-executed", name: "bash", arguments: { command: "false" } }]; f.response.stopReason = "toolUse";
    assert.deepEqual(await compactWith(f.event, f.ctx, { transport: f.transport, capability: f.capability }), { cancel: true });
    assert.equal(f.calls(), 1);
});

test("смена модели во время ответа отменяет принятие сводки", async () => {
    const f = fixture(); const request = f.transport.request;
    f.transport.request = async (...args) => { const result = await request(...args); f.ctx.model!.id = "other"; return result; };
    assert.deepEqual(await compactWith(f.event, f.ctx, { transport: f.transport, capability: f.capability }), { cancel: true });
});

test("отмена перед отправкой сохраняет общий запрет запросов", async () => {
    const f = fixture(); f.controller.abort();
    assert.deepEqual(await compactWith(f.event, f.ctx, { transport: f.transport, capability: f.capability }), { cancel: true });
    assert.equal(f.calls(), 0);
});
