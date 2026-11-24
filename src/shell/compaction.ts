import { AppendRoute } from "./append-route.js";
import { goalFeatures, loadGoalReportPolicySync } from "../goal/goal-report-config.js";
import { registerModelTransfer } from "./model-transfer.js";
import type { GoalGate } from "../core/model.js";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { appendAudit, type AuditEntry, type AuditOrigin, type AuditReason } from "../compaction/audit.js";
import { COMPACT_CARD_TYPE, cardUsage, estimateSummaryTokens, renderCompactCard, type CompactCardData } from "../compaction/card.js";
import {
	buildInstructions,
	buildLedger,
	checkpointParamsSchema,
	compactedSinceLastUserMessage,
	continuationPrompt,
	withoutLegacyServiceTurns,
} from "../compaction/checkpoint.js";
import type { SummarySettings } from "../compaction/language.js";
import { appendMetrics, metricsFromCard } from "../compaction/metrics.js";
import { recordAppendSwitch, restoreAppendSwitch, restoreMode } from "../compaction/session-mode.js";
import type { ContextMode } from "../compaction/policy.js";
import type { Usage } from "@earendil-works/pi-ai";
import { combineUsage, summarizeCompaction, summarizeTree } from "../compaction/summary.js";
import type { CoreEffect, CompactionReason } from "../core/model.js";
import { createRequestStage, REQUEST_STAGE_EVENTS, type RequestStageEvent } from "../request-stage/index.js";
import { LEGACY_RECORD_NAMES, RECORD } from "../records.js";
import type { CoreDriver } from "./driver.js";
import type { Tickets } from "./tickets.js";
import { say, sayFor } from "../language.js";
import { notice } from "./notice.js";
import { createWindowMode } from "./window-mode.js";

const workingStandard = (): string => say("Compact: стандартная сводка", "Compact: standard summary");
const workingAppend = (): string => say("Compact: append по кэшу последнего запроса", "Compact: append on the last request cache");
/** Коды отказа маршрута append в слова владельцу: причина видна в карточке и в журнале. */
const APPEND_REFUSAL_REASONS: Readonly<Record<string, string>> = {
	APPEND_CAPTURE_UNAVAILABLE: "no-captured-request",
	APPEND_ROUTE_CHANGED: "route-changed",
	APPEND_BRANCH_CHANGED: "branch-changed",
	APPEND_CONTEXT_CHANGED: "context-changed",
	APPEND_SOURCE_UNAVAILABLE: "sources-unavailable",
	APPEND_PAYLOAD_MISMATCH: "payload-mismatch",
	APPEND_PAYLOAD_TOO_LARGE: "request-too-large",
	APPEND_OUTPUT_LIMIT_MISMATCH: "output-limit-mismatch",
};
/** Паузы перед повторами запроса сводки: разовый сбой сети или провайдера не должен срывать сжатие. */
const SUMMARY_RETRY_DELAYS_MS: readonly number[] = [1000, 4000];
/** Сколько слов провайдера о сбое сохранять в журнале и уведомлении. */
const FAILURE_DETAIL_LIMIT = 300;
const MODES: readonly ContextMode[] = ["economy", "long-once", "long-chat", "off"];

type ContextCompletion = { value: string; label: string; description: string };

