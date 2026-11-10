import { matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThreadGoal } from "./types.js";

interface RetryRecoveryDeps {
  getGoal(): ThreadGoal | null;
  isAvailable(): boolean;
  now(): number;
  canRecover(): boolean;
  clearContinuation(): void;
  resume(ctx: ExtensionContext): void;
  pause(ctx: ExtensionContext, reason: string): void;
  pauseManual(ctx: ExtensionContext): void;
  pending(ctx: ExtensionContext, reason: string): void;
  settled(ctx: ExtensionContext): void;
}
interface RetryResult {
  role: string;
  stopReason?: string;
  content?: string | Array<{ type: string; text?: string }>;
}

/** Coordinates observed retries in this session without trusting anonymous shared-bus events or initiating requests. */
export function createExternalRetryRecovery(deps: RetryRecoveryDeps) {
  let context: ExtensionContext | null = null;
  let sessionId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let cycle: { goalId: string; recovering: boolean; intentAfter: number; carrierAt: number } | null = null;
  // The file path appears lazily after the first persisted turn; only the session ID is stable throughout it.
  const scope = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
  const sameSession = (ctx: ExtensionContext): boolean => sessionId !== null && scope(ctx) === sessionId;
  const active = (): boolean => cycle !== null && cycle.goalId === deps.getGoal()?.goalId;
  const invalidate = (): void => { cycle = null; };
  const recordIntent = (goalId: string): void => {
    const previous = active() ? cycle : null;
    cycle = { goalId, recovering: false, intentAfter: Math.max(deps.now(), previous?.intentAfter ?? -1, previous?.carrierAt ?? -1), carrierAt: previous?.carrierAt ?? -1 };
    deps.clearContinuation();
  };
  const emptyResult = (message: RetryResult): boolean => {
    const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content ?? "" }];
    return message.stopReason === "stop" && parts.every(part => part.type !== "toolCall" && !(part.type === "text" && part.text?.trim()));
  };
  const eligible = (ctx: ExtensionContext): ThreadGoal | null => {
    const goal = deps.getGoal();
    return sameSession(ctx) && deps.isAvailable() && deps.canRecover() && goal &&
      (goal.status === "active" || (goal.status === "paused" && goal.pause?.kind === "recovery")) ? goal : null;
  };
  const detach = (): void => {
    invalidate();
    unsubscribe?.();
    unsubscribe = null;
    context = null;
    sessionId = null;
  };
  const bind = (ctx: ExtensionContext): void => {
    detach();
    context = ctx;
    sessionId = scope(ctx);
    // Pause provenance explains history; it cannot recreate permission for an old queued retry.
    if (ctx.mode === "tui") {
      unsubscribe = ctx.ui.onTerminalInput((data) => {
        if (active() && matchesKey(data, "escape")) {
          invalidate();
          deps.pauseManual(context ?? ctx);
        }
        // Pi still owns cancelling the running turn and clearing its queue.
        return undefined;
      });
    }
  };
  return {
    bind, detach, invalidate, active, ownsContext: sameSession,
    observe(ctx: ExtensionContext) { if (sameSession(ctx)) context = ctx; },
    error(ctx: ExtensionContext, error: string): boolean {
      const goal = eligible(ctx);
      if (!goal) return false;
      const wasRecovering = active() && cycle!.recovering;
      recordIntent(goal.goalId);
      if (!wasRecovering) return false; // The normal classifier owns the first error.
      deps.pause(ctx, `External retry failed (${error})`);
      return true;
    },
    // Length/empty recovery has no error; record its intent from this session's actual assistant result.
    result(ctx: ExtensionContext, message: RetryResult): void {
      if (message.role !== "assistant") return;
      const goal = eligible(ctx);
      if (!goal || (active() && !cycle!.recovering)) return;
      if (message.stopReason !== "length" && !emptyResult(message)) return;
      recordIntent(goal.goalId);
    },
    /** Admit only an actual hidden retry following recovery intent in this exact session and goal. */
    admit(ctx: ExtensionContext, timestamp: number): boolean {
      const goal = eligible(ctx);
      // Pi stamps at enqueue time, before steer/follow-up queues: old copies cannot authorize a later attempt.
      if (!goal || !active() || cycle!.recovering || !Number.isSafeInteger(timestamp) || timestamp <= cycle!.intentAfter) return false;
      cycle!.recovering = true;
      cycle!.carrierAt = timestamp;
      if (goal.status === "paused") deps.resume(ctx);
      deps.pending(ctx, "External retry is executing in this session.");
      return true;
    },
    finish(ctx: ExtensionContext, message: RetryResult | undefined): void {
      if (!sameSession(ctx) || !active() || !message) return;
      if (message.stopReason === "aborted") { invalidate(); return; }
      if (message.stopReason === "error") return;
      if (message.stopReason === "length" || emptyResult(message)) {
        // A bounded driver may give up here; retain the last failure, not an autonomous goal continuation.
        if (deps.getGoal()?.status === "active" && deps.canRecover()) deps.pause(ctx, `External recovery remains incomplete (${message.stopReason === "length" ? "length limit" : "empty response"})`);
        return;
      }
      if (!cycle!.recovering) return;
      invalidate();
      if (deps.getGoal()?.status === "active" && deps.canRecover()) deps.settled(ctx);
    },
  };
}
