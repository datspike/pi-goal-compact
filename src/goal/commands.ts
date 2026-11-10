import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { updateGoalStatus } from "./state.js";
import type { GoalEntrySource, GoalResult, ThreadGoal } from "./types.js";
import { say } from "../language.js";

export interface CommandHost {
  getGoal(): ThreadGoal | null;
  setGoal(goal: ThreadGoal, source: GoalEntrySource, ctx: GoalCommandContext): void;
  waitForGoalProjection?: () => Promise<void>;
  clearGoal(source: GoalEntrySource, ctx: GoalCommandContext): void;
  showGoalSnapshot?: (ctx: GoalCommandContext, mode: "status" | "details") => void;
  /** @deprecated Presentation compatibility only; does not open a widget. */
  toggleGoalWidget?: (ctx: GoalCommandContext) => void;
  getGoalResumeFailure(): GoalResult | null;
  getGoalResumeEpoch(): number;
  invalidateResumeInstructions(): void;
  cancelProviderLimitAutoResume(goalId: string, ctx: GoalCommandContext): void;
}

export type GoalCommandPi = Pick<ExtensionAPI, "registerCommand">;

export type GoalCommandContext = ExtensionCommandContext;

/** Resumes a paused goal without queueing a follow-up prompt. */
export function handleSilentGoalResume(host: CommandHost, ctx: GoalCommandContext): void {
  const current = host.getGoal();
  const result = updateGoalStatus(current, "active");
  if (!result.ok || !result.goal) {
    ctx.ui.notify(result.message, "warning");
    return;
  }
  const blocked = host.getGoalResumeFailure();
  if (blocked) {
    ctx.ui.notify(blocked.message, "warning");
    return;
  }
  host.cancelProviderLimitAutoResume(result.goal.goalId, ctx);
  host.setGoal(result.goal, "command", ctx);
  ctx.ui.notify(result.message);
}

/** Registers lifecycle and read-only observability controls; creation belongs to model tools. */
export function registerGoalCommand(pi: GoalCommandPi, host: CommandHost): void {
  pi.registerCommand("gs", {
    description: say("Показать краткий статус текущей цели.", "Show the compact current goal status."),
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify(say("Использование: /gs", "Usage: /gs"), "warning");
        return;
      }
      host.showGoalSnapshot?.(ctx, "status");
    },
  });
  pi.registerCommand("gp", {
    description: say("Поставить активную цель на паузу.", "Pause the active goal."),
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify(say("Использование: /gp", "Usage: /gp"), "warning");
        return;
      }
      host.invalidateResumeInstructions();
      const result = updateGoalStatus(host.getGoal(), "paused");
      if (!result.ok || !result.goal) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      host.setGoal(result.goal, "command", ctx);
      await host.waitForGoalProjection?.();
      ctx.ui.notify(result.message);
    },
  });
  pi.registerCommand("gr", {
    description: say("Возобновить цель с паузы без нового запроса к модели.", "Resume a paused goal without a follow-up prompt."),
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify(say("Использование: /gr", "Usage: /gr"), "warning");
        return;
      }
      const epoch = host.getGoalResumeEpoch();
      await host.waitForGoalProjection?.();
      if (host.getGoalResumeEpoch() !== epoch) {
        ctx.ui.notify(say("Команда возобновления устарела: был новый ввод, остановка или смена сессии либо цели.", "Resume command is stale after a new input, stop, or session/goal replacement."), "warning");
        return;
      }
      handleSilentGoalResume(host, ctx);
      await host.waitForGoalProjection?.();
    },
  });
  pi.registerCommand("gc", {
    description: say("Очистить текущую цель.", "Clear the current goal."),
    async handler(args, ctx) {
      // The former /gc accepted a continuation comment; never treat that input as clear.
      if (args.trim()) {
        ctx.ui.notify(say("Использование: /gc (очищает цель; комментарий не принимается)", "Usage: /gc (clears the goal; comments are not accepted)"), "warning");
        return;
      }
      if (!host.getGoal()) {
        ctx.ui.notify(say("Цель не задана.", "No goal is set."), "warning");
        return;
      }
      host.clearGoal("command", ctx);
      ctx.ui.notify(say("Цель очищена.", "Goal cleared."));
    },
  });
  pi.registerCommand("gw", {
    description: say("Показать краткий обзор работы и ссылку на документ цели.", "Show the short work overview and goal document link."),
    async handler(args, ctx) {
      if (args.trim()) {
        ctx.ui.notify(say("Использование: /gw", "Usage: /gw"), "warning");
        return;
      }
      host.showGoalSnapshot?.(ctx, "details");
    },
  });
}
