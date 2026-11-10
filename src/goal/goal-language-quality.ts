import { language } from "../language.js";
/** Shared by prose validation and model-facing descriptions. */
export const MAX_GOAL_PROSE_PARAGRAPH_CHARS = 700;

export type LanguageVerdict = "clean" | "review" | "repair_required";
export type FindingSeverity = "warning" | "error";

export interface LanguageFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
  excerpt?: string;
  field?: string | null;
  length?: number | null;
  limit?: number | null;
  repair?: string;
}

export interface LanguageDiagnostic {
  code: string;
  field: string | null;
  length: number | null;
  limit: number | null;
  repair: string;
}

export interface ProtectedFacts {
  codeBlocks: string[];
  inlineCode: string[];
  urls: string[];
  paths: string[];
  hashes: string[];
  issueKeys: string[];
  mergeRequestRefs: string[];
  cliFlags: string[];
}

export interface ProtectedFactComparison {
  ok: boolean;
  missing: ProtectedFacts;
  added: ProtectedFacts;
}

export interface LanguageLintResult {
  verdict: LanguageVerdict;
  findings: LanguageFinding[];
  errors: LanguageFinding[];
  warnings: LanguageFinding[];
  diagnostics: LanguageDiagnostic[];
  score: number;
  protectedFacts: ProtectedFacts;
}

export interface GoalLanguageOptions {
  /** Technical names which are allowed in prose without being treated as English. */
  technicalAllowlist?: Iterable<string>;
}

const DEFAULT_TECHNICAL_ALLOWLIST = new Set([
  "api", "cli", "codex", "current", "json", "markdown", "mr", "pi", "runtime",
  "reducer", "checkpoint", "compaction", "reload", "resume", "state", "status",
  "goal", "humanizer", "typescript", "javascript", "node", "npm", "git", "github",
  "gitlab", "http", "https", "url", "uuid", "sha", "utf", "utf8", "tui", "tdd",
  "smoke", "test", "tests", "typecheck", "typescript", "workspace", "worktree",
]);

const ARTIFACT_PATTERNS: Array<[string, RegExp, string]> = [
  ["chatbot-citation", /(?:oaicite|\[cite\s*:\s*\d+\]|\bcite\s*:\s*\d+)/i, "артефакт цитирования чат-бота"],
  ["chatbot-turn-marker", /\bturn[_-]?\d+\b|<\/?think>|<\/?analysis>/i, "служебная метка чат-бота"],
  ["chatbot-utm", /\butm_(?:source|medium|campaign|term|content)=/i, "хвост ссылки чат-бота"],
  ["chatbot-closing", /\b(?:надеюсь,?\s+это\s+поможет|если\s+у\s+вас\s+есть\s+вопросы,?\s+обращайтесь)\b/i, "шаблонная концовка чат-бота"],
];

const HARD_PATTERNS: Array<[string, RegExp, string]> = [
  ["negative-parallelism", /(?:^|\s)не\s+(?:просто|только)(?:\s|,)[^.!?\n]{0,120}(?:^|\s)а\s+\w+/iu, "негативное противопоставление из шаблонов LLM"],
  ["prose-symbol", /(?:^|\s)[=→><+&](?:\s|$)|\bvs\.?\b/i, "служебный знак в обычной прозе"],
];

const STYLE_PATTERNS: Array<[string, RegExp, string]> = [
  ["long-dash", /—/, "длинное тире; предпочтительнее короткая пунктуация"],
];

const AI_LEXICON: Array<[string, RegExp, string]> = [
  ["ai-keyword", /ключев(?:ой|ая|ое|ые)|демонстрирует|способствует|обеспечивает/iu, "шаблонная оценочная лексика"],
  ["ai-transition", /важно\s+отметить|таким\s+образом|в\s+конечном\s+итоге/iu, "шаблонный переход"],
  ["ai-meta", /давайте\s+(?:разбер(?:ём|емся)|погрузимся)|подвед(?:ём|ем)\s+итог|подводя\s+итоги/iu, "анонс или резюме вместо факта"],
  ["ai-pseudo-depth", /по\s+сути|если\s+копнуть\s+глубже|в\s+современном\s+мире/iu, "псевдоглубина или пустой усилитель"],
  ["ai-jargon", /(?:имплементировать|валидировать|персистить|энфорсить|роллаут|юзкейс|флоу|дедлайн|фидбек|адресовать\s+проблему)/iu, "необъяснённый техножаргон"],
  ["ai-grandiosity", /(?:неотъемлем(?:ая|ой)\s+часть|знаменует|уникальн(?:ый|ая)|эффективн(?:ый|ая))/iu, "раздутая или общая формулировка"],
];

