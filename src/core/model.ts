/**
 * Состояние, события и действия ядра (решение 0001).
 *
 * Ядро не знает о Pi: события описывают, что случилось, действия — что
 * обвязка должна сделать. Те же события и правила описаны в моделях
 * formal/Continuation.tla и formal/Agreement.tla.
 */

/** Аргументы контрольной точки передаются ядром как есть: текст строит обвязка. */
export type CheckpointRequest = Readonly<Record<string, unknown>>;

export type CheckpointState =
  | { readonly phase: "none" }
  | { readonly phase: "pending"; readonly request: CheckpointRequest; readonly epoch: number; readonly suppressed: boolean }
  | { readonly phase: "compacting"; readonly request: CheckpointRequest; readonly epoch: number; readonly suppressed: boolean };

export interface CoreState {
  /** Растёт на реплике владельца, смене ветки, сессии или модели. Билет прошлой эпохи устарел. */
  readonly epoch: number;
  readonly agent: "idle" | "running";
  readonly checkpoint: CheckpointState;
  /** Эпоха свежего билета в очереди Pi; свежий билет бывает только один. */
  readonly ticketEpoch: number | null;
  /** Свой отказ билету: следующее прерывание прогона — не обрыв владельцем. */
  readonly selfAbort: boolean;
}

export const initialState: CoreState = {
  epoch: 0,
  agent: "idle",
  checkpoint: { phase: "none" },
  ticketEpoch: null,
  selfAbort: false,
};

/** checkpoint — продолжение после сжатия по запросу агента; goal — продолжение цели из простоя. */
export type TicketKind = "checkpoint" | "goal";

/**
 * Что цель разрешает прямо сейчас. Решает модуль цели, ядро только сверяет.
 * runs — работать без владельца; held — цель есть, но стоит (ожидание ответа, пауза,
 * неизвестный исход записи, предел продолжений, сабагент); absent — цели нет или она закрыта.
 */
export type GoalGate = "runs" | "held" | "absent";

export interface Ticket {
  readonly epoch: number;
  readonly kind: TicketKind;
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export type CoreEvent =
  /** Настоящая реплика владельца, не служебное сообщение. */
  | { readonly type: "owner_input" }
  /** Смена ветки, сессии или выбор другой модели владельцем. */
  | { readonly type: "context_switched" }
  | { readonly type: "run_started" }
  | { readonly type: "settled"; readonly aborted: boolean }
  /** Агент попросил контрольную точку; alreadyCompacted — сжатие уже было после последней реплики владельца. */
  | { readonly type: "checkpoint_requested"; readonly request: CheckpointRequest; readonly alreadyCompacted: boolean }
  | { readonly type: "compaction_started"; readonly reason: CompactionReason; readonly willRetry: boolean }
  | { readonly type: "compaction_finished"; readonly reason: CompactionReason; readonly willRetry: boolean; readonly ok: boolean }
  /** Сжатие по запросу агента полностью завершилось, Pi отпустил блокировку. */
  /** pendingMessages — у Pi уже есть ждущее сообщение, и оно само запустит прогон. */
  | { readonly type: "checkpoint_compact_done"; readonly ok: boolean; readonly pendingMessages: boolean }
  /** Билет дошёл до before_agent_start. */
  | { readonly type: "ticket_arrived"; readonly ticket: Ticket; readonly gate: GoalGate }
  /**
   * Граница agent_before_settle: последняя точка прогона перед простоем.
   * pendingMessages — в очереди Pi уже есть сообщение (обычно реплика владельца), оно и пойдёт дальше.
   */
  | { readonly type: "before_settle"; readonly gate: GoalGate; readonly outcome: "completed" | "aborted" | "error"; readonly pendingMessages: boolean }
  /** Повод начать работу цели из простоя: сабагент закончил, возобновление, смена ветки, сжатие. */
  | { readonly type: "wake"; readonly gate: GoalGate };

export type CheckpointRefusal = "in_progress" | "already_compacted";

export type CoreEffect =
  | { readonly type: "checkpoint_scheduled" }
  | { readonly type: "checkpoint_refused"; readonly reason: CheckpointRefusal }
  | { readonly type: "compact"; readonly request: CheckpointRequest }
  /** request есть только у билета контрольной точки. */
  | { readonly type: "send_ticket"; readonly ticket: Ticket; readonly request: CheckpointRequest | null }
  /** Продолжить цель следующим запросом модели в том же прогоне. */
  | { readonly type: "continue_goal" }
  | { readonly type: "admit_ticket" }
  | { readonly type: "abort_run" }
  /** Контрольная точка снята: путь из простоя не нужен. */
  | { readonly type: "checkpoint_cancelled"; readonly reason: "threshold" | "context_switched" | "aborted" | "failed" };

export interface StepResult {
  readonly state: CoreState;
  readonly effects: readonly CoreEffect[];
}
