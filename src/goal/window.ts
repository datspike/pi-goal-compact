import type { AgentMessage } from "../compaction/file-hints.js";

import { RECORD } from "../records.js";
import { renderAgreement } from "./agreement.js";
import type { GoalFeatures } from "./goal-report-config.js";
import type { ThreadGoal } from "./types.js";

/** Сколько знаков последних реплик владельца ставится после сводки, когда цели нет (решение Р4). */
export const OWNER_REPLIES_CHARS = 1500;

export interface WindowInput {
  goal: ThreadGoal | null;
  features: Pick<GoalFeatures, "agreementInWindow" | "singleFactOwner" | "ownerRepliesWithoutGoal">;
  /** Реплики владельца из сжатой части ветки, от старых к новым. */
  ownerReplies: readonly string[];
}

const GOAL_HEADINGS = ["## Цель", "## Goal"];

/**
 * Убирает из сводки её раздел «Цель»: при незакрытой цели его место занимает договорённость (Т5.3).
 * Раздел идёт от заголовка до следующего заголовка второго уровня.
 */
export function withoutGoalSection(summary: string): string {
  const lines = summary.split("\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = line.trimEnd();
    if (GOAL_HEADINGS.includes(heading)) {
      skipping = true;
      continue;
    }
    if (skipping && /^## /.test(heading)) skipping = false;
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").replace(/^\n+/, "");
}

/** Последние реплики владельца дословно, в пределах `limit` знаков; начало слишком длинной обрезается. */
export function lastOwnerReplies(replies: readonly string[], limit = OWNER_REPLIES_CHARS): string[] {
  const picked: string[] = [];
  let left = limit;
  for (let index = replies.length - 1; index >= 0 && left > 0; index--) {
    const reply = replies[index]!.trim();
    if (!reply) continue;
    const chars = [...reply];
    picked.unshift(chars.length <= left ? reply : `…${chars.slice(chars.length - left).join("")}`);
    left -= chars.length;
  }
  return picked;
}

const openGoal = (goal: ThreadGoal | null): goal is ThreadGoal => goal !== null && goal.status !== "complete";

/**
 * Собирает начало окна при каждом запросе (решение 0004): сводка последнего сжатия, за ней при
 * незакрытой цели — договорённость последней редакции, без цели — последние реплики владельца.
 * В журнал собранное не пишется; без сжатия окно не меняется.
 */
export function assembleWindow(messages: readonly AgentMessage[], input: WindowInput): AgentMessage[] | undefined {
  let summaryIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "compactionSummary") {
      summaryIndex = index;
      break;
    }
  }
  if (summaryIndex < 0) return undefined;
  const summary = messages[summaryIndex]!;
  if (summary.role !== "compactionSummary") return undefined;
  const goal = openGoal(input.goal) ? input.goal : null;
  const next = [...messages];
  let changed = false;
  if (goal && input.features.singleFactOwner) {
    const stripped = withoutGoalSection(summary.summary);
    if (stripped !== summary.summary) {
      next[summaryIndex] = { ...summary, summary: stripped };
      changed = true;
    }
  }
  const after: AgentMessage[] = [];
  if (goal && input.features.agreementInWindow) {
    after.push({ role: "custom", customType: RECORD.agreement, content: renderAgreement(goal), display: false, timestamp: summary.timestamp });
  } else if (!goal && input.features.ownerRepliesWithoutGoal) {
    const replies = lastOwnerReplies(input.ownerReplies);
    if (replies.length > 0) {
      const content = ["## Последние реплики владельца дословно", ...replies.map((reply) => `> ${reply.replace(/\n/g, "\n> ")}`)].join("\n\n");
      after.push({ role: "custom", customType: RECORD.ownerReplies, content, display: false, timestamp: summary.timestamp });
    }
  }
  if (after.length > 0) {
    next.splice(summaryIndex + 1, 0, ...after);
    changed = true;
  }
  return changed ? next : undefined;
}

interface BranchEntry {
  type: string;
  id: string;
  firstKeptEntryId?: string;
  message?: unknown;
}

function messageText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return null;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return null;
  const text = candidate.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
  return text || null;
}

/** Реплики владельца, которые ушли в последнее сжатие: всё до первой сохранённой записи. */
export function compactedOwnerReplies(branch: readonly BranchEntry[]): string[] {
  let compaction: BranchEntry | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    if (branch[index]!.type === "compaction") {
      compaction = branch[index];
      break;
    }
  }
  if (!compaction) return [];
  const keptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  const end = keptIndex >= 0 ? keptIndex : branch.indexOf(compaction);
  const replies: string[] = [];
  for (const entry of branch.slice(0, end)) {
    if (entry.type !== "message") continue;
    const text = messageText(entry.message);
    if (text) replies.push(text);
  }
  return replies;
}
