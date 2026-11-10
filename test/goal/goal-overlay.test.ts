import assert from "node:assert/strict";
import test from "node:test";

import { createGoalRuntimeStatus } from "../../src/goal/goal-runtime-status.js";
import { createThreadGoal } from "../../src/goal/state.js";
import { createGoalReportState } from "../../src/goal/goal-reports.js";

test("goal status integration does not mount a TUI widget or overlay host", () => {
  const goal = createThreadGoal("Проверить отсутствие overlay");
  const status = createGoalRuntimeStatus({
    getGoalForDisplay: () => goal,
    getGoalStatus: () => goal.status,
    getRecoveryAttention: () => null,
    isProviderLimitAutoResumeScheduled: () => false,
    getReportState: createGoalReportState,
    setActivity: () => undefined,
  });

  status.refreshUi({
    mode: "tui",
    ui: {
      setStatus() {},
    },
  });

  status.stopStatusRefresh(true);
});
