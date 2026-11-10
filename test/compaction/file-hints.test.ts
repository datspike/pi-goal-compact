import { describe, expect, test } from "../support/expect.js";
import { compactedWith, compactWith, treeSummaryWith, type FakeCompactEvent, type FakeContext, type FakeEntry, type FakeTreeEvent } from "../support/compaction.js";
import { assistantToolCall as tool, fileListsOf } from "../support/pi-messages.js";
import { collectFileLists, FILE_HINTS_MAX_CHARS, formatFileHints, withoutFileTracking, withoutMessageFileTracking, type AgentMessage } from "../../src/compaction/file-hints.js";

const BODY = "## Цель\nСохранить смысл задачи.\n## Ограничения и предпочтения\nНе менять production.\n## Прогресс\nИсправить src/current.ts.\n## Следующие шаги\nПроверить tests/current.test.ts; старый результат не повторять.";
const OLD = `${BODY}\n\n<read-files>\narchive/old.ts\n</read-files>\n\n<modified-files>\narchive/changed.ts\n</modified-files>`;
const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 };

const compact = compactWith;
const compacted = compactedWith;
const treeSummary = treeSummaryWith;

function fixture(texts = [BODY]) {
	const prompts: string[] = [];
	const options: Array<{ signal?: AbortSignal } | undefined> = [];
	const model = { maxTokens: 16384, contextWindow: 272000 };
	const ctx: FakeContext = {
		model,
		modelRegistry: { complete: async (_model, context, opts) => {
			const block = context.messages[0]?.content[0];
			prompts.push(typeof block === "object" && block.type === "text" ? block.text : ""); options.push(opts);
			return { stopReason: "stop", content: [{ type: "text", text: texts.shift() ?? BODY }], usage };
		} },
	};
	const event: FakeCompactEvent = { signal: new AbortController().signal, branchEntries: [{ type: "compaction", details: { readFiles: ["archive/old.ts"], modifiedFiles: ["archive/changed.ts"] } }], preparation: {
		previousSummary: OLD, messagesToSummarize: [tool("src/current.ts", "edit")], turnPrefixMessages: [],
		fileOps: { read: new Set(["tests/current.test.ts"]), edited: new Set(["src/current.ts"]), written: new Set() },
		settings: { reserveTokens: 16384 }, firstKeptEntryId: "retained", tokensBefore: 256000, isSplitTurn: false,
	} };
	return { ctx, model, event, prompts, options };
}

describe("bounded file navigation", () => {
	test("removes old and new tracking without removing prose or fenced examples", () => {
		expect(withoutFileTracking(OLD)).toBe(BODY);
		expect(withoutFileTracking(OLD.replaceAll("\n", "\r\n"))).toBe(BODY.replaceAll("\n", "\r\n"));
		const fenced = "````markdown\n```\n<read-files>\nexample.ts\n</read-files>\n````";
		expect(withoutFileTracking(fenced)).toBe(fenced);
		for (const raw of ["<read-files>\nunfinished", "before\n<read-files>\n<important>\nkeep", "inline <read-files>literal</read-files>"]) expect(withoutFileTracking(raw)).toBe(raw);
		const hints = formatFileHints({ readFiles: ["a.ts"], modifiedFiles: [] }, [tool("a.ts")], "");
		expect(withoutFileTracking(BODY + hints)).toBe(BODY);
	});

	test("never sanitizes user/tool contents; copies summary messages only", () => {
		const summary = { role: "branchSummary", summary: OLD, fromId: "a", timestamp: 0 } as const;
		const input: AgentMessage[] = [
			{ role: "user", content: OLD, timestamp: 0 },
			{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: OLD }], isError: false, timestamp: 0 },
			summary,
		];
		const result = withoutMessageFileTracking(input);
		expect(result[0]).toBe(input[0]); expect(result[1]).toBe(input[1]);
		const cleaned = result[2];
		expect(cleaned?.role === "branchSummary" ? cleaned.summary : undefined).toBe(BODY); expect(summary.summary).toBe(OLD);
	});

	test("keeps cumulative metadata exact, filters malformed details, and preserves roots", () => {
		const files = collectFileLists({ read: new Set(["a.ts", "/repo/a.ts"]) }, [
			{ type: "compaction", fromHook: true, details: { modifiedFiles: ["a.ts", "other/a.ts", 123], readFiles: ["space name.ts"] } },
			{ type: "branch_summary", details: { readFiles: "invalid" } },
			{ type: "message", details: { modifiedFiles: ["not-a-ledger.ts"] } },
		]);
		expect(files).toEqual({ readFiles: ["/repo/a.ts", "space name.ts"], modifiedFiles: ["a.ts", "other/a.ts"] });
	});

	test("groups exact names, does not claim current diff, and keeps historical files out of exact hints", () => {
		const files = { readFiles: ["/repo/src/a.ts", "/repo/src/b.ts", "/other/src/a.ts", "archive/old.ts"], modifiedFiles: ["tests/test.ts"] };
		const hints = formatFileHints(files, [tool("/repo/src/b.ts"), tool("/repo/src/a.ts"), tool("/other/src/a.ts")], "tests/test.ts");
		expect(hints).toContain('"/repo/src/":'); expect(hints).toContain('"/other/src/":');
		expect(hints).toContain('"test.ts" [изменялся]');
		expect(hints).not.toContain("old.ts"); expect(hints).toContain("не список текущих изменений");
	});

	test("bounds even huge histories and long/unusual names without truncating exact paths", () => {
		const paths = Array.from({ length: 10000 }, (_, i) => `/root/${i}/` + "long".repeat(70) + ".ts");
		paths.push("/root/" + "x".repeat(20000), "new\nline.ts", 'quote"name.ts');
		const files = { readFiles: paths, modifiedFiles: [] };
		const hints = formatFileHints(files, paths.map((path) => tool(path)), BODY);
		expect(hints.length).toBeLessThanOrEqual(FILE_HINTS_MAX_CHARS);
		expect(hints).toContain('new\\nline.ts'); expect(hints).toContain('quote\\"name.ts');
		expect(hints).not.toContain("x".repeat(500));
		expect(files.readFiles.length).toBe(10003);
	});
});

