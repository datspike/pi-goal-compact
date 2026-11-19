import { setLanguage } from "../../src/language.js";
import { MAX_COMPACT_PAYLOAD_CHARS } from "../../src/compaction/compact-budget.js";
import { describe, expect, test } from "../support/expect.js";
import { compactedWith, compactWith, treeSummaryWith, type FakeCompactEvent, type FakeComplete, type FakeContext, type FakeEntry, type FakeModel, type FakeTreeEvent } from "../support/compaction.js";
import type { AgentMessage } from "../../src/compaction/file-hints.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSummaryLanguage } from "../../src/compaction/language.js";
import {
	RUSSIAN_COMPACTION_FOCUS,
	RUSSIAN_TREE_SUMMARY_INSTRUCTIONS,
	localizeSummaryStructure,
	stripBranchSummaryPreamble,
} from "../../src/compaction/summary.js";

test("summary language is independently configurable and validates the Pi profile", () => {
	const dir = mkdtempSync(join(tmpdir(), "compaction-language-"));
	try {
		expect(loadSummaryLanguage(dir)).toBe("ru");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "en" } }));
		expect(loadSummaryLanguage(dir)).toBe("en");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ contextCompaction: { summaryLanguage: "fr" } }));
		expect(() => loadSummaryLanguage(dir)).toThrow("contextCompaction.summaryLanguage must be ru or en");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("Russian summary formatting", () => {
	test("translates only native structural headings and preserves technical markers", () => {
		const source = [
			"## Goal",
			"A task in progress.",
			"## Constraints & Preferences",
			"## Progress",
			"### Done",
			"### In Progress",
			"### Blocked",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context",
			"<read-files>",
			"src/example.ts",
			"</read-files>",
			"Error: exact message",
		].join("\n");

		expect(localizeSummaryStructure(source)).toBe([
			"## Цель",
			"A task in progress.",
			"## Ограничения и предпочтения",
			"## Прогресс",
			"### Готово",
			"### В работе",
			"### Заблокировано",
			"## Ключевые решения",
			"## Следующие шаги",
			"## Критический контекст",
			"<read-files>",
			"src/example.ts",
			"</read-files>",
			"Error: exact message",
		].join("\n"));
	});

	test("translates split-turn headings as well", () => {
		expect(localizeSummaryStructure("## Original Request\n## Early Progress\n## Context for Suffix")).toBe("## Исходный запрос\n## Ранний прогресс\n## Контекст для сохранённой части");
	});

	test("translates actual native split-turn headings and service label", () => {
		expect(localizeSummaryStructure("## Original Request\n## Progress So Far\n## Context Needed to Continue\n**Turn Context (split turn):**")).toBe("## Исходный запрос\n## Прогресс на текущий момент\n## Контекст для продолжения\n**Контекст разрезанного хода:**");
	});

	test("does not rewrite technical headings inside code or file blocks", () => {
		const source = "```markdown\n```js\n## Goal\nstill code\n```\n~~~markdown\n## Progress\n~~~\n<read-files>\n## Goal\n</read-files>";
		expect(localizeSummaryStructure(source)).toBe(source);
	});

	test("removes only the native branch preamble", () => {
		const source = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n## Goal\nРабота";
		expect(stripBranchSummaryPreamble(source)).toBe("## Goal\nРабота");
		expect(stripBranchSummaryPreamble("Вводный абзац\n\n## Раздел\nТекст")).toBe("Вводный абзац\n\n## Раздел\nТекст");
		expect(stripBranchSummaryPreamble("## Цель\nРабота")).toBe("## Цель\nРабота");
	});

	test("prompts require Russian prose without changing technical literals", () => {
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("Пиши весь естественный текст");
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("<read-files>");
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("«решение пользователя» или «предложение агента»");
		expect(RUSSIAN_COMPACTION_FOCUS).toContain("испробованные пути с причиной отказа");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("## Цель");
		expect(RUSSIAN_TREE_SUMMARY_INSTRUCTIONS).toContain("Сохраняй точные пути");
	});

	test("returns an explicit cancellation when no model is selected", async () => {
		const ctx: FakeContext = { model: undefined, modelRegistry: { complete: async () => { throw new Error("запрос без модели не отправляется"); } } };
		expect(await compactWith(compactEvent(), ctx)).toEqual({ cancel: true });
	});
});

