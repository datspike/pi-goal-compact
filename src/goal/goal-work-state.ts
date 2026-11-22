import { say } from "../language.js";

export interface GoalWorkUpdateResult {
  /** false — план не принят и в журнал не записан; модель получает причину и следующий шаг (решение 0026). */
  applied: boolean;
  goalId: string;
  workRevision: number;
  workStateStale: boolean;
  projectionFresh: boolean;
  stage: "complete" | "projection" | GoalWorkRuleViolation["stage"];
  retryable: boolean;
  error: string | null;
  message?: string;
  remediation?: string;
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

/** Пункты, которые ещё требуют работы: план не закрыт, пока они живы (решение 0026). */
export function liveGoalWorkItems(state: GoalWorkState | null): GoalWorkItem[] {
  if (!state) return [];
  return state.items.filter((item) => item.status === "planned" || item.status === "active" || item.status === "blocked");
}

/** Доступные шаги без участия владельца: препятствие их не отменяет и не останавливает весь план. */
export function actionableGoalWorkItems(state: GoalWorkState | null): GoalWorkItem[] {
  if (!state) return [];
  return state.items.filter((item) => item.status === "planned" || item.status === "active");
}

/** Нарушение договора плана: код стадии, текст для модели и следующий шаг. */
export interface GoalWorkRuleViolation {
  stage: "insufficient_attempts" | "dropped_item" | "done_without_result";
  message: string;
  remediation: string;
}

/**
 * Правила плана из решения 0026. Проверяется структура журнала, а не правдивость прозы:
 * Пункт пользователя остаётся на прежнем правиле редьюсера; здесь проверяется работа,
 * которую агент предлагал сам.
 */
export function checkGoalWorkRules(
  previous: GoalWorkState | null,
  next: GoalWorkState,
): GoalWorkRuleViolation | null {
  const previousById = new Map((previous?.items ?? []).map((item) => [item.id, item]));
  const nextById = new Map(next.items.map((item) => [item.id, item]));
  for (const item of next.items) {
    // Наблюдение может жить в result или в evidence: оба поля для этого и заведены,
    // а закрытие без единого слова о наблюдении остаётся отказом.
    if (item.status === "done" && !item.result?.trim() && !item.evidence?.trim()) {
      return {
        stage: "done_without_result",
        message: say(`Пункт «${item.title}» закрыт без наблюдения: ни result, ни evidence не говорят, что именно увидено.`, `Item “${item.title}” is closed without an observation: neither result nor evidence says what was seen.`),
        remediation: say("Запиши в result или evidence наблюдение, которое показывает нужное состояние, либо оставь пункт незакрытым.", "Record the observation that shows the required state in result or evidence, or keep the item open."),
      };
    }
    // Препятствие обязано назвать, чего не хватает: пустой blocked — это выход без объяснения.
    if (item.status === "blocked" && !item.result?.trim()) {
      return {
        stage: "insufficient_attempts",
        message: say(`Пункт «${item.title}» объявлен препятствием без объяснения: в result не сказано, чего не хватает и что уже испробовано.`, `Item “${item.title}” is declared blocked without an explanation: result does not say what is missing and what was already tried.`),
        remediation: say("Назови в result, что уже испробовано с разных сторон и какого ресурса не хватает; только потом объявляй препятствие.", "State in result what was tried from different angles and which resource is missing; only then declare a blocker."),
      };
    }
  }
  // Пункт пользователя остаётся на прежнем правиле редьюсера: здесь только работа,
  // которую агент предлагал сам и не вправе убрать молча.
  for (const [id, item] of previousById) {
    if (item.source === "user" || item.status === "done" || item.status === "cancelled" || nextById.has(id)) continue;
    return {
      stage: "dropped_item",
      message: say(`Незавершённый пункт «${item.title}» исчез из плана: молча убрать работу нельзя.`, `Unfinished item “${item.title}” disappeared from the plan: work cannot be dropped silently.`),
      remediation: say("Оставь пункт в плане либо запиши его как cancelled с причиной в result.", "Keep the item in the plan or record it as cancelled with a reason in result."),
    };
  }
  return null;
}

