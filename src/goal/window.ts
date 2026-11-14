import { say } from "../language.js";
import type { AgentMessage } from "../compaction/file-hints.js";

import { RECORD, withCurrentRecordNames } from "../records.js";
import { renderAgreement } from "./agreement.js";
import type { GoalFeatures } from "./goal-report-config.js";
import { reconstructGoal } from "./state.js";
import type { SessionEntryLike, ThreadGoal } from "./types.js";

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
 * Вызывающий передаёт цель на момент сжатия (`goalAtCompaction`), если она есть (решение 0012).
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
      const content = [say("## Последние реплики владельца дословно", "## Latest owner replies verbatim"), ...replies.map((reply) => `> ${reply.replace(/\n/g, "\n> ")}`)].join("\n\n");
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

/**
 * Цель, которую держит начало окна (решение 0012): та, что была открыта при последнем сжатии,
 * в своём состоянии на момент сжатия. Поправки, пункты «Решаю сам», закрытие и снятие этой цели
 * до следующего сжатия начало окна не меняют: иначе провайдер заново пишет кэш всего хвоста.
 * null — снимка нет или поставлена другая открытая цель; тогда окно строится по текущей цели.
 * Источник — только записи ветки, поэтому ответ одинаков при каждом запросе, после /reload и в копии сессии.
 */
export function goalAtCompaction(branch: readonly SessionEntryLike[], current: ThreadGoal | null): ThreadGoal | null {
  const entries = withCurrentRecordNames(branch);
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]!.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex < 0) return null;
  const atCompaction = reconstructGoal(entries.slice(0, compactionIndex)).goal;
  if (!openGoal(atCompaction)) return null;
  if (openGoal(current) && current.goalId !== atCompaction.goalId) return null;
  return atCompaction;
}

/** Поправка видна в конце окна, пока в его начале прежняя редакция той же цели. */
export function amendedAfterCompactionNotice(current: ThreadGoal): string {
  return [
    say(
      `В начале окна договорённость этой цели в редакции на момент сжатия. Действует новая редакция ниже; в начало окна она встанет при следующем сжатии.`,
      `The start of the window holds this goal's agreement as of compaction. The new revision below applies; it moves to the start of the window at the next compaction.`,
    ),
    renderAgreement(current),
  ].join("\n\n");
}

/** Пометка в ответе на закрытие, когда договорённость закрытой цели остаётся в начале окна. */
export function retainedAgreementNotice(): string {
  return say(
    "Договорённость в начале окна относится к этой цели и остаётся там до следующего сжатия только как история. Цель закрыта: по договорённости больше не работай, следующую работу задаёт владелец.",
    "The agreement at the start of the window belongs to this goal and stays there until the next compaction only as history. The goal is closed: do not work from that agreement any more; the owner sets the next work.",
  );
}
