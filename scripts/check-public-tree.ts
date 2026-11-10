/**
 * Проверка приватных границ: в Git и в npm-пакет не должны попасть локальные слои,
 * состояние сессий, личные пути и секреты.
 *
 * Запуск: npm run check:public. Проверяются отслеживаемые файлы и новые файлы,
 * которые Git не игнорирует, то есть всё, что может войти в следующий коммит.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Violation {
  readonly file: string;
  readonly reason: string;
}

const PRIVATE_LAYERS = [".task_files/", ".runtime/", ".pi/", "sessions/"];
const PRIVATE_NAMES = new Set(["AGENTS.local.md", "auth.json", "models.json", "mcp.json", "settings.json"]);
const PRIVATE_SUFFIXES = [".jsonl", ".sqlite", ".db"];

const CONTENT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/home\/[A-Za-z0-9_-]+/, "личный путь в домашнем каталоге"],
  [/\/Users\/[A-Za-z0-9_-]+/, "личный путь в домашнем каталоге"],
  [/file:\/\/\//, "локальная ссылка file://"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "закрытый ключ"],
  [/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["'][^"'\s]{16,}["']/i, "похоже на секрет"],
];

/** Локальный список личных слов: имена, названия хранилищ. В Git не попадает. */
const LOCAL_MARKERS_FILE = ".task_files/private-markers.txt";

function listCandidateFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

function readLocalMarkers(root: string): string[] {
  const path = join(root, LOCAL_MARKERS_FILE);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function pathViolation(file: string): string | undefined {
  const layer = PRIVATE_LAYERS.find((prefix) => file.startsWith(prefix) || file.includes(`/${prefix}`));
  if (layer) return `локальный слой ${layer}`;
  if (PRIVATE_NAMES.has(basename(file))) return "локальный файл настроек или правил";
  if (PRIVATE_SUFFIXES.some((suffix) => file.endsWith(suffix))) return "состояние сессии или база";
  return undefined;
}

function contentViolations(text: string, markers: readonly string[]): string[] {
  const found = CONTENT_RULES.filter(([pattern]) => pattern.test(text)).map(([, reason]) => reason);
  const lower = text.toLowerCase();
  for (const marker of markers) {
    if (lower.includes(marker.toLowerCase())) found.push("слово из локального списка личных слов");
  }
  return [...new Set(found)];
}

/** Возвращает нарушения для файлов, которые Git отслеживает или готов принять. */
export function findViolations(root: string): Violation[] {
  const markers = readLocalMarkers(root);
  const violations: Violation[] = [];
  for (const file of listCandidateFiles(root)) {
    const byPath = pathViolation(file);
    if (byPath) {
      violations.push({ file, reason: byPath });
      continue;
    }
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    if (bytes.includes(0)) continue;
    for (const reason of contentViolations(bytes.toString("utf8"), markers)) violations.push({ file, reason });
  }
  return violations;
}

/** Состав npm-пакета проверяется отдельно: его задаёт package.json, а не .gitignore. */
export function findPackageViolations(root: string): Violation[] {
  const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const [report] = JSON.parse(raw) as [{ files: { path: string }[] }];
  return report.files
    .map(({ path }) => ({ file: `пакет: ${path}`, reason: pathViolation(path) }))
    .filter((entry): entry is Violation => entry.reason !== undefined);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(import.meta.url), "../..");
  const violations = [...findViolations(root), ...findPackageViolations(root)];
  for (const { file, reason } of violations) console.error(`${file}: ${reason}`);
  if (violations.length > 0) {
    console.error(`\nПриватные границы нарушены: ${violations.length}.`);
    process.exit(1);
  }
  console.log("Приватные границы целы.");
}
