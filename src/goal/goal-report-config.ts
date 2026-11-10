import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface GoalReportPolicy {
  afterActiveSeconds: number;
  afterAssistantTurns: number;
  /** Сколько скрытых продолжений подряд без сообщения пользователя допустимо; 0 — без предела. */
  maxHiddenContinuations?: number;
}

export const DEFAULT_GOAL_REPORT_POLICY: Readonly<GoalReportPolicy> = Object.freeze({
  afterActiveSeconds: 500,
  afterAssistantTurns: 30,
});

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

type GoalReportPolicyFile = Partial<GoalReportPolicy>;

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
  return {
    policy: {
      ...DEFAULT_GOAL_REPORT_POLICY,
      ...user,
      ...project,
    },
    warnings,
    paths,
  };
}
