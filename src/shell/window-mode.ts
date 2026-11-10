import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCompactCapability, type CompactCapabilityOverride } from "../compaction/compact-budget.js";
import { ECONOMY_WINDOW, formatFooter, LONG_CHAT_MAXIMUM, resolvePolicy, type ContextMode } from "../compaction/policy.js";
import { appendMode, restoreMode } from "../compaction/session-mode.js";
import { STATUS_KEY } from "../records.js";
import { notice, type Say } from "./notice.js";

type RegistryDeclaration = { contextWindow?: number; hasLongPricingTier: boolean };

/** Окно и ценовой уровень берутся из точной записи реестра моделей, не из текущей подмены окна. */
function modelDeclaration(ctx: ExtensionContext): RegistryDeclaration {
	const model = ctx.model;
	const candidate = model && ctx.modelRegistry.getAll().find((entry) => entry.provider === model.provider && entry.id === model.id);
	const contextWindow = candidate?.contextWindow;
	const hasLongPricingTier =
		contextWindow !== undefined && Number.isFinite(contextWindow) &&
		contextWindow >= ECONOMY_WINDOW &&
		(candidate?.cost?.tiers?.some((tier) => Number.isFinite(tier.inputTokensAbove) && tier.inputTokensAbove >= contextWindow) ?? false);
	return contextWindow === undefined ? { hasLongPricingTier } : { contextWindow, hasLongPricingTier };
}

export interface WindowMode {
	readonly mode: () => ContextMode;
	readonly policy: (ctx: ExtensionContext) => ReturnType<typeof resolvePolicy>;
	readonly capability: (ctx: ExtensionContext) => ReturnType<typeof resolveCompactCapability>;
	/** Pi меняет модель по просьбе самого расширения: это не выбор владельца. */
	readonly isInternalTransition: () => boolean;
	readonly restore: (ctx: ExtensionContext) => Promise<void>;
	readonly select: (ctx: ExtensionContext, next: ContextMode) => Promise<void>;
	readonly afterCompaction: (ctx: ExtensionContext) => Promise<void>;
	readonly modelChanged: (ctx: ExtensionContext) => Promise<void>;
	readonly updateFooter: (ctx: ExtensionContext, suffix?: string) => void;
}

/**
 * Режимы окна economy, long-once, long-chat и off (строка реестра С01).
 * Окно меняется только у текущей модели и только в пределах её объявленных
 * возможностей; режим хранится в журнале сессии.
 */
export function createWindowMode(pi: ExtensionAPI, say: Say, overrides: readonly CompactCapabilityOverride[]): WindowMode {
	let mode: ContextMode = "economy";
	let useActualWindowFallback = false;
	let internalModelTransition = false;
	let windowErrorNotified = false;

	const resolved = (ctx: ExtensionContext) => {
		const declaration = modelDeclaration(ctx);
		const longTier = declaration.hasLongPricingTier;
		return resolvePolicy(mode, ctx.model, declaration.contextWindow, { ...(longTier ? { sessionOverrideWindow: LONG_CHAT_MAXIMUM } : {}), longPricingTierAvailable: longTier });
	};
	const policy = (ctx: ExtensionContext) => {
		const current = resolved(ctx);
		const actualWindow = ctx.model?.contextWindow;
		return !useActualWindowFallback || !actualWindow || actualWindow <= 0 ? current : {
			...current,
			mode,
			window: actualWindow,
			threshold: mode === "off" ? undefined : Math.floor(actualWindow * 0.75),
			source: mode === "off" ? "off" as const : "fallback" as const,
		};
	};
	const capability = (ctx: ExtensionContext) => ctx.model
		? resolveCompactCapability(ctx.model, ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)?.contextWindow, overrides)
		: { window: 0, source: "unsupported" as const, outputLimitEnforced: false };
	let footerSuffix = "";
	const updateFooter = (ctx: ExtensionContext, suffix?: string): void => {
		if (suffix !== undefined) footerSuffix = suffix;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, formatFooter(ctx.getContextUsage()?.tokens, policy(ctx)) + footerSuffix);
	};
	const setMode = (next: ContextMode): void => {
		if (mode !== next) { mode = next; appendMode(pi, next); }
	};
	const setModelInternally = async (model: Parameters<ExtensionAPI["setModel"]>[0]): Promise<boolean> => {
		internalModelTransition = true;
		try {
			return await pi.setModel(model);
		} finally {
			internalModelTransition = false;
		}
	};
	/** Применяет окно режима к текущей модели; при сбое откатывает модель и честно показывает фактическое окно. */
	const ensureWindow = async (ctx: ExtensionContext, fallbackMode: ContextMode = "economy"): Promise<boolean> => {
		useActualWindowFallback = false;
		windowErrorNotified = false;
		const target = resolved(ctx);
		if (target.mode !== mode) { setMode("economy"); await ensureWindow(ctx); updateFooter(ctx); return false; }
		if (!ctx.model || target.window <= 0 || ctx.model.contextWindow === target.window) return true;
		const previousModel = ctx.model;
		const thinkingLevel = pi.getThinkingLevel();
		const restorePreviousModel = async (): Promise<boolean> => {
			const matchesPrevious = () => ctx.model?.provider === previousModel.provider && ctx.model?.id === previousModel.id && ctx.model?.contextWindow === previousModel.contextWindow;
			if (matchesPrevious()) return true;
			try {
				if (!await setModelInternally(previousModel)) return false;
				pi.setThinkingLevel(thinkingLevel);
				return matchesPrevious();
			} catch {
				return false;
			}
		};
		try {
			if (!await setModelInternally({ ...ctx.model, contextWindow: target.window })) throw new Error("setModel returned false");
			pi.setThinkingLevel(thinkingLevel);
		} catch {
			const restored = await restorePreviousModel();
			let safeMode = false;
			if (restored) {
				setMode(fallbackMode);
				safeMode = ctx.model?.contextWindow === resolved(ctx).window;
				useActualWindowFallback = !safeMode;
			} else {
				setMode("economy");
				useActualWindowFallback = true;
			}
			const message = safeMode
				? say("Не удалось применить окно контекста; сохранён прежний режим", "Could not apply the context window; retained the previous mode")
				: say("Не удалось применить окно контекста и восстановить согласованное окно; отображается фактическое окно, повторите выбор economy", "Could not apply the context window or restore a consistent window; showing the actual window, select economy again");
			updateFooter(ctx);
			notice(ctx, message, "error");
			windowErrorNotified = true;
			return false;
		}
		updateFooter(ctx);
		return true;
	};

	return {
		mode: () => mode,
		policy,
		capability,
		isInternalTransition: () => internalModelTransition,
		updateFooter,
		async restore(ctx) {
			mode = restoreMode(ctx.sessionManager.getEntries());
			await ensureWindow(ctx);
			updateFooter(ctx);
		},
		async select(ctx, next) {
			const previousMode = mode;
			setMode(next);
			if (!(await ensureWindow(ctx, previousMode)) && next !== "economy" && !windowErrorNotified) {
				notice(ctx, say("Для точной записи модели нет доступного long-tier; оставлен economy", "The exact model entry has no available long tier; economy is retained"), "error");
			}
			updateFooter(ctx);
		},
		async afterCompaction(ctx) {
			if (mode === "long-once") { setMode("economy"); await ensureWindow(ctx, "long-once"); }
			else if (mode === "long-chat") await ensureWindow(ctx);
			updateFooter(ctx);
		},
		async modelChanged(ctx) {
			await ensureWindow(ctx);
			updateFooter(ctx);
		},
	};
}
