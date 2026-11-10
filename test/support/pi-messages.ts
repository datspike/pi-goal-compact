import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { FileLists } from "../../src/compaction/file-hints.js";

export const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Полное сообщение ассистента с одним вызовом файлового инструмента — источник файловых наводок. */
export function assistantToolCall(path: string, name = "read"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call-${name}-${path.length}`, name, arguments: { path } }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture-model",
    usage: ZERO_USAGE,
    stopReason: "toolUse",
    timestamp: 0,
  };
}

/** Проверяет, что `details` сжатия — списки файлов, и отдаёт их типизированными. */
export function fileListsOf(details: unknown): FileLists {
  if (typeof details !== "object" || details === null) throw new Error(`нет списков файлов: ${JSON.stringify(details)}`);
  const { readFiles, modifiedFiles } = details as Partial<Record<keyof FileLists, unknown>>;
  if (!isStringList(readFiles) || !isStringList(modifiedFiles)) throw new Error(`неверные списки файлов: ${JSON.stringify(details)}`);
  return { readFiles, modifiedFiles };
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