describe("summary integration", () => {
	test("normal compact excludes the historical appendix from input and output but preserves metadata and prose", async () => {
		const { ctx, event, prompts, options } = fixture();
		const original = JSON.stringify(event, (_key, value) => value instanceof Set ? [...value] : value);
		const result = await compacted(event, ctx);
		expect(prompts[0]).not.toContain("archive/old.ts");
		expect(prompts[0]).toContain(BODY);
		expect(result.summary.startsWith(BODY + "\n\n<file-hints>")).toBe(true);
		expect(result.summary).not.toContain("<read-files>");
		expect(result.details).toEqual({ readFiles: ["archive/old.ts", "tests/current.test.ts"], modifiedFiles: ["archive/changed.ts", "src/current.ts"] });
		expect(result.firstKeptEntryId).toBe("retained"); expect(result.usage).toEqual(usage);
		expect(options[0]?.signal).toBe(event.signal);
		expect(JSON.stringify(event, (_key, value) => value instanceof Set ? [...value] : value)).toBe(original);
	});

	test("split turn with no history generation carries semantic history, not its appendices", async () => {
		const prefix = "## Исходный запрос\nПродолжить работу.\n## Контекст для продолжения\nНе повторять старый запуск.";
		const { ctx, event, prompts } = fixture([prefix]);
		event.preparation.isSplitTurn = true;
		event.preparation.messagesToSummarize = [];
		event.preparation.turnPrefixMessages = [tool("src/current.ts")];
		const result = await compacted(event, ctx);
		expect(prompts.length).toBe(1);
		expect(result.summary).toContain(BODY);
		expect(result.summary).toContain(prefix);
		expect(result.summary.match(/<file-hints>/g)?.length).toBe(1);
		expect(result.summary).not.toContain("<read-files>");
	});

	test("split turn with history generation cleans nested summary messages and sums usage", async () => {
		const { ctx, event, prompts } = fixture([BODY, "## Исходный запрос\nНовый шаг"]);
		event.preparation.isSplitTurn = true;
		event.preparation.messagesToSummarize.push({ role: "compactionSummary", summary: OLD, tokensBefore: 256000, timestamp: 0 });
		event.preparation.turnPrefixMessages = [tool("src/current.ts")];
		const result = await compacted(event, ctx);
		expect(prompts.length).toBe(2); expect(prompts[0]).not.toContain("archive/old.ts");
		expect(result.usage?.totalTokens).toBe(60);
	});

	test("50 compacts keep hints bounded and all historical paths in details", async () => {
		const { ctx, event } = fixture();
		for (let i = 0; i < 50; i++) {
			event.preparation.fileOps.edited.add(`.runtime/run-${i}/result.json`);
			const result = await compacted(event, ctx);
			expect(result.summary.length - BODY.length).toBeLessThanOrEqual(FILE_HINTS_MAX_CHARS);
			expect(withoutFileTracking(result.summary)).toBe(BODY);
			event.branchEntries.push({ type: "compaction", details: result.details });
			event.preparation.previousSummary = result.summary;
		}
		expect(fileListsOf(event.branchEntries.at(-1)?.details).modifiedFiles.length).toBe(52);
	});

	test("tree summarizes cleaned branch entries without mutating originals or losing inherited metadata", async () => {
		const { ctx, prompts } = fixture();
		const entry: FakeEntry = { type: "branch_summary", id: "b1", parentId: null, timestamp: new Date(0).toISOString(), fromId: "source", summary: OLD, fromHook: true, details: { readFiles: ["archive/old.ts"], modifiedFiles: ["archive/changed.ts"] } };
		const event: FakeTreeEvent = { signal: new AbortController().signal, preparation: { userWantsSummary: true, entriesToSummarize: [entry] } };
		const result = (await treeSummary(event, ctx))!;
		expect(prompts[0]).not.toContain("archive/old.ts"); expect(prompts[0]).toContain("Сохранить смысл задачи");
		expect(result.details.modifiedFiles).toEqual(["archive/changed.ts"]); expect(entry.summary).toBe(OLD);
		expect(result.usage).toEqual(usage);
		event.preparation.replaceInstructions = true; event.preparation.customInstructions = "ONLY CUSTOM";
		await treeSummary(event, ctx);
		expect(prompts[1]).toContain("ONLY CUSTOM"); expect(prompts[1]).not.toContain("Чего пользователь пытался добиться");
	});

	test("failed compact cancels explicitly while tree retains its fallback and inputs stay unchanged", async () => {
		for (const response of [new Error("offline"), { stopReason: "length", content: [] }, { stopReason: "stop", content: [{ type: "text", text: "invalid" }] }]) {
			const { ctx, event } = fixture();
			ctx.modelRegistry.complete = async () => { if (response instanceof Error) throw response; return response; };
			expect(await compact(event, ctx)).toEqual({ cancel: true });
			expect(event.preparation.previousSummary).toBe(OLD);
			const tree: FakeTreeEvent = { signal: event.signal, preparation: { userWantsSummary: true, entriesToSummarize: [{ type: "branch_summary", id: "b", summary: OLD, fromId: "a", timestamp: new Date(0).toISOString() }] } };
			expect(await treeSummary(tree, ctx)).toBeUndefined();
		}
	});
});

