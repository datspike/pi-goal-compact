import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProviderRetryConfig {
  enabled: boolean;
  windowMs: number;
  allowSwitch: boolean;
}

const defaults: ProviderRetryConfig = { enabled: false, windowMs: 15 * 60_000, allowSwitch: true };

/** Читает явное включение новой политики, отдельно от штатных настроек retry Pi. */
export function loadProviderRetryConfig(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): ProviderRetryConfig {
  let text: string;
  try { text = readFileSync(join(agentDir, "settings.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  const config: unknown = JSON.parse(text)?.piGoalCompact?.providerRetry;
  if (config === undefined) return { ...defaults };
  if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("piGoalCompact.providerRetry: ожидается объект");
  const { enabled = defaults.enabled, windowMs = defaults.windowMs, allowSwitch = defaults.allowSwitch } = config as Partial<ProviderRetryConfig>;
  if (typeof enabled !== "boolean" || typeof allowSwitch !== "boolean") throw new Error("piGoalCompact.providerRetry: enabled и allowSwitch должны быть true или false");
  if (!Number.isSafeInteger(windowMs) || windowMs < 0 || windowMs > 2_147_483_647) throw new Error("piGoalCompact.providerRetry.windowMs: ожидается конечный срок в миллисекундах (0–2147483647)");
  return { enabled, windowMs, allowSwitch };
}
