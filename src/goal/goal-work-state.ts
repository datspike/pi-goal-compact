export interface GoalWorkUpdateResult {
  applied: true;
  goalId: string;
  workRevision: number;
  workStateStale: boolean;
  projectionFresh: boolean;
  stage: "complete" | "projection";
  retryable: boolean;
  error: string | null;
}

/** Рабочая картина цели, общая для документа, команд и продолжений агента. */
export interface GoalWorkItem {
  id: string;
  title: string;
  status: "planned" | "active" | "blocked" | "done" | "cancelled";
  /** Отличает поручение пользователя от предложенного агентом пути. */
  source: "user" | "agent";
  result?: string;
  evidence?: string;
}

/** Краткое изложение не изменяет исходный контракт цели и не доказывает её завершение. */
export interface GoalWorkState {
  outcome: string;
  doneWhen: string;
  summary: string;
  items: GoalWorkItem[];
  activeDecisionIds: string[];
  /** Следующий доступный этап; ссылка не выдаёт новых полномочий. */
  nextItemId?: string;
  verification?: string;
  risks?: string;
}

const statuses = new Set(["planned", "active", "blocked", "done", "cancelled"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** Проверяет только форму и однозначность ссылок; не оценивает качество модельной прозы. */
export function isGoalWorkState(value: unknown): value is GoalWorkState {
  if (!record(value) || typeof value.outcome !== "string" || typeof value.doneWhen !== "string" ||
      typeof value.summary !== "string" || !Array.isArray(value.items) || !Array.isArray(value.activeDecisionIds) ||
      !optionalText(value.verification) || !optionalText(value.risks)) return false;
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id) ||
        typeof item.title !== "string" || typeof item.status !== "string" || !statuses.has(item.status) ||
        (item.source !== "user" && item.source !== "agent") ||
        !optionalText(item.result) || !optionalText(item.evidence)) return false;
    ids.add(item.id);
  }
  if (value.nextItemId !== undefined && (typeof value.nextItemId !== "string" ||
    !value.items.some((item: GoalWorkItem) => item.id === value.nextItemId && (item.status === "planned" || item.status === "active")))) return false;
  return value.activeDecisionIds.every((id) => typeof id === "string" && id.trim().length > 0) &&
    new Set(value.activeDecisionIds).size === value.activeDecisionIds.length;
}

/** Возвращает независимый снимок без общих изменяемых массивов. */
export function cloneGoalWorkState(state: GoalWorkState | null): GoalWorkState | null {
  return state ? { ...state, items: state.items.map((item) => ({ ...item })), activeDecisionIds: [...state.activeDecisionIds] } : null;
}

/** Возвращает оставшийся путь в порядке плана; отменённое и завершённое не оживает. */
export function remainingGoalWork(state: GoalWorkState): GoalWorkItem[] {
  return state.items.filter((item) => item.status !== "done" && item.status !== "cancelled").map((item) => ({ ...item }));
}

/** Общий выбор для документа, обзора и продолжения; локальный блокер не становится следующим действием. */
export function selectNextGoalWork(state: GoalWorkState): GoalWorkItem | null {
  return (state.nextItemId ? state.items.find((item) => item.id === state.nextItemId && (item.status === "planned" || item.status === "active")) : undefined)
    ?? state.items.find((item) => item.status === "planned")
    ?? state.items.find((item) => item.status === "active")
    ?? null;
}

/** Сигнал обновить смысловую сводку, а не жёсткий лимит или разрешение обрезать обязательства. */
export function goalWorkNeedsCompaction(state: GoalWorkState): boolean {
  return JSON.stringify(state).length > 16_000 || state.items.filter((item) => item.status === "done" || item.status === "cancelled").length > 12;
}
