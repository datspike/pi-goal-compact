import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RUNTIME_PERSIST_INTERVAL_MS } from "./runtime-config.js";
import { loadedGoalRuntimeRevision } from "./goal-runtime-revision.js";
import {
  clearEntry,
  cloneGoal,
  goalsEquivalent,
  isRuntimeUsageGoalStatus,
  runtimeUsageEntry,
  setEntry,
} from "./state.js";
import { CUSTOM_ENTRY_TYPE, type GoalEntrySource, type ThreadGoal } from "./types.js";

interface GoalPersistenceDeps {
  pi: Pick<ExtensionAPI, "appendEntry">;
  assertExternalWrite?: () => void;
}

function canPersistRuntimeUsageEntry(goal: ThreadGoal, lastPersistedGoal: ThreadGoal | null): boolean {
  return Boolean(
    lastPersistedGoal &&
      goal.goalId === lastPersistedGoal.goalId &&
      goal.objective === lastPersistedGoal.objective &&
      goal.tokenBudget === lastPersistedGoal.tokenBudget &&
      goal.createdAt === lastPersistedGoal.createdAt &&
      isRuntimeUsageGoalStatus(goal.status) &&
      isRuntimeUsageGoalStatus(lastPersistedGoal.status),
  );
}

export interface GoalCanonicalWriteReceipt {
  applied: null;
  stage: "canonical";
  retryable: false;
  goalId: string;
  message: string;
  remediation: string;
  snapshotUpdatedAt?: number;
  eventId?: string;
  projectionEvent?: string;
  reportId?: string;
  noteId?: string;
  kind?: "decision" | "paper_cut";
  operation?: "record_goal_note" | "update_goal_work" | "report_goal_progress";
}

/** SDK append may change memory before failing; its error is not a rollback. */
export class GoalCanonicalWriteError extends Error {
  constructor(readonly details: GoalCanonicalWriteReceipt) { super(JSON.stringify(details)); }
}

export function createGoalPersistence(deps: GoalPersistenceDeps) {
  let goal: ThreadGoal | null = null;
  let lastPersistedGoal: ThreadGoal | null = null;
  let lastRuntimePersistAt: number | null = null;
  let unconfirmedWrite: GoalCanonicalWriteError | null = null;
  const assertWritable = (): void => {
    if (unconfirmedWrite) throw unconfirmedWrite;
    deps.assertExternalWrite?.();
  };

  const getGoal = (): ThreadGoal | null => (goal ? cloneGoal(goal) : null);

  const setGoalSnapshot = (nextGoal: ThreadGoal | null): void => {
    goal = nextGoal ? cloneGoal(nextGoal) : null;
  };

  const syncPersistedSnapshot = (snapshot: ThreadGoal | null): void => {
    lastPersistedGoal = snapshot ? cloneGoal(snapshot) : null;
    lastRuntimePersistAt = null;
    unconfirmedWrite = null;
  };

  const flushGoalPersistence = (source: GoalEntrySource): boolean => {
    assertWritable();
    if (!goal) {
      return false;
    }
    if (lastPersistedGoal && goalsEquivalent(goal, lastPersistedGoal)) {
      return false;
    }

    const entry = source === "runtime" && canPersistRuntimeUsageEntry(goal, lastPersistedGoal)
      ? runtimeUsageEntry(goal)
      : setEntry(goal, source);
    try {
      deps.pi.appendEntry(
        CUSTOM_ENTRY_TYPE,
        lastPersistedGoal?.goalId !== goal.goalId
          ? { ...entry, extensionRevision: loadedGoalRuntimeRevision }
          : entry,
      );
    } catch (error) {
      unconfirmedWrite = new GoalCanonicalWriteError({
        applied: null, stage: "canonical", retryable: false, goalId: goal.goalId, snapshotUpdatedAt: goal.updatedAt,
        message: `Goal snapshot write acknowledgement is unknown: ${error instanceof Error ? error.message : String(error)}`,
        remediation: "Reopen the saved session file and selected branch, then reconcile this goalId, contract, amendment ID and status before another write. SDK memory, get_goal in this process and extension reload do not prove persistence. If saved, repair projections without repeating the change; repeat an approved operation only after confirming its absence in the file.",
      });
      throw unconfirmedWrite;
    }
    lastPersistedGoal = cloneGoal(goal);
    lastRuntimePersistAt = Date.now();
    return true;
  };

  const maybeFlushRuntimePersistence = (source: GoalEntrySource): void => {
    if (!goal || goal.status !== "active") {
      return;
    }
    const now = Date.now();
    if (lastRuntimePersistAt !== null && now - lastRuntimePersistAt < RUNTIME_PERSIST_INTERVAL_MS) {
      return;
    }
    flushGoalPersistence(source);
  };

  const clearGoalSnapshot = (): void => {
    goal = null;
    lastPersistedGoal = null;
    lastRuntimePersistAt = null;
  };

  const appendClearEntry = (clearedGoalId: string | null, source: GoalEntrySource): void => {
    clearGoalSnapshot();
    deps.pi.appendEntry(CUSTOM_ENTRY_TYPE, clearEntry(clearedGoalId, source));
  };

  return {
    assertWritable,
    getUnconfirmedWrite: () => unconfirmedWrite,
    appendClearEntry,
    flushGoalPersistence,
    getGoal,
    maybeFlushRuntimePersistence,
    setGoalSnapshot,
    syncPersistedSnapshot,
  };
}