/** Событие сжатия без истории; поля, нужные тесту, задаются переопределением. */
function compactEvent(preparation: Partial<FakeCompactEvent["preparation"]> = {}, signal = new AbortController().signal): FakeCompactEvent {
	return {
		branchEntries: [],
		signal,
		reason: "threshold",
		willRetry: false,
		preparation: { settings: { reserveTokens: 8192 }, isSplitTurn: false, messagesToSummarize: [], previousSummary: undefined, turnPrefixMessages: [], fileOps: { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() }, firstKeptEntryId: "kept", tokensBefore: 100, ...preparation },
	};
}

const userMessage = (text: string): AgentMessage => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

test("Russian compact keeps localized headings, split-turn context and cumulative files", async () => {
	const responses = ["## Goal\nContinue work", "## Goal\nExisting work", "## Original Request\nComplete the feature"];
	const ctx: FakeContext = {
		model: { maxTokens: 8192 },
		modelRegistry: { complete: async () => ({ content: [{ type: "text", text: responses.shift() }], usage: { input: 1 } }) },
	};
	const event = compactEvent({ fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]) } });
	const normal = await compactedWith(event, ctx);
	expect(normal.summary).toContain("## Цель\nContinue work");
	expect(normal.summary).toContain("<file-hints>");
	expect(normal.summary).not.toContain("<modified-files>");
	expect(normal.details.modifiedFiles).toEqual(["src/b.ts"]);
	const message = userMessage("Continue the feature");
	const split = await compactedWith({ ...event, preparation: { ...event.preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] } }, ctx);
	expect(split.summary).toContain("**Контекст разрезанного хода:**\nЭтот ход начат после истории выше.");
	expect(split.summary).toContain("действует он; разделы выше описывают состояние до хода.\n## Исходный запрос");
});

test("если после фильтра нет нового содержания, сводка сохраняется с разрезом хода и без него", async () => {
    const previousSummary = "## Цель\nСверить результаты.\n\n## Следующие шаги\nОткрытая проверка.";
    let calls = 0;
    const ctx: FakeContext = {
        model: { maxTokens: 8192 },
        modelRegistry: { complete: async () => {
            calls++;
            return { content: [{ type: "text", text: "## Цель\nНовая сводка вместо старой." }] };
        } },
    };
    for (const isSplitTurn of [true, false]) {
        const saved = await compactedWith(compactEvent({ isSplitTurn, previousSummary }), ctx);
        expect(calls).toEqual(0);
        expect(saved.summary).toEqual(previousSummary);
        expect(saved.firstKeptEntryId).toEqual("kept");
    }
});

test("явные инструкции пересказывают прежнюю сводку даже при пустом разрезе", async () => {
    const previousSummary = "## Цель\nСверить результаты.";
    const customInstructions = "Укажи, какая проверка осталась открытой.";
    const requests: string[] = [];
    const ctx: FakeContext = {
        model: { maxTokens: 8192 },
        modelRegistry: { complete: async (_model, context) => {
            requests.push(JSON.stringify(context.messages));
            return { content: [{ type: "text", text: "## Цель\nСверить результаты. Открыта проверка второй строки." }] };
        } },
    };
    const saved = await compactedWith({ ...compactEvent({ isSplitTurn: true, previousSummary }), customInstructions }, ctx);
    expect(requests.length).toEqual(1);
    expect(requests[0]).toContain(JSON.stringify(previousSummary).slice(1, -1));
    expect(requests[0]).toContain(customInstructions);
    expect(saved.summary).toContain("Открыта проверка второй строки.");
});

