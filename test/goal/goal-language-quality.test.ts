import assert from "node:assert/strict";
import test from "node:test";
import {
  compareProtectedFacts,
  extractProtectedFacts,
  lintGoalMarkdown,
} from "../../src/goal/goal-language-quality.js";

test("protects technical literals and does not lint their English contents", () => {
  const text = "Проверен `report_goal_progress` для MR `ABC-42` в `src/goal-language-quality.ts`: https://gitlab.example.test/a/b и SHA abcdef1234567, запуск npm test --watch.";
  const facts = extractProtectedFacts(text);
  assert.deepEqual(facts.inlineCode, ["`report_goal_progress`", "`ABC-42`", "`src/goal-language-quality.ts`"]);
  assert.deepEqual(facts.urls, ["https://gitlab.example.test/a/b"]);
  assert.deepEqual(facts.hashes, ["abcdef1234567"]);
  assert.deepEqual(facts.cliFlags, ["--watch"]);
  assert.equal(lintGoalMarkdown(text).verdict, "clean");
});

test("protects code blocks, paths, Jira keys and merge request refs", () => {
  const text = "Изменения в /srv/app/src/index.ts и ../test/a.test.ts для PROJ-17 и group!387.\n```ts\nconst value = 'English should not matter';\n```";
  const facts = extractProtectedFacts(text);
  assert.deepEqual(facts.codeBlocks, ["```ts\nconst value = 'English should not matter';\n```"]);
  assert.deepEqual(facts.paths, ["/srv/app/src/index.ts", "../test/a.test.ts"]);
  assert.deepEqual(facts.issueKeys, ["PROJ-17"]);
  assert.deepEqual(facts.mergeRequestRefs, ["group!387"]);
  assert.equal(lintGoalMarkdown(text).verdict, "clean");
});

test("detects chatbot artifacts as hard failures", () => {
  const result = lintGoalMarkdown("Проверка завершена. <think>скрытая служебная часть</think> [cite: 2]");
  assert.equal(result.verdict, "repair_required");
  assert.ok(result.errors.some((finding) => finding.code === "chatbot-turn-marker"));
  assert.ok(result.errors.some((finding) => finding.code === "chatbot-citation"));
});

test("detects hard humanizer patterns and mixed language", () => {
  const result = lintGoalMarkdown("Это не просто отчёт, а controlled flow validated. Следующий шаг — rollout.");
  assert.equal(result.verdict, "repair_required");
  assert.ok(result.errors.some((finding) => finding.code === "negative-parallelism"));
  assert.ok(result.warnings.some((finding) => finding.code === "long-dash"));
  assert.ok(result.errors.some((finding) => finding.code === "mixed-language"));
});

test("technical allowlist avoids false positives for ordinary goal wording", () => {
  const result = lintGoalMarkdown("В runtime сохранён checkpoint после compaction. Затем выполнен reload и пройден typecheck.");
  assert.equal(result.verdict, "clean");
});

test("AI lexicon is reviewable alone but a cluster requires repair", () => {
  const one = lintGoalMarkdown("Ключевой результат проверен.");
  assert.equal(one.verdict, "review");
  assert.equal(one.errors.length, 0);

  const cluster = lintGoalMarkdown("Ключевой результат демонстрирует эффективность. Важно отметить, что это способствует работе. В конечном итоге давайте разберёмся с флоу.");
  assert.equal(cluster.verdict, "repair_required");
  assert.ok(cluster.errors.some((finding) => finding.code === "ai-cluster"));
});

test("detects long one-line dumps and long paragraphs", () => {
  const oneLine = lintGoalMarkdown("слово ".repeat(70));
  assert.equal(oneLine.verdict, "repair_required");
  assert.ok(oneLine.errors.some((finding) => finding.code === "one-line-dump"));
  assert.equal(oneLine.diagnostics[0]?.length, oneLineTextLength("слово ".repeat(70)));

  const paragraph = lintGoalMarkdown("абзац ".repeat(150));
  assert.ok(paragraph.errors.some((finding) => finding.code === "long-paragraph"));
  assert.ok(paragraph.diagnostics.some((diagnostic) => diagnostic.code === "long-paragraph" && diagnostic.limit === 700));
});

