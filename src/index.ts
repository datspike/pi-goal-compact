import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSummarySettings } from "./compaction/language.js";
import { registerCompaction } from "./shell/compaction.js";
import { CoreDriver } from "./shell/driver.js";

/**
 * Точка сборки расширения: одно ядро, к нему подключены обвязки.
 * Поведение описано решениями в docs/adr/.
 */
export default function goalCompact(pi: ExtensionAPI): void {
	const settings = loadSummarySettings();
	const driver = new CoreDriver();
	const compaction = registerCompaction(pi, settings, driver);
	driver.bind(compaction);
}