const ENGLISH_WORDS = new Set([
  "controlled", "flow", "validated", "validation", "implemented", "implementation", "blocking",
  "blocked", "missing", "passed", "failed", "target", "adapter", "posting", "live", "draft",
  "review", "publish", "published", "current", "decision", "paper", "cut", "next", "step",
  "none", "done", "work", "status", "phase", "verified", "verification", "because", "without",
  "and", "or", "the", "is", "are", "was", "were", "with", "for", "from", "after", "before",
]);

const DIAGNOSTIC_REPAIRS: Readonly<Record<string, string>> = {
  "chatbot-citation": "Удалите служебную цитату чат-бота.",
  "chatbot-turn-marker": "Удалите служебную метку чат-бота.",
  "chatbot-utm": "Удалите служебный хвост ссылки.",
  "chatbot-closing": "Замените шаблонную концовку конкретным фактом.",
  "negative-parallelism": "Перепишите противопоставление прямым техническим утверждением.",
  "prose-symbol": "Замените служебный знак обычной пунктуацией или защитите точный литерал кодовым оформлением.",
  "english-sentence": "Перепишите обычную прозу по-русски, сохранив технические литералы без изменений.",
  "mixed-language": "Не смешивайте русскую и английскую лексику в одном предложении; технические литералы оформите как код.",
  "one-line-dump": "Разбейте текст на короткие абзацы или список; одна независимая мысль должна занимать один блок.",
  "long-paragraph": "Разделите абзац на несколько независимых мыслей или оформите их отдельными пунктами списка.",
  "unclosed-code-fence": "Закройте fenced code block тем же символом и не меньшей длиной ограждения.",
  "ai-cluster": "Замените кластер шаблонной лексики конкретными фактами и проверками.",
};

/** Английские тексты замечаний, которые возможны в английском варианте; ключ — русский текст. */
export const ENGLISH_FINDING_MESSAGES: Readonly<Record<string, string>> = {
  "артефакт цитирования чат-бота": "chatbot citation artifact",
  "служебная метка чат-бота": "chatbot service marker",
  "хвост ссылки чат-бота": "chatbot link tracking tail",
  "служебный знак в обычной прозе": "service symbol in ordinary prose",
  "текст представляет собой слишком длинную строку без структуры": "the text is one overly long line without structure",
  "абзац слишком длинный; разделите независимые мысли": "the paragraph is too long; split independent thoughts",
  "незакрытый fenced code block скрывает остаток Markdown-текста": "an unclosed fenced code block hides the rest of the Markdown text",
};

const localized = (message: string): string => (language() === "en" ? ENGLISH_FINDING_MESSAGES[message] : undefined) ?? message;

const ENGLISH_DIAGNOSTIC_REPAIRS: Readonly<Record<string, string>> = {
  "chatbot-citation": "Remove the chatbot citation marker.",
  "chatbot-turn-marker": "Remove the chatbot service marker.",
  "chatbot-utm": "Remove the tracking tail of the link.",
  "chatbot-closing": "Replace the boilerplate closing with a concrete fact.",
  "prose-symbol": "Replace the service symbol with ordinary punctuation or protect the exact literal as code.",
  "one-line-dump": "Split the text into short paragraphs or a list; one independent thought per block.",
  "long-paragraph": "Split the paragraph into independent thoughts or turn them into separate list items.",
  "unclosed-code-fence": "Close the fenced code block with the same character and at least the same fence length.",
};

export function diagnosticRepairForCode(code: string): string | null {
  return (language() === "en" ? ENGLISH_DIAGNOSTIC_REPAIRS[code] : DIAGNOSTIC_REPAIRS[code]) ?? null;
}

/** Журнал хранит текст исправления на языке записи; после смены языка он остаётся допустимым. */
export function isKnownDiagnosticRepair(code: string, repair: unknown): boolean {
  return typeof repair === "string" && (repair === DIAGNOSTIC_REPAIRS[code] || repair === ENGLISH_DIAGNOSTIC_REPAIRS[code]);
}

function emptyFacts(): ProtectedFacts {
  return { codeBlocks: [], inlineCode: [], urls: [], paths: [], hashes: [], issueKeys: [], mergeRequestRefs: [], cliFlags: [] };
}

function collect(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

export interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  rest: string;
}