test("негодная прежняя сводка не переносится в пустой разрез", async () => {
    const reasons: string[] = [];
    const ctx: FakeContext = {
        model: { maxTokens: 8192 },
        modelRegistry: { complete: async () => { throw new Error("лишний запрос"); } },
    };
    const event = compactEvent({ isSplitTurn: true, previousSummary: "Без структурного заголовка." });
    expect(await compactWith(event, ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
    expect(reasons).toEqual(["invalid-response"]);
});

test("английскую сводку тоже пишет расширение: английские разделы, правила и наводки", async () => {
	setLanguage("en");
	try {
		const requests: string[] = [];
		const responses = ["## Goal\nContinue work", "## Goal\nExisting work", "## Original Request\nComplete the feature"];
		const ctx: FakeContext = {
			model: { maxTokens: 8192 },
			modelRegistry: { complete: async (_model, context) => {
				requests.push(JSON.stringify(context.messages));
				return { content: [{ type: "text", text: responses.shift() }], usage: { input: 1 } };
			} },
		};
		const event = compactEvent({ fileOps: { read: new Set(["src/a.ts"]), edited: new Set(["src/b.ts"]) } });
		const normal = await compactedWith(event, ctx);
		expect(normal.summary).toContain("## Goal\nContinue work");
		expect(normal.summary).toContain("Tracked in total: 1 read, 1 modified");
		expect(normal.summary).not.toMatch(/[А-Яа-я]/);
		expect(requests[0]).toContain("give every decision an explicit status");
		expect(requests[0]).not.toMatch(/[А-Яа-я]/);
		const message = userMessage("Continue the feature");
		const split = await compactedWith({ ...event, preparation: { ...event.preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] } }, ctx);
		expect(split.summary).toContain("**Turn Context (split turn):**\nThis turn started after the history above.");
		expect(split.summary).toContain("## Original Request\nComplete the feature");
	} finally {
		setLanguage("ru");
	}
});

test("split-turn compact sends custom instructions to every summary request", async () => {
	const message = userMessage("Continue the feature");
	for (const includeHistory of [false, true]) {
		const requests: string[] = [];
		const ctx: FakeContext = {
			model: { maxTokens: 8192 },
			modelRegistry: { complete: async (_model, context) => {
				requests.push(JSON.stringify(context.messages));
				return { content: [{ type: "text", text: requests.length === 1 && includeHistory ? "## Goal\nExisting work" : "## Original Request\nComplete the feature" }], usage: { input: 1 } };
			} },
		};
		const event = compactEvent({ isSplitTurn: true, messagesToSummarize: includeHistory ? [message] : [], turnPrefixMessages: [message] });
		const result = await compactWith({ ...event, customInstructions: "SPECIAL-OMEGA" }, ctx);
		expect(result).toHaveProperty("compaction");
		expect(requests).toHaveLength(includeHistory ? 2 : 1);
		for (const request of requests) expect(request).toContain("SPECIAL-OMEGA");
	}
});

test("Russian /tree keeps localized headings and usage", async () => {
	const ctx: FakeContext = { model: { contextWindow: 128000, maxTokens: 8192 }, modelRegistry: { complete: async () => ({ content: [{ type: "text", text: "## Goal\nRead src/a.ts" }], usage: { input: 3 } }) } };
	const event: FakeTreeEvent = { preparation: { userWantsSummary: true, entriesToSummarize: [{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } }] }, signal: new AbortController().signal };
	const result = await treeSummaryWith(event, ctx);
	expect(result?.summary).toContain("## Цель\nRead src/a.ts");
	expect(result?.usage).toEqual({ input: 3 });
});

type Call = Parameters<FakeComplete>;

