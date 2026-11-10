/**
 * Имена записей журнала сессии (решение 0007).
 *
 * Новое расширение пишет только под своими именами. Прежние имена читаются,
 * чтобы сессии старой пары расширений открывались и продолжались.
 */
export const RECORD = {
  mode: "goal-compact-mode",
  audit: "goal-compact-audit",
  standard: "goal-compact-standard",
  card: "goal-compact-card",
  ticket: "goal-compact-ticket",
} as const;

export const LEGACY_RECORD = {
  mode: "context-compaction-mode",
  card: "context-compaction-card",
} as const;

/** Строка в нижней строке Pi; одна на расширение. */
export const STATUS_KEY = "goal-compact";
