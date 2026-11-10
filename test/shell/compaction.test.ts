import { Check } from "typebox/value";
import { checkpointParamsSchema } from "../../src/compaction/checkpoint.js";
import { getContextArgumentCompletions } from "../../src/shell/compaction.js";
import { describe, expect, test } from "../support/expect.js";
import { fakePi, type FakePi } from "../support/pi-fake.js";

const params = { mainObjective: "Продолжить цель", completedCheckpoint: "Завершён этап", continuationTarget: "Сделать следующий шаг" };

async function startManual(runtime: FakePi) {
  const result = await runtime.tool("checkpoint_compact_continue").execute("call", params, undefined, undefined, runtime.ctx);
  expect(result.details.result).toBe("scheduled");
  await runtime.settle();
  expect(runtime.compactOptions).toHaveLength(1);
  return runtime.compactOptions[0];
}

/** Доводит контрольную точку до отправленного билета. */
async function completeManual(runtime: FakePi) {
  const callback = await startManual(runtime);
  await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 100 } });
  await runtime.event("session_compact", { reason: "manual", willRetry: false, compactionEntry: { tokensBefore: 100 } });
  callback.onComplete({});
  await runtime.flush();
  return callback;
}

describe("контрольная точка с продолжением", () => {
  test("без контрольной точки ход не запускает сжатие и не пишет журнал", async () => {
    const runtime = fakePi();
    await runtime.event("turn_end", { message: { role: "assistant" }, toolResults: [] });
    await runtime.settle();
    expect(runtime.compactOptions).toHaveLength(0);
    expect(runtime.audits()).toHaveLength(0);
  });

  test("сжатие ждёт успокоения хода и несёт структурированную точку", async () => {
    const runtime = fakePi();
    await runtime.tool("checkpoint_compact_continue").execute("call", params, undefined, undefined, runtime.ctx);
    expect(runtime.compactOptions).toHaveLength(0);
    await runtime.settle(false);
    expect(runtime.compactOptions).toHaveLength(0);
    await runtime.settle(true);
    expect(runtime.compactOptions[0].customInstructions).toContain("Главная цель");
    expect(runtime.compactOptions[0].customInstructions).toContain("Следующий шаг");
  });

  test("продолжение уходит скрытым билетом только после onComplete, когда Pi отпустил блокировку", async () => {
    const runtime = fakePi();
    const callback = await startManual(runtime);
    await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 100 } });
    await runtime.event("session_compact", { reason: "manual", willRetry: false, compactionEntry: { tokensBefore: 12_000 } });
    expect(runtime.sent).toHaveLength(0);
    expect(runtime.audits("manual-tool").filter((entry) => entry.phase === "success")).toHaveLength(1);
    callback.onComplete({});
    await runtime.flush();
    expect(runtime.sent).toHaveLength(1);
    const [{ message, options }] = runtime.sent as [{ message: any; options: any }];
    expect(message).toMatchObject({ customType: "goal-compact-ticket", display: false });
    expect(message.content).toContain("Сделать следующий шаг");
    expect(options).toEqual({ triggerTurn: true });
    expect(runtime.audits("manual-tool").map((entry) => entry.phase)).toEqual(["pending", "running", "success", "continuation-claimed", "send-attempted"]);
    callback.onError(new Error("late"));
    expect(runtime.sent).toHaveLength(1);
  });

  test("английская сводка отдаётся Pi, а точка и продолжение пишутся по-английски", async () => {
    const runtime = fakePi({ language: "en" });
    expect(await runtime.event("session_before_tree", {})).toBeUndefined();
    expect(await runtime.event("before_provider_request", { payload: { model: "fixture" } })).toBeUndefined();
    const callback = await completeManual(runtime);
    expect(callback.customInstructions).toContain("## Main objective");
    expect(callback.customInstructions).not.toContain("## Главная цель");
    expect(runtime.sent[0]?.message.content).toContain("Continue the main objective");
    for (const reason of ["threshold", "overflow"]) {
      expect(await runtime.event("session_before_compact", { reason, willRetry: reason === "overflow", preparation: { tokensBefore: 100 } })).toBeUndefined();
    }
  });

  test("неудачное сжатие пишет ошибку и не продолжает", async () => {
    const runtime = fakePi();
    const callback = await startManual(runtime);
    await runtime.event("session_compact_failed", { reason: "manual", willRetry: false });
    callback.onError(new Error("failed"));
    await runtime.flush();
    expect(runtime.sent).toHaveLength(0);
    expect(runtime.audits("manual-tool").filter((entry) => entry.phase === "error")).toHaveLength(1);
  });

  test("неудачная русская сводка по порогу явно отменяет сжатие без скрытого повтора", async () => {
    const runtime = fakePi();
    expect(await runtime.event("session_before_compact", { reason: "threshold", willRetry: false, preparation: { tokensBefore: 256_000 } })).toEqual({ cancel: true });
    await runtime.event("session_compact_failed", { reason: "threshold", willRetry: false });
    expect(runtime.compactOptions).toHaveLength(0);
    expect(runtime.sent).toHaveLength(0);
    expect(runtime.audits("external-unattributed").filter((entry) => entry.reason === "threshold").map((entry) => entry.phase)).toEqual(["contained", "error"]);
  });

  test("сжатие Pi по порогу снимает только ждущую точку и не делает второго сжатия", async () => {
    const runtime = fakePi({ language: "en" });
    await runtime.tool("checkpoint_compact_continue").execute("call", params, undefined, undefined, runtime.ctx);
    await runtime.event("session_before_compact", { reason: "threshold", willRetry: false, preparation: { tokensBefore: 256_000 } });
    await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 256_000 } });
    await runtime.settle();
    expect(runtime.compactOptions).toHaveLength(0);
    expect(runtime.sent).toHaveLength(0);
    expect(runtime.audits("manual-tool").filter((entry) => entry.phase === "cancel")).toHaveLength(1);
  });

  test("повторный вызов во время ожидания и вызов после уже сделанного сжатия отклоняются", async () => {
    const runtime = fakePi();
    const tool = runtime.tool("checkpoint_compact_continue");
    await tool.execute("call", params, undefined, undefined, runtime.ctx);
    expect((await tool.execute("call", params, undefined, undefined, runtime.ctx)).details.result).toBe("in_progress");
    const compacted = fakePi({ branch: [{ id: "u", type: "message", message: { role: "user", content: "x" } }, { id: "c", type: "compaction", summary: "s" }] });
    expect((await compacted.tool("checkpoint_compact_continue").execute("call", params, undefined, undefined, compacted.ctx)).details.result).toBe("already_compacted");
  });

  test("ждущее в очереди Pi сообщение заменяет продолжение", async () => {
    const runtime = fakePi({ language: "en" });
    const callback = await startManual(runtime);
    runtime.setPending(true);
    callback.onComplete({});
    await runtime.flush();
    expect(runtime.sent).toHaveLength(0);
  });

  test("реплика владельца во время сжатия отменяет продолжение", async () => {
    const runtime = fakePi({ language: "en" });
    const callback = await startManual(runtime);
    await runtime.event("input", { text: "стоп", source: "interactive" });
    callback.onComplete({});
    await runtime.flush();
    expect(runtime.sent).toHaveLength(0);
  });

  test("служебный ввод расширений не считается репликой владельца", async () => {
    const runtime = fakePi({ language: "en" });
    const callback = await startManual(runtime);
    await runtime.event("input", { text: "служебное", source: "extension" });
    callback.onComplete({});
    await runtime.flush();
    expect(runtime.sent).toHaveLength(1);
  });
});