function oneLineTextLength(text: string): number {
  return text.trim().length;
}

test("preserves real Markdown paragraph boundaries and ignores fenced code", () => {
  const sections = [
    "# Первый раздел\n\n" + "слово ".repeat(90),
    "## Второй раздел\n\n" + "слово ".repeat(90),
    "- отдельный пункт\n- ещё один пункт",
    "```ts\n" + "const value = 'English';\n" + "```",
  ].join("\n\n");
  const result = lintGoalMarkdown(sections);
  assert.equal(result.errors.some((finding) => finding.code === "long-paragraph"), false);
  assert.equal(result.errors.some((finding) => finding.code === "one-line-dump"), false);
});

test("protects tilde fenced code like backtick fenced code", () => {
  const text = ["Проверка завершена.", "~~~ts", "const value = 'Controlled flow validated';", "~~~"].join("\n");
  const result = lintGoalMarkdown(text);
  assert.equal(result.verdict, "clean");
  assert.deepEqual(result.protectedFacts.codeBlocks, ["~~~ts\nconst value = 'Controlled flow validated';\n~~~"]);
});

test("protects nested shorter fences inside a longer fenced code block", () => {
  const text = [
    "Проверка завершена.",
    "````md",
    "```js",
    "const value = 'Controlled flow validated';",
    "```",
    "````",
  ].join("\n");
  const result = lintGoalMarkdown(text);
  assert.equal(result.verdict, "clean");
  assert.deepEqual(result.protectedFacts.codeBlocks, [
    "````md\n```js\nconst value = 'Controlled flow validated';\n```\n````",
  ]);
});

test("rejects a backtick fence whose info string contains a backtick", () => {
  const result = lintGoalMarkdown(["```bad`", "# Injected", "```"].join("\n"));
  assert.equal(result.verdict, "repair_required");
  assert.deepEqual(result.protectedFacts.codeBlocks, []);
  assert.ok(result.errors.some((finding) => finding.code === "unclosed-code-fence"));
});

test("does not protect inline code assembled from a malformed fence delimiter", () => {
  const result = lintGoalMarkdown("```Controlled flow validated`");
  assert.equal(result.verdict, "repair_required");
  assert.deepEqual(result.protectedFacts.inlineCode, []);
  assert.ok(result.errors.some((finding) => finding.code === "english-sentence"));
});

test("does not accept Unicode whitespace after a closing fence", () => {
  const result = lintGoalMarkdown(["```ts", "Controlled flow validated", "```\u00a0", "Контроль завершён."].join("\n"));
  assert.equal(result.verdict, "repair_required");
  assert.ok(result.errors.some((finding) => finding.code === "unclosed-code-fence"));
});

test("reports one genuine paragraph longer than the limit", () => {
  const result = lintGoalMarkdown("# Раздел\n\n" + "слово ".repeat(150));
  assert.ok(result.errors.some((finding) => finding.code === "long-paragraph"));
});

test("treats a heading as its own block without requiring a following blank line", () => {
  const paragraph = "слово ".repeat(116).trim();
  assert.ok(paragraph.length < 700);
  const result = lintGoalMarkdown(`# Заголовок\n${paragraph}`);
  assert.equal(result.errors.some((finding) => finding.code === "long-paragraph"), false);
});

test("does not lose repeated protected facts during repair comparison", () => {
  const before = "Повторить /tmp/project/src/index.ts и ещё раз /tmp/project/src/index.ts.";
  const after = "Повторить /tmp/project/src/index.ts.";
  const result = compareProtectedFacts(before, after);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing.paths, ["/tmp/project/src/index.ts"]);
});

test("ignores Markdown structure and functional need-user questions", () => {
  const text = ["- пункт", "> цитата", "---", "Какой вариант выбрать?", "```ts", "const value = 'English';", "```"].join("\\n");
  const result = lintGoalMarkdown(text);
  assert.notEqual(result.verdict, "repair_required");
  assert.equal(result.errors.some((finding) => finding.code === "prose-symbol"), false);
  assert.equal(result.errors.some((finding) => finding.code === "rhetorical-question"), false);
});

