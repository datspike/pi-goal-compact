import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalGate } from "./core/model.js";
import { loadSummarySettings } from "./compaction/language.js";
import { registerCompaction } from "./shell/compaction.js";
import { CoreDriver } from "./shell/driver.js";
import { registerGoalContinuation } from "./shell/goal-continuation.js";
import { registerGoal } from "./shell/goal-events.js";
import { createGoalSession } from "./shell/goal-session.js";
import { registerTickets } from "./shell/tickets.js";

/**
 * Собирает расширение: одно ядро, к нему подключены обвязки цели и сжатия.
 * Возвращает модуль цели, чтобы тесты проверяли собранное расширение, а не его части.
 * Поведение описано решениями в docs/adr/.
 */
export function compose(pi: ExtensionAPI) {
	// Цель регистрируется первой: перед сводкой она убирает свои служебные записи из входа сжатия.
	const goal = createGoalSession(pi);
	registerGoal(pi, goal);
	const settings = loadSummarySettings();
	const driver = new CoreDriver();
	// Продолжение регистрируется последним: на запуске сессии и смене ветки оно видит уже
	// восстановленную цель и новую эпоху ядра.
	let gate = (): GoalGate => "absent";
	const tickets = registerTickets(pi, driver, () => gate());
	const compaction = registerCompaction(pi, settings, driver, tickets);
	const continuation = registerGoalContinuation(pi, goal, driver, tickets);
	gate = continuation.gate;
	goal.bindRunHooks(continuation.hooks);
	driver.bind((effect, ctx) => {
		tickets.execute(effect);
		compaction(effect, ctx);
		continuation.execute(effect, ctx);
	});
	return { goal };
}

export default function goalCompact(pi: ExtensionAPI): void {
	compose(pi);
}
