import { say } from "../language.js";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CoreEffect, GoalGate, TicketKind } from "../core/model.js";
import { RECORD } from "../records.js";
import type { CoreDriver } from "./driver.js";

/** Неотправленный билет этого процесса заменяется в окне модели пустой пометкой (решение 0002). */
const expiredTicket = (): string => say("Это служебное продолжение устарело; не выполняй его.", "This service continuation is stale; do not act on it.");

interface TicketDetails { id: string; runtime: string; epoch: number; kind: TicketKind }

function ticketDetails(value: unknown): TicketDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = value as Partial<TicketDetails>;
	return typeof details.id === "string" && typeof details.runtime === "string" && typeof details.epoch === "number" &&
		(details.kind === "checkpoint" || details.kind === "goal")
		? details as TicketDetails
		: undefined;
}

export type SendTicketEffect = Extract<CoreEffect, { type: "send_ticket" }>;

/**
 * Билеты — единственный путь начать работу из простоя (решение 0002).
 *
 * Билет — скрытое сообщение с эпохой ядра. При доставке ядро сверяет эпоху и разрешение цели.
 * Негодный билет запускает прогон, который нельзя отменить до `before_agent_start`: в Pi 1.5
 * `ctx.abort()` в этот момент только ставит флаг, а запрос к модели всё равно уходит. Поэтому
 * отмена исполняется при первой сборке окна этого прогона (`context`), когда у прогона уже есть
 * сигнал отмены, а текст билета к этому моменту заменён пустой пометкой.
 */
export function registerTickets(pi: ExtensionAPI, driver: CoreDriver, gate: () => GoalGate) {
	const runtime = randomUUID();
	const issued = new Set<string>();
	const admitted = new Set<string>();
	let abortRequested = false;

	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType !== "custom" || event.message.customType !== RECORD.ticket) return undefined;
		const details = ticketDetails(event.message.details);
		// Билет другого процесса (после /reload или из старой сессии) не может быть годен: эпоха -1 никогда не совпадёт.
		const epoch = details && details.runtime === runtime ? details.epoch : -1;
		const effects = driver.dispatch({ type: "ticket_arrived", ticket: { epoch, kind: details?.kind ?? "checkpoint" }, gate: gate() }, ctx);
		if (details && effects.some((effect) => effect.type === "admit_ticket")) admitted.add(details.id);
		return undefined;
	});
	pi.on("context", (event, ctx) => {
		if (abortRequested) {
			abortRequested = false;
			ctx.abort();
		}
		let changed = false;
		const messages = event.messages.map((message) => {
			if (message.role !== "custom" || message.customType !== RECORD.ticket) return message;
			const details = ticketDetails(message.details);
			if (!details || details.runtime !== runtime || !issued.has(details.id) || admitted.has(details.id)) return message;
			changed = true;
			return { ...message, content: expiredTicket() };
		});
		return changed ? { messages } : undefined;
	});
	// Прогон закончился, не дойдя до сборки окна: отменять уже нечего.
	pi.on("agent_settled", () => { abortRequested = false; });
	pi.on("session_shutdown", () => { abortRequested = false; });

	return {
		/** Ставит билет в очередь Pi и запускает прогон. false — Pi отказал, билета нет. */
		send(effect: SendTicketEffect, content: string): boolean {
			const id = randomUUID();
			issued.add(id);
			const details: TicketDetails = { id, runtime, epoch: effect.ticket.epoch, kind: effect.ticket.kind };
			try {
				pi.sendMessage({ customType: RECORD.ticket, content, display: false, details }, { triggerTurn: true });
				return true;
			} catch {
				return false;
			}
		},
		execute(effect: CoreEffect): void {
			if (effect.type === "abort_run") abortRequested = true;
		},
	};
}

export type Tickets = ReturnType<typeof registerTickets>;