describe("билет продолжения на входе в прогон", () => {
  const arrive = (runtime: FakePi, message: any) => runtime.event("before_agent_start", { type: "before_agent_start", messageType: "custom", message, systemPrompt: "", systemPromptOptions: {} });

  // В Pi 1.5 отмена из before_agent_start не останавливает запрос к модели: у прогона ещё нет
  // сигнала отмены. Поэтому отказ исполняется при первой сборке окна того же прогона.
  test("свежий билет проходит, устаревший прерывается при сборке окна и гаснет в нём", async () => {
    const runtime = fakePi({ language: "en" });
    await completeManual(runtime);
    const ticket = runtime.sent[0]!.message;
    await arrive(runtime, ticket);
    await runtime.event("context", { messages: [] });
    expect(runtime.aborts).toBe(0);
    await arrive(runtime, ticket);
    expect(runtime.aborts).toBe(0);
    await runtime.event("context", { messages: [] });
    expect(runtime.aborts).toBe(1);
    await runtime.event("context", { messages: [] });
    expect(runtime.aborts).toBe(1);

    const second = fakePi({ language: "en" });
    await completeManual(second);
    const stale = second.sent[0]!.message;
    await second.event("input", { text: "новая реплика", source: "interactive" });
    await arrive(second, stale);
    const context = await second.event("context", { messages: [{ role: "custom", ...stale }] });
    expect(second.aborts).toBe(1);
    expect(context.messages[0].content).not.toContain("Continue the main objective");
  });

  test("свой отказ билету не снимает следующую контрольную точку", async () => {
    const runtime = fakePi({ language: "en" });
    await completeManual(runtime);
    const ticket = runtime.sent[0]!.message;
    await runtime.event("input", { text: "новая реплика", source: "interactive" });
    await arrive(runtime, ticket);
    await runtime.tool("checkpoint_compact_continue").execute("call", params, undefined, undefined, runtime.ctx);
    await runtime.settle(true, true);
    expect(runtime.compactOptions).toHaveLength(2);
  });

  test("билет другого процесса прерывается, чужие сообщения не трогаются", async () => {
    const runtime = fakePi({ language: "en" });
    await arrive(runtime, { customType: "goal-compact-ticket", content: "x", details: { id: "a", runtime: "other", epoch: 0, kind: "checkpoint" } });
    await runtime.event("context", { messages: [] });
    expect(runtime.aborts).toBe(1);
    await arrive(runtime, { customType: "other-extension", content: "x" });
    await runtime.event("context", { messages: [] });
    expect(runtime.aborts).toBe(1);
  });
});

