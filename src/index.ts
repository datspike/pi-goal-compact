import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSummarySettings } from "./compaction/language.js";
import { registerCompaction } from "./shell/compaction.js";
import { CoreDriver } from "./shell/driver.js";
import { registerGoal } from "./shell/goal-events.js";
import { createGoalSession } from "./shell/goal-session.js";

/**
 * Точка сборки расширения: одно ядро, к нему подключены обвязки.
 * Поведение описано решениями в docs/adr/.
 */
export default function goalCompact(pi: ExtensionAPI): void {
	// Цель регистрируется первой: перед сводкой она убирает свои служебные записи из входа сжатия.
	registerGoal(pi, createGoalSession(pi));
	const settings = loadSummarySettings();
	const driver = new CoreDriver();
	const compaction = registerCompaction(pi, settings, driver);
	driver.bind(compaction);
}
