import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { findViolations } from "../scripts/check-public-tree.ts";

// Запрещённые образцы собираются по частям, чтобы сам тест не нарушал проверяемое правило.
const HOME_PATH = ["", "home", "someone", "project"].join("/");

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "public-tree-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

function reasons(files: Record<string, string>): string[] {
  const root = repoWith(files);
  try {
    return findViolations(root).map(({ file, reason }) => `${file}: ${reason}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("чистое дерево проходит", () => {
  assert.deepEqual(reasons({ "src/a.ts": "export const a = 1;\n", "README.md": "Путь: ~/.pi/agent\n" }), []);
});

test("личный путь в тексте — нарушение", () => {
  assert.deepEqual(reasons({ "docs/a.md": `Смотри ${HOME_PATH}/file\n` }), [
    "docs/a.md: личный путь в домашнем каталоге",
  ]);
});

test("локальные слои и состояние сессий — нарушение, даже если Git их не игнорирует", () => {
  assert.deepEqual(
    reasons({
      ".task_files/plan.md": "план\n",
      "AGENTS.local.md": "правила машины\n",
      "fixtures/session.jsonl": "{}\n",
    }).sort(),
    [
      ".task_files/plan.md: локальный слой .task_files/",
      "AGENTS.local.md: локальный файл настроек или правил",
      "fixtures/session.jsonl: состояние сессии или база",
    ],
  );
});

test("игнорируемые Git файлы не проверяются: в коммит они не попадут", () => {
  assert.deepEqual(reasons({ ".gitignore": ".runtime/\n", ".runtime/log.txt": `${HOME_PATH}\n` }), []);
});

test("секрет и закрытый ключ — нарушение", () => {
  const key = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const secret = `const api_key = "${"x".repeat(24)}";\n`;
  assert.deepEqual(reasons({ "a.txt": `${key}\n`, "b.ts": secret }).sort(), [
    "a.txt: закрытый ключ",
    "b.ts: похоже на секрет",
  ]);
});

test("слово из локального списка личных слов — нарушение", () => {
  assert.deepEqual(
    reasons({
      ".gitignore": ".task_files/\n",
      ".task_files/private-markers.txt": "# личные слова\nТайноеХранилище\n",
      "docs/a.md": "Заметка лежит в тайноехранилище.\n",
    }),
    ["docs/a.md: слово из локального списка личных слов"],
  );
});
