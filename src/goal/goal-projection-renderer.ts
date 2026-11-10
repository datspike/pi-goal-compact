import { goalPreservedContext } from "./goal-projection-state.js";
import { goalWorkNeedsCompaction, selectNextGoalWork } from "./goal-work-state.js";
import { createHash } from "node:crypto";
import { closesMarkdownFence, parseMarkdownFence, type MarkdownFence } from "./goal-language-quality.js";
import { goalProgressEventLabel, type GoalProgressReport } from "./report-schema.js";
import type { ThreadGoal } from "./types.js";
import type { GoalDecisionEntry, GoalPaperCutEntry, GoalProgressEventRecord, GoalProjectionState, ProjectionPaperCutStatus } from "./goal-projection-state.js";

function text(value: string | undefined | null): string {
  return (value ?? "").trim();
}

function markdownText(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && !lines[0]!.trim()) lines.shift();
  while (lines.length > 0 && !lines.at(-1)!.trim()) lines.pop();
  return lines.join("\n");
}

export function sanitizeTitle(value: string): string {
  return text(value).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ");
}

/** Preserve valid fences and nested lists while neutralizing headings in prose. */
export function sanitizeMarkdownBlock(value: string): string {
  const lines = markdownText(value).split("\n");
  let openFence: MarkdownFence | null = null;
  return lines.map((line) => {
    const fence = parseMarkdownFence(line);
    if (openFence === null && fence) {
      openFence = fence;
      return line;
    }
    if (openFence && fence && closesMarkdownFence(openFence, fence)) {
      openFence = null;
      return line;
    }
    if (openFence === null && /^\s{0,3}#{1,6}\s/.test(line)) return line.replace(/^(\s{0,3})#/, "$1\\#");
    return line;
  }).join("\n");
}

function section(title: string, value: string | undefined | null): string[] {
  const content = sanitizeMarkdownBlock(value ?? "");
  return content ? [`## ${title}`, "", content, ""] : [];
}

function listSection(title: string, value: string | undefined | null): string[] {
  const content = sanitizeMarkdownBlock(value ?? "");
  return content ? [`## ${title}`, "", content, ""] : [];
}

function statusLabel(status: GoalProgressReport["status"] | ThreadGoal["status"]): string {
  switch (status) {
    case "working": return "Работа продолжается";
    case "verifying": return "Проверка";
    case "blocked": return "Заблокировано";
    case "awaiting_user": return "Нужно решение пользователя";
    case "active": return "Активна";
    case "paused": return "Приостановлена";
    case "budgetLimited": return "Ограничена бюджетом";
    case "complete": return "Завершена";
  }
}

/** Строит стабильную пользовательскую проекцию CURRENT без побочных эффектов. */
export function renderCurrent(goal: ThreadGoal, progress: GoalProgressReport | null): string {
  const lines = ["# Текущее состояние", ""];
  if (!progress) {
    lines.push("## Статус", "", `Цель создана. Статус: ${statusLabel(goal.status)}.`, "", "## Следующий шаг", "", "Начать работу по цели.", "");
  } else {
    const renderedStatus = goal.status === "complete" ? statusLabel("complete") : statusLabel(progress.status);
    lines.push("## Статус", "", `${renderedStatus}. Фаза: ${sanitizeTitle(progress.phase)}.`, "");
    lines.push(...section("Ход работы", progress.summary));
    lines.push(...listSection("Изменения", progress.changed));
    lines.push(...listSection("Готово", progress.completed));
    lines.push(...section("Решение или проблема", progress.problemOrDecision));
    lines.push(...section("Риск и сложность", progress.riskAndComplexity));
    lines.push(...section("Проверка", progress.verification));
    lines.push(...section("Следующий шаг", progress.nextStep));
    lines.push(...section("Нужен пользователь", progress.needUser));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCurrentProjection(state: GoalProjectionState): string {
  return renderCurrent(state.goal, state.latestProgress);
}

function renderProgressEvent(entry: GoalProgressEventRecord, index: number): string[] {
  const report = entry.report;
  const lines = [`## #${index + 1} · ${goalProgressEventLabel(entry.eventKind)} · ${statusLabel(report.status)}`, "", `Фаза: ${sanitizeTitle(report.phase)}`, "", `Время: ${new Date(entry.createdAt).toISOString()}`, ""];
  lines.push(...(report.summary?.trim() ? [sanitizeMarkdownBlock(report.summary), ""] : []));
  lines.push(...listSection("Изменения", report.changed));
  lines.push(...listSection("Готово", report.completed));
  lines.push(...section("Решение или проблема", report.problemOrDecision));
  lines.push(...section("Риск и сложность", report.riskAndComplexity));
  lines.push(...section("Проверка", report.verification));
  lines.push(...section("Следующий шаг", report.nextStep));
  lines.push(...section("Нужен пользователь", report.needUser));
  return lines;
}

export function renderTimeline(entries: readonly GoalProgressEventRecord[]): string {
  const lines = ["# История прогресса", ""];
  if (entries.length === 0) return `${lines.join("\n")}Пока нет событий прогресса.\n`;
  entries.forEach((entry, index) => lines.push(...renderProgressEvent(entry, index)));
  return `${lines.join("\n").trimEnd()}\n`;
}

function renderEntryText(value: string): string {
  return value.trim();
}

/**
 * Вкладывает legacy Markdown как verbatim-блок. Старые записи принадлежат
 * пользователю: их нельзя переписывать санитизацией или языковым repair.
 */
function verbatimBlock(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}

function legacySection(title: string, value: string | null | undefined): string[] {
  if (!value) return [];
  return [`## ${title}`, "", verbatimBlock(value), ""];
}

/** Строит append-only журнал решений; порядок входных записей сохраняется. */
export function renderDecisions(entries: readonly GoalDecisionEntry[], legacyContent?: string | null): string {
  const lines = ["# Решения", ""];
  if (entries.length === 0 && !legacyContent?.trim()) return `${lines.join("\n")}Пока нет зафиксированных решений.\n`;
  entries.forEach((entry, index) => {
    const decision = entry.source === "approved-amendment" ? verbatimBlock(entry.decision) : sanitizeMarkdownBlock(entry.decision);
    lines.push(`## D-${index + 1} · ${sanitizeTitle(entry.title)}`, "", "**Решение:**", "", decision, "", "**Причина:**", "", sanitizeMarkdownBlock(entry.rationale), "");
    if (entry.consequence?.trim()) lines.push("**Последствие:**", "", sanitizeMarkdownBlock(entry.consequence), "");
  });
  lines.push(...legacySection("Сохранённые записи до перехода на управляемый формат", legacyContent));
  return `${lines.join("\n").trimEnd()}\n`;
}

function paperCutStatusLabel(status: ProjectionPaperCutStatus): string {
  return status === "open" ? "открыта" : status === "resolved" ? "решена" : "не исправляется";
}

function paperCutSeverityLabel(severity: GoalPaperCutEntry["severity"]): string {
  return severity === "low" ? "низкий" : severity === "medium" ? "средний" : "высокий";
}

/** Строит стабильный журнал отложенных мелких проблем. */
export function renderPaperCuts(entries: readonly GoalPaperCutEntry[], legacyContent?: string | null): string {
  const lines = ["# Отложенные проблемы", ""];
  if (entries.length === 0 && !legacyContent?.trim()) return `${lines.join("\n")}Пока нет отложенных проблем.\n`;
  entries.forEach((entry, index) => {
    lines.push(`## PC-${index + 1} · ${paperCutSeverityLabel(entry.severity)} приоритет · ${paperCutStatusLabel(entry.status)}`, "", `### ${sanitizeTitle(entry.title)}`, "", sanitizeMarkdownBlock(entry.impact), "");
    if (entry.revisit?.trim()) lines.push(`**Вернуться:** ${sanitizeTitle(entry.revisit)}`, "");
    if (entry.resolution?.trim()) lines.push(`**Результат:** ${sanitizeTitle(entry.resolution)}`, "");
  });
  lines.push(...legacySection("Сохранённые записи до перехода на управляемый формат", legacyContent));
  return `${lines.join("\n").trimEnd()}\n`;
}

const GOAL_DOCUMENT_MARKER = "<!-- pi-goal-view:v1:";


/** Строит актуальную сводку без накопления истории; оригиналы доступны через get_goal. */
export function renderGoalDocument(state: GoalProjectionState): string {
  const work = state.workState;
  const progress = state.latestProgress;
  const lines = ["# Цель", "", "Документ обновляется из состояния сессии. Изменения вносите через инструменты цели.", "",
    ...section("Состояние", `${statusLabel(state.status === "active" && progress ? progress.status : state.status)}.`),
  ];
  if (work) {
    lines.push(...section("Замысел", work.outcome), ...section("Когда результат достаточен", work.doneWhen), ...section("Где мы сейчас", work.summary));
    if (state.workStateStale) lines.push("**Договорённость изменилась. Рабочую сводку нужно сверить с новым контрактом.**", "");
    const labels = { planned: "Предстоит", active: "В работе", blocked: "Заблокировано", done: "Готово", cancelled: "Отменено" };
    const groups = [
      { heading: "Достигнуто", items: work.items.filter((item) => item.status === "done") },
      { heading: "В работе", items: work.items.filter((item) => item.status === "active") },
      { heading: "Оставшиеся этапы", items: work.items.filter((item) => item.status === "planned" || item.status === "blocked") },
      { heading: "Отменённые работы", items: work.items.filter((item) => item.status === "cancelled") },
    ];
    for (const group of groups) {
      lines.push(`## ${group.heading}`, "");
      if (!group.items.length) lines.push("Не отмечено.", "");
      for (const item of group.items) {
        lines.push(`### ${sanitizeTitle(item.title)}`, "", `${labels[item.status]}. ${item.source === "user" ? "Поручение пользователя" : "Предложение агента"}. Идентификатор: ${sanitizeTitle(item.id)}.`, "");
        if (item.result) lines.push("**Результат или причина:**", "", sanitizeMarkdownBlock(item.result), "");
        if (item.evidence) lines.push("**Подтверждение:**", "", sanitizeMarkdownBlock(item.evidence), "");
        else if (item.status === "done") lines.push("Подтверждение результата не записано.", "");
      }
    }
    const next = selectNextGoalWork(work);
    lines.push(...section("Следующий доступный этап", next ? `${next.id}: ${next.title}` : "Доступный этап не выбран; проверьте препятствия и полный контракт."));
    if (goalWorkNeedsCompaction(work)) lines.push("**Сводка разрослась.** При следующем `update_goal_work` обобщите завершённое и повторы, сохранив замысел, причины решений, ссылки, ограничения и всю незавершённую работу. История не удаляется.", "");
  } else {
    lines.push(state.status === "complete" ? "Рабочий план не был записан." : "Рабочий план ещё не записан. Это не означает, что работа закончена.", "");
    lines.push(...legacySection("Исходная договорённость", state.goal.objective));
    if (progress) lines.push(...section("Последнее известное положение", progress.summary || progress.phase), ...section("Ближайший шаг", progress.nextStep));
  }
  if (progress?.needUser) lines.push(...section("Нужно решение пользователя", progress.needUser));
  if (progress?.status === "blocked") lines.push(...section("Препятствие", progress.problemOrDecision));
  const decisions = work ? state.decisions.filter((entry) => work.activeDecisionIds.includes(entry.id)) : state.decisions;
  lines.push(work ? "## Действующие решения" : "## Решения для сверки", "");
  if (!work && decisions.length) lines.push("Рабочий снимок ещё не определяет, какие из этих решений действуют. Сверьте их, не объявляя всю историю текущим планом.", "");
  if (!decisions.length) lines.push("Актуальные решения ещё не отмечены. История не считается действующим планом автоматически.", "");
  for (const entry of decisions) {
    lines.push(`### ${sanitizeTitle(entry.title)}`, "", `Идентификатор: ${sanitizeTitle(entry.id)}.`, "",
      entry.source === "approved-amendment" ? verbatimBlock(entry.decision) : sanitizeMarkdownBlock(entry.decision), "",
      "**Почему так:**", "", sanitizeMarkdownBlock(entry.rationale), "", ...(entry.consequence ? ["**Следствие:**", "", sanitizeMarkdownBlock(entry.consequence), ""] : []));
  }
  const priorVerification = progress?.verification || [...state.progressEvents].reverse().find((entry) => entry.report.verification)?.report.verification;
  const verification = work ? state.workStateStale ? "Договорённость изменилась; проверки нужно сверить." : work.verification || (state.verifiedWorkRevision === state.workRevision ? state.workVerification : null) : state.workVerification;
  lines.push(...section("Проверки текущего плана", verification || "Подтверждение не записано."), ...section("Риски", work?.risks));
  if (priorVerification && priorVerification !== verification) lines.push(...section("Ранее записанная проверка", priorVerification));
  for (const risk of state.paperCuts.filter((entry) => entry.status !== "resolved")) {
    lines.push(`### ${sanitizeTitle(risk.title)}`, "", sanitizeMarkdownBlock(risk.impact), "",
      ...(risk.status === "wont_fix" ? section("Почему риск принят", risk.resolution || "Причина в прежней записи не указана.") : section("Когда вернуться", risk.revisit)));
  }
  const resolvedCount = state.paperCuts.filter((entry) => entry.status === "resolved").length;
  if (resolvedCount) lines.push(`Закрыто недочётов: ${resolvedCount}. Исходные записи и причины закрытия сохранены в истории.`, "");
  const preserved = goalPreservedContext(state);
  if (preserved) {
    lines.push("## Сохранённые источники", "", preserved.notice, "");
    if (preserved.documents.length) lines.push(`Исходные документы: ${preserved.documents.join(", ")}.`, "");
    for (const id of preserved.sourceEventIds) lines.push("Открыть источник через `get_goal`:", "", verbatimBlock(JSON.stringify({ view: "history", event_id: id })), "");
  }
  lines.push("## Контракт и история", "",
    'Полный неизменённый контракт: `get_goal` с `view="full"`. Перед завершением сверьте его, а не только эту сводку.', "",
    `В истории сохранены решения (${state.decisions.length}), события прогресса (${state.progressEvents.length}) и исходные документы (${state.importedDocuments.length}).`, "",
    'Адресное чтение: `get_goal` с `view="history"` возвращает указатель событий; `event_id` открывает исходную запись, `content_offset` продолжает её без потери текста.', "",
  );
  const body = `${lines.join("\n").trimEnd()}\n`;
  return `${GOAL_DOCUMENT_MARKER}${createHash("sha256").update(body).digest("hex")} -->\n${body}`;
}
