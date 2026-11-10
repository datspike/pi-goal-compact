/**
 * Дымовой прогон Б1 на настоящем Pi без сети: ответ `ask_user` переживает сжатие, перезапуск
 * процесса и перезагрузку расширения; затем один отчёт `working`, одно продолжение и закрытие.
 *
 * Pi запускается в режиме RPC с отдельным профилем и офлайн-провайдером, который по номеру хода
 * отдаёт заранее заданный вызов инструмента. Номер хода пишется в журнал, поэтому повторный
 * запрос к провайдеру после перезапуска виден как лишний шаг.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const DONE = "QUESTION_PROBE_DONE";
const LAST_STEP = 9;

function fixtureSource(): string {
  return `
import extension from ${JSON.stringify(join(repo, "src/index.ts"))};
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  const skip = process.env.PROBE_RELOAD === "1" && !globalThis.__questionProbeLoaded;
  globalThis.__questionProbeLoaded = true;
  pi.registerCommand("question-probe-reload", { description: "Reload isolated probe", handler: async (_args, ctx) => { await ctx.reload(); } });
  if (!skip) extension(pi);
  let step = 0;
  pi.on("session_start", (_event, ctx) => {
    step = Math.max(0, ...ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "question-probe-step").map(e => e.data.step));
  });
  pi.registerTool({ name: "ask_user", label: "Fixture question", description: "Return a deterministic UI answer", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "User answered: A" }], details: { mode: "single", cancelled: false, response: { kind: "selection", selections: ["A"] } } }; }
  });
  pi.registerProvider("question-probe", { api: "question-probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1024 }],
    streamSimple(model, context) {
      // Сводку при сжатии пишет само расширение через ту же модель; такой запрос не тратит ход стенда.
      // Ход разрезан сжатием, поэтому ответ годится и для истории («Цель»), и для начала хода («Исходный запрос»).
      if (JSON.stringify(context.messages).includes("context summarization assistant")) {
        const summary = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "## Цель\\nЦель ждёт обработки подтверждённого ответа A. Опубликуй working и заверши проверку.\\n\\n## Исходный запрос\\nОбработать ответ A." }], usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const summaryStream = createAssistantMessageEventStream();
        queueMicrotask(() => { summaryStream.push({ type: "start", partial: summary }); summaryStream.push({ type: "done", reason: "stop", message: summary }); summaryStream.end(); });
        return summaryStream;
      }
      step++;
      if (step > ${LAST_STEP}) throw new Error("Unexpected continuation loop");
      pi.appendEntry("question-probe-step", { step });
      const calls = {
        1: ["create_goal", { objective: "Проверить автоматическое продолжение после ответа пользователя без сети.", agreement: { owner_wants: "Проверить продолжение после ответа.", done_when: "Ответ обработан, цель закрыта." }, self_decided: [] }],
        2: ["report_goal_progress", { action: "publish", status: "awaiting_user", phase: "Выбор", summary: "Нужен выбор пользователя.", needUser: "Выберите A.", nextStep: "Обработать ответ." }],
        3: ["ask_user", {}],
        4: ["report_goal_progress", { action: "publish", status: "working", phase: "Продолжение", summary: "Ответ A получен.", changed: "Ответ A обработан.", nextStep: "Завершить проверку." }],
        6: ["report_goal_progress", { action: "publish", status: "verifying", phase: "Проверка", summary: "Проверяю итог.", verification: "Ответ обработан, продолжение выполнено один раз.", nextStep: "Завершить цель." }],
        7: ["update_goal", { status: "complete" }],
        8: ["update_goal", { status: "complete" }],
      };
      const call = calls[step];
      const input = step === 3 ? 256500 : 100;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: call ? "toolUse" : "stop", content: call ? [{ type: "toolCall", id: "probe-" + step, name: call[0], arguments: call[1] }] : [{ type: "text", text: step === ${LAST_STEP} ? "${DONE}" : "Ответ обработан." }], usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    }
  });
}
`;
}

type Row = { type?: string; customType?: string; data?: { step?: number; kind?: string; goal?: { status?: string } }; message?: { role?: string; stopReason?: string; toolName?: string; isError?: boolean; content?: unknown } };

async function run(root: string, fixture: string, name: string, seed?: string, reload = false): Promise<Row[]> {
  const home = join(root, name);
  mkdirSync(home);
  writeFileSync(join(home, "settings.json"), JSON.stringify({ defaultProvider: "question-probe", defaultModel: "offline", compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 }, retry: { enabled: false } }));
  // Pi при запуске уносит старые JSONL из корня профиля, поэтому сессия лежит в подкаталоге.
  mkdirSync(join(home, "probe"));
  const session = join(home, "probe", "session.jsonl");
  if (seed) writeFileSync(session, seed);
  const args = [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-builtin-tools", "--system-prompt", "Offline deterministic probe.", "-e", fixture, "--session", session];
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PROBE_RELOAD: reload ? "1" : "0" };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  const child: ChildProcess = spawn(process.execPath, args, { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    await new Promise<void>((done, reject) => {
      timer = setTimeout(() => reject(new Error(`${name}: нет ответа за 20 с: ${errors.slice(-1200)} ${output.slice(-1500)}`)), 20_000);
      child.stderr?.on("data", (data) => { errors += String(data); });
      child.stdout?.on("data", (data) => {
        output += String(data);
        if (output.includes(`"text":"${DONE}"`)) done();
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`${name}: Pi завершился с кодом ${code}: ${errors.slice(-1200)}`)));
      if (!seed || reload) child.stdin?.write(JSON.stringify({ type: "prompt", message: reload ? "/question-probe-reload" : "Run offline probe." }) + "\n");
    });
    return readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((done) => child.once("exit", done));
  }
}

function assertCompleted(rows: Row[], name: string): void {
  const steps = rows.filter((row) => row.type === "custom" && row.customType === "question-probe-step").map((row) => row.data?.step);
  assert.deepEqual(steps, Array.from({ length: LAST_STEP }, (_, index) => index + 1), `${name}: каждый ход провайдера ровно один раз`);
  // Ответ на вопрос — квитанция `user_input`, а не подтверждённое решение: `user_decision` пишет только
  // `resume_goal` с подтверждением (так же в `pi-codex-goal` с коммита 2a38b19).
  assert.ok(rows.some((row) => row.customType === "goal-compact-progress" && row.data?.kind === "user_input"), `${name}: ответ пользователя записан`);
  const results = rows.filter((row) => row.message?.role === "toolResult").map((row) => ({ tool: row.message?.toolName, error: row.message?.isError, text: row.message?.content }));
  assert.ok(rows.some((row) => row.customType === "goal-compact-goal" && row.data?.goal?.status === "complete"), `${name}: цель закрыта ${JSON.stringify(results).slice(-3000)}`);
  assert.equal(rows.filter((row) => row.message?.role === "assistant" && ["error", "aborted"].includes(row.message.stopReason ?? "")).length, 0, `${name}: без ошибок и обрывов`);
  assert.equal(rows.filter((row) => row.type === "compaction").length, 1, `${name}: ровно одно сжатие`);
}

test("Б1: ответ на вопрос переживает сжатие, перезапуск и перезагрузку на настоящем Pi", { timeout: 90_000 }, async () => {
  // SMOKE_KEEP=1 оставляет профили и журналы прогона в `.runtime/` для разбора.
  const keep = process.env.SMOKE_KEEP === "1";
  const root = mkdtempSync(join(keep ? join(repo, ".runtime") : tmpdir(), "goal-compact-question-smoke-"));
  try {
    const fixture = join(root, "fixture.ts");
    writeFileSync(fixture, fixtureSource());
    const fresh = await run(root, fixture, "fresh");
    assertCompleted(fresh, "fresh");
    const compactIndex = fresh.findIndex((row) => row.type === "compaction");
    const seed = fresh.slice(0, compactIndex + 1).map((row) => JSON.stringify(row)).join("\n") + "\n";
    assertCompleted(await run(root, fixture, "restart", seed), "restart");
    assertCompleted(await run(root, fixture, "reload", seed, true), "reload");
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
});