export function parseMarkdownFence(line: string): MarkdownFence | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const marker = match[1]![0] as "`" | "~";
  const rest = match[2] ?? "";
  if (marker === "`" && rest.includes("`")) return null;
  return { marker, length: match[1]!.length, rest };
}

export function closesMarkdownFence(open: MarkdownFence, candidate: MarkdownFence): boolean {
  return candidate.marker === open.marker && candidate.length >= open.length && /^[ \t]*$/.test(candidate.rest);
}

function fencedCodeBlockRanges(text: string): Array<{ start: number; end: number }> {
  const lines = text.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  let open: { fence: MarkdownFence; start: number } | null = null;
  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\r?\n$/, "");
    const fence = parseMarkdownFence(line);
    if (open === null && fence) open = { fence, start: offset };
    else if (open && fence && closesMarkdownFence(open.fence, fence)) {
      ranges.push({ start: open.start, end: offset + lineWithEnding.length });
      open = null;
    }
    offset += lineWithEnding.length;
  }
  return ranges;
}

function maskRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  let result = text;
  for (const range of [...ranges].reverse()) {
    const masked = result.slice(range.start, range.end).replace(/[^\r\n]/g, " ");
    result = `${result.slice(0, range.start)}${masked}${result.slice(range.end)}`;
  }
  return result;
}

function inlineCodeRanges(text: string): Array<{ start: number; end: number }> {
  const lines = text.match(/.*(?:\r?\n|$)/g)?.filter((line) => line.length > 0) ?? [];
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\r?\n$/, "");
    // A malformed backtick fence is ordinary prose, not a source of protected
    // inline literals assembled from a suffix of its delimiter run.
    if (/^ {0,3}`{3,}/.test(line) && parseMarkdownFence(line) === null) {
      offset += lineWithEnding.length;
      continue;
    }
    let cursor = 0;
    while (cursor < line.length) {
      const opening = line.indexOf("`", cursor);
      if (opening < 0) break;
      let openingEnd = opening;
      while (line[openingEnd] === "`") openingEnd += 1;
      const runLength = openingEnd - opening;
      let search = openingEnd;
      let closed = false;
      while (search < line.length) {
        const candidate = line.indexOf("`", search);
        if (candidate < 0) break;
        let candidateEnd = candidate;
        while (line[candidateEnd] === "`") candidateEnd += 1;
        if (candidateEnd - candidate === runLength) {
          ranges.push({ start: offset + opening, end: offset + candidateEnd });
          cursor = candidateEnd;
          closed = true;
          break;
        }
        search = candidateEnd;
      }
      if (!closed) cursor = openingEnd;
    }
    offset += lineWithEnding.length;
  }
  return ranges;
}

