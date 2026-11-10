import { RECORD } from "../records.js";
import type { ContextMode } from "./policy.js";

export const MODE_ENTRY = RECORD.mode;

export interface ModeEntry {
	mode: ContextMode;
}

/** Восстанавливает последний допустимый режим окна из журнала с новыми именами записей. */
export function restoreMode(entries: readonly any[]): ContextMode {
	let mode: ContextMode = "economy";
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
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
