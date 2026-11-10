import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_GOAL_FEATURES, DEFAULT_GOAL_REPORT_POLICY, goalFeatures, loadGoalReportPolicy } from "../../src/goal/goal-report-config.js";

async function withConfigDirs(run: (dirs: { agentDir: string; cwd: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-codex-goal-report-config-"));
  const dirs = { agentDir: join(root, "agent"), cwd: join(root, "project") };
  await mkdir(dirs.agentDir, { recursive: true });
  await mkdir(dirs.cwd, { recursive: true });
  try {
    await run(dirs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("report policy uses defaults when both config files are absent", async () => {
  await withConfigDirs(async (dirs) => {
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(result.policy, DEFAULT_GOAL_REPORT_POLICY);
    assert.deepEqual(result.warnings, []);
  });
});

test("project report policy overrides the user policy field by field", async () => {
  await withConfigDirs(async (dirs) => {
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ afterActiveSeconds: 700, afterAssistantTurns: 40 }));
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(join(dirs.cwd, ".pi", "goal-reports.json"), JSON.stringify({ afterAssistantTurns: 12 }));
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(result.policy, { afterActiveSeconds: 700, afterAssistantTurns: 12 });
    assert.deepEqual(result.warnings, []);
  });
});

test("invalid project values do not erase valid lower-precedence policy", async () => {
  await withConfigDirs(async (dirs) => {
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ afterActiveSeconds: 700, afterAssistantTurns: 40 }));
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(join(dirs.cwd, ".pi", "goal-reports.json"), JSON.stringify({ afterActiveSeconds: 0, afterAssistantTurns: "fast" }));
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(result.policy, { afterActiveSeconds: 700, afterAssistantTurns: 40 });
    assert.equal(result.warnings.length, 2);
  });
});

test("invalid JSON falls back without throwing", async () => {
  await withConfigDirs(async (dirs) => {
    await writeFile(join(dirs.agentDir, "goal-reports.json"), "{broken");
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(result.policy, DEFAULT_GOAL_REPORT_POLICY);
    assert.equal(result.warnings.length, 1);
  });
});

test("default user policy path follows the host agent-dir resolver", async () => {
  await withConfigDirs(async (dirs) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
    try {
      await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ afterActiveSeconds: 800 }));
      const result = await loadGoalReportPolicy({ cwd: dirs.cwd });
      assert.equal(result.policy.afterActiveSeconds, 800);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

test("maxHiddenContinuations accepts zero and rejects negative or fractional values", async () => {
  await withConfigDirs(async (dirs) => {
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ maxHiddenContinuations: 5 }));
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(join(dirs.cwd, ".pi", "goal-reports.json"), JSON.stringify({ maxHiddenContinuations: -1 }));
    const result = await loadGoalReportPolicy(dirs);
    assert.equal(result.policy.maxHiddenContinuations, 5);
    assert.match(result.warnings.join("\n"), /maxHiddenContinuations must be a non-negative safe integer/);
    await writeFile(join(dirs.cwd, ".pi", "goal-reports.json"), JSON.stringify({ maxHiddenContinuations: 0 }));
    assert.equal((await loadGoalReportPolicy(dirs)).policy.maxHiddenContinuations, 0);
  });
});

test("выключатели доработок по умолчанию включены, а файлы меняют их по одному", async () => {
  await withConfigDirs(async (dirs) => {
    assert.deepEqual(goalFeatures((await loadGoalReportPolicy(dirs)).policy), DEFAULT_GOAL_FEATURES);
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ features: { completionReturn: false, amendNeedsOwner: false } }));
    await mkdir(join(dirs.cwd, ".pi"), { recursive: true });
    await writeFile(join(dirs.cwd, ".pi", "goal-reports.json"), JSON.stringify({ features: { amendNeedsOwner: true } }));
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(goalFeatures(result.policy), { ...DEFAULT_GOAL_FEATURES, completionReturn: false });
    assert.deepEqual(result.warnings, []);
  });
});

test("неизвестный или не булев выключатель даёт предупреждение и не меняет остальные", async () => {
  await withConfigDirs(async (dirs) => {
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ features: { agreementInWindow: "no", ghost: false, singleFactOwner: false } }));
    const result = await loadGoalReportPolicy(dirs);
    assert.deepEqual(goalFeatures(result.policy), { ...DEFAULT_GOAL_FEATURES, singleFactOwner: false });
    assert.equal(result.warnings.length, 2);
    await writeFile(join(dirs.agentDir, "goal-reports.json"), JSON.stringify({ features: [true] }));
    const broken = await loadGoalReportPolicy(dirs);
    assert.deepEqual(goalFeatures(broken.policy), DEFAULT_GOAL_FEATURES);
    assert.match(broken.warnings[0] ?? "", /features must be an object/);
  });
});
