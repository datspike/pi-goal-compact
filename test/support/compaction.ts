import type { RussianCompactionResult } from "../../src/compaction/summary.js";

/** Достаёт сжатие из успешного результата сводки; отмена — провал теста. */
export function compactionOf(result: RussianCompactionResult | undefined) {
  if (!result || !("compaction" in result)) throw new Error(`сводка отменена: ${JSON.stringify(result)}`);
  return result.compaction;
}
