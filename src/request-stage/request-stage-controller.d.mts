import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GenerationTelemetry } from "./generation-telemetry.mjs";

/** Состояние строки работы, которое контроллер отдаёт наружу. */
export type RequestStageState = { visible: boolean; message?: string; rate?: string };

/** Типы для расширения: модуль перенесён из request-stage без изменений и остаётся на JavaScript. */
export declare class RequestStageController {
	constructor(options?: {
		now?: () => number;
		intervalMs?: number;
		width?: () => number;
		telemetry?: GenerationTelemetry;
		onState?: (state: RequestStageState, ui: ExtensionContext["ui"] | undefined) => void;
	});
	handle(event: { type: string }, ctx: ExtensionContext): void;
	rateText(now?: number): string | undefined;
	beginCompaction(ctx: ExtensionContext, label: string): void;
	endCompaction(): void;
}