test("карточка сжатия пишется после session_compact и читается прежним видом", async () => {
  const runtime = fakePi({ language: "en" });
  await runtime.event("session_before_compact", { reason: "threshold", willRetry: false, preparation: { tokensBefore: 258_796 } });
  expect(runtime.entries.filter((entry) => entry.type === "goal-compact-card")).toHaveLength(0);
  await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 258_796, summary: "x".repeat(400), usage: { input: 250_000, cacheRead: 0, cost: { total: 0.04 } } } });
  const cards = runtime.entries.filter((entry) => entry.type === "goal-compact-card");
  expect(cards).toHaveLength(1);
  expect(cards[0]!.data).toMatchObject({ version: 2, kind: "standard", trigger: "threshold", tokensBefore: 258_796, summaryTokens: 100 });
  expect(JSON.stringify(cards[0]!.data)).not.toContain("xxxx");
  const theme = { fg: (_c: string, text: string) => text };
  for (const type of ["goal-compact-card", "context-compaction-card"]) {
    expect(runtime.renderers.get(type)({ data: cards[0]!.data }, { expanded: false }, theme).render(200)[0]).toContain("standard compact");
  }
});

describe("режимы окна", () => {
  test("economy, long-once, long-chat и off меняют только окно модели и сохраняют thinking", async () => {
    const runtime = fakePi({ thinkingLevel: "max", modelSwitchThinkingLevel: "low" });
    await runtime.command("long-once", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(372_000);
    expect(runtime.thinkingLevel).toBe("max");
    await runtime.command("long-chat", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    await runtime.command("off", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    await runtime.command("economy", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(272_000);
  });

  test("длинный режим берёт окно сессии у любого провайдера с точным длинным ценовым уровнем", async () => {
    const runtime = fakePi({ modelProvider: "custom", registryContextWindow: 272_000, registryTiers: [{ inputTokensAbove: 272_000 }] });
    await runtime.command("long-chat", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    expect(runtime.notices.some((entry) => entry.text.includes("source=session-override"))).toBe(true);
  });

  for (const registryContextWindow of [272_000, 600_000]) test(`без длинного ценового уровня остаётся economy (окно реестра ${registryContextWindow})`, async () => {
    const runtime = fakePi({ modelProvider: "custom", registryContextWindow, registryTiers: [] });
    await runtime.command("long-chat", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(272_000);
    expect(runtime.notices.some((entry) => entry.text.includes("нет доступного long-tier"))).toBe(true);
  });

  test("long-once возвращается к economy только после успешного сжатия", async () => {
    const runtime = fakePi();
    await runtime.command("long-once", runtime.ctx);
    await runtime.event("session_compact_failed", { reason: "threshold", willRetry: false });
    expect(runtime.ctx.model.contextWindow).toBe(372_000);
    await runtime.event("session_compact", { reason: "threshold", willRetry: false, compactionEntry: { tokensBefore: 356_000 } });
    expect(runtime.ctx.model.contextWindow).toBe(272_000);
    expect(runtime.entries.some((entry) => entry.type === "goal-compact-mode" && entry.data.mode === "economy")).toBe(true);
  });

  test("long-chat переживает сжатие, а off отдаёт порог Pi", async () => {
    const runtime = fakePi();
    await runtime.command("long-chat", runtime.ctx);
    await runtime.event("session_compact", { reason: "overflow", willRetry: true, compactionEntry: { tokensBefore: 590_000 } });
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    await runtime.command("off", runtime.ctx);
    expect(runtime.compactOptions).toHaveLength(0);
  });

  test("отказ setModel возвращает economy и сообщает об ограничении", async () => {
    const runtime = fakePi({ setModelResult: false });
    await runtime.command("long-chat", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(272_000);
    expect(runtime.notices.some((entry) => entry.level === "error")).toBe(true);
    expect(runtime.entries.some((entry) => entry.type === "goal-compact-mode" && entry.data.mode === "economy")).toBe(true);
  });

  test("частичный сбой setModel возвращает прежнюю модель", async () => {
    const runtime = fakePi({ setModelResults: ["reject", true], emitModelSelect: true });
    await runtime.command("long-chat", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(272_000);
    expect(runtime.setModelCalls.map((model) => model.contextWindow)).toEqual([600_000, 272_000]);
  });

  test("сбой перехода к economy сохраняет длинный режим", async () => {
    const runtime = fakePi({ setModelResults: [true, "reject", true], emitModelSelect: true });
    await runtime.command("long-chat", runtime.ctx);
    await runtime.command("economy", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    expect(runtime.notices.some((entry) => entry.text.includes("сохранён прежний режим"))).toBe(true);
    expect(runtime.notices.some((entry) => entry.text.includes("context: long-chat") && entry.text.includes("600000"))).toBe(true);
  });

  test("повторный сбой economy честно показывает фактическое окно", async () => {
    const runtime = fakePi({ setModelResults: ["reject", false, "reject", true], emitModelSelect: true });
    await runtime.command("long-chat", runtime.ctx);
    await runtime.command("economy", runtime.ctx);
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    expect(runtime.notices.some((entry) => entry.text.includes("context: economy") && entry.text.includes("600000") && entry.text.includes("source=fallback"))).toBe(true);
  });

  test("режим восстанавливается из журнала прежнего расширения, старый порог молча игнорируется (К7)", async () => {
    const branch = [
      { id: "m", type: "custom", customType: "context-compaction-mode", data: { mode: "long-chat" } },
      { id: "t", type: "custom", customType: "checkpoint-compact-session-threshold", data: { kind: "tokens", value: 1 } },
    ];
    const runtime = fakePi({ branch, sessionId: `legacy-${Date.now()}` });
    await runtime.event("session_start", { reason: "startup" });
    await runtime.event("session_start", { reason: "reload" });
    expect(runtime.ctx.model.contextWindow).toBe(600_000);
    expect(runtime.notices.filter((entry) => entry.text.includes("порог"))).toHaveLength(0);
  });
});

for (const change of ["none", "model", "route", "api", "fork", "switch", "tree", "pending"] as const) test(`продолжение перепроверяет контекст после восстановления окна: ${change}`, async () => {
  const runtime = fakePi({ language: "en", emitModelSelect: true });
  await runtime.command("long-once", runtime.ctx);
  const callback = await startManual(runtime);
  await runtime.event("session_before_compact", { reason: "manual", willRetry: false, preparation: { tokensBefore: 100 } });
  await runtime.event("session_compact", { reason: "manual", willRetry: false, compactionEntry: { tokensBefore: 12_000 } });
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let waits = 0;
  runtime.setModelBarrier(async () => { if (waits++ === 0) { entered(); await blocked; } });
  callback.onComplete({});
  await reached;
  if (change === "model") runtime.ctx.model = { ...runtime.ctx.model, id: "different-model" };
  if (change === "route") runtime.ctx.model = { ...runtime.ctx.model, baseUrl: "https://changed.invalid/v1" };
  if (change === "api") runtime.ctx.model = { ...runtime.ctx.model, api: "different-api" };
  if (["model", "route", "api"].includes(change)) await runtime.event("model_select", {});
  if (change === "fork") await runtime.event("session_before_fork", {});
  if (change === "switch") await runtime.event("session_before_switch", {});
  if (change === "tree") await runtime.event("session_before_tree", {});
  if (change === "pending") runtime.setPending(true);
  release();
  await runtime.flush();
  expect(runtime.sent).toHaveLength(change === "none" ? 1 : 0);
  expect(runtime.audits().filter((entry) => entry.phase === "send-attempted")).toHaveLength(change === "none" ? 1 : 0);
});

test("схема точки принимает необязательные режимы и не принимает прежние имена аргументов (К7)", () => {
  for (const language of ["ru", "en"] as const) {
    const schema = checkpointParamsSchema(language);
    expect(Check(schema, params)).toBe(true);
    for (const continuationMode of ["explicit_prompt", "plan_phase", "resume_existing_plan", "goal_loop", "auto_context_pressure"]) {
      expect(Check(schema, { ...params, continuationMode })).toBe(true);
    }
    expect(Check(schema, { ...params, continuationMode: "unknown" })).toBe(false);
    expect(Check(schema, { mainObjective: "a", completedCheckpoint: "b", nextStep: "c" })).toBe(false);
  }
});

test("подсказки /context на обоих языках", () => {
  expect(getContextArgumentCompletions("lo")?.map((item) => item.value)).toEqual(["long-once", "long-chat"]);
  expect(getContextArgumentCompletions("off", "en")?.[0]?.description).toContain("Restore");
  expect(getContextArgumentCompletions("xyz")).toBeNull();
});
