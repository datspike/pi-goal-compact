import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSummarySettings } from "./compaction/language.js";
import { registerCompaction } from "./shell/compaction.js";
import { CoreDriver } from "./shell/driver.js";
import { registerGoal } from "./shell/goal-events.js";
import { createGoalSession } from "./shell/goal-session.js";

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
	const compaction = registerCompaction(pi, settings, driver);
	driver.bind(compaction);
	return { goal };
}

export default function goalCompact(pi: ExtensionAPI): void {
	compose(pi);
}
