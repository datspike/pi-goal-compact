import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { appendAudit, type AuditEntry, type AuditOrigin, type AuditReason } from "../compaction/audit.js";
import { COMPACT_CARD_TYPE, estimateSummaryTokens, renderCompactCard, type CompactCardData } from "../compaction/card.js";
import {
	buildInstructions,
	buildLedger,
	checkpointParamsSchema,
	compactedSinceLastUserMessage,
	continuationPrompt,
	withoutLegacyServiceTurns,
} from "../compaction/checkpoint.js";
import type { SummarySettings } from "../compaction/language.js";
import type { ContextMode } from "../compaction/policy.js";
import { summarizeCompaction, summarizeTree } from "../compaction/summary.js";
import type { CoreEffect, CompactionReason } from "../core/model.js";
import { createRequestStage, REQUEST_STAGE_EVENTS, type RequestStageEvent } from "../request-stage/index.js";
import { LEGACY_RECORD_NAMES, RECORD } from "../records.js";
import type { CoreDriver } from "./driver.js";
import type { Tickets } from "./tickets.js";
import { say, sayFor } from "../language.js";
import { notice } from "./notice.js";
import { createWindowMode } from "./window-mode.js";

const workingStandard = (): string => say("Compact: стандартная сводка", "Compact: standard summary");
const MODES: readonly ContextMode[] = ["economy", "long-once", "long-chat", "off"];

type ContextCompletion = { value: string; label: string; description: string };

const CONTEXT_COMPLETIONS: readonly ContextCompletion[] = [
	{ value: "status", label: "status", description: "Показать текущий режим, окно и порог" },
	{ value: "economy", label: "economy", description: "Консервативное окно, ограниченное capability модели" },
	{ value: "long-once", label: "long-once", description: "Увеличенное окно по declared capability до следующего compact" },
	{ value: "long-chat", label: "long-chat", description: "Постоянное увеличенное окно по declared capability" },
	{ value: "off", label: "off", description: "Вернуть declared registry-окно без extension soft cap" },
];
const ENGLISH_DESCRIPTIONS: Readonly<Record<string, string>> = {
	status: "Show the current mode, window and threshold",
	economy: "Conservative window bounded by model capability",
	"long-once": "Extended window until the next compaction",
	"long-chat": "Persistent extended window within model capability",
	off: "Restore the declared registry window without the extension soft cap",
};

export function getContextArgumentCompletions(prefix: string, language: "ru" | "en" = "ru"): ContextCompletion[] | null {
	const query = prefix.trimStart().replace(/\s+/g, " ");
	const items = CONTEXT_COMPLETIONS.filter((item) => item.value.startsWith(query));
	if (!items.length) return null;
	return language === "ru" ? [...items] : items.map((item) => ({ ...item, description: ENGLISH_DESCRIPTIONS[item.value] ?? item.description }));
}

/** Маршрут модели без окна: смена окна этим расширением маршрут не меняет. */
function routeOf(ctx: ExtensionContext): string {
	const model = ctx.model;
	return JSON.stringify(model ? [model.provider, model.id, model.api, model.baseUrl ?? ""] : null);
}

type PendingCard = Pick<CompactCardData, "kind" | "provider" | "model" | "durationMs" | "repairAttempts"> & { sessionId: string };

/**
 * Сжатие без цели: режимы окна, сводки, контрольная точка с продолжением,
 * карточки и рабочая стадия (строки реестра С01–С14).
 */
