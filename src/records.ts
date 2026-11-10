/**
 * Имена записей журнала сессии (решение 0007).
 *
 * Новое расширение пишет только под своими именами. Прежние имена
 * переводятся в новые на входе (`withCurrentRecordNames`), поэтому модули
 * чтения знают одно имя на запись, а сессии старой пары расширений
 * открываются и продолжаются.
 */
export const RECORD = {
  goal: "goal-compact-goal",
  progress: "goal-compact-progress",
  projection: "goal-compact-projection",
  observability: "goal-compact-observability",
  progressInstruction: "goal-compact-progress-instruction",
  progressDue: "goal-compact-progress-due",
  mode: "goal-compact-mode",
  audit: "goal-compact-audit",
  standard: "goal-compact-standard",
  card: "goal-compact-card",
  ticket: "goal-compact-ticket",
} as const;

/** Прежнее имя → новое. Поля записей при этом не меняются: формат тот же. */
export const LEGACY_RECORD_NAMES: Readonly<Record<string, string>> = {
  "pi-codex-goal": RECORD.goal,
  "pi-codex-goal-progress": RECORD.progress,
  "pi-codex-goal-projection": RECORD.projection,
  "pi-codex-goal-observability": RECORD.observability,
  "pi-codex-goal-progress-instruction": RECORD.progressInstruction,
  "pi-codex-goal-progress-due": RECORD.progressDue,
  "context-compaction-mode": RECORD.mode,
  "context-compaction-card": RECORD.card,
};

interface NamedEntry { readonly type?: string; readonly customType?: string }

/** Отдаёт записи журнала с новыми именами; записи без прежнего имени возвращаются теми же объектами. */
export function withCurrentRecordNames<T extends NamedEntry>(entries: Iterable<T>): T[] {
  const result: T[] = [];
  for (const entry of entries) {
    const renamed = entry.customType === undefined ? undefined : LEGACY_RECORD_NAMES[entry.customType];
    result.push(renamed ? { ...entry, customType: renamed } : entry);
  }
  return result;
}

/** Ключи нижней строки Pi: окно контекста и цель показываются рядом и не затирают друг друга. */
export const STATUS_KEY = { context: "goal-compact-context", goal: "goal-compact-goal" } as const;