test("unclosed fenced blocks require repair and do not hide trailing prose", () => {
  const result = lintGoalMarkdown("Проверка начала.\n```ts\nconst value = 'English';\nControlled flow validated, блокеры отсутствуют.");
  assert.equal(result.verdict, "repair_required");
  assert.ok(result.errors.some((finding) => finding.code === "unclosed-code-fence"));
  assert.ok(result.errors.some((finding) => finding.code === "mixed-language" || finding.code === "english-sentence"));
});

test("compares protected facts for repair and rejects loss or invention", () => {
  const before = "Проверен `npm test` в /tmp/project/src/index.ts, MR `ABC-42`, SHA abcdef1234567.";
  const after = "Проверена команда `npm test` в /tmp/project/src/index.ts, MR `ABC-42`, SHA abcdef1234567.";
  assert.deepEqual(compareProtectedFacts(before, after), {
    ok: true,
    missing: { codeBlocks: [], inlineCode: [], urls: [], paths: [], hashes: [], issueKeys: [], mergeRequestRefs: [], cliFlags: [] },
    added: { codeBlocks: [], inlineCode: [], urls: [], paths: [], hashes: [], issueKeys: [], mergeRequestRefs: [], cliFlags: [] },
  });

  const changed = compareProtectedFacts(before, "Проверен `npm run test` в /tmp/project/src/index.ts, MR `ABC-42`, SHA abcdef1234567.");
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.missing.inlineCode, ["`npm test`"]);
  assert.deepEqual(changed.added.inlineCode, ["`npm run test`"]);
});

test("code formatting protects exact progress-report literals without translation", () => {
  const error = "Telegram sendMessage failed with HTTP 401";
  const unformatted = lintGoalMarkdown(`Проверка завершена: ${error}.`);
  assert.ok(unformatted.errors.some((finding) => finding.code === "mixed-language"));

  const literals = [error, "git diff --check", "report_goal_progress", "awaiting_user"];
  for (const literal of literals) {
    const inline = `\`${literal}\``;
    const inlineResult = lintGoalMarkdown(`Проверка завершена: ${inline}.`);
    assert.equal(inlineResult.verdict, "clean");
    assert.deepEqual(inlineResult.protectedFacts.inlineCode, [inline]);
    assert.deepEqual(Buffer.from(inlineResult.protectedFacts.inlineCode[0]!.slice(1, -1)), Buffer.from(literal));

    const block = `\`\`\`\n${literal}\n\`\`\``;
    const blockResult = lintGoalMarkdown(`Проверка завершена.\n\n${block}`);
    assert.equal(blockResult.verdict, "clean");
    assert.deepEqual(blockResult.protectedFacts.codeBlocks, [block]);
    assert.deepEqual(Buffer.from(blockResult.protectedFacts.codeBlocks[0]!.slice(4, -4)), Buffer.from(literal));
  }
});

test("protected literals do not exempt surrounding prose from language and layout checks", () => {
  const inlineError = "`Telegram sendMessage failed with HTTP 401`";
  const english = lintGoalMarkdown(`Проверка завершена: ${inlineError}. Controlled flow validated.`);
  assert.equal(english.verdict, "repair_required");
  assert.ok(english.errors.some((finding) => finding.code === "mixed-language" || finding.code === "english-sentence"));

  const longDash = lintGoalMarkdown(`Проверка завершена — ${inlineError}.`);
  assert.ok(longDash.warnings.some((finding) => finding.code === "long-dash"));
  assert.equal(longDash.errors.some((finding) => finding.code === "mixed-language"), false);

  const longLine = lintGoalMarkdown(`Проверка завершена: ${inlineError}. ${"слово ".repeat(70)}`);
  assert.ok(longLine.errors.some((finding) => finding.code === "one-line-dump"));
  assert.equal(longLine.errors.some((finding) => finding.code === "mixed-language"), false);
});