describe("tracking boundary regressions", () => {
	const trackingOnly = (heading: string) => `<file-hints>\n${heading}\nNOT-SEMANTIC-BODY\n</file-hints>`;
	test("tracking-only generated history or prefix cancels without another summarizer", async () => {
		for (const mode of ["normal", "history", "prefix", "prefix-no-history"]) {
			const responses = mode === "history" ? [trackingOnly("## Цель"), "## Исходный запрос\nKeep prefix"]
				: mode === "prefix" ? [BODY, trackingOnly("## Исходный запрос")]
				: [trackingOnly(mode === "normal" ? "## Цель" : "## Исходный запрос")];
			const { ctx, event } = fixture(responses);
			if (mode !== "normal") {
				event.preparation.isSplitTurn = true;
				event.preparation.turnPrefixMessages = [tool("src/current.ts")];
				if (mode === "prefix-no-history") event.preparation.messagesToSummarize = [];
			}
			expect(await compact(event, ctx)).toEqual({ cancel: true });
			expect(event.preparation.previousSummary).toBe(OLD);
		}
	});

	test("tree rejects tracking-only output even with replaceInstructions", async () => {
		for (const replaceInstructions of [false, true]) {
			const { ctx } = fixture([trackingOnly("## Цель")]);
			const event: FakeTreeEvent = { signal: new AbortController().signal, preparation: { userWantsSummary: true, replaceInstructions, customInstructions: "Custom summary", entriesToSummarize: [{ type: "branch_summary", summary: OLD, fromId: "a", timestamp: new Date(0).toISOString() }] } };
			expect(await treeSummary(event, ctx)).toBeUndefined();
		}
	});

	test("legacy filenames cannot keep a large completed list in the next compact or displace tree context", async () => {
		for (const unusual of ["<draft>.ts", "<draft>", "```notes.ts", "~~~notes.ts"]) {
			const paths = [unusual, ...Array.from({ length: 10000 }, (_, i) => `archive/${i}.ts`)];
			const previous = `${BODY}\n\n<read-files>\n${paths.join("\n")}\n</read-files>`;
			const { ctx, model, event, prompts } = fixture();
			event.preparation.previousSummary = previous;
			event.branchEntries = [{ type: "compaction", details: { readFiles: paths } }];
			const result = await compacted(event, ctx);
			expect(prompts[0]).not.toContain("archive/9999.ts");
			expect(result.details.readFiles).toContain(unusual);
			expect(result.details.readFiles).toContain("archive/9999.ts");
			model.contextWindow = 18000;
			const tree: FakeTreeEvent = { signal: event.signal, preparation: { userWantsSummary: true, entriesToSummarize: [
				{ type: "message", message: { role: "user", content: "EARLIER_SEMANTIC_OBLIGATION", timestamp: 0 }, timestamp: new Date(0).toISOString() },
				{ type: "branch_summary", summary: previous, fromId: "a", timestamp: new Date(1).toISOString(), details: { readFiles: paths } },
			] } };
			const treeResult = (await treeSummary(tree, ctx))!;
			expect(prompts[1]).not.toContain("archive/9999.ts");
			expect(prompts[1]).toContain("EARLIER_SEMANTIC_OBLIGATION");
			expect(treeResult.details.readFiles).toContain(unusual);
		}
	});
});

