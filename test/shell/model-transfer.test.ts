import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakePi, type FakePi } from "../support/pi-fake.js";
import { asPi } from "../support/as-pi.js";
import { RECORD } from "../../src/records.js";

const target: Model<Api> = { provider: "test", id: "small", name: "Small", api: "openai-responses", baseUrl: "http://localhost", input: ["text"], reasoning: true, contextWindow: 64000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const largeTarget: Model<Api> = { ...target, id: "large", name: "Large", contextWindow: 1_048_576, maxTokens: 16_384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
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

test("внутренняя передача в economy применяет ограниченное окно новой модели", async () => {
 const runtime = fakePi({ models: [largeTarget], emitModelSelect: true, registryContextWindow: largeTarget.contextWindow });
 await command(runtime, "model-next", "test/large");
 await saved(runtime, "threshold");
 assert.equal(runtime.ctx.model.id, "large");
 assert.equal(runtime.ctx.model.contextWindow, 272_000);
 // После передачи хост мог вернуть модели полное окно без model_select; перед ходом оно возвращается.
 runtime.ctx.model = { ...runtime.ctx.model, contextWindow: largeTarget.contextWindow };
 await runtime.event("before_agent_start", { messageType: "user", prompt: "продолжай", systemPrompt: "" });
 assert.equal(runtime.ctx.model.contextWindow, 272_000);
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
test("сбой сжатия оставляет передачу в очереди и не обрывает ходы", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next", "test/small");
 await runtime.event("session_compact_failed", { reason: "manual", willRetry: false, aborted: false, errorMessage: "Compaction failed: network" });
 const stopped = runtime.notices.at(-1);
 assert.equal(stopped?.level, "warning");
 assert.match(stopped?.text ?? "", /network/);
 assert.match(stopped?.text ?? "", /test\/small.*\/compact.*\/model-next cancel/s);
 assert.ok(!runtime.entries.some(entry => entry.type === RECORD.transfer && JSON.stringify(entry.data).includes('"phase":"failed"')));
 const aborts = runtime.aborts;
 await runtime.event("context", { messages: [] });
 assert.equal(runtime.aborts, aborts, "ход после сбоя сжатия идёт на прежней модели");
 await command(runtime, "model-next", "status");
 assert.match(runtime.notices.at(-1)?.text ?? "", /ожидает сжатия/);
 // Повторное сжатие доводит ту же передачу без нового выбора модели.
 await saved(runtime);
 assert.equal(runtime.ctx.model.id, "small");
});
test("отмена сжатия владельцем тоже оставляет передачу в очереди", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next", "test/small");
 await runtime.event("session_compact_failed", { reason: "manual", willRetry: false, aborted: true });
 assert.match(runtime.notices.at(-1)?.text ?? "", /Сжатие отменено.*test\/small/s);
 await saved(runtime);
 assert.equal(runtime.ctx.model.id, "small");
});
test("ход, начатый во время ручного сжатия, ждёт его конца и новой модели", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await command(runtime, "model-next", "test/small");
 await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 1000 } });
 let modelAtStart: string | undefined;
 const run = runtime.event("before_agent_start", { type: "before_agent_start", prompt: "уведомление", systemPrompt: "" }).then(() => { modelAtStart = runtime.ctx.model.id; });
 await runtime.flush();
 assert.equal(modelAtStart, undefined, "ход не стартует, пока идёт сжатие");
 await saved(runtime);
 await run;
 assert.equal(modelAtStart, "small");
 const aborts = runtime.aborts;
 await runtime.event("context", { messages: [] });
 assert.equal(runtime.aborts, aborts);
 // Вне сжатия ход не ждёт.
 await runtime.event("before_agent_start", { type: "before_agent_start", prompt: "уведомление", systemPrompt: "" });
});
test("ход, ждавший сжатия, после его сбоя идёт дальше, а после отмены владельцем не уходит модели", async () => {
 for (const cancelled of [false, true]) {
  const runtime = fakePi({ models: [target], emitModelSelect: true });
  // Отмену владельцем Pi передаёт сигналом сжатия; сводка сама называет её причиной отказа.
  await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 1000 }, ...(cancelled ? { signal: AbortSignal.abort() } : {}) });
  let started = false;
  const run = runtime.event("before_agent_start", { type: "before_agent_start", prompt: "уведомление", systemPrompt: "" }).then(() => { started = true; });
  await runtime.flush();
  assert.equal(started, false);
  await runtime.event("session_compact_failed", cancelled ? { reason: "manual", willRetry: false, aborted: true } : { reason: "manual", willRetry: false, aborted: false, errorMessage: "Compaction failed: network" });
  await run;
  const aborts = runtime.aborts;
  await runtime.event("context", { messages: [] });
  assert.equal(runtime.aborts, aborts + (cancelled ? 1 : 0));
  await runtime.event("context", { messages: [] });
  assert.equal(runtime.aborts, aborts + (cancelled ? 1 : 0), "отмена относится только к ждавшему ходу");
 }
});
test("после сбоя применения модели каждый оборванный ход объясняет причину и выход", async () => {
 const runtime = fakePi({ models: [target], setModelResult: false });
 await command(runtime, "model-next", "test/small");
 await saved(runtime);
 const stopped = runtime.notices.at(-1);
 assert.equal(stopped?.level, "error");
 assert.match(stopped?.text ?? "", /test\/small/);
 assert.match(stopped?.text ?? "", /\/model-next cancel/);
 for (let turn = 0; turn < 2; turn++) {
  const before = runtime.aborts;
  await runtime.event("context", { messages: [] });
  assert.equal(runtime.aborts, before + 1);
  assert.match(runtime.notices.at(-1)?.text ?? "", /Ход не отправлен.*test\/small.*\/model-next cancel/s);
 }
 await command(runtime, "model-next", "cancel");
 const notices = runtime.notices.length;
 const aborts = runtime.aborts;
 await runtime.event("context", { messages: [] });
 assert.equal(runtime.aborts, aborts);
 assert.equal(runtime.notices.length, notices);
});