/** Сжатие под охраной контекста: сессия, дерево, модель и маршрут могут меняться во время запроса. */
function guardedFixture() {
	const controller = new AbortController();
	const activeModel: FakeModel = { provider: "fixture", id: "active", api: "openai-responses", baseUrl: "https://active.invalid", maxTokens: 8192, contextWindow: 128000 };
	const branch: FakeEntry[] = [{ id: "root", parentId: null, type: "message" }];
	let sessionId = "session-a";
	let route: object = {};
	const calls: Call[] = [];
	const fixture: { controller: AbortController; branch: FakeEntry[]; activeModel: FakeModel; calls: Call[]; response: unknown; ctx: FakeContext; event: FakeCompactEvent; setSession(value: string): void; setRoute(value: object): void } = {
		controller,
		branch,
		activeModel,
		calls,
		response: { stopReason: "stop", content: [{ type: "text", text: "## Goal\nСводка" }], usage: { input: 2, output: 3 } },
		ctx: {
			model: activeModel,
			sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl`, getLeafId: () => branch.at(-1)?.id ?? null, getBranch: () => branch },
			modelRegistry: { getProvider: () => route, complete: async (...args) => { calls.push(args); return fixture.response; } },
		},
		event: compactEvent({}, controller.signal),
		setSession: (value) => { sessionId = value; },
		setRoute: (value) => { route = value; },
	};
	return fixture;
}

test("standard compact uses the service model without changing the active identity and requests SSE once", async () => {
	const fixture = guardedFixture();
	const serviceModel: FakeModel = { ...fixture.activeModel, id: "service", baseUrl: "https://service.invalid" };
	const result = await compactWith(fixture.event, fixture.ctx, { model: serviceModel });
	expect(result).toHaveProperty("compaction");
	expect(fixture.calls).toHaveLength(1);
	expect(fixture.calls[0]?.[0]).toBe(serviceModel);
	expect(fixture.calls[0]?.[2]).toMatchObject({ transport: "sse", maxRetries: 0, signal: fixture.event.signal });
	expect(fixture.ctx.model).toBe(fixture.activeModel);
});

test("standard compact classifies invalid responses and request failures separately", async () => {
	const invalid = guardedFixture();
	invalid.response = { stopReason: "stop", content: [{ type: "text", text: "не структурировано" }] };
	const invalidReasons: string[] = [];
	expect(await compactWith(invalid.event, invalid.ctx, { onFailure: (reason) => invalidReasons.push(reason) })).toEqual({ cancel: true });
	expect(invalidReasons).toEqual(["invalid-response"]);
	const failed = guardedFixture();
	failed.ctx.modelRegistry.complete = async (...args) => { failed.calls.push(args); throw new Error("network unavailable"); };
	const failedReasons: string[] = [];
	expect(await compactWith(failed.event, failed.ctx, { onFailure: (reason) => failedReasons.push(reason) })).toEqual({ cancel: true });
	expect(failedReasons).toEqual(["request-failed"]);
});

test("standard compact rejects session, tree, model and route changes after await", async () => {
	for (const change of ["session", "tree", "model", "route"] as const) {
		const fixture = guardedFixture();
		fixture.ctx.modelRegistry.complete = async (...args) => {
			fixture.calls.push(args);
			if (change === "session") fixture.setSession("session-b");
			// Другая ветка: суммируемое начало истории больше не то, что видит модель.
			if (change === "tree") fixture.branch.splice(0, fixture.branch.length, { id: "other", parentId: null, type: "message" }, { id: "child", parentId: "other", type: "message" });
			if (change === "model") fixture.ctx.model = { ...fixture.activeModel, id: "changed" };
			if (change === "route") fixture.setRoute({});
			return fixture.response;
		};
		const reasons: string[] = [];
		expect(await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
		expect(reasons).toEqual(["context-changed"]);
		expect(fixture.calls).toHaveLength(1);
	}
});

test("standard compact ignores session records that never reach the model", async () => {
	const fixture = guardedFixture();
	fixture.ctx.modelRegistry.complete = async (...args) => {
		fixture.calls.push(args);
		// pi-autoname renames the session while the summary request is in flight.
		fixture.branch.push({ id: "name", parentId: "root", type: "session_info" }, { id: "state", parentId: "name", type: "custom", customType: "pi-autoname-state" }, { id: "usage", parentId: "state", type: "usage" });
		return fixture.response;
	};
	const reasons: string[] = [];
	expect(await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toHaveProperty("compaction");
	expect(reasons).toEqual([]);
});

test("standard compact keeps messages appended to the branch end during the summary request", async () => {
	const fixture = guardedFixture();
	fixture.ctx.modelRegistry.complete = async (...args) => {
		fixture.calls.push(args);
		// Уведомление сабагента приходит, пока пишется сводка: Pi оставит его в окне после сводки.
		fixture.branch.push({ id: "notify", parentId: "root", type: "custom_message" }, { id: "reply", parentId: "notify", type: "message" });
		return fixture.response;
	};
	const reasons: string[] = [];
	const result = await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) });
	expect(result).toHaveProperty("compaction");
	expect(reasons).toEqual([]);
});

test("standard compact rejects a changed entry inside the summarized history even when the branch grows", async () => {
	const fixture = guardedFixture();
	fixture.branch.push({ id: "middle", parentId: "root", type: "message" });
	fixture.ctx.modelRegistry.complete = async (...args) => {
		fixture.calls.push(args);
		fixture.branch.splice(1, 1, { id: "edited", parentId: "root", type: "message" }, { id: "tail", parentId: "edited", type: "custom_message" });
		return fixture.response;
	};
	const reasons: string[] = [];
	expect(await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
	expect(reasons).toEqual(["context-changed"]);
});

test("standard compact rejects an appended context_edit of summarized history", async () => {
	const fixture = guardedFixture();
	fixture.ctx.modelRegistry.complete = async (...args) => {
		fixture.calls.push(args);
		// Pi правит старую запись новой записью в конце ветки; префикс списка при этом не меняется.
		fixture.branch.push({ id: "edit", parentId: "root", type: "context_edit" });
		return fixture.response;
	};
	const reasons: string[] = [];
	expect(await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
	expect(reasons).toEqual(["context-changed"]);
});

test("standard compact treats abort and owner loss as explicit cancellation", async () => {
	const aborted = guardedFixture();
	aborted.ctx.modelRegistry.complete = async (...args) => { aborted.calls.push(args); aborted.controller.abort(); return aborted.response; };
	const abortedReasons: string[] = [];
	expect(await compactWith(aborted.event, aborted.ctx, { onFailure: (reason) => abortedReasons.push(reason) })).toEqual({ cancel: true });
	expect(abortedReasons).toEqual(["aborted"]);
	const stale = guardedFixture();
	const staleReasons: string[] = [];
	expect(await compactWith(stale.event, stale.ctx, { isCurrent: () => false, onFailure: (reason) => staleReasons.push(reason) })).toEqual({ cancel: true });
	expect(staleReasons).toEqual(["context-changed"]);
	expect(stale.calls).toHaveLength(0);
});

test("split-turn stops before the prefix request when history loses its context", async () => {
	const fixture = guardedFixture();
	const message = userMessage("Новый ход");
	fixture.event.preparation = { ...fixture.event.preparation, isSplitTurn: true, messagesToSummarize: [message], turnPrefixMessages: [message] };
	fixture.ctx.modelRegistry.complete = async (...args) => {
		fixture.calls.push(args);
		fixture.ctx.model = { ...fixture.activeModel, id: "changed" };
		return fixture.response;
	};
	const reasons: string[] = [];
	expect(await compactWith(fixture.event, fixture.ctx, { onFailure: (reason) => reasons.push(reason) })).toEqual({ cancel: true });
	expect(reasons).toEqual(["context-changed"]);
	expect(fixture.calls).toHaveLength(1);
});

for (const kind of ["small", "oversized", "swallowed-error", "late-route"] as const) test(`standard final provider boundary: ${kind}`, async () => {
	const fixture = guardedFixture();
	const huge = kind === "oversized" || kind === "swallowed-error";
	const text = huge ? "\0".repeat(Math.ceil(MAX_COMPACT_PAYLOAD_CHARS / 6) + 2048) : "Сохранить локальный JSON";
	fixture.event.preparation.messagesToSummarize = [userMessage(text)];
	const reasons: string[] = [];
	let sent = 0;
	fixture.ctx.modelRegistry.complete = async (model, context, options) => {
		const payload = { model: model.id, input: context.messages, encrypted_content: "opaque-kept" };
		if (kind === "late-route") fixture.activeModel.baseUrl = "https://changed.invalid";
		try { expect((await options?.onPayload?.(payload, model)) ?? payload).toBe(payload); }
		catch (error) { if (kind === "swallowed-error") return { stopReason: "error", errorMessage: String(error), content: [] }; throw error; }
		sent++;
		return fixture.response;
	};
	const result = await compactWith(fixture.event, fixture.ctx, { model: { ...fixture.activeModel, contextWindow: 1048576 }, capability: { window: 1048576, source: "offline exact-route declaration", outputLimitEnforced: false }, onFailure: (reason) => reasons.push(reason) });
	if (kind === "small") { expect(result).toHaveProperty("compaction"); expect(sent).toBe(1); }
	else { expect(result).toEqual({ cancel: true }); expect(sent).toBe(0); expect(reasons).toEqual([kind === "late-route" ? "context-changed" : "request-too-large"]); }
});

test("сбой запроса сводки повторяется, а его причина доходит до владельца", async () => {
	const recovered = guardedFixture();
	const ok = recovered.response;
	let attempt = 0;
	recovered.ctx.modelRegistry.complete = async (...args) => {
		recovered.calls.push(args);
		if (++attempt === 1) throw new Error("socket hang up");
		return attempt === 2 ? { stopReason: "error", errorMessage: "503 upstream", content: [] } : ok;
	};
	const retries: string[] = [];
	const reasons: string[] = [];
	const result = await compactWith(recovered.event, recovered.ctx, { retryDelaysMs: [0, 0], onRetry: (n, of, detail) => retries.push(`${n}/${of}:${detail}`), onFailure: (reason) => reasons.push(reason) });
	expect(result).toHaveProperty("compaction");
	expect(retries).toEqual(["1/2:socket hang up", "2/2:503 upstream"]);
	expect(reasons).toEqual([]);

	const exhausted = guardedFixture();
	exhausted.response = { stopReason: "error", errorMessage: "503 upstream", content: [] };
	const failures: string[] = [];
	expect(await compactWith(exhausted.event, exhausted.ctx, { retryDelaysMs: [0], onFailure: (reason, detail) => failures.push(`${reason}:${detail}`) })).toEqual({ cancel: true });
	expect(exhausted.calls).toHaveLength(2);
	expect(failures).toEqual(["request-failed:503 upstream"]);
});

test("негодный ответ и отмена во время паузы не повторяются", async () => {
	const invalid = guardedFixture();
	invalid.response = { stopReason: "stop", content: [{ type: "text", text: "не структурировано" }] };
	expect(await compactWith(invalid.event, invalid.ctx, { retryDelaysMs: [0, 0] })).toEqual({ cancel: true });
	expect(invalid.calls).toHaveLength(1);

	const cancelled = guardedFixture();
	cancelled.response = { stopReason: "error", errorMessage: "503 upstream", content: [] };
	const reasons: string[] = [];
	const started = Date.now();
	const result = await compactWith(cancelled.event, cancelled.ctx, { retryDelaysMs: [60_000], onRetry: () => cancelled.controller.abort(), onFailure: (reason) => reasons.push(reason) });
	expect(result).toEqual({ cancel: true });
	expect(cancelled.calls).toHaveLength(1);
	expect(reasons).toEqual(["aborted"]);
	expect(Date.now() - started).toBeLessThan(5_000);
});
