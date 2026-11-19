/**
 * Дымовой прогон Б3 на настоящем Pi без сети: при сжатии с активной целью служебные продолжения
 * не попадают во вход сводчика, а окно после сжатия несёт сводку без раздела «Цель» и ровно одну
 * копию договорённости.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AGREEMENT, withProbe, type ProbeScript } from "../support/offline-pi.js";

const report = (n: number) => ["report_goal_progress", { action: "publish", status: "working", phase: "Работа", summary: `Шаг ${n} сделан.`, changed: `Сделан шаг ${n}.`, nextStep: "Следующий шаг." }] as [string, Record<string, unknown>];

const script: ProbeScript = {
  calls: {
    1: ["create_goal", { objective: "Проверить окно после сжатия без сети.", agreement: AGREEMENT, self_decided: [] }],
    // Ход 2 заканчивается ответом без инструмента: цель продолжается служебным сообщением. Ходы 3–5
    // отодвигают его из оставленного хвоста окна в сводимую часть истории.
    3: report(3),
    4: report(4),
    5: report(5),
    7: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Окно после сжатия проверено.", nextStep: "Завершить цель." }],
    // Первая попытка закрытия возвращает договорённость на сверку, вторая закрывает цель.
    8: ["update_goal", { status: "complete" }],
    9: ["update_goal", { status: "complete" }],
  },
  heavySteps: [6],
  lastStep: 10,
};

const count = (text: string, part: string) => text.split(part).length - 1;

test("Б3: окно после сжатия с целью — сводка без «Цели», одна договорённость, без служебных продолжений", { timeout: 60_000 }, async () => {
  await withProbe(script, async (start, requests) => {
    const rows = await start("window");
    assert.equal(rows.filter((row) => row.type === "compaction").length, 1, "ровно одно сжатие");
    assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"), "цель закрыта");
    const log = requests("window");
    const goalId = /"goalId":"([0-9a-f-]{36})"/.exec(JSON.stringify(rows))?.[1];
    assert.ok(goalId, "цель создана");
    const summaries = log.filter((request) => request.kind === "summary");
    assert.ok(summaries.length > 0, "сводку писало расширение");
    const summarized = summaries.map((request) => request.window).join("\n");
    assert.ok(summarized.includes(`Goal ID: ${goalId}`), "служебное продолжение попало в сводимую часть истории");
    assert.equal(count(summarized, "pi_goal_continuation"), 0, "во вход сводчика продолжение идёт без служебной обёртки");
    assert.equal(count(summarized, "goal-compact-ticket"), 0, "билет не попадает во вход сводчика");
    const after = log.find((request) => request.kind === "turn" && request.step === 7);
    assert.ok(after, "после сжатия цель продолжилась");
    assert.ok(after.window.includes("Продолжить проверку."), "в окне есть сводка");
    assert.ok(!after.window.includes("Довести проверку до закрытия цели."), "раздел «Цель» сводки уступил место договорённости");
    assert.equal(count(after.window, "## Договорённость (редакция"), 1, "ровно одна копия договорённости");
    // Закрытие после сжатия не меняет начало окна (решение 0012): договорённость и сводка без «Цели»
    // стоят там же, а ответ на закрытие говорит, что договорённость больше не действует.
    const closed = log.find((request) => request.kind === "turn" && request.step === 10);
    assert.ok(closed, "после закрытия был ещё запрос");
    const head = (window: string) => window.slice(0, window.indexOf("### Готово, когда"));
    assert.equal(head(closed.window), head(after.window), "начало окна после закрытия то же");
    assert.ok(!closed.window.includes("Довести проверку до закрытия цели."), "раздел «Цель» сводки не вернулся");
    assert.ok(closed.window.includes("остаётся там до следующего сжатия только как история"), "ответ на закрытие несёт пометку");

    // Воспроизводим короткую историческую часть сводки при открытой цели.
    const compactIndex = rows.findIndex((row) => row.type === "compaction");
    const source = rows.slice(0, compactIndex + 1);
    const boundary = "**Контекст разрезанного хода:**";
    const partial = `## Цель\nСтарое поручение.\n\n${boundary}\nНиже новое поручение.\n\n## Исходный запрос\nПродолжить по новому плану.`;
    const seed = source.map((row, index) => JSON.stringify(index === compactIndex ? { ...row, summary: partial } : row)).join("\n") + "\n";
    await start("resume-split", { seed, prompt: "Продолжай по плану." });
    const resumed = requests("resume-split").find((request) => request.kind === "turn");
    assert.ok(resumed, "после возобновления есть запрос к провайдеру");
    assert.ok(resumed.window.includes(boundary), "пометка приоритета доходит до провайдера");
    assert.ok(!resumed.window.includes("Старое поручение."));
    assert.equal(count(resumed.window, "## Договорённость (редакция"), 1);

    const fileHint = "<file-hints>\n\"notes/roadmap.md\"\n</file-hints>";
    const short = source.map((row, index) => JSON.stringify(index === compactIndex
      ? { ...row, summary: `## Цель\nСтарое поручение.\n\n${fileHint}` } : row)).join("\n") + "\n";
    await start("resume-files", { seed: short, prompt: "Продолжай по плану." });
    const withFiles = requests("resume-files").find((request) => request.kind === "turn");
    assert.ok(withFiles, "после возобновления есть запрос к провайдеру");
    assert.ok(withFiles.window.includes("notes/roadmap.md"), "файловая наводка доходит до провайдера");
    assert.ok(!withFiles.window.includes("Старое поручение."));
  });
});

test("свежая файловая наводка доходит до провайдера после сжатия по порогу", { timeout: 30_000 }, async () => {
  const archive = Array.from({ length: 26 }, (_, i) => `docs/archive/check-${i}.md`);
  const recent = "notes/current-check.md";
  const timestamp = new Date(0).toISOString();
  const assistant = { role: "assistant", api: "probe", provider: "probe", model: "offline", timestamp: 1 };
  const seed = [
    { type: "session", version: 3, id: "ba7fddf2-494f-49ba-8ee2-5ba0ea13c761", timestamp, cwd: process.cwd() },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "Сверь результаты.", timestamp: 0 } },
    { type: "message", id: "read", parentId: "user", timestamp, message: { ...assistant, stopReason: "toolUse", content: [{ type: "toolCall", name: "read", id: "read-1", arguments: { path: recent } }] } },
    { type: "message", id: "result", parentId: "read", timestamp, message: { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "Прочитано." }], isError: false, timestamp: 1 } },
    { type: "compaction", id: "prior", parentId: "result", timestamp, firstKeptEntryId: "user", tokensBefore: 100, summary: "## Цель\nСверить результаты.", details: { readFiles: archive, modifiedFiles: [] } },
    { type: "message", id: "kept", parentId: "prior", timestamp, message: { ...assistant, stopReason: "stop", content: [{ type: "text", text: "Данные ".repeat(300) }], usage: { input: 256500, output: 1, totalTokens: 256501, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  const summaryText = `## Цель\nСверить результаты.\n\n## Исходный запрос\nПроверка открыта.\n\nАрхив: ${archive.map(path => path + ".disabled").join(", ")}`;
  await withProbe({ calls: {}, heavySteps: [], lastStep: 1, summaryText }, async (start, requests) => {
    const rows = await start("recent-file", { seed, prompt: "Продолжи проверку." });
    assert.equal(rows.filter(row => row.type === "compaction").length, 2);
    const log = requests("recent-file");
    assert.ok(log.some(r => r.kind === "summary" && r.window.includes(recent)), "чтение вошло в сжимаемую часть");
    const after = log.find(r => r.kind === "turn");
    assert.ok(after, "после сжатия есть следующий запрос");
    const window = after.window.replaceAll('\\"', '"');
    assert.match(window, /<file-hints>.*?"notes\/":.*?"current-check\.md" \[читался\].*?<\/file-hints>/s);
  });
});

test("в запрос без цели после сжатия попадает исправленная реплика, а не прежний текст", { timeout: 30_000 }, async () => {
  const timestamp = new Date(0).toISOString();
  const seed = [
    { type: "session", version: 3, id: "ba7fddf2-494f-49ba-8ee2-5ba0ea13c762", timestamp, cwd: process.cwd() },
    { type: "message", id: "old", parentId: null, timestamp, message: { role: "user", content: "ORIGINAL_PROBE_TEXT", timestamp: 0 } },
    { type: "message", id: "removed", parentId: "old", timestamp, message: { role: "user", content: "REMOVED_PROBE_TEXT", timestamp: 0 } },
    { type: "message", id: "kept", parentId: "removed", timestamp, message: { role: "user", content: "KEPT_PROBE_TEXT", timestamp: 0 } },
    { type: "context_edit", id: "replace", parentId: "kept", timestamp, targetId: "old", replacement: { content: "REPLACEMENT_PROBE_TEXT" } },
    { type: "context_edit", id: "delete", parentId: "replace", timestamp, targetId: "removed", replacement: null },
    { type: "compaction", id: "prior", parentId: "delete", timestamp, firstKeptEntryId: "kept", tokensBefore: 100, summary: "## Цель\nПроверить продолжение." },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await withProbe({ calls: {}, heavySteps: [], lastStep: 1 }, async (start, requests) => {
    await start("edited-replies", { seed, prompt: "Продолжи проверку." });
    const request = requests("edited-replies").find(r => r.kind === "turn");
    assert.ok(request, "Pi отправил первый запрос после открытия сессии");
    assert.ok(request.window.includes("REPLACEMENT_PROBE_TEXT"));
    assert.ok(request.window.includes("KEPT_PROBE_TEXT"));
    assert.ok(!request.window.includes("ORIGINAL_PROBE_TEXT"));
    assert.ok(!request.window.includes("REMOVED_PROBE_TEXT"));
  });
});
