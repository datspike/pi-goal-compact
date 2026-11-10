import type { ExtensionContext } from "@earendil-works/pi-coding-agent";


export function notice(ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(text, level);
}