test("короткие имена mn и mnn равнозначны полным командам", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 for (const [alias, full] of [["mn", "model-next"], ["mnn", "model-next-now"]] as const) assert.equal(runtime.commands.get(alias)?.handler, runtime.commands.get(full)?.handler, `${alias} — тот же обработчик, что ${full}`);
 await command(runtime, "mn", "small");
 assert.equal(runtime.ctx.model.id, "gpt-5.6-sol", "до сжатия модель не меняется");
 await command(runtime, "mn", "status");
 assert.match(runtime.notices.at(-1)?.text ?? "", /test\/small/);
 await command(runtime, "mn", "cancel");
 assert.match(runtime.notices.at(-1)?.text ?? "", /Переключение отменено/);
 await runtime.settle();
 await command(runtime, "mnn", "test/small");
 assert.equal(runtime.compactOptions.length, 1, "mnn в простое сразу просит сжатие, как model-next-now");
 await saved(runtime);
 assert.equal(runtime.ctx.model.id, "small");
});
test("автодополнение коротких имён совпадает с полными", async () => {
 const runtime = fakePi({ models: [target] });
 await command(runtime, "mn", "status");
 const values = async (name: string, prefix: string) => {
  const items = await runtime.commands.get(name)?.getArgumentCompletions?.(prefix);
  return items?.map(item => item.value) ?? null;
 };
 assert.deepEqual(await values("mn", "st"), await values("model-next", "st"));
 assert.deepEqual(await values("mn", "ca"), ["cancel"]);
 assert.deepEqual(await values("mnn", "sm"), await values("model-next-now", "sm"));
});

test("немедленная передача рвёт ход на его границе и продолжает работу до простоя", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await runtime.event("agent_start", {});
 await command(runtime, "mnn", "test/small --thinking medium");
 assert.equal(runtime.compactOptions.length, 0, "до границы хода сжатие не начато");
 await runtime.event("turn_end", { message: { stopReason: "toolUse" }, toolResults: [], turnIndex: 0 });
 assert.equal(runtime.compactOptions.length, 1, "граница хода запускает сжатие сразу");
 await runtime.settle(true, true);
 await saved(runtime);
 assert.equal(runtime.ctx.model.id, "small", "работа ушла новой модели");
 runtime.compactOptions[0]?.onComplete?.({ summary: "fixture", firstKeptEntryId: "x", tokensBefore: 1000 });
 await runtime.flush();
 assert.equal(runtime.sent.length, 1, "ровно одно продолжение и без реплики владельца");
 assert.equal(runtime.thinkingLevel, "medium");
});
test("граница хода не запускает сжатие для отложенной передачи без --now", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await runtime.event("agent_start", {});
 await command(runtime, "mn", "test/small");
 await runtime.event("turn_end", { message: { stopReason: "toolUse" }, toolResults: [], turnIndex: 0 });
 assert.equal(runtime.compactOptions.length, 0);
 await runtime.event("agent_settled", { aborted: false });
 assert.equal(runtime.compactOptions.length, 0, "сжатие остаётся за следующим компактом");
});

test("отмена владельцем не запускает разрыв хода для /mnn", async () => {
 const runtime = fakePi({ models: [target], emitModelSelect: true });
 await runtime.event("agent_start", {});
 await command(runtime, "mnn", "test/small");
 await runtime.event("turn_end", { outcome: "aborted", message: { stopReason: "aborted" }, toolResults: [], turnIndex: 0 });
 assert.equal(runtime.compactOptions.length, 0, "отменённый ход не запускает сжатие");
 await runtime.settle(true, true);
 assert.equal(runtime.sent.length, 0, "после Esc нет скрытого продолжения");
});
