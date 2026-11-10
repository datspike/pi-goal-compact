/**
 * Проверка моделей TLA+ одной командой.
 *
 * Исправная модель обязана пройти, а каждая намеренная поломка — нарушить
 * своё свойство. Свойство, которое ни разу не падало, ничего не доказывает,
 * поэтому поломки входят в проверку наравне с исправной моделью.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORMAL = join(ROOT, "formal");
const CACHE = join(FORMAL, ".cache");
const JAR = join(CACHE, "tla2tools.jar");
const JAR_URL = "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar";
/** Контрольная сумма из описания релиза v1.8.0 на GitHub. */
const JAR_SHA256 = "e1f11b75c4b5bc4478ba0ac5cb6ae28e40a01b0016bc33e0aa97da22dfdbcd7f";

interface Run {
  model: "Continuation" | "Agreement";
  bug: string;
  /** Имя нарушенного свойства или null для исправной модели. */
  expect: string | null;
  meaning: string;
}

export const RUNS: readonly Run[] = [
  { model: "Continuation", bug: "none", expect: null, meaning: "исправная модель продолжения" },
  { model: "Continuation", bug: "noDedupe", expect: "P1_OneContinuation", meaning: "билет кладётся, хотя свежий уже есть" },
  { model: "Continuation", bug: "noHoldCheck", expect: "P2_HoldHolds", meaning: "ожидание владельца не останавливает продолжение" },
  { model: "Continuation", bug: "completeRuns", expect: "P3_NoRevival", meaning: "закрытая цель считается рабочей" },
  { model: "Continuation", bug: "noWriteGuard", expect: "P4_NoUnknownWrite", meaning: "неизвестный исход записи не останавливает работу" },
  { model: "Continuation", bug: "noFreshGuard", expect: "P5_NoStaleTicket", meaning: "билет не сверяется с эпохой" },
  { model: "Continuation", bug: "noNotice", expect: "P6_NoSilentStall", meaning: "остановка из-за записи не объясняется владельцу" },
  { model: "Continuation", bug: "noGoalCheckOnTicket", expect: "P2_HoldHolds", meaning: "билет после сжатия не сверяется с состоянием цели" },
  { model: "Agreement", bug: "none", expect: null, meaning: "исправная модель договорённости" },
  { model: "Agreement", bug: "noStrip", expect: "P7_OneCurrentAgreement", meaning: "раздел «Цель» сводки не заменяется" },
  { model: "Agreement", bug: "staleCache", expect: "P7_OneCurrentAgreement", meaning: "сборщик окна держит старую редакцию" },
  { model: "Agreement", bug: "ignoreRevisions", expect: "P8_NoStaleClose", meaning: "возврат договорённости не привязан к версиям" },
  { model: "Agreement", bug: "noVerifying", expect: "P8_NoStaleClose", meaning: "закрытие без отчёта verifying" },
  { model: "Agreement", bug: "noOwnerCheck", expect: "P9_OwnerOnlyEdits", meaning: "договорённость правится в автономном прогоне" },
];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function ensureJar(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(JAR)) {
    const response = await fetch(JAR_URL);
    if (!response.ok) throw new Error(`TLC не скачан: ${response.status} ${JAR_URL}`);
    writeFileSync(JAR, Buffer.from(await response.arrayBuffer()));
  }
  const actual = sha256(JAR);
  if (actual !== JAR_SHA256) throw new Error(`Контрольная сумма ${JAR} не совпала: ${actual}`);
}

interface Outcome {
  violated: string | null;
  steps: string[];
  states: string | null;
  error: string | null;
}

/** Разбирает вывод TLC: нарушенное свойство и цепочку действий контрпримера. */
export function parseTlcOutput(output: string): Outcome {
  const violated = output.match(/Invariant (\w+) is violated/)?.[1] ?? null;
  const steps = [...output.matchAll(/^State \d+: <(\w+)/gm)].map((match) => match[1] ?? "").filter((name) => name !== "Initial");
  const states = output.match(/(\d+) distinct states found/)?.[1] ?? null;
  const clean = /No error has been found/.test(output);
  const error = violated === null && !clean ? (output.split("\n").find((line) => /error/i.test(line)) ?? "TLC завершился без итога") : null;
  return { violated, steps, states, error };
}

function check(run: Run): Outcome {
  const config = readFileSync(join(FORMAL, `${run.model}.cfg`), "utf8").replace(/Bug = "none"/, `Bug = "${run.bug}"`);
  const configPath = join(CACHE, `${run.model}-${run.bug}.cfg`);
  writeFileSync(configPath, config);
  const result = spawnSync("java", [
    "-XX:+UseParallelGC", "-jar", JAR, "-noGenerateSpecTE", "-workers", "auto",
    "-metadir", join(CACHE, "states", `${run.model}-${run.bug}`),
    "-config", configPath, join(FORMAL, `${run.model}.tla`),
  ], { encoding: "utf8", cwd: ROOT });
  if (result.error) throw new Error(`java не запустилась: ${result.error.message}`);
  return parseTlcOutput(`${result.stdout}\n${result.stderr}`);
}

async function main(): Promise<void> {
  await ensureJar();
  let failed = 0;
  for (const run of RUNS) {
    const outcome = check(run);
    const ok = outcome.error === null && outcome.violated === run.expect;
    if (!ok) failed++;
    const verdict = run.expect === null
      ? `${outcome.states ?? "?"} состояний, нарушений нет`
      : `${outcome.violated ?? "нарушения нет"}: ${outcome.steps.join(" → ")}`;
    console.log(`${ok ? "ok  " : "FAIL"} ${run.model}/${run.bug} — ${run.meaning}; ${outcome.error ?? verdict}`);
  }
  if (failed > 0) {
    console.error(`Проверка моделей не прошла: ${failed} из ${RUNS.length}.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
