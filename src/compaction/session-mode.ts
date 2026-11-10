import { LEGACY_RECORD, RECORD } from "../records.js";
import type { ContextMode } from "./policy.js";

export const MODE_ENTRY = RECORD.mode;

export interface ModeEntry {
	mode: ContextMode;
}

const MODE_TYPES: ReadonlySet<string> = new Set([RECORD.mode, LEGACY_RECORD.mode]);

/** Восстанавливает последний допустимый режим окна из журнала, включая записи прежнего расширения сжатия. */
export function restoreMode(entries: readonly any[]): ContextMode {
	let mode: ContextMode = "economy";
	for (const entry of entries) {
		if (entry?.type !== "custom" || !MODE_TYPES.has(entry.customType)) continue;
		const candidate = entry.data?.mode;
		if (candidate === "economy" || candidate === "long-once" || candidate === "long-chat" || candidate === "off") {
			mode = candidate;
		}
	}
	return mode;
}

/** Сохраняет именованный режим новой записью журнала. */
export function appendMode(pi: { appendEntry(type: string, data: ModeEntry): void }, mode: ContextMode): void {
	pi.appendEntry(MODE_ENTRY, { mode });
}
