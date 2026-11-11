import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakePi, type FakePi } from "../support/pi-fake.js";
import { asPi } from "../support/as-pi.js";
import { RECORD } from "../../src/records.js";

const target: Model<Api> = { provider: "test", id: "small", name: "Small", api: "openai-responses", baseUrl: "http://localhost", input: ["text"], reasoning: true, contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
async function command(runtime: FakePi, name: string, args: string) {
 const cmd = runtime.commands.get(name);
 assert.ok(cmd);
 await cmd.handler(args, asPi<ExtensionCommandContext>(runtime.ctx));
}
async function saved(runtime: FakePi, reason = "manual", willRetry = false) {
 await runtime.event("session_compact", { reason, willRetry, compactionEntry: { id: "compact-1", tokensBefore: 1000, summary: "fixture" } });
}
test("отложенная модель не применяется до сохранённого сжатия", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next", "test/small");
 assert.equal(runtime.ctx.model.id, "gpt-5.6-sol");
 assert.equal(runtime.compactOptions.length, 0);
 await saved(runtime, "threshold");
 assert.equal(runtime.ctx.model.id, "small");
 assert.equal(runtime.sent.length, 0);
 await command(runtime, "model-next", "status");
 assert.ok(runtime.notices.at(-1)?.text.includes("не запланировано"));
});
test("немедленная передача ждёт окончания работы и продолжает ровно один раз", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await runtime.event("agent_start", {});
 await command(runtime, "model-next-now", "test/small --thinking medium");
 assert.equal(runtime.compactOptions.length, 0);
 await runtime.settle();
 assert.equal(runtime.compactOptions.length, 1);
 await saved(runtime);
 assert.equal(runtime.ctx.model.id, "small");
 runtime.compactOptions[0]?.onComplete?.({ summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 });
 await runtime.flush();
 assert.equal(runtime.thinkingLevel, "medium");
 assert.equal(runtime.sent.length, 1);
});
test("немедленная передача в простое не начинает новую задачу", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await runtime.settle();
 await command(runtime, "model-next-now", "small");
 await saved(runtime);
 runtime.compactOptions[0]?.onComplete?.({ summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 });
 await runtime.flush();
 assert.equal(runtime.sent.length, 0);
});
test("отмена и ручная смена модели снимают ожидающую передачу", async () => {
 for (const cancel of ["command", "manual"] as const) {
  const runtime = fakePi({ models: [target], emitModelSelect: true });
  await command(runtime, "model-next", "small");
  if (cancel === "command") await command(runtime, "model-next", "cancel");
  else { runtime.ctx.model = { ...runtime.ctx.model, id: "manual" }; await runtime.event("model_select", {}); }
  await saved(runtime);
  assert.notEqual(runtime.ctx.model.id, "small");
 }
});
test("сбой смены модели блокирует продолжение и сохраняет причину", async () => {
 const runtime = fakePi({ models: [target], setModelResult: false });
 await runtime.event("agent_start", {});
 await command(runtime, "model-next-now", "small");
 await runtime.settle();
 await saved(runtime);
 runtime.compactOptions[0]?.onComplete?.({ summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 });
 await runtime.flush();
 assert.equal(runtime.sent.length, 0);
 assert.ok(runtime.aborts > 0);
 assert.ok(runtime.entries.some(entry => entry.type === RECORD.transfer && JSON.stringify(entry.data).includes('"phase":"failed"')));
});
test("переполнение использует повтор Pi без собственного второго продолжения", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next", "small");
 await saved(runtime, "overflow", true);
 assert.equal(runtime.ctx.model.id, "small");
 assert.equal(runtime.sent.length, 0);
});
test("отмена немедленной передачи до сжатия снимает и ожидающий компакт", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next-now", "small");
 await command(runtime, "model-next", "cancel");
 await runtime.settle();
 assert.equal(runtime.compactOptions.length, 0);
 assert.equal(runtime.sent.length, 0);
});
test("ожидающая передача переживает reload, но не наследуется другой сессией", async () => {
 const first = fakePi({ models: [target], sessionId: "same" });
 await command(first, "model-next", "small");
 const branch = first.ctx.sessionManager.getBranch();
 for (const sessionId of ["same", "forked"]) {
  const next = fakePi({ models: [target], sessionId, branch, emitModelSelect: true });
  await next.event("session_start", { reason: "reload" });
  await saved(next);
  assert.equal(next.ctx.model.id === "small", sessionId === "same");
 }
});
test("ошибка сжатия не переключает модель и не запускает продолжение", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next-now", "small");
 await runtime.settle();
 await runtime.event("session_compact_failed", { reason: "manual", willRetry: false });
 runtime.compactOptions[0]?.onError?.(new Error("fixture failure"));
 await runtime.flush();
 assert.notEqual(runtime.ctx.model.id, "small");
 assert.equal(runtime.sent.length, 0);
});
test("смена ветки оставляет долговечную отмену даже при том же sessionId", async () => {
 const first = fakePi({ models: [target], sessionId: "same" });
 await command(first, "model-next", "small");
 const inherited = first.ctx.sessionManager.getBranch();
 await first.event("session_before_tree", { preparation: { userWantsSummary: false } });
 // Новая ветка могла ответвиться раньше записи отмены.
 first.setBranch(inherited);
 await first.event("session_tree", {});
 const reloaded = fakePi({ models: [target], sessionId: "same", branch: first.ctx.sessionManager.getBranch() });
 await reloaded.event("session_start", { reason: "reload" });
 await saved(reloaded);
 assert.notEqual(reloaded.ctx.model.id, "small");
});
test("неизвестный usage после compact проверяется по проекции меньшего окна", async () => {
 const runtime = fakePi({ models: [target], contextTokens: null, projectionText: "x".repeat(300000) });
 await command(runtime, "model-next", "small");
 await saved(runtime);
 assert.notEqual(runtime.ctx.model.id, "small");
 assert.ok(runtime.notices.some(item => item.text.includes("не помещается")));
 assert.equal(runtime.sent.length, 0);
});
test("переполнение до конца хода не запускает второй compact для model-next-now", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next-now", "small");
 await runtime.event("session_before_compact", { reason: "overflow", willRetry: true, preparation: { tokensBefore: 1000 } });
 await saved(runtime, "overflow", true);
 await runtime.settle();
 assert.equal(runtime.compactOptions.length, 0);
 assert.equal(runtime.ctx.model.id, "small");
});
for (const initial of ["model-next", "model-next-now"]) {
 for (const retry of ["model-next", "model-next-now"]) {
  test(`повтор ${retry} после ошибки ${initial} использует сохранённый compact`, async () => {
   const runtime = fakePi({ models: [target], setModelResults: [false, true], emitModelSelect: true });
   await runtime.event("agent_start", {});
   await command(runtime, initial, "small");
   await runtime.settle();
   runtime.setBranch([...runtime.ctx.sessionManager.getBranch(), { type: "compaction", id: "compact-1", summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 }]);
   await saved(runtime);
   runtime.compactOptions[0]?.onComplete?.({ summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 });
   await runtime.flush();
   assert.notEqual(runtime.ctx.model.id, "small");
   const compactsBeforeRetry = runtime.compactOptions.length;
   await command(runtime, retry, "small");
   assert.equal(runtime.ctx.model.id, "small");
   assert.equal(runtime.compactOptions.length, compactsBeforeRetry);
  });
 }
}
