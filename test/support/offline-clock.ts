import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Два равных интервала: исполнение инструмента и явное ожидание. */
export default function offlineClock(pi: ExtensionAPI): void {
  for (const name of ["clock_sample", "bg_wait"]) pi.registerTool({
    name, label: name, description: "Интервал дымовой проверки учёта.", parameters: Type.Object({}),
    async execute() {
      await delay(1_150);
      return { content: [{ type: "text", text: "Интервал завершён." }], details: {} };
    },
  });
}
