import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Выбор строки по языку расширения: русская строка — источник истины. */
export type Say = (ru: string, en: string) => string;

export function sayFor(language: "ru" | "en"): Say {
	return (ru, en) => language === "ru" ? ru : en;
}

export function notice(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}
