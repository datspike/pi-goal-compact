import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Выключатели доработок Д2–Д8. Выключенная доработка возвращает поведение прежней пары
 * расширений: так можно сравнить сборки и откатить одну доработку, не трогая остальные.
 */
export interface GoalFeatures {
  /** Д2: договорённость стоит в начале окна сразу после сводки сжатия. */
  agreementInWindow: boolean;
  /** Д3: первая попытка закрытия возвращает договорённость. */
  completionReturn: boolean;
  /** Д4: `create_goal` требует список «Решаю сам», состояние пункта меняет только владелец. */
  selfDecidedList: boolean;
  /** Д5: правило задавать вопросы до цели в описании `create_goal`. */
  askBeforeGoal: boolean;
  /** Д6: у факта один хозяин — сводка без раздела «Цель», продолжение без пересказа цели. */
  singleFactOwner: boolean;
  /** Д7: без цели после сводки стоят последние реплики владельца дословно. */
  ownerRepliesWithoutGoal: boolean;
  /** Д8: правка цели принимается только после настоящей реплики владельца. */
  amendNeedsOwner: boolean;
}

export const GOAL_FEATURE_NAMES = ["agreementInWindow", "completionReturn", "selfDecidedList", "askBeforeGoal", "singleFactOwner", "ownerRepliesWithoutGoal", "amendNeedsOwner"] as const satisfies readonly (keyof GoalFeatures)[];

export const DEFAULT_GOAL_FEATURES: Readonly<GoalFeatures> = Object.freeze({
  agreementInWindow: true,
  completionReturn: true,
  selfDecidedList: true,
  askBeforeGoal: true,
  singleFactOwner: true,
  ownerRepliesWithoutGoal: true,
  amendNeedsOwner: true,
});

export interface GoalReportPolicy {
  afterActiveSeconds: number;
  afterAssistantTurns: number;
  /** Сколько скрытых продолжений подряд без сообщения пользователя допустимо; 0 — без предела. */
  maxHiddenContinuations?: number;
  /** Отсутствует у старых состояний — тогда действуют значения по умолчанию. */
  features?: GoalFeatures;
}

export const DEFAULT_GOAL_REPORT_POLICY: Readonly<GoalReportPolicy> = Object.freeze({
  afterActiveSeconds: 500,
  afterAssistantTurns: 30,
});

/** Действующие выключатели политики. */
export function goalFeatures(policy: Pick<GoalReportPolicy, "features">): GoalFeatures {
  return policy.features ?? DEFAULT_GOAL_FEATURES;
}

export interface GoalReportPolicyLoadOptions {
  cwd?: string;
  agentDir?: string;
}

export interface GoalReportPolicyLoadResult {
  policy: GoalReportPolicy;
  warnings: string[];
  paths: {
    user: string;
    project: string;
  };
}

type GoalReportPolicyFile = Partial<Omit<GoalReportPolicy, "features">> & { features?: Partial<GoalFeatures> };

const CONFIG_FILE_NAME = "goal-reports.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parsePolicyFile(value: unknown, path: string, warnings: string[]): GoalReportPolicyFile {
  if (!isRecord(value)) {
    warnings.push(`${path} must contain a JSON object.`);
    return {};
  }
  const policy: GoalReportPolicyFile = {};
  for (const key of ["afterActiveSeconds", "afterAssistantTurns"] as const) {
    if (value[key] === undefined) continue;
    if (isPositiveSafeInteger(value[key])) {
      policy[key] = value[key];
    } else {
      warnings.push(`${path}.${key} must be a positive safe integer; the value was ignored.`);
    }
  }
  if (value.maxHiddenContinuations !== undefined) {
    const limit = value.maxHiddenContinuations;
    if (typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0) {
      policy.maxHiddenContinuations = limit;
    } else {
      warnings.push(`${path}.maxHiddenContinuations must be a non-negative safe integer; the value was ignored.`);
    }
  }
  if (value.features !== undefined) {
    if (!isRecord(value.features)) {
      warnings.push(`${path}.features must be an object of booleans; the value was ignored.`);
    } else {
      const features: Partial<GoalFeatures> = {};
      for (const [key, flag] of Object.entries(value.features)) {
        if (!(GOAL_FEATURE_NAMES as readonly string[]).includes(key)) warnings.push(`${path}.features.${key} is unknown; the value was ignored.`);
        else if (typeof flag !== "boolean") warnings.push(`${path}.features.${key} must be a boolean; the value was ignored.`);
        else features[key as keyof GoalFeatures] = flag;
      }
      policy.features = features;
    }
  }
  return policy;
}

async function readPolicyFile(path: string, warnings: string[]): Promise<GoalReportPolicyFile> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    warnings.push(`${path} could not be read; defaults or lower-precedence values will be used.`);
    return {};
  }
  try {
    return parsePolicyFile(JSON.parse(content) as unknown, path, warnings);
  } catch {
    warnings.push(`${path} is not valid JSON; defaults or lower-precedence values will be used.`);
    return {};
  }
}

export async function loadGoalReportPolicy(options: GoalReportPolicyLoadOptions = {}): Promise<GoalReportPolicyLoadResult> {
  const agentDir = options.agentDir ?? getAgentDir();
  const cwd = options.cwd ?? process.cwd();
  const paths = {
    user: join(agentDir, CONFIG_FILE_NAME),
    project: join(cwd, ".pi", CONFIG_FILE_NAME),
  };
  const warnings: string[] = [];
  const user = await readPolicyFile(paths.user, warnings);
  const project = await readPolicyFile(paths.project, warnings);
  const { features: userFeatures, ...userPolicy } = user;
  const { features: projectFeatures, ...projectPolicy } = project;
  return {
    policy: {
      ...DEFAULT_GOAL_REPORT_POLICY,
      ...userPolicy,
      ...projectPolicy,
      // Выключатели сливаются по одному: проектный файл меняет только названные в нём.
      ...(userFeatures || projectFeatures ? { features: { ...DEFAULT_GOAL_FEATURES, ...userFeatures, ...projectFeatures } } : {}),
    },
    warnings,
    paths,
  };
}
