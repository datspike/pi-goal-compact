/**
 * Стенд для дымовых прогонов на настоящем Pi без сети.
 *
 * Pi запускается в режиме RPC с отдельным профилем и офлайн-провайдером. Провайдер по номеру
 * хода отдаёт заранее заданный вызов инструмента или текст, а номер хода пишет в журнал:
 * повторный запрос после перезапуска виден как лишний шаг. Сводку при сжатии пишет само
 * расширение через ту же модель; такой запрос номера хода не тратит.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
export const PROBE_DONE = "PROBE_DONE";

/** Сценарий провайдера: вызов инструмента на ходу, ходы с переполненным окном и последний ход. */
export type ProbeScript = {
  calls: Record<number, [tool: string, args: Record<string, unknown>]>;
  /** Ходы, после которых окно почти заполнено и Pi сжимает его по порогу. */
  heavySteps: number[];
  /** Последний ход отвечает текстом `PROBE_DONE`; ход сверх него — ошибка стенда. */
  lastStep: number;
  /** Промежуточные ходы, где прогон тоже заканчивается текстом `PROBE_DONE`, — точки остановки процесса. */
  stopSteps?: number[];
};

export type Row = {
  type?: string;
  customType?: string;
  content?: unknown;
  data?: { step?: number; kind?: string; goal?: { status?: string } };
  message?: { role?: string; stopReason?: string; toolName?: string; isError?: boolean; content?: unknown };
};

/** Точка входа собранного расширения; стенд по умолчанию загружает только её. */
const EXTENSION = join(repo, "src/index.ts");

function fixtureSource(script: ProbeScript, extensions: readonly string[]): string {
  return `
${extensions.map((path, index) => `import extension${index} from ${JSON.stringify(path)};`).join("\n")}
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync } from "node:fs";
const script = ${JSON.stringify(script)};
const usage = (input) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function reply(message) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
  return stream;
}
export default function(pi) {
  const skip = process.env.PROBE_RELOAD === "1" && !globalThis.__probeLoaded;
  globalThis.__probeLoaded = true;
  pi.registerCommand("probe-reload", { description: "Reload isolated probe", handler: async (_args, ctx) => { await ctx.reload(); } });
  if (!skip) { ${extensions.map((_, index) => `extension${index}(pi);`).join(" ")} }
  let step = 0;
  pi.on("session_start", (_event, ctx) => {
    step = Math.max(0, ...ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "probe-step").map(e => e.data.step));
  });
  pi.registerTool({ name: "ask_user", label: "Fixture question", description: "Return a deterministic UI answer", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "User answered: A" }], details: { mode: "single", cancelled: false, response: { kind: "selection", selections: ["A"] } } }; }
  });
  pi.registerProvider("probe", { api: "probe", baseUrl: "http://127.0.0.1:1", apiKey: "offline", models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 1024 }],
    streamSimple(model, context) {
      const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
      const window = JSON.stringify(context.messages);
      const log = (kind) => appendFileSync(process.env.PROBE_LOG, JSON.stringify({ kind, step, window }) + "\\n");
      // Ход может быть разрезан сжатием, поэтому сводка годится и для истории («Цель»), и для начала хода («Исходный запрос»).
      if (window.includes("context summarization assistant")) {
        log("summary");
        return reply({ ...base, stopReason: "stop", content: [{ type: "text", text: "## Цель\\nДовести проверку до закрытия цели.\\n\\n## Исходный запрос\\nПродолжить проверку." }], usage: usage(100) });
      }
      step++;
      if (step > script.lastStep) throw new Error("Unexpected continuation loop");
      pi.appendEntry("probe-step", { step });
      log("turn");
      const call = script.calls[step];
      const input = script.heavySteps.includes(step) ? 256500 : 100;
      const content = call ? [{ type: "toolCall", id: "probe-" + step, name: call[0], arguments: call[1] }] : [{ type: "text", text: step === script.lastStep || (script.stopSteps ?? []).includes(step) ? "${PROBE_DONE}" : "Шаг выполнен." }];
      return reply({ ...base, stopReason: call ? "toolUse" : "stop", content, usage: usage(input) });
    }
  });
}
`;
}

/** Каталог прогона. `SMOKE_KEEP=1` оставляет профили и журналы в `.runtime/` для разбора. */
/** Запрос к провайдеру: ход стенда или сводка при сжатии, с сообщениями окна в JSON. */
export type ProbeRequest = { kind: "turn" | "summary"; step: number; window: string };

/** Как запустить Pi: с засеянным журналом и с перезагрузкой расширения вместо первой реплики. */
type StartOptions = {
  seed?: string;
  reload?: boolean;
  /** Первая реплика; без засева по умолчанию «Run offline probe.», с засевом — никакой. */
  prompt?: string;
  /** Загружаемые расширения вместо собранного — например, прежняя пара для проверки совместимости. */
  extensions?: readonly string[];
};

export async function withProbe(script: ProbeScript, run: (start: (name: string, options?: StartOptions) => Promise<Row[]>, requests: (name: string) => ProbeRequest[]) => Promise<void>): Promise<void> {
  const keep = process.env.SMOKE_KEEP === "1";
  const root = mkdtempSync(join(keep ? join(repo, ".runtime") : tmpdir(), "goal-compact-smoke-"));
  try {
    const requests = (name: string) => readFileSync(join(root, name, "requests.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as ProbeRequest);
    await run((name, options = {}) => startPi(root, script, name, options), requests);
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

async function startPi(root: string, script: ProbeScript, name: string, { seed, reload = false, prompt, extensions = [EXTENSION] }: StartOptions): Promise<Row[]> {
  const home = join(root, name);
  mkdirSync(home);
  const fixture = join(home, "fixture.ts");
  writeFileSync(fixture, fixtureSource(script, extensions));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ defaultProvider: "probe", defaultModel: "offline", compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 100 }, retry: { enabled: false } }));
  // Pi при запуске уносит старые JSONL из корня профиля, поэтому сессия лежит в подкаталоге.
  mkdirSync(join(home, "probe"));
  const session = join(home, "probe", "session.jsonl");
  if (seed) writeFileSync(session, seed);
  const args = [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-builtin-tools", "--system-prompt", "Offline deterministic probe.", "-e", fixture, "--session", session];
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: home, PI_OFFLINE: "1", PROBE_LOG: join(home, "requests.jsonl"), PROBE_RELOAD: reload ? "1" : "0" };
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
        if (output.includes(`"text":"${PROBE_DONE}"`)) done();
      });
      child.on("error", reject);
      child.on("exit", (code) => reject(new Error(`${name}: Pi завершился с кодом ${code}: ${errors.slice(-1200)}`)));
      const message = reload ? "/probe-reload" : prompt ?? (seed ? undefined : "Run offline probe.");
      if (message) child.stdin?.write(JSON.stringify({ type: "prompt", message }) + "\n");
    });
    return readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
  } finally {
    clearTimeout(timer);
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise((done) => child.once("exit", done));
  }
}

/** Номера ходов провайдера в порядке записи. */
export function probeSteps(rows: Row[]): Array<number | undefined> {
  return rows.filter((row) => row.type === "custom" && row.customType === "probe-step").map((row) => row.data?.step);
}

/** Журнал до первой записи, подходящей под условие, включительно — им засевается сессия для перезапуска. */
export function seedThrough(rows: Row[], match: (row: Row) => boolean): string {
  const index = rows.findIndex(match);
  if (index < 0) throw new Error("В журнале нет записи для засева.");
  return rows.slice(0, index + 1).map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export const AGREEMENT = { owner_wants: "Проверить продолжение без сети.", done_when: "Цель закрыта." };
