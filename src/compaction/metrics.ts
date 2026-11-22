import { RECORD } from "../records.js";
import type { CompactCardData } from "./card.js";

export const METRICS_ENTRY = RECORD.metrics;

/**
 * Итог одного сжатия для разбора после сессии: режим, кэш, размеры, время и расход.
 * Карточка показывает то же владельцу в ленте, здесь те же числа лежат машинно.
 */
export interface CompactMetrics {
	version: 1;
	kind: CompactCardData["kind"];
	trigger?: string;
	/** Причина, по которой append не применён; без неё сжатие шло обычным путём. */
	fallbackReason?: string;
	appendCacheStatus?: string;
	provider?: string;
	model?: string;
	tokensBefore?: number;
	summaryTokens?: number;
	durationMs?: number;
	appendDurationMs?: number;
	cost?: number;
	appendCost?: number;
	repairAttempts?: number;
	/** Отмена владельцем или смена контекста: сжатия не было, но попытка видна. */
	outcome?: "saved" | "failed";
	sessionId: string;
}

export function appendMetrics(pi: { appendEntry(type: string, data: CompactMetrics): void }, metrics: CompactMetrics): void {
	pi.appendEntry(METRICS_ENTRY, metrics);
}

/** Собирает запись метрик из тех же полей, что уходят в карточку. */
export function metricsFromCard(card: Omit<CompactCardData, "version">, sessionId: string, outcome: "saved" | "failed"): CompactMetrics {
	return {
		version: 1,
		kind: card.kind,
		...(card.trigger ? { trigger: card.trigger } : {}),
		...(card.fallbackReason ? { fallbackReason: card.fallbackReason } : {}),
		...(card.appendCacheStatus ? { appendCacheStatus: card.appendCacheStatus } : {}),
		...(card.provider ? { provider: card.provider } : {}),
		...(card.model ? { model: card.model } : {}),
		...(card.tokensBefore === undefined ? {} : { tokensBefore: card.tokensBefore }),
		...(card.summaryTokens === undefined ? {} : { summaryTokens: card.summaryTokens }),
		...(card.durationMs === undefined ? {} : { durationMs: card.durationMs }),
		...(card.appendDurationMs === undefined ? {} : { appendDurationMs: card.appendDurationMs }),
		...(card.usage?.cost?.total === undefined ? {} : { cost: card.usage.cost.total }),
		...(card.appendUsage?.cost?.total === undefined ? {} : { appendCost: card.appendUsage.cost.total }),
		...(card.repairAttempts === undefined ? {} : { repairAttempts: card.repairAttempts }),
		outcome,
		sessionId,
	};
}