/** Extracts literal values which a language repair must preserve byte-for-byte. */
export function extractProtectedFacts(text: string): ProtectedFacts {
  const facts = emptyFacts();
  const blockRanges = fencedCodeBlockRanges(text);
  facts.codeBlocks = blockRanges.map((range) => text.slice(range.start, range.end).replace(/\r?\n$/, ""));
  const withoutBlocks = maskRanges(text, blockRanges);
  const inlineRanges = inlineCodeRanges(withoutBlocks);
  facts.inlineCode = inlineRanges.map((range) => text.slice(range.start, range.end));
  const withoutCode = maskRanges(withoutBlocks, inlineRanges);
  facts.urls = collect(withoutCode, /https?:\/\/[^\s<>()]+/gi).map((value) => value.replace(/[),.;!?]+$/, ""));
  facts.hashes = collect(withoutCode, /\b[a-f0-9]{7,64}\b/gi);
  facts.issueKeys = collect(withoutCode, /\b[A-Z][A-Z0-9]+-\d+\b/g);
  facts.mergeRequestRefs = collect(withoutCode, /(?:\b[\w.-]+!\d+\b|!\d+\b)/g);
  facts.cliFlags = collect(withoutCode, /(?<![\w-])(?:--[a-z][\w-]*|-[a-zA-Z])\b/g);
  facts.paths = collect(withoutCode, /(?<![\w@])(?:\.?\.?\/|\/)[\w.@~+%-]+(?:\/[\w.@~+%-]+)+(?:#[\w.-]+)?/g);
  return facts;
}

function maskProtected(text: string): string {
  const blockRanges = fencedCodeBlockRanges(text);
  const patterns = [
    /https?:\/\/[^\s<>()]+/gi,
    /\b[a-f0-9]{7,64}\b/gi,
    /\b[A-Z][A-Z0-9]+-\d+\b/g,
    /(?:\b[\w.-]+!\d+\b|!\d+\b)/g,
    /(?<![\w-])(?:--[a-z][\w-]*|-[a-zA-Z])\b/g,
    /(?<![\w@])(?:\.?\.?\/|\/)[\w.@~+%-]+(?:\/[\w.@~+%-]+)+(?:#[\w.-]+)?/g,
  ];
  let result = maskRanges(text, blockRanges);
  result = maskRanges(result, inlineCodeRanges(result));
  for (const pattern of patterns) result = result.replace(pattern, (match) => " ".repeat(match.length));
  return result;
}

function excerpt(text: string, index: number): string {
  return text.slice(Math.max(0, index - 35), Math.min(text.length, index + 100)).replace(/\s+/g, " ").trim();
}

function finding(code: string, severity: FindingSeverity, message: string, text: string, match: RegExpMatchArray | null): LanguageFinding {
  return { code, severity, message: localized(message), ...(match?.index === undefined ? {} : { excerpt: excerpt(text, match.index) }) };
}

function addPatternFindings(findings: LanguageFinding[], text: string, patterns: Array<[string, RegExp, string]>, severity: FindingSeverity): void {
  for (const [code, pattern, message] of patterns) {
    const match = text.match(pattern);
    if (match) findings.push(finding(code, severity, message, text, match));
  }
}

function nonTechnicalEnglishWords(text: string, allowlist: Set<string>): string[] {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  return words.filter((word) => {
    const normalized = word.toLowerCase().replace(/[']/g, "");
    return !allowlist.has(normalized) && !/^[A-Z]{2,}$/.test(word);
  });
}

function proseText(text: string): { text: string; unclosedFence: boolean } {
  const lines = text.split(/\r?\n/);
  let openFence: MarkdownFence | null = null;
  let fencedLines: string[] = [];
  const visible: string[] = [];
  const appendBoundary = (): void => {
    if (visible.at(-1) !== "") visible.push("");
  };
  for (const rawLine of lines) {
    const fence = parseMarkdownFence(rawLine);
    if (openFence === null && fence) {
      openFence = fence;
      fencedLines = [];
      appendBoundary();
      continue;
    }
    if (openFence && fence && closesMarkdownFence(openFence, fence)) {
      openFence = null;
      fencedLines = [];
      appendBoundary();
      continue;
    }
    if (openFence !== null) {
      // A closing fence makes this content protected code. If no closing
      // fence exists, retain the buffered remainder below so malformed
      // Markdown cannot hide prose from the language gate.
      fencedLines.push(rawLine);
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(rawLine)) {
      appendBoundary();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+/.test(rawLine);
    const listItem = /^\s{0,3}(?:[-+*]|\d+[.)])\s+/.test(rawLine);
    if (heading || listItem) appendBoundary();
    if (!rawLine.trim()) {
      appendBoundary();
      continue;
    }
    const line = rawLine
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/^\s{0,3}>\s?/, "")
      .trim();
    if (line) visible.push(line);
    if (heading) appendBoundary();
  }
  if (openFence !== null) {
    appendBoundary();
    for (const rawLine of fencedLines) {
      const line = rawLine.trim();
      if (line) visible.push(line);
    }
  }
  return { text: visible.join("\n"), unclosedFence: openFence !== null };
}

function detectLanguageMix(text: string, allowlist: Set<string>, findings: LanguageFinding[]): void {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const cyrillic = (sentence.match(/[А-Яа-яЁё]/g) ?? []).length;
    const englishWords = nonTechnicalEnglishWords(sentence, allowlist);
    const knownEnglish = englishWords.filter((word) => ENGLISH_WORDS.has(word.toLowerCase().replace(/[']/g, "")));
    if (knownEnglish.length >= 3 && knownEnglish.length >= cyrillic / 2) {
      findings.push(finding("english-sentence", "error", "предложение в основном написано по-английски", text, text.match(new RegExp(escapeRegExp(sentence)))));
    } else if (cyrillic > 0 && knownEnglish.length >= 2) {
      findings.push(finding("mixed-language", "error", "русская и английская лексика смешаны в одном предложении", text, text.match(new RegExp(escapeRegExp(sentence)))));
    }
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function countAiFamilies(text: string): number {
  return AI_LEXICON.filter(([, pattern]) => pattern.test(text)).length;
}

function detectLength(text: string, findings: LanguageFinding[]): void {
  const plain = text.trim();
  if (!plain.includes("\n") && plain.length > 320) {
    findings.push({
      code: "one-line-dump",
      severity: "error",
      message: localized("текст представляет собой слишком длинную строку без структуры"),
      length: plain.length,
      limit: 320,
      repair: diagnosticRepairForCode("one-line-dump")!,
    });
  }
  for (const paragraph of plain.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean)) {
    if (paragraph.length > MAX_GOAL_PROSE_PARAGRAPH_CHARS) {
      findings.push({
        code: "long-paragraph",
        severity: "error",
        message: localized("абзац слишком длинный; разделите независимые мысли"),
        length: paragraph.length,
        limit: MAX_GOAL_PROSE_PARAGRAPH_CHARS,
        repair: diagnosticRepairForCode("long-paragraph")!,
      });
    }
  }
}

function subtractFacts(before: ProtectedFacts, after: ProtectedFacts): { missing: ProtectedFacts; added: ProtectedFacts } {
  const resultMissing = emptyFacts();
  const resultAdded = emptyFacts();
  for (const key of Object.keys(before) as Array<keyof ProtectedFacts>) {
    const remaining = [...after[key]];
    for (const value of before[key]) {
      const index = remaining.indexOf(value);
      if (index < 0) resultMissing[key].push(value);
      else remaining.splice(index, 1);
    }
    resultAdded[key] = remaining;
  }
  return { missing: resultMissing, added: resultAdded };
}

/** Compares protected literals before and after a model language repair. */
export function compareProtectedFacts(before: ProtectedFacts | string, after: ProtectedFacts | string): ProtectedFactComparison {
  const left = typeof before === "string" ? extractProtectedFacts(before) : before;
  const right = typeof after === "string" ? extractProtectedFacts(after) : after;
  const { missing, added } = subtractFacts(left, right);
  const hasFacts = (facts: ProtectedFacts) => Object.values(facts).some((values) => values.length > 0);
  return { ok: !hasFacts(missing) && !hasFacts(added), missing, added };
}

/** Deterministically checks a goal Markdown projection without changing its contents. */
export function lintGoalMarkdown(text: string, options: GoalLanguageOptions = {}): LanguageLintResult {
  const protectedFacts = extractProtectedFacts(text);
  const visible = maskProtected(text);
  const findings: LanguageFinding[] = [];
  const proseResult = proseText(visible);
  const prose = proseResult.text;
  if (proseResult.unclosedFence) {
    findings.push({ code: "unclosed-code-fence", severity: "error", message: localized("незакрытый fenced code block скрывает остаток Markdown-текста") });
  }
  // Русские правила (смешение языков, шаблонная лексика, обороты) в английском варианте не действуют:
  // английская проза там и есть нужный язык. Общие правила структуры и следов чат-бота остаются.
  const russian = language() === "ru";
  addPatternFindings(findings, prose, russian ? ARTIFACT_PATTERNS : ARTIFACT_PATTERNS.filter(([code]) => code !== "chatbot-closing"), "error");
  addPatternFindings(findings, prose, russian ? HARD_PATTERNS : HARD_PATTERNS.filter(([code]) => code === "prose-symbol"), "error");
  if (russian) {
    addPatternFindings(findings, prose, STYLE_PATTERNS, "warning");
    addPatternFindings(findings, prose, AI_LEXICON, "warning");
    detectLanguageMix(prose, new Set([...DEFAULT_TECHNICAL_ALLOWLIST, ...(options.technicalAllowlist ?? [])].map((value) => value.toLowerCase())), findings);
  }
  detectLength(prose, findings);

  const aiFamilies = russian ? countAiFamilies(visible) : 0;
  if (aiFamilies >= 3) findings.push({ code: "ai-cluster", severity: "error", message: `обнаружен кластер из ${aiFamilies} семейств шаблонной лексики` });
  const errors = findings.filter((item) => item.severity === "error");
  const warnings = findings.filter((item) => item.severity === "warning");
  const score = errors.length * 3 + warnings.length;
  const verdict: LanguageVerdict = errors.length > 0 ? "repair_required" : warnings.length > 0 ? "review" : "clean";
  const diagnostics = findings
    .filter((item) => item.severity === "error")
    .map((item) => ({
      code: item.code,
      field: item.field ?? null,
      length: item.length ?? null,
      limit: item.limit ?? null,
      repair: diagnosticRepairForCode(item.code)!,
    }));
  return { verdict, findings, errors, warnings, diagnostics, score, protectedFacts };
}