export function registerCompaction(pi: ExtensionAPI, settings: SummarySettings, driver: CoreDriver, tickets: Tickets): (effect: CoreEffect, ctx: ExtensionContext) => void {
	const language = settings.summaryLanguage;
	const say = sayFor(language);
	const window = createWindowMode(pi, say, settings.compactCapabilities ?? []);
	const stage = createRequestStage();
	let summarySequence = 0;
	let pendingCard: PendingCard | undefined;
	let manualCorrelation: string | undefined;
	let route = "";

	const audit = (ctx: ExtensionContext, origin: AuditOrigin, correlation: string, phase: AuditEntry["phase"], reason: AuditReason, willRetry = false, tokens?: number): void => {
		const policy = window.policy(ctx);
		appendAudit(pi, {
			version: 2, correlation, origin, reason, phase,
			tokens: tokens ?? ctx.getContextUsage()?.tokens ?? null,
			window: policy.window, threshold: policy.threshold ?? null, mode: window.mode(), source: policy.source, willRetry,
			sessionId: ctx.sessionManager.getSessionId(),
		});
	};
	const external = (ctx: ExtensionContext, phase: AuditEntry["phase"], reason: AuditReason, willRetry: boolean, tokens?: number): void =>
		audit(ctx, "external-unattributed", randomUUID(), phase, reason, willRetry, tokens);
	const manual = (ctx: ExtensionContext, phase: AuditEntry["phase"]): void => {
		if (manualCorrelation) audit(ctx, "manual-tool", manualCorrelation, phase, "manual");
	};

	const summarize = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const generation = ++summarySequence;
		const started = Date.now();
		stage.beginCompaction(ctx, workingStandard());
		try {
			const model = ctx.model ? { ...ctx.model, contextWindow: window.capability(ctx).window } : undefined;
			const compact = await summarizeCompaction(event, ctx, {
				...(model ? { model } : {}),
				capability: window.capability(ctx),
				isCurrent: () => generation === summarySequence,
				onFailure: (reason) => {
					pi.appendEntry(RECORD.standard, { version: 1, reason });
					if (reason !== "aborted") notice(ctx, `Compact: ${reason}`, "warning");
				},
			});
			if ("compaction" in compact) {
				pendingCard = {
					kind: "standard", durationMs: Date.now() - started, sessionId: ctx.sessionManager.getSessionId(),
					...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
				};
			}
			return compact;
		} finally {
			stage.endCompaction();
		}
	};

	const execute = (effect: CoreEffect, ctx: ExtensionContext): void => {
		switch (effect.type) {
			case "compact": {
				manual(ctx, "running");
				const params = effect.request;
				ctx.compact({
					customInstructions: buildInstructions(buildLedger(params, language), language),
					onComplete: () => {
						// Окно меняется после того, как Pi отпустил блокировку сжатия.
						void window.afterCompaction(ctx).then(() => driver.dispatch({ type: "checkpoint_compact_done", ok: true, pendingMessages: ctx.hasPendingMessages() }, ctx));
					},
					onError: () => {
						driver.dispatch({ type: "checkpoint_compact_done", ok: false, pendingMessages: ctx.hasPendingMessages() }, ctx);
					},
				});
				return;
			}
			case "send_ticket": {
				// Билет контрольной точки ядро выдаёт только вместе с её запросом.
				if (effect.ticket.kind !== "checkpoint" || !effect.request) return;
				const sent = tickets.send(effect, continuationPrompt(effect.request, language));
				if (sent) {
					manual(ctx, "continuation-claimed");
					manual(ctx, "send-attempted");
				} else {
					manual(ctx, "error");
					notice(ctx, say("Не удалось поставить continuation после compact", "Could not queue continuation after compaction"), "error");
				}
				manualCorrelation = undefined;
				return;
			}
			case "checkpoint_cancelled":
				manual(ctx, effect.reason === "failed" ? "error" : "cancel");
				manualCorrelation = undefined;
				if (effect.reason === "failed") notice(ctx, say("Не удалось сжать контекст по контрольной точке", "Checkpoint compaction failed"), "error");
				return;
			case "checkpoint_scheduled":
			case "checkpoint_refused":
			case "admit_ticket":
			case "abort_run":
			case "continue_goal":
				return;
		}
	};

	pi.registerTool({
		name: "checkpoint_compact_continue",
		label: "Checkpoint Compact Continue",
		description: say("Сохраняет checkpoint, сжимает контекст и продолжает ту же цель после успешного compact.", "Saves a checkpoint, compacts context, and continues the same objective after successful compaction."),
		promptSnippet: say("Сохранить ход работы, сжать контекст и продолжить ту же цель после сжатия", "Checkpoint current progress, compact context, and continue the same objective after compaction"),
		promptGuidelines: language === "ru"
			? ["Используй checkpoint_compact_continue только по явной просьбе пользователя или при инструкции сохранить checkpoint перед сжатием.", "Перед вызовом заверши текущую атомарную работу и вызывай tool последним действием checkpoint.", "Для работы по плану передавай planPath/currentPhase/nextPhase."]
			: ["Use checkpoint_compact_continue only when the user explicitly asks or instructions require a checkpoint before compaction.", "Finish the current atomic work first and call the tool as the last checkpoint action.", "For plan-based work pass planPath/currentPhase/nextPhase."],
		parameters: checkpointParamsSchema(language),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const effects = driver.dispatch({ type: "checkpoint_requested", request: params, alreadyCompacted: compactedSinceLastUserMessage(ctx) }, ctx);
			const refused = effects.find((effect) => effect.type === "checkpoint_refused");
			if (refused?.type === "checkpoint_refused" && refused.reason === "in_progress") {
				return { content: [{ type: "text" as const, text: say("Compact уже ожидает или выполняется.", "Compaction is already pending or running.") }], details: { reason: "manual", params, result: "in_progress" }, terminate: true };
			}
			if (refused?.type === "checkpoint_refused") {
				return { content: [{ type: "text" as const, text: say("Compact уже был выполнен после последнего сообщения пользователя.", "Compaction already ran after the last user message.") }], details: { reason: "manual", params, result: "already_compacted" }, terminate: false };
			}
			manualCorrelation = randomUUID();
			manual(ctx, "pending");
			return { content: [{ type: "text" as const, text: say("Checkpoint compact запланирован после завершения текущего хода.", "Checkpoint compaction is scheduled after the current turn.") }], details: { reason: "manual", params, result: "scheduled" }, terminate: true };
		},
	});

	pi.registerCommand("context", {
		description: say("Показывает или меняет именованный режим context compaction.", "Show or change the named context compaction mode."),
		getArgumentCompletions: (prefix) => getContextArgumentCompletions(prefix, language),
		handler: async (args, ctx) => {
			const command = args.trim().replace(/\s+/g, " ") || "status";
			if (command !== "status" && !MODES.includes(command as ContextMode)) {
				notice(ctx, say("Использование: /context [status|economy|long-once|long-chat|off]", "Usage: /context [status|economy|long-once|long-chat|off]"), "error");
				return;
			}
			if (command !== "status") await window.select(ctx, command as ContextMode);
			const policy = window.policy(ctx);
			notice(ctx, `context: ${window.mode()}; model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : say("модель не выбрана", "no model selected")}; ${say("окно", "window")}=${policy.window}; compact@${policy.threshold ?? "native"}; source=${policy.source}`);
			window.updateFooter(ctx);
		},
	});

	const renderCard = (entry: { data?: CompactCardData }, options: { expanded: boolean }, theme: Parameters<typeof renderCompactCard>[2]) =>
		entry.data ? renderCompactCard(entry.data, options.expanded, theme, language) : undefined;
	pi.registerEntryRenderer<CompactCardData>(COMPACT_CARD_TYPE, renderCard);
	// Pi рисует запись по имени, сохранённому в файле сессии, поэтому прежнему имени нужен свой рисовальщик.
	for (const [legacy, current] of Object.entries(LEGACY_RECORD_NAMES)) {
		if (current === COMPACT_CARD_TYPE) pi.registerEntryRenderer<CompactCardData>(legacy, renderCard);
	}

	const shared = new Set<RequestStageEvent>(["session_start", "model_select", "turn_end", "agent_settled", "agent_start", "before_agent_start", "session_before_compact", "session_compact", "session_compact_failed", "session_shutdown"]);
	for (const type of REQUEST_STAGE_EVENTS) {
		if (!shared.has(type)) pi.on(type as "turn_start", (event: unknown, ctx: ExtensionContext) => stage.observe(type, event, ctx));
	}

	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") driver.dispatch({ type: "owner_input" }, ctx);
		return undefined;
	});
	pi.on("before_agent_start", (event, ctx) => { stage.observe("before_agent_start", event, ctx); });
	pi.on("agent_start", (event, ctx) => {
		stage.observe("agent_start", event, ctx);
		driver.dispatch({ type: "run_started" }, ctx);
	});
	pi.on("agent_settled", (event, ctx) => {
		stage.observe("agent_settled", event, ctx);
		if (ctx.isIdle()) driver.dispatch({ type: "settled", aborted: event.aborted }, ctx);
	});
	pi.on("turn_end", (event, ctx) => {
		stage.observe("turn_end", event, ctx);
		window.updateFooter(ctx);
	});
	pi.on("session_start", async (event, ctx) => {
		stage.observe("session_start", event, ctx);
		++summarySequence;
		pendingCard = undefined;
		manualCorrelation = undefined;
		route = routeOf(ctx);
		driver.dispatch({ type: "context_switched" }, ctx);
		await window.restore(ctx);
	});
	const switched = (ctx: ExtensionContext): void => {
		++summarySequence;
		driver.dispatch({ type: "context_switched" }, ctx);
	};
	pi.on("session_before_switch", (_event, ctx) => { switched(ctx); });
	pi.on("session_before_fork", (_event, ctx) => { switched(ctx); });
	pi.on("model_select", async (event, ctx) => {
		stage.observe("model_select", event, ctx);
		++summarySequence;
		// Своя смена окна меняет только contextWindow; другая модель, API или адрес — смена контекста даже во время неё.
		const next = routeOf(ctx);
		if (next !== route) { route = next; driver.dispatch({ type: "context_switched" }, ctx); }
		if (window.isInternalTransition()) { window.updateFooter(ctx); return; }
		await window.modelChanged(ctx);
	});
	pi.on("session_before_compact", async (event, ctx) => {
		stage.observe("session_before_compact", event, ctx);
		const reason = event.reason as CompactionReason;
		driver.dispatch({ type: "compaction_started", reason, willRetry: event.willRetry }, ctx);
		if (reason !== "manual" || !manualCorrelation) external(ctx, "contained", reason, event.willRetry, event.preparation.tokensBefore);
		const branch = ctx.sessionManager.getBranch();
		const preparation = event.preparation;
		if (Array.isArray(preparation.messagesToSummarize)) preparation.messagesToSummarize = withoutLegacyServiceTurns(preparation.messagesToSummarize, branch) ?? preparation.messagesToSummarize;
		if (Array.isArray(preparation.turnPrefixMessages)) preparation.turnPrefixMessages = withoutLegacyServiceTurns(preparation.turnPrefixMessages, branch) ?? preparation.turnPrefixMessages;
		// Сводку на обоих языках пишет расширение (Т11.3): иначе договорённость некуда вставить.
		return summarize(event, ctx);
	});
	pi.on("context", (event, ctx) => {
		const messages = withoutLegacyServiceTurns(event.messages, ctx.sessionManager.getBranch());
		return messages ? { messages } : undefined;
	});
	pi.on("session_before_tree", async (event, ctx) => {
		switched(ctx);
		return summarizeTree(event, ctx);
	});
	pi.on("session_compact", async (event, ctx) => {
		stage.observe("session_compact", event, ctx);
		const pending = pendingCard?.sessionId === ctx.sessionManager.getSessionId() ? pendingCard : undefined;
		pendingCard = undefined;
		const { sessionId: _sessionId, ...card } = pending ?? { sessionId: "" };
		const entry = event.compactionEntry;
		const summaryTokens = estimateSummaryTokens(entry.summary);
		pi.appendEntry<CompactCardData>(COMPACT_CARD_TYPE, {
			version: 2,
			kind: "standard",
			...card,
			trigger: event.reason,
			tokensBefore: entry.tokensBefore,
			...(summaryTokens === undefined ? {} : { summaryTokens }),
			...(entry.usage ? { usage: entry.usage } : {}),
		});
		const reason = event.reason as CompactionReason;
		const manualRun = reason === "manual" && manualCorrelation !== undefined;
		driver.dispatch({ type: "compaction_finished", reason, willRetry: event.willRetry, ok: true }, ctx);
		if (manualRun) { manual(ctx, "success"); window.updateFooter(ctx); return; }
		await window.afterCompaction(ctx);
		external(ctx, "success", reason, event.willRetry, entry.tokensBefore);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		stage.observe("session_compact_failed", event, ctx);
		pendingCard = undefined;
		const reason = event.reason as CompactionReason;
		driver.dispatch({ type: "compaction_finished", reason, willRetry: event.willRetry, ok: false }, ctx);
		if (reason !== "manual" || !manualCorrelation) external(ctx, "error", reason, event.willRetry);
		window.updateFooter(ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		stage.observe("session_shutdown", event, ctx);
		++summarySequence;
	});

	return execute;
}