describe("metadata-backed legacy boundaries", () => {
	for (const tag of ["read-files", "modified-files"]) {
		test(`${tag}: literal closing path stays in metadata, not compact/tree input`, async () => {
			const paths = [`</${tag}>`, ...Array.from({ length: 10000 }, (_, i) => `archive/${i}.ts`)].sort();
			const details = { readFiles: tag === "read-files" ? paths : [], modifiedFiles: tag === "modified-files" ? paths : [] };
			const previous = `${BODY}\n\n<${tag}>\n${paths.join("\n")}\n</${tag}>`;
			expect(withoutFileTracking(previous, [details])).toBe(BODY);
			const entry: FakeEntry = { type: "compaction", summary: previous, details, timestamp: new Date(0).toISOString() };
			const { ctx, model, event, prompts } = fixture();
			event.branchEntries = [entry];
			event.preparation.previousSummary = previous;
			event.preparation.messagesToSummarize.push({ role: "compactionSummary", summary: previous, tokensBefore: 0, timestamp: 0 });
			const compact = await compacted(event, ctx);
			expect(prompts[0]).not.toContain("archive/9999.ts");
			const field = tag === "read-files" ? "readFiles" : "modifiedFiles";
			expect(compact.details[field]).toContain(`</${tag}>`);
			expect(compact.details[field]).toContain("archive/9999.ts");
			model.contextWindow = 18000;
			const tree: FakeTreeEvent = { signal: event.signal, preparation: { userWantsSummary: true, entriesToSummarize: [
				{ type: "message", message: { role: "user", content: "EARLIER_SEMANTIC_OBLIGATION", timestamp: 0 }, timestamp: new Date(0).toISOString() },
				{ ...entry, type: "branch_summary", fromId: "a" },
			] } };
			const branch = (await treeSummary(tree, ctx))!;
			expect(prompts[1]).not.toContain("archive/9999.ts");
			expect(prompts[1]).toContain("EARLIER_SEMANTIC_OBLIGATION");
			expect(branch.details[field]).toEqual(paths);
			expect(entry.summary).toBe(previous);
			const split = fixture(["## Исходный запрос\nKeep prefix"]);
			split.event.branchEntries = [entry];
			Object.assign(split.event.preparation, { previousSummary: previous, isSplitTurn: true, messagesToSummarize: [], turnPrefixMessages: [tool("current.ts")] });
			const splitResult = await compacted(split.event, split.ctx);
			expect(splitResult.summary).not.toContain("archive/9999.ts");
			expect(splitResult.details[field]).toContain(`</${tag}>`);
		});
	}

	test("exact serialization does not swallow prose between separate lists or fenced samples", () => {
		const details = { readFiles: ["</read-files>", "a.ts"], modifiedFiles: [] };
		const block = `<read-files>\n${details.readFiles.join("\n")}\n</read-files>`;
		expect(withoutFileTracking(`${BODY}\n${block}\nKEEP_BETWEEN\n${block}`, [details])).toBe(`${BODY}\nKEEP_BETWEEN`);
		const fenced = `\`\`\`text\n${block}\n\`\`\``;
		expect(withoutFileTracking(fenced, [details])).toBe(fenced);
		expect(withoutFileTracking(`${BODY}\r\n${block.replaceAll("\n", "\r\n")}`, [details])).toBe(BODY);
		const multiline = { readFiles: ["prefix\n</read-files>\nsuffix", "z.ts"] };
		const multiBlock = `<read-files>\n${multiline.readFiles.join("\n")}\n</read-files>`;
		expect(withoutFileTracking(`${BODY}\n${multiBlock}`, [multiline])).toBe(BODY);
	});
});

test("known closing-tag paths do not make incomplete legacy lists look complete", () => {
	for (const tag of ["read-files", "modified-files"]) {
		const paths = [`</${tag}>`, "a.ts", "z.ts"];
		const details = { [tag === "read-files" ? "readFiles" : "modifiedFiles"]: paths };
		for (const body of [paths, paths.slice(0, 2), paths.slice(0, 1)]) {
			const incomplete = `${BODY}\n<${tag}>\n${body.join("\n")}`;
			expect(withoutFileTracking(incomplete, [details])).toBe(incomplete);
		}
	}
});
