import { say } from "../language.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { RECORD } from "../records.js";
import { renderAgreement } from "./agreement.js";
import { createGoalProgressEntryComponent } from "./goal-reports.js";
import { formatDuration } from "./format.js";
import type { GoalWorkingState } from "./format.js";
import type { SessionEntryLike, ThreadGoal } from "./types.js";

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
  if (state.lifecycle === "complete") return say("✓ Завершена", "✓ Complete");
  if (state.lifecycle === "paused") return say("На паузе", "Paused");
  if (state.lifecycle === "budgetLimited") return say("Лимит бюджета", "Budget limit");
  if (state.progressStatus === "blocked") return say("Заблокировано", "Blocked");
  if (state.awaitingUser && !state.userAnswerReceived) return say("Жду ответа", "Waiting for reply");
  if (state.blocker) return say("Заблокировано", "Blocked");
  if (state.progressStatus === "verifying") return say("Проверяю", "Verifying");
  return state.lifecycle === "active" ? say("Работаю", "Working") : say("Нет цели", "No goal");
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
  if (!state.goal) return [say("Цель: нет активной цели", "Goal: no active goal")];
  const lines = [say(`Цель: ${statusLabel(state)} · ${formatDuration(state.usage.activeSeconds)}`, `Goal: ${statusLabel(state)} · ${formatDuration(state.usage.activeSeconds)}`)];
  if (mode === "status") {
    addOptional(lines, say("Сейчас", "Now"), state.currentStep);
    addOptional(lines, say("Дальше", "Next"), state.nextStep);
    return lines;
  }
  const work = state.workState;
  const agreement = state.goal.agreement;
  if (agreement) {
    addOptional(lines, say(`Договорённость (ред. ${agreement.revision})`, `Agreement (rev. ${agreement.revision})`), agreement.ownerWants);
    addOptional(lines, say("Готово, когда", "Done when"), agreement.doneWhen);
    const unconfirmed = (state.goal.selfDecided ?? []).filter((item) => item.state === "unconfirmed");
    if (unconfirmed.length) {
      lines.push(say("Решаю сам, не подтверждено:", "Decided myself, not confirmed:"));
      unconfirmed.slice(0, 5).forEach((item, index) => lines.push(`  ${index + 1}. ${clean(item.text)}`));
      if (unconfirmed.length > 5) lines.push(say(`  Ещё ${unconfirmed.length - 5} — в GOAL.md.`, `  ${unconfirmed.length - 5} more in GOAL.md.`));
    }
  }
  addOptional(lines, say("Замысел", "Intent"), work?.outcome || state.goal.objective);
  addOptional(lines, say("Сейчас", "Now"), work?.summary || state.currentStep);
  if (work) {
    const active = work.items.filter((item) => item.status === "active");
    const done = work.items.filter((item) => item.status === "done");
    if (active.length) addOptional(lines, say("В работе", "In progress"), active.slice(0, 2).map((item) => item.title).join("; "));
    if (done.length) addOptional(lines, say("Готово", "Done"), done.slice(-2).map((item) => item.title).join("; "));
    const remaining = work.items.filter((item) => item.status === "planned" || item.status === "blocked");
    if (remaining.length) {
      lines.push(say("Предстоит:", "Planned:"));
      for (const item of remaining.slice(0, 5)) lines.push(`  • ${clean(item.title)}${item.status === "blocked" ? say(" — заблокировано", " — blocked") : ""}`);
      if (remaining.length > 5) lines.push(say(`  Ещё ${remaining.length - 5} этапов — в сводке.`, `  ${remaining.length - 5} more stages in the summary.`));
    } else if (!active.length && state.lifecycle !== "complete") {
      lines.push(say("Будущие этапы не отмечены; полноту результата ещё нужно проверить.", "Future stages are not marked; the result still needs a completeness check."));
    }
    if (state.workStateStale) lines.push(say("План: договорённость изменилась, сводку нужно сверить.", "Plan: the agreement changed, the summary needs reconciling."));
  } else {
    lines.push(say("План ещё не записан; это не означает, что оставшейся работы нет.", "No plan recorded yet; this does not mean no work remains."));
    addOptional(lines, say("Дальше", "Next"), state.nextStep);
  }
  addOptional(lines, say("Проверка", "Verification"), state.latestUsefulVerification);
  addOptional(lines, say("Препятствие", "Blocker"), state.blocker);
  addOptional(lines, say("Нужно решение", "Decision needed"), state.needUser);
  if (state.continuationHeld) lines.push(say("Продолжение удерживается до решения пользователя.", "Continuation is held until the user decides."));
  if (state.projection && !state.projection.fresh) lines.push(say("Сводка требует синхронизации.", "The summary needs synchronization."));
  const document = state.artifactRefs.find((ref) => ref.artifact === "GOAL");
  if (document) lines.push(`${say("Подробности", "Details")}: \u001b]8;;${document.path}\u001b\\GOAL.md\u001b]8;;\u001b\\`);
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

/**
 * Т3.7, Т4.3: каждая новая редакция договорённости появляется в ленте один раз, чтобы владелец
 * видел, что теперь считается целью. Запись только для показа: модель её не получает.
 */
export function appendAgreementEntry(pi: Pick<ExtensionAPI, "appendEntry">, branch: Iterable<SessionEntryLike>, goal: ThreadGoal): void {
  if (!goal.agreement) return;
  const key = `agreement\u0000${goal.goalId}\u0000${goal.agreement.revision}`;
  if (hasSnapshot(branch, key)) return;
  const lines = renderAgreement(goal).split("\n").filter((line, index, all) => line !== "" || all[index - 1] !== "");
  pi.appendEntry(GOAL_OBSERVABILITY_ENTRY_TYPE, { version: 1, kind: "snapshot", mode: "details", key, lines, goalId: goal.goalId } satisfies GoalObservabilityEntry);
}

export function renderGoalObservabilityEntry(entry: { data?: unknown }): { render(width: number): string[]; invalidate(): void } | undefined {
  if (!isSnapshotEntry(entry.data)) return undefined;
  return createGoalProgressEntryComponent(entry.data.lines, true);
}
