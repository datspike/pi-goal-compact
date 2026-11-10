import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initialState, type CoreEffect, type CoreEvent, type CoreState } from "../core/model.js";
import { step } from "../core/step.js";

export type EffectExecutor = (effect: CoreEffect, ctx: ExtensionContext) => void;

/**
 * Держит состояние ядра и исполняет его действия.
 * Решений не принимает: только передаёт событие в step и действия — исполнителю.
 */
export class CoreDriver {
  private current: CoreState = initialState;
  private executor: EffectExecutor = () => {};

  get state(): CoreState {
    return this.current;
  }

  bind(executor: EffectExecutor): void {
    this.executor = executor;
  }

  dispatch(event: CoreEvent, ctx: ExtensionContext): readonly CoreEffect[] {
    const { state, effects } = step(this.current, event);
    this.current = state;
    for (const effect of effects) this.executor(effect, ctx);
    return effects;
  }
}
