const ASTRA_MODEL = "openai/gpt-6.2-astra";
const SOL_MODEL = "openai/gpt-6.2-sol";
const FIRST_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

export type ProviderRetryErrorClass = "model-temporary" | "unlocalized-temporary" | "not-admitted";

export interface ProviderRetryChain {
  /** Монотонная отметка первого подтверждённого временного сбоя. */
  startedAtMs: number;
  model: string;
  /** Число уже выданных дополнительных повторов на той же модели. */
  attemptsIssued: number;
  switched: boolean;
}

export interface ProviderRetryInput {
  chain: ProviderRetryChain;
  nowMs: number;
  /** Отметка текущего сбоя; при пробуждении таймера не меняется. */
  failedAtMs: number;
  errorClass: ProviderRetryErrorClass;
  /** Монотонная нижняя граница из Retry-After; без заголовка — failedAtMs. */
  notBeforeMs: number;
  windowMs: number;
  allowSwitch: boolean;
}

export type ProviderRetryStopReason =
  | "error-not-admitted"
  | "already-switched"
  | "retry-after-outside-window"
  | "window-exhausted";

export type ProviderRetryDecision =
  | { type: "stop"; reason: ProviderRetryStopReason }
  | { type: "wait"; untilMs: number }
  | { type: "retry" }
  | { type: "switch"; model: typeof SOL_MODEL };

/**
 * Выбирает одно действие после штатных повторов Pi. Все отметки — в одной монотонной шкале,
 * окно — конечная неотрицательная длительность. Повторную проверку после wait вызывают
 * с новым nowMs, без изменения отметки сбоя и счётчика только из-за ожидания.
 */
export function decideProviderRetry(input: ProviderRetryInput): ProviderRetryDecision {
  const { chain, nowMs, failedAtMs, errorClass, notBeforeMs, windowMs, allowSwitch } = input;
  if (errorClass === "not-admitted") return { type: "stop", reason: "error-not-admitted" };
  if (chain.switched) return { type: "stop", reason: "already-switched" };

  const deadlineMs = chain.startedAtMs + windowMs;
  if (notBeforeMs > deadlineMs && notBeforeMs > failedAtMs) return { type: "stop", reason: "retry-after-outside-window" };

  const delayMs = Math.min(FIRST_DELAY_MS * 2 ** chain.attemptsIssued, MAX_DELAY_MS);
  const retryAtMs = Math.max(failedAtMs + delayMs, notBeforeMs);
  if (nowMs < deadlineMs && retryAtMs < deadlineMs) {
    return nowMs < retryAtMs ? { type: "wait", untilMs: retryAtMs } : { type: "retry" };
  }

  // Крайняя отметка принадлежит переходу: ещё один старт на Astra мог бы его отложить.
  if (chain.model === ASTRA_MODEL && allowSwitch && errorClass === "model-temporary") {
    return nowMs < deadlineMs ? { type: "wait", untilMs: deadlineMs } : { type: "switch", model: SOL_MODEL };
  }
  return { type: "stop", reason: "window-exhausted" };
}
