import { RECORD } from "../records.js";
import type { GoalAgreement, SelfDecidedItem } from "./agreement.js";

export const CUSTOM_ENTRY_TYPE = RECORD.goal;
export const MAX_OBJECTIVE_CHARS = 8000;

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

export interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface ThreadGoal {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  usage: GoalUsage;
  createdAt: number;
  updatedAt: number;
  /** Durable interruption provenance; absent on legacy goals. */
  pause?: { kind: "manual" | "recovery" | "shutdown"; reason: string };
  /** Canonical provenance for amendments applied by the runtime; absent on legacy goals. */
  appliedAmendments?: readonly string[];
  /** Договорённость последней редакции (Д1); нет у целей прежней пары и созданных с выключенной доработкой. */
  agreement?: GoalAgreement;
  /** Список «Решаю сам» (Д4); отклонённые пункты остаются в нём. */
  selfDecided?: readonly SelfDecidedItem[];
  /** Отпечаток, при котором первая попытка закрытия вернула договорённость (Д3). */
  completionCheck?: string;
}

export type GoalEntrySource = "command" | "tool" | "runtime";

/** Legacy names kept for old session entries and the compatibility writer. */
export const GOAL_ARTIFACT_NAMES = ["GOAL", "CURRENT", "TIMELINE", "DECISIONS", "CONTEXT-MAP", "PAPER-CUTS"] as const;
export type GoalArtifactName = (typeof GOAL_ARTIFACT_NAMES)[number];

/** User-facing artifacts managed by the v3 typed progress lifecycle. */
export const GOAL_MANAGED_ARTIFACT_NAMES = ["GOAL"] as const;
export type GoalManagedArtifactName = (typeof GOAL_MANAGED_ARTIFACT_NAMES)[number];

export interface GoalArtifactRef {
  goalId: string;
  artifact: GoalArtifactName;
  revision: number;
  path: string;
}

export type RuntimeUsageGoalStatus = Extract<GoalStatus, "active" | "budgetLimited">;

export type GoalCustomEntry =
	| {
			version: 1;
			kind: "set";
			source: GoalEntrySource;
			goal: ThreadGoal;
			at: number;
	  }
	| {
			version: 1;
			kind: "usage";
			source: "runtime";
			goalId: string;
			status: RuntimeUsageGoalStatus;
			usage: GoalUsage;
			updatedAt: number;
			at: number;
	  }
	| {
			version: 1;
			kind: "clear";
			source: GoalEntrySource;
			clearedGoalId: string | null;
			at: number;
	  }
	| {
			version: 1;
			kind: "host_overflow_cap_reset";
			active: boolean;
			at: number;
	  }
	| {
			version: 1;
			kind: "artifact";
			goalId: string;
			artifact: GoalArtifactName;
			revision: number;
			at: number;
	  };

export interface GoalResult {
  ok: boolean;
  message: string;
  goal: ThreadGoal | null;
  operation?: "amend_goal" | "update_goal" | "resume_goal";
  /** null means the canonical write was not acknowledged; reconcile before retry. */
  applied?: boolean | null;
  /** `agreement_check` — первая попытка закрытия вернула договорённость для сверки (Д3). */
  stage?: "canonical" | "projection" | "complete" | "agreement_check";
  retryable?: boolean;
  remediation?: string;
  amendmentId?: string;
  eventId?: string;
  reportId?: string;
  projectionEvent?: string;
}

export interface GoalSnapshot {
	goal: ThreadGoal | null;
	hasGoal: boolean;
}

export interface SessionEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}
