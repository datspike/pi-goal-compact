import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { RECORD } from "../records.js";
import { createGoalProgressEntryComponent } from "./goal-reports.js";
import { formatDuration } from "./format.js";
import type { GoalWorkingState } from "./format.js";
import type { SessionEntryLike } from "./types.js";

export const GOAL_OBSERVABILITY_ENTRY_TYPE = RECORD.observability;

type SnapshotMode = "status" | "details";

export interface GoalObservabilityEntry {
  version: 1;
  kind: "snapshot";
  mode: SnapshotMode;
  goalId?: string;
  key: string;
  lines: string[];
}

function statusLabel(state: GoalWorkingState): string {
  if (state.lifecycle === "complete") return "✓ Завершена";
  if (state.lifecycle === "paused") return "На паузе";
  if (state.lifecycle === "budgetLimited") return "Лимит бюджета";
  if (state.progressStatus === "blocked") return "Заблокировано";
  if (state.awaitingUser && !state.userAnswerReceived) return "Жду ответа";
  if (state.blocker) return "Заблокировано";
  if (state.progressStatus === "verifying") return "Проверяю";
  return state.lifecycle === "active" ? "Работаю" : "Нет цели";
}

function clean(value: string | null | undefined): string | null {
  const result = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\s+/g, " ").trim();
  if (!result) return null;
  const chars = [...result];
  return chars.length > 220 ? `${chars.slice(0, 219).join("")}…` : result;
}

function addOptional(lines: string[], label: string, value: string | null | undefined): void {
  const normalized = clean(value);
  if (normalized) lines.push(`${label}: ${normalized}`);
}

export function formatGoalSnapshot(state: GoalWorkingState, mode: SnapshotMode): string[] {
  if (!state.goal) return ["Цель: нет активной цели"];
  const lines = [`Цель: ${statusLabel(state)} · ${formatDuration(state.usage.activeSeconds)}`];
  if (mode === "status") {
    addOptional(lines, "Сейчас", state.currentStep);
    addOptional(lines, "Дальше", state.nextStep);
    return lines;
  }
  const work = state.workState;
  addOptional(lines, "Замысел", work?.outcome || state.goal.objective);
  addOptional(lines, "Сейчас", work?.summary || state.currentStep);
  if (work) {
    const active = work.items.filter((item) => item.status === "active");
    const done = work.items.filter((item) => item.status === "done");
    if (active.length) addOptional(lines, "В работе", active.slice(0, 2).map((item) => item.title).join("; "));
    if (done.length) addOptional(lines, "Готово", done.slice(-2).map((item) => item.title).join("; "));
    const remaining = work.items.filter((item) => item.status === "planned" || item.status === "blocked");
    if (remaining.length) {
      lines.push("Предстоит:");
      for (const item of remaining.slice(0, 5)) lines.push(`  • ${clean(item.title)}${item.status === "blocked" ? " — заблокировано" : ""}`);
      if (remaining.length > 5) lines.push(`  Ещё ${remaining.length - 5} этапов — в сводке.`);
    } else if (!active.length && state.lifecycle !== "complete") {
      lines.push("Будущие этапы не отмечены; полноту результата ещё нужно проверить.");
    }
    if (state.workStateStale) lines.push("План: договорённость изменилась, сводку нужно сверить.");
  } else {
    lines.push("План ещё не записан; это не означает, что оставшейся работы нет.");
    addOptional(lines, "Дальше", state.nextStep);
  }
  addOptional(lines, "Проверка", state.latestUsefulVerification);
  addOptional(lines, "Препятствие", state.blocker);
  addOptional(lines, "Нужно решение", state.needUser);
  if (state.continuationHeld) lines.push("Продолжение удерживается до решения пользователя.");
  if (state.projection && !state.projection.fresh) lines.push("Сводка требует синхронизации.");
  const document = state.artifactRefs.find((ref) => ref.artifact === "GOAL");
  if (document) lines.push(`Подробности: \u001b]8;;${document.path}\u001b\\GOAL.md\u001b]8;;\u001b\\`);
  return lines;
}

function snapshotKey(goalId: string | undefined, mode: SnapshotMode, lines: readonly string[]): string {
  return `${goalId ?? ""}\u0000${mode}\u0000${lines.join("\u0000")}`;
}

function isSnapshotEntry(value: unknown): value is GoalObservabilityEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<GoalObservabilityEntry>;
  return entry.version === 1 && entry.kind === "snapshot" &&
    (entry.mode === "status" || entry.mode === "details") &&
    (entry.goalId === undefined || typeof entry.goalId === "string") &&
    typeof entry.key === "string" && Array.isArray(entry.lines) && entry.lines.every(line => typeof line === "string");
}

function hasSnapshot(branch: Iterable<SessionEntryLike>, key: string): boolean {
  return [...branch].some((entry) => entry.customType === GOAL_OBSERVABILITY_ENTRY_TYPE && isSnapshotEntry(entry.data) && entry.data.key === key);
}

export function appendGoalSnapshot(
  pi: Pick<ExtensionAPI, "appendEntry">,
  ctx: ExtensionCommandContext,
  state: GoalWorkingState,
  mode: SnapshotMode,
): void {
  const lines = formatGoalSnapshot(state, mode);
  const goalId = state.goal?.goalId;
  const key = snapshotKey(goalId, mode, lines);
  if (hasSnapshot(ctx.sessionManager.getBranch(), key)) return;
  pi.appendEntry(GOAL_OBSERVABILITY_ENTRY_TYPE, { version: 1, kind: "snapshot", mode, key, lines, ...(goalId ? { goalId } : {}) } satisfies GoalObservabilityEntry);
}

export function renderGoalObservabilityEntry(entry: { data?: unknown }): { render(width: number): string[]; invalidate(): void } | undefined {
  if (!isSnapshotEntry(entry.data)) return undefined;
  return createGoalProgressEntryComponent(entry.data.lines, true);
}
