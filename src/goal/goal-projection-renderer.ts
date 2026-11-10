import { say } from "../language.js";
import { renderSelfDecided } from "./agreement.js";
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
    case "working": return say("Работа продолжается", "Work in progress");
    case "verifying": return say("Проверка", "Verifying");
    case "blocked": return say("Заблокировано", "Blocked");
    case "awaiting_user": return say("Нужно решение пользователя", "User decision needed");
    case "active": return say("Активна", "Active");
    case "paused": return say("Приостановлена", "Paused");
    case "budgetLimited": return say("Ограничена бюджетом", "Budget limited");
    case "complete": return say("Завершена", "Complete");
  }
}

/** Строит стабильную пользовательскую проекцию CURRENT без побочных эффектов. */
export function renderCurrent(goal: ThreadGoal, progress: GoalProgressReport | null): string {
  const lines = [say("# Текущее состояние", "# Current state"), ""];
  if (!progress) {
    lines.push(say("## Статус", "## Status"), "", say(`Цель создана. Статус: ${statusLabel(goal.status)}.`, `Goal created. Status: ${statusLabel(goal.status)}.`), "", say("## Следующий шаг", "## Next step"), "", say("Начать работу по цели.", "Start working on the goal."), "");
  } else {
    const renderedStatus = goal.status === "complete" ? statusLabel("complete") : statusLabel(progress.status);
    lines.push(say("## Статус", "## Status"), "", `${renderedStatus}. ${say("Фаза", "Phase")}: ${sanitizeTitle(progress.phase)}.`, "");
    lines.push(...section(say("Ход работы", "Course of work"), progress.summary));
    lines.push(...listSection(say("Изменения", "Changes"), progress.changed));
    lines.push(...listSection(say("Готово", "Done"), progress.completed));
    lines.push(...section(say("Решение или проблема", "Decision or problem"), progress.problemOrDecision));
    lines.push(...section(say("Риск и сложность", "Risk and complexity"), progress.riskAndComplexity));
    lines.push(...section(say("Проверка", "Verification"), progress.verification));
    lines.push(...section(say("Следующий шаг", "Next step"), progress.nextStep));
    lines.push(...section(say("Нужен пользователь", "User needed"), progress.needUser));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCurrentProjection(state: GoalProjectionState): string {
  return renderCurrent(state.goal, state.latestProgress);
}

function renderProgressEvent(entry: GoalProgressEventRecord, index: number): string[] {
  const report = entry.report;
  const lines = [`## #${index + 1} · ${goalProgressEventLabel(entry.eventKind)} · ${statusLabel(report.status)}`, "", `${say("Фаза", "Phase")}: ${sanitizeTitle(report.phase)}`, "", `${say("Время", "Time")}: ${new Date(entry.createdAt).toISOString()}`, ""];
  lines.push(...(report.summary?.trim() ? [sanitizeMarkdownBlock(report.summary), ""] : []));
  lines.push(...listSection(say("Изменения", "Changes"), report.changed));
  lines.push(...listSection(say("Готово", "Done"), report.completed));
  lines.push(...section(say("Решение или проблема", "Decision or problem"), report.problemOrDecision));
  lines.push(...section(say("Риск и сложность", "Risk and complexity"), report.riskAndComplexity));
  lines.push(...section(say("Проверка", "Verification"), report.verification));
  lines.push(...section(say("Следующий шаг", "Next step"), report.nextStep));
  lines.push(...section(say("Нужен пользователь", "User needed"), report.needUser));
  return lines;
}

export function renderTimeline(entries: readonly GoalProgressEventRecord[]): string {
  const lines = [say("# История прогресса", "# Progress history"), ""];
  if (entries.length === 0) return `${lines.join("\n")}${say("Пока нет событий прогресса.", "No progress events yet.")}\n`;
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
  const lines = [say("# Решения", "# Decisions"), ""];
  if (entries.length === 0 && !legacyContent?.trim()) return `${lines.join("\n")}${say("Пока нет зафиксированных решений.", "No decisions recorded yet.")}\n`;
  entries.forEach((entry, index) => {
    const decision = entry.source === "approved-amendment" ? verbatimBlock(entry.decision) : sanitizeMarkdownBlock(entry.decision);
    lines.push(`## D-${index + 1} · ${sanitizeTitle(entry.title)}`, "", say("**Решение:**", "**Decision:**"), "", decision, "", say("**Причина:**", "**Reason:**"), "", sanitizeMarkdownBlock(entry.rationale), "");
    if (entry.consequence?.trim()) lines.push(say("**Последствие:**", "**Consequence:**"), "", sanitizeMarkdownBlock(entry.consequence), "");
  });
  lines.push(...legacySection(say("Сохранённые записи до перехода на управляемый формат", "Records kept from before the managed format"), legacyContent));
  return `${lines.join("\n").trimEnd()}\n`;
}

function paperCutStatusLabel(status: ProjectionPaperCutStatus): string {
  return status === "open" ? say("открыта", "open") : status === "resolved" ? say("решена", "resolved") : say("не исправляется", "won't fix");
}

function paperCutSeverityLabel(severity: GoalPaperCutEntry["severity"]): string {
  return severity === "low" ? say("низкий", "low") : severity === "medium" ? say("средний", "medium") : say("высокий", "high");
}

/** Строит стабильный журнал отложенных мелких проблем. */
export function renderPaperCuts(entries: readonly GoalPaperCutEntry[], legacyContent?: string | null): string {
  const lines = [say("# Отложенные проблемы", "# Deferred issues"), ""];
  if (entries.length === 0 && !legacyContent?.trim()) return `${lines.join("\n")}${say("Пока нет отложенных проблем.", "No deferred issues yet.")}\n`;
  entries.forEach((entry, index) => {
    lines.push(`## PC-${index + 1} · ${paperCutSeverityLabel(entry.severity)} ${say("приоритет", "priority")} · ${paperCutStatusLabel(entry.status)}`, "", `### ${sanitizeTitle(entry.title)}`, "", sanitizeMarkdownBlock(entry.impact), "");
    if (entry.revisit?.trim()) lines.push(`${say("**Вернуться:**", "**Revisit:**")} ${sanitizeTitle(entry.revisit)}`, "");
    if (entry.resolution?.trim()) lines.push(`${say("**Результат:**", "**Resolution:**")} ${sanitizeTitle(entry.resolution)}`, "");
  });
  lines.push(...legacySection(say("Сохранённые записи до перехода на управляемый формат", "Records kept from before the managed format"), legacyContent));
  return `${lines.join("\n").trimEnd()}\n`;
}

const GOAL_DOCUMENT_MARKER = "<!-- pi-goal-view:v1:";


/** Строит актуальную сводку без накопления истории; оригиналы доступны через get_goal. */
export function renderGoalDocument(state: GoalProjectionState): string {
  const work = state.workState;
  const progress = state.latestProgress;
  const lines = [say("# Цель", "# Goal"), "", say("Документ обновляется из состояния сессии. Изменения вносите через инструменты цели.", "This document is rebuilt from the session state. Make changes through the goal tools."), "",
    ...section(say("Состояние", "State"), `${statusLabel(state.status === "active" && progress ? progress.status : state.status)}.`),
  ];
  if (state.goal.agreement) {
    // Договорённость — слова владельца в пересказе модели; показываем дословно, как её видит модель.
    lines.push(say(`## Договорённость (редакция ${state.goal.agreement.revision})`, `## Agreement (revision ${state.goal.agreement.revision})`), "", say("**Чего хочет владелец:**", "**What the owner wants:**"), "", verbatimBlock(state.goal.agreement.ownerWants), "",
      say("**Решаю сам — владелец не подтверждал:**", "**Decided myself — not confirmed by the owner:**"), "", verbatimBlock(renderSelfDecided(state.goal.selfDecided ?? [])), "",
      say("**Готово, когда:**", "**Done when:**"), "", verbatimBlock(state.goal.agreement.doneWhen), "");
  }
  if (work) {
    lines.push(...section(say("Замысел", "Intent"), work.outcome), ...section(say("Когда результат достаточен", "When the result is enough"), work.doneWhen), ...section(say("Где мы сейчас", "Where we are"), work.summary));
    if (state.workStateStale) lines.push(say("**Договорённость изменилась. Рабочую сводку нужно сверить с новым контрактом.**", "**The agreement changed. Check the work summary against the new contract.**"), "");
    const labels = { planned: say("Предстоит", "Planned"), active: say("В работе", "In progress"), blocked: say("Заблокировано", "Blocked"), done: say("Готово", "Done"), cancelled: say("Отменено", "Cancelled") };
    const groups = [
      { heading: say("Достигнуто", "Achieved"), items: work.items.filter((item) => item.status === "done") },
      { heading: say("В работе", "In progress"), items: work.items.filter((item) => item.status === "active") },
      { heading: say("Оставшиеся этапы", "Remaining stages"), items: work.items.filter((item) => item.status === "planned" || item.status === "blocked") },
      { heading: say("Отменённые работы", "Cancelled work"), items: work.items.filter((item) => item.status === "cancelled") },
    ];
    for (const group of groups) {
      lines.push(`## ${group.heading}`, "");
      if (!group.items.length) lines.push(say("Не отмечено.", "Nothing marked."), "");
      for (const item of group.items) {
        lines.push(`### ${sanitizeTitle(item.title)}`, "", `${labels[item.status]}. ${item.source === "user" ? say("Поручение пользователя", "User request") : say("Предложение агента", "Agent proposal")}. ${say("Идентификатор", "Identifier")}: ${sanitizeTitle(item.id)}.`, "");
        if (item.result) lines.push(say("**Результат или причина:**", "**Result or reason:**"), "", sanitizeMarkdownBlock(item.result), "");
        if (item.evidence) lines.push(say("**Подтверждение:**", "**Evidence:**"), "", sanitizeMarkdownBlock(item.evidence), "");
        else if (item.status === "done") lines.push(say("Подтверждение результата не записано.", "No evidence recorded for the result."), "");
      }
    }
    const next = selectNextGoalWork(work);
    lines.push(...section(say("Следующий доступный этап", "Next available stage"), next ? `${next.id}: ${next.title}` : say("Доступный этап не выбран; проверьте препятствия и полный контракт.", "No available stage is selected; check blockers and the full contract.")));
    if (goalWorkNeedsCompaction(work)) lines.push(say("**Сводка разрослась.** При следующем `update_goal_work` обобщите завершённое и повторы, сохранив замысел, причины решений, ссылки, ограничения и всю незавершённую работу. История не удаляется.", "**The summary has grown.** In the next `update_goal_work`, condense finished work and repetition while keeping the intent, decision reasons, links, constraints and all unfinished work. History is not deleted."), "");
  } else {
    lines.push(state.status === "complete" ? say("Рабочий план не был записан.", "No work plan was recorded.") : say("Рабочий план ещё не записан. Это не означает, что работа закончена.", "No work plan is recorded yet. This does not mean the work is finished."), "");
    lines.push(...legacySection(say("Исходная договорённость", "Original contract"), state.goal.objective));
    if (progress) lines.push(...section(say("Последнее известное положение", "Last known position"), progress.summary || progress.phase), ...section(say("Ближайший шаг", "Next step"), progress.nextStep));
  }
  if (progress?.needUser) lines.push(...section(say("Нужно решение пользователя", "User decision needed"), progress.needUser));
  if (progress?.status === "blocked") lines.push(...section(say("Препятствие", "Blocker"), progress.problemOrDecision));
  const decisions = work ? state.decisions.filter((entry) => work.activeDecisionIds.includes(entry.id)) : state.decisions;
  lines.push(work ? say("## Действующие решения", "## Current decisions") : say("## Решения для сверки", "## Decisions to reconcile"), "");
  if (!work && decisions.length) lines.push(say("Рабочий снимок ещё не определяет, какие из этих решений действуют. Сверьте их, не объявляя всю историю текущим планом.", "The work snapshot does not yet say which of these decisions are current. Reconcile them without declaring the whole history the current plan."), "");
  if (!decisions.length) lines.push(say("Актуальные решения ещё не отмечены. История не считается действующим планом автоматически.", "No current decisions are marked yet. History is not treated as the current plan automatically."), "");
  for (const entry of decisions) {
    lines.push(`### ${sanitizeTitle(entry.title)}`, "", `${say("Идентификатор", "Identifier")}: ${sanitizeTitle(entry.id)}.`, "",
      entry.source === "approved-amendment" ? verbatimBlock(entry.decision) : sanitizeMarkdownBlock(entry.decision), "",
      say("**Почему так:**", "**Why:**"), "", sanitizeMarkdownBlock(entry.rationale), "", ...(entry.consequence ? [say("**Следствие:**", "**Consequence:**"), "", sanitizeMarkdownBlock(entry.consequence), ""] : []));
  }
  const priorVerification = progress?.verification || [...state.progressEvents].reverse().find((entry) => entry.report.verification)?.report.verification;
  const verification = work ? state.workStateStale ? say("Договорённость изменилась; проверки нужно сверить.", "The agreement changed; checks need reconciling.") : work.verification || (state.verifiedWorkRevision === state.workRevision ? state.workVerification : null) : state.workVerification;
  lines.push(...section(say("Проверки текущего плана", "Checks of the current plan"), verification || say("Подтверждение не записано.", "No evidence recorded.")), ...section(say("Риски", "Risks"), work?.risks));
  if (priorVerification && priorVerification !== verification) lines.push(...section(say("Ранее записанная проверка", "Earlier recorded check"), priorVerification));
  for (const risk of state.paperCuts.filter((entry) => entry.status !== "resolved")) {
    lines.push(`### ${sanitizeTitle(risk.title)}`, "", sanitizeMarkdownBlock(risk.impact), "",
      ...(risk.status === "wont_fix" ? section(say("Почему риск принят", "Why the risk is accepted"), risk.resolution || say("Причина в прежней записи не указана.", "The earlier record gives no reason.")) : section(say("Когда вернуться", "When to revisit"), risk.revisit)));
  }
  const resolvedCount = state.paperCuts.filter((entry) => entry.status === "resolved").length;
  if (resolvedCount) lines.push(say(`Закрыто недочётов: ${resolvedCount}. Исходные записи и причины закрытия сохранены в истории.`, `Resolved issues: ${resolvedCount}. Original records and resolution reasons are kept in history.`), "");
  const preserved = goalPreservedContext(state);
  if (preserved) {
    lines.push(say("## Сохранённые источники", "## Preserved sources"), "", preserved.notice, "");
    if (preserved.documents.length) lines.push(`${say("Исходные документы", "Original documents")}: ${preserved.documents.join(", ")}.`, "");
    for (const id of preserved.sourceEventIds) lines.push(say("Открыть источник через `get_goal`:", "Open the source with `get_goal`:"), "", verbatimBlock(JSON.stringify({ view: "history", event_id: id })), "");
  }
  lines.push(say("## Контракт и история", "## Contract and history"), "",
    say('Полный неизменённый контракт: `get_goal` с `view="full"`. Перед завершением сверьте его, а не только эту сводку.', 'Full unchanged contract: `get_goal` with `view="full"`. Check it before completion, not only this summary.'), "",
    say(`В истории сохранены решения (${state.decisions.length}), события прогресса (${state.progressEvents.length}) и исходные документы (${state.importedDocuments.length}).`,
      `History keeps decisions (${state.decisions.length}), progress events (${state.progressEvents.length}) and original documents (${state.importedDocuments.length}).`), "",
    say('Адресное чтение: `get_goal` с `view="history"` возвращает указатель событий; `event_id` открывает исходную запись, `content_offset` продолжает её без потери текста.', 'Addressed reading: `get_goal` with `view="history"` returns an event index; `event_id` opens the original record, `content_offset` continues it without losing text.'), "",
  );
  const body = `${lines.join("\n").trimEnd()}\n`;
  return `${GOAL_DOCUMENT_MARKER}${createHash("sha256").update(body).digest("hex")} -->\n${body}`;
}
