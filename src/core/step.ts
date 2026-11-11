import type { CoreEffect, CoreEvent, CoreState, GoalGate, StepResult, Ticket } from "./model.js";

const result = (state: CoreState, ...effects: CoreEffect[]): StepResult => ({ state, effects });

/**
 * Билет годен, только если с его постановки не было реплики владельца и смены контекста,
 * а цель всё ещё разрешает работу. Продолжение после сжатия по запросу агента законно и без
 * цели: агент сам попросил сжать и продолжить; но ожидающую или приостановленную цель оно не обходит.
 */
function admissible(state: CoreState, ticket: Ticket, gate: GoalGate): boolean {
  const fresh = ticket.epoch === state.epoch && state.ticketEpoch === ticket.epoch;
  return fresh && state.transfer !== "applying" && state.transfer !== "failed" && (ticket.kind === "goal" ? gate === "runs" : gate !== "held");
}

/**
 * Один шаг автомата: состояние и событие дают новое состояние и действия.
 * Функция чистая; обвязка исполняет действия по порядку.
 */
export function step(state: CoreState, event: CoreEvent): StepResult {
  switch (event.type) {
    case "checkpoint_cancel_requested":
      if (state.checkpoint.phase === "pending") return result({ ...state, checkpoint: { phase: "none" } }, { type: "checkpoint_cancelled", reason: "aborted" });
      return result(state.checkpoint.phase === "compacting" ? { ...state, checkpoint: { ...state.checkpoint, suppressed: true } } : state);
    case "transfer_queued":
      return result({ ...state, transfer: "queued" });
    case "transfer_saved":
      return result(state.transfer === "queued" ? { ...state, transfer: "applying" } : state);
    case "transfer_applied":
      return result({ ...state, transfer: event.ok ? "queued" : "failed" });
    case "transfer_cancelled": {
      const { transfer: _transfer, ...cleared } = state;
      return result(cleared);
    }
    case "owner_input":
    case "context_switched": {
      const cancelled = state.checkpoint.phase === "pending" && event.type === "context_switched";
      const next: CoreState = {
        ...state,
        epoch: state.epoch + 1,
        ticketEpoch: null,
        // Реплика владельца не отменяет ждущую контрольную точку: сжатие пройдёт
        // после его хода, но продолжение по старой эпохе уже не уйдёт.
        checkpoint: cancelled ? { phase: "none" } : state.checkpoint,
        ...(event.type === "owner_input" ? { agent: "running" as const } : {}),
      };
      return cancelled ? result(next, { type: "checkpoint_cancelled", reason: "context_switched" }) : result(next);
    }
    case "run_started":
      return result({ ...state, agent: "running" });
    case "checkpoint_requested": {
      if (state.checkpoint.phase !== "none") return result(state, { type: "checkpoint_refused", reason: "in_progress" });
      if (event.alreadyCompacted) return result(state, { type: "checkpoint_refused", reason: "already_compacted" });
      return result({ ...state, checkpoint: { phase: "pending", request: event.request, epoch: state.epoch, suppressed: false, ...(event.continueAfter === undefined ? {} : { continueAfter: event.continueAfter }) } }, { type: "checkpoint_scheduled" });
    }
    case "settled": {
      const idle: CoreState = { ...state, agent: "idle", selfAbort: false };
      if (event.aborted && !state.selfAbort && state.checkpoint.phase === "pending") {
        return result({ ...idle, checkpoint: { phase: "none" } }, { type: "checkpoint_cancelled", reason: "aborted" });
      }
      if (state.checkpoint.phase !== "pending") return result(idle);
      return result({ ...idle, checkpoint: { ...state.checkpoint, phase: "compacting" } }, { type: "compact", request: state.checkpoint.request });
    }
    case "compaction_started": {
      // Автоматическое сжатие до успокоения хода уже выполняет ждущую контрольную точку.
      if (event.reason !== "manual" && state.checkpoint.phase === "pending") {
        return result({ ...state, checkpoint: { phase: "none" } }, { type: "checkpoint_cancelled", reason: "threshold" });
      }
      return result(suppressIfRetry(state, event.willRetry));
    }
    case "compaction_finished":
      return result(suppressIfRetry(state, event.willRetry));
    case "checkpoint_compact_done": {
      if (state.checkpoint.phase !== "compacting") return result(state);
      const { request, epoch, suppressed } = state.checkpoint;
      const cleared: CoreState = { ...state, checkpoint: { phase: "none" } };
      if (!event.ok) return result(cleared, { type: "checkpoint_cancelled", reason: "failed" });
      // Pi повторит прерванный запрос сам, или владелец уже ответил: продолжение не нужно.
      if (state.checkpoint.continueAfter === false || suppressed || event.pendingMessages || epoch !== state.epoch || state.agent !== "idle") return result(cleared);
      const ticket: Ticket = { epoch: state.epoch, kind: "checkpoint" };
      return result({ ...cleared, ticketEpoch: state.epoch }, { type: "send_ticket", ticket, request });
    }
    case "before_settle": {
      // Ждущая контрольная точка сама запустит работу после сжатия; ошибку и обрыв разбирает модуль цели.
      const continues = event.gate === "runs" && event.outcome === "completed" && !event.pendingMessages &&
        state.agent === "running" && state.checkpoint.phase === "none" && state.transfer !== "applying" && state.transfer !== "failed";
      return continues ? result(state, { type: "continue_goal" }) : result(state);
    }
    case "wake": {
      // Во время прогона будить не нужно: решение примет граница перед простоем. Свежий билет — один.
      if (event.gate !== "runs" || state.agent !== "idle" || state.checkpoint.phase !== "none" || state.ticketEpoch === state.epoch || state.transfer === "applying" || state.transfer === "failed") return result(state);
      const ticket: Ticket = { epoch: state.epoch, kind: "goal" };
      return result({ ...state, ticketEpoch: state.epoch }, { type: "send_ticket", ticket, request: null });
    }
    case "ticket_arrived": {
      if (admissible(state, event.ticket, event.gate)) return result({ ...state, agent: "running", ticketEpoch: null }, { type: "admit_ticket" });
      return result({ ...state, selfAbort: true }, { type: "abort_run" });
    }
  }
}

function suppressIfRetry(state: CoreState, willRetry: boolean): CoreState {
  // Pi сам повторит прерванный запрос после сжатия: своё продолжение дало бы второй прогон.
  if (!willRetry || state.checkpoint.phase === "none") return state;
  return { ...state, checkpoint: { ...state.checkpoint, suppressed: true } };
}
