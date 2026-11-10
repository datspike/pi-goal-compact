import type { Api, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../../src/compaction/file-hints.js";
import { summarizeCompaction, summarizeTree, type CompactionSummaryOptions, type CompactionSummaryResult } from "../../src/compaction/summary.js";
import { asPi } from "./as-pi.js";
import { fileListsOf } from "./pi-messages.js";

/** Достаёт сжатие из успешного результата сводки; отмена — провал теста. */
export function compactionOf(result: CompactionSummaryResult | undefined) {
  if (!result || !("compaction" in result)) throw new Error(`сводка отменена: ${JSON.stringify(result)}`);
  return result.compaction;
}

/** Модель в подделке: сводке нужны только лимиты и признаки маршрута. */
export type FakeModel = { provider?: string; id?: string; api?: string; baseUrl?: string; maxTokens: number; contextWindow?: number };
/** Подмена запроса к модели: параметры как у Pi, ответ — любая проверяемая тестом форма. */
export type FakeComplete = (model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) => Promise<unknown>;
export type FakeEntry = { type: string; id?: string; parentId?: string | null; customType?: string; fromHook?: boolean; details?: unknown; summary?: string; fromId?: string; timestamp?: string; message?: unknown };

/** Та часть контекста Pi, которую читает сводка; ответ модели подменяется целиком. */
export type FakeContext = {
  model: FakeModel | undefined;
  sessionManager?: { getSessionId(): string; getSessionFile(): string; getLeafId(): string | null; getBranch(): FakeEntry[] };
  modelRegistry: { getProvider?: () => unknown; complete: FakeComplete };
};
export type FakeCompactEvent = {
  signal: AbortSignal;
  branchEntries: FakeEntry[];
  customInstructions?: string;
  reason?: string;
  willRetry?: boolean;
  preparation: {
    previousSummary?: string | undefined;
    messagesToSummarize: AgentMessage[];
    turnPrefixMessages: AgentMessage[];
    fileOps: { read: Set<string>; edited: Set<string>; written?: Set<string> };
    settings: { reserveTokens: number };
    firstKeptEntryId: string;
    tokensBefore: number;
    isSplitTurn: boolean;
  };
};
export type FakeTreeEvent = {
  signal: AbortSignal;
  preparation: { userWantsSummary: boolean; replaceInstructions?: boolean; customInstructions?: string; entriesToSummarize: FakeEntry[] };
};
type FakeCompactionOptions = Omit<CompactionSummaryOptions, "model"> & { model?: FakeModel };

/** Запускает сжатие на подделках; приведение к типам Pi собрано здесь, а не в каждом тесте. */
export function compactWith(event: FakeCompactEvent, ctx: FakeContext, options?: FakeCompactionOptions) {
  const { model, ...rest } = options ?? {};
  return summarizeCompaction(event as SessionBeforeCompactEvent, asPi<ExtensionContext>(ctx), model ? { ...rest, model: model as Model<Api> } : rest);
}

/** Успешное сжатие с типизированными списками файлов. */
export async function compactedWith(event: FakeCompactEvent, ctx: FakeContext, options?: FakeCompactionOptions) {
  const result = compactionOf(await compactWith(event, ctx, options));
  return { ...result, details: fileListsOf(result.details) };
}

/** Сводка ветки на подделках; без сводки — `undefined`. */
export async function treeSummaryWith(event: FakeTreeEvent, ctx: FakeContext) {
  const summary = (await summarizeTree(event as SessionBeforeTreeEvent, asPi<ExtensionContext>(ctx)))?.summary;
  return summary && { ...summary, details: fileListsOf(summary.details) };
}
