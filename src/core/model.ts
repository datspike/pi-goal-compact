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

export type TicketKind = "checkpoint";

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
  | { readonly type: "ticket_arrived"; readonly ticket: Ticket };

export type CheckpointRefusal = "in_progress" | "already_compacted";

export type CoreEffect =
  | { readonly type: "checkpoint_scheduled" }
  | { readonly type: "checkpoint_refused"; readonly reason: CheckpointRefusal }
  | { readonly type: "compact"; readonly request: CheckpointRequest }
  | { readonly type: "send_ticket"; readonly ticket: Ticket; readonly request: CheckpointRequest }
  | { readonly type: "admit_ticket" }
  | { readonly type: "abort_run" }
  /** Контрольная точка снята: путь из простоя не нужен. */
  | { readonly type: "checkpoint_cancelled"; readonly reason: "threshold" | "context_switched" | "aborted" | "failed" };

export interface StepResult {
  readonly state: CoreState;
  readonly effects: readonly CoreEffect[];
}