const CONTEXT_COMPLETIONS: readonly ContextCompletion[] = [
	{ value: "status", label: "status", description: "Показать текущий режим, окно и порог" },
	{ value: "economy", label: "economy", description: "Консервативное окно, ограниченное capability модели" },
	{ value: "long-once", label: "long-once", description: "Увеличенное окно по declared capability до следующего compact" },
	{ value: "long-chat", label: "long-chat", description: "Постоянное увеличенное окно по declared capability" },
	{ value: "off", label: "off", description: "Вернуть declared registry-окно без extension soft cap" },
	{ value: "append on", label: "append on", description: "Включить append-сводку на это окно до /new" },
	{ value: "append off", label: "append off", description: "Выключить append-сводку в этом окне" },
];
const ENGLISH_DESCRIPTIONS: Readonly<Record<string, string>> = {
	status: "Show the current mode, window and threshold",
	economy: "Conservative window bounded by model capability",
	"long-once": "Extended window until the next compaction",
	"long-chat": "Persistent extended window within model capability",
	off: "Restore the declared registry window without the extension soft cap",
	"append on": "Enable append summaries for this window until /new",
	"append off": "Disable append summaries in this window",
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

type PendingCard = Pick<CompactCardData, "kind" | "provider" | "model" | "durationMs" | "appendDurationMs" | "repairAttempts" | "fallbackReason" | "appendCacheStatus" | "appendUsage" | "appendAttempts"> & { sessionId: string };

/**
 * Сжатие без цели: режимы окна, сводки, контрольная точка с продолжением,
 * карточки и рабочая стадия (строки реестра С01–С14).
 */
export function registerCompaction(pi: ExtensionAPI, settings: SummarySettings, driver: CoreDriver, tickets: Tickets, gate: () => GoalGate = () => "absent", cancelDeferredWakes: () => void = () => {}): (effect: CoreEffect, ctx: ExtensionContext) => void {
	const language = settings.summaryLanguage;
	const say = sayFor(language);
	const window = createWindowMode(pi, say, settings.compactCapabilities ?? []);
	const transfer = registerModelTransfer(pi, driver, gate);
	const stage = createRequestStage();
	// Принятая попытка: по ней видно попадание в кэш, потому что префикс у неё уже совпал с прежним запросом.
	let appendUsage: Usage | undefined;
	// Все попытки вместе: столько на самом деле стоил append, включая отвергнутые ответы.
	let appendSpent: Usage | undefined;
	let appendAttempts = 0;
	// Настройка разрешает append, а включает его владелец только на текущее окно: без его слова режим выключен.
	const appendAllowed = settings.appendCompaction;
	let appendEnabled = false;
	const append = new AppendRoute(value => {
		if (value.phase === "response" && value.usage) {
			appendUsage = value.usage;
			appendSpent = combineUsage(appendSpent, value.usage);
			appendAttempts += 1;
		}
		pi.appendEntry(RECORD.appendAttempt, value);
	});
	let summarySequence = 0;
	// Причина последней отменённой сводки: Pi сообщает о сбое без неё, а владельцу нужна конкретика.
	let lastFailure: string | undefined;
	let lastFailureAborted = false;
	/**
	 * Идущее ручное сжатие. Pi запускает ход от сообщения расширения с triggerTurn, не дожидаясь его конца:
	 * запрос ушёл бы прежней модели с несжатым окном. Такой ход ждёт здесь и стартует уже после сжатия.
	 */
	let manualCompaction: { done: Promise<boolean>; finish: (aborted: boolean) => void } | undefined;
	// Владелец отменил сжатие, пока ход ждал его: ход тоже не должен уйти модели.
	let cancelWaitingRun = false;
	const finishManualCompaction = (aborted: boolean): void => {
		const current = manualCompaction;
		manualCompaction = undefined;
		current?.finish(aborted);
	};
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

	const refusalReason = (error: unknown): string => {
		const message = error instanceof Error ? error.message : String(error);
		return APPEND_REFUSAL_REASONS[message] ?? "unsupported-route";
	};
	/** Кэш append виден только по расходу ответа: без usage состояние неизвестно, а не промах. */
	const cacheStatus = (usage: Usage | undefined): string | undefined => {
		if (!usage) return undefined;
		if (typeof usage.cacheRead !== "number") return "unknown";
		return usage.cacheRead > 0 ? "hit" : "miss";
	};

	const summarize = async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const generation = ++summarySequence;
		lastFailure = undefined;
		lastFailureAborted = false;
		const started = Date.now();
		appendUsage = undefined;
		appendSpent = undefined;
		appendAttempts = 0;
		// Отказ append виден в карточке и в рабочей строке до того, как началась сводка.
		let fallbackReason: string | undefined;
		let appendCacheStatus: string | undefined;
		let transport: import("../compaction/summary.js").SummaryTransport | undefined;
		const capability = window.capability(ctx);
		if (appendEnabled) {
			try { transport = append.prepare(ctx, event, language, capability.window); }
			catch (error) {
				fallbackReason = refusalReason(error);
				appendCacheStatus = "not-attempted";
				pi.appendEntry(RECORD.appendAttempt, { phase: "preflight-refusal", reason: fallbackReason });
				notice(ctx, `Compact: ${say("append не применился", "append was not applied")} (${fallbackReason}); ${say("идёт обычная сводка", "standard summary runs")}`, "warning");
			}
		}
		stage.beginCompaction(ctx, transport ? workingAppend() : workingStandard());
		try {
			const model = ctx.model ? { ...ctx.model, contextWindow: capability.window } : undefined;
			const run = (useAppend: boolean) => summarizeCompaction(event, ctx, {
				...(model ? { model } : {}),
				...(useAppend && transport ? { transport } : {}),
				capability,
				isCurrent: () => generation === summarySequence,
				retryDelaysMs: SUMMARY_RETRY_DELAYS_MS,
				onRetry: (attempt, attempts, detail) => {
					notice(ctx, `Compact: ${say("запрос сводки не прошёл", "summary request failed")}${detail ? ` (${detail.slice(0, FAILURE_DETAIL_LIMIT)})` : ""}; ${say("повтор", "retry")} ${attempt}/${attempts}`, "warning");
				},
				onFailure: (reason, detail) => {
					const words = detail?.slice(0, FAILURE_DETAIL_LIMIT);
					lastFailure = words ? `${reason}: ${words}` : reason;
					lastFailureAborted = reason === "aborted";
					pi.appendEntry(RECORD.standard, { version: 1, reason, ...(words ? { detail: words } : {}) });
					if (reason !== "aborted" && !transfer.queued()) notice(ctx, `Compact: ${lastFailure}`, "warning");
				},
			});
			let usedAppend = Boolean(transport);
			let compact = await run(usedAppend);
			const appendDurationMs = transport ? Date.now() - started : undefined;
			let standardStarted = started;
			if (transport && "cancel" in compact && !event.signal.aborted && !lastFailureAborted && lastFailure !== "context-changed") {
				fallbackReason = lastFailure ?? "summary-failed";
				appendCacheStatus = cacheStatus(appendUsage) ?? "unknown";
				pi.appendEntry(RECORD.appendAttempt, { phase: "fallback", reason: fallbackReason });
				usedAppend = false;
				standardStarted = Date.now();
				compact = await run(false);
			}
			if ("compaction" in compact) {
				// В сводке учитываются и отвергнутые ответы: они тоже расходуют модельный бюджет.
				const usage = usedAppend ? appendSpent : combineUsage(compact.compaction.usage, appendSpent);
				if (usage) compact.compaction.usage = usage;
				pendingCard = {
					kind: usedAppend ? "append" : "standard", sessionId: ctx.sessionManager.getSessionId(),
					...(fallbackReason ? { fallbackReason } : {}),
					...(usedAppend ? { ...(cacheStatus(appendUsage) ? { appendCacheStatus: cacheStatus(appendUsage)! } : {}) } : appendCacheStatus ? { appendCacheStatus } : {}),
					...(!usedAppend ? { durationMs: Date.now() - standardStarted } : {}),
					...(appendDurationMs !== undefined ? { appendDurationMs } : {}),
					...(appendAttempts ? { appendAttempts } : {}),
					...cardUsage({ usedAppend, ...(appendUsage ? { accepted: appendUsage } : {}), ...(appendSpent ? { spent: appendSpent } : {}) }),
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
						void window.afterCompaction(ctx).then(() => driver.dispatch({ type: "checkpoint_compact_done", ok: !transfer.failed(), pendingMessages: ctx.hasPendingMessages() }, ctx));
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

	if (goalFeatures(loadGoalReportPolicySync().policy).checkpointCompactContinue) pi.registerTool({
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
			const appendCommand = /^append(?: (on|off))?$/.exec(command);
			if (appendCommand) {
				const next = appendCommand[1];
				if (next === "on" && !appendAllowed) {
					notice(ctx, say("Append выключен настройкой contextCompaction.appendCompaction.", "Append is disabled by contextCompaction.appendCompaction."), "error");
					return;
				}
				if (next) {
					appendEnabled = next === "on";
					recordAppendSwitch(pi, appendEnabled);
					if (appendEnabled) append.install(ctx); else append.dispose();
				}
			} else if (command !== "status" && !MODES.includes(command as ContextMode)) {
				notice(ctx, say("Использование: /context [status|append on|append off|economy|long-once|long-chat|off]", "Usage: /context [status|append on|append off|economy|long-once|long-chat|off]"), "error");
				return;
			} else if (command !== "status") await window.select(ctx, command as ContextMode);
			const policy = window.policy(ctx);
			const appendState = appendAllowed ? (appendEnabled ? "on" : "off") : "forbidden";
			notice(ctx, `${say("context", "context")}: ${window.mode()}; append=${appendState}; model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : say("модель не выбрана", "no model selected")}; ${say("окно", "window")}=${policy.window}; compact@${policy.threshold ?? "native"}; source=${policy.source}`);
			if (appendAllowed && appendEnabled) notice(ctx, say("Append включён на это окно до /new; при отказе будет обычная сводка с причиной.", "Append is on for this window until /new; on refusal a standard summary runs and names the reason."));
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
	pi.on("before_agent_start", async (event, ctx) => {
		stage.observe("before_agent_start", event, ctx);
		// Pi дожидается этого обработчика до первого запроса хода и берёт модель и окно уже после него.
		if (manualCompaction && await manualCompaction.done) cancelWaitingRun = true;
		// Окно режима могло тихо потеряться без model_select (хост пересобрал модель);
		// перед запросом сверяем его с режимом, иначе контекст растёт до предела модели.
		await window.modelChanged(ctx);
	});
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
		cancelWaitingRun = false;
		finishManualCompaction(false);
		route = routeOf(ctx);
		driver.dispatch({ type: "context_switched" }, ctx);
		await window.restore(ctx);
		transfer.restore(ctx);
		appendEnabled = appendAllowed && restoreAppendSwitch(ctx.sessionManager.getBranch());
		append.reset();
		if (appendEnabled) append.install(ctx); else append.dispose();
	});
	const switched = (ctx: ExtensionContext): void => {
		// Смена контекста отменяет отложенные пробуждения и начинает append заново.
		cancelDeferredWakes();
		append.reset();
		++summarySequence;
		transfer.cancel(ctx);
		driver.dispatch({ type: "context_switched" }, ctx);
	};
	pi.on("session_before_switch", (_event, ctx) => { switched(ctx); });
	pi.on("session_before_fork", (_event, ctx) => { switched(ctx); });
	pi.on("session_tree", (_event, ctx) => { switched(ctx); });
	pi.on("model_select", async (event, ctx) => {
		stage.observe("model_select", event, ctx);
		++summarySequence;
		// Своя смена окна меняет только contextWindow; другая модель, API или адрес — смена контекста даже во время неё.
		const next = routeOf(ctx);
		if (next !== route) {
			append.reset();
			route = next;
			if (appendEnabled) append.install(ctx);
			if (!transfer.ownsModelChange(ctx)) { transfer.cancel(ctx); driver.dispatch({ type: "context_switched" }, ctx); }
		}
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
		if (reason === "manual" && !manualCompaction) {
			let finish: (aborted: boolean) => void = () => {};
			const done = new Promise<boolean>((resolve) => { finish = resolve; });
			manualCompaction = { done, finish };
		}
		// Сводку на обоих языках пишет расширение (Т11.3): иначе договорённость некуда вставить.
		return summarize(event, ctx);
	});
	pi.on("context", (event, ctx) => {
		if (appendEnabled) append.install(ctx);
		const messages = withoutLegacyServiceTurns(event.messages, ctx.sessionManager.getBranch());
		if (cancelWaitingRun) { cancelWaitingRun = false; ctx.abort(); }
		transfer.blocked(ctx);
		return messages ? { messages } : undefined;
	});
	pi.on("session_before_tree", async (event, ctx) => {
		switched(ctx);
		return summarizeTree(event, ctx);
	});
	pi.on("session_compact", async (event, ctx) => {
		append.reset();
		stage.observe("session_compact", event, ctx);
		const pending = pendingCard?.sessionId === ctx.sessionManager.getSessionId() ? pendingCard : undefined;
		pendingCard = undefined;
		const { sessionId: _sessionId, ...card } = pending ?? { sessionId: "", kind: "standard" as const };
		const entry = event.compactionEntry;
		const summaryTokens = estimateSummaryTokens(entry.summary);
		const cardData: Omit<CompactCardData, "version"> = {
			...card,
			trigger: event.reason,
			tokensBefore: entry.tokensBefore,
			...(summaryTokens === undefined ? {} : { summaryTokens }),
			...(entry.usage ? { usage: entry.usage } : {}),
		};
		pi.appendEntry<CompactCardData>(COMPACT_CARD_TYPE, { version: 2, ...cardData });
		// Те же числа, но машинно: по ним режим и fallback разбираются после сессии.
		appendMetrics(pi, metricsFromCard(cardData, ctx.sessionManager.getSessionId(), "saved"));
		const reason = event.reason as CompactionReason;
		const manualRun = reason === "manual" && manualCorrelation !== undefined;
		await transfer.afterSaved(ctx, entry.id);
		driver.dispatch({ type: "compaction_finished", reason, willRetry: event.willRetry, ok: true }, ctx);
		// Ждущий ход отпускается после смены модели: его первый запрос уходит уже новой модели.
		finishManualCompaction(false);
		if (manualRun) { manual(ctx, "success"); window.updateFooter(ctx); return; }
		await window.afterCompaction(ctx);
		external(ctx, "success", reason, event.willRetry, entry.tokensBefore);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		stage.observe("session_compact_failed", event, ctx);
		pendingCard = undefined;
		const failure = lastFailure ?? event.errorMessage;
		appendMetrics(pi, { version: 1, kind: "standard", outcome: "failed", ...(failure ? { fallbackReason: failure } : {}), sessionId: ctx.sessionManager.getSessionId() });
		// Pi помечает aborted и отказ самого расширения; отмену владельцем отличает причина сводки или отсутствие ошибки.
		const cancelled = lastFailure === undefined ? event.aborted === true && !event.errorMessage : lastFailureAborted;
		transfer.compactFailed(ctx, lastFailure ?? event.errorMessage, cancelled);
		lastFailure = undefined;
		lastFailureAborted = false;
		finishManualCompaction(cancelled);
		const reason = event.reason as CompactionReason;
		driver.dispatch({ type: "compaction_finished", reason, willRetry: event.willRetry, ok: false }, ctx);
		if (reason !== "manual" || !manualCorrelation) external(ctx, "error", reason, event.willRetry);
		window.updateFooter(ctx);
	});
	pi.on("session_shutdown", (event, ctx) => {
		stage.observe("session_shutdown", event, ctx);
		++summarySequence;
		append.dispose();
		finishManualCompaction(false);
	});

	return execute;
}
