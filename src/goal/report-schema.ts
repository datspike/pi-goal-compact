import { say } from "../language.js";
/**
 * Схема отчёта о ходе цели: виды событий, пределы полей и проверка.
 * Отдельный лист, чтобы документ цели и журнал отчётов не зависели друг от друга.
 */

export const MAX_REPORT_PHASE_CHARS = 160;

export const MAX_REPORT_SUMMARY_CHARS = 480;

export const MAX_REPORT_CHANGED_CHARS = 2_000;

export const MAX_REPORT_COMPLETED_CHARS = 2_000;

export const MAX_REPORT_PROBLEM_CHARS = 2_000;

export const MAX_REPORT_RISK_CHARS = 1_200;

export const MAX_REPORT_VERIFICATION_CHARS = 2_000;

export const MAX_REPORT_NEXT_STEP_CHARS = 1_200;

export const MAX_REPORT_NEED_USER_CHARS = 1_200;

export type GoalProgressStatus = "working" | "verifying" | "blocked" | "awaiting_user";

export type GoalProgressEventKind =
  | "goal_started"
  | "phase_changed"
  | "progress_checkpoint"
  | "verification"
  | "blocker_opened"
  | "blocker_resolved"
  | "decision_recorded"
  | "artifact_updated"
  | "goal_completed";

export interface GoalProgressReport {
  /** Typed durable event discriminator. Omitted in v1 entries; those replay as progress_checkpoint. */
  eventKind?: GoalProgressEventKind;
  status: GoalProgressStatus;
  phase: string;
  /** Reader-facing narrative. Legacy reports have no summary; all new publishes require it. */
  summary?: string;
  changed?: string;
  completed?: string;
  problemOrDecision?: string;
  riskAndComplexity?: string;
  verification?: string;
  nextStep: string;
  needUser?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

// Model-authored prose is not a terminal control channel. Keep LF for paragraphs.
const TERMINAL_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

const TERMINAL_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;

export function stripGoalTerminalControls(value: string, preserveFileLinks = false): string {
  const links: string[] = [];
  const protectedValue = preserveFileLinks ? value.replace(/\u001b\]8;;(file:[^\u0007\u001b]*)\u001b\\([^\u001b]*?)\u001b\]8;;\u001b\\/gu, (_match, href: string, label: string) => {
    const token = `\uE000${links.length}\uE001`;
    links.push(`\u001b]8;;${href}\u001b\\${label}\u001b]8;;\u001b\\`);
    return token;
  }) : value;
  const clean = protectedValue
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/gu, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/gu, "")
    .replace(TERMINAL_CONTROLS, "");
  return preserveFileLinks ? clean.replace(/\uE000(\d+)\uE001/gu, (_match, index: string) => links[Number(index)] ?? "") : clean;
}

export function isOptionalText(value: unknown, maxLength: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && [...value.trim()].length <= maxLength);
}

export function isGoalProgressEventKind(value: unknown): value is GoalProgressEventKind {
  return value === "goal_started" || value === "phase_changed" || value === "progress_checkpoint" ||
    value === "verification" || value === "blocker_opened" || value === "blocker_resolved" ||
    value === "decision_recorded" || value === "artifact_updated" || value === "goal_completed";
}

export function normalizedGoalProgressEventKind(report: GoalProgressReport): GoalProgressEventKind {
  return report.eventKind ?? "progress_checkpoint";
}

export function goalProgressEventLabel(kind: GoalProgressEventKind): string {
  switch (kind) {
    case "goal_started": return say("Старт цели", "Goal started");
    case "phase_changed": return say("Смена фазы", "Phase changed");
    case "progress_checkpoint": return "Checkpoint";
    case "verification": return say("Проверка", "Verification");
    case "blocker_opened": return say("Блокер открыт", "Blocker opened");
    case "blocker_resolved": return say("Блокер снят", "Blocker resolved");
    case "decision_recorded": return say("Решение", "Decision");
    case "artifact_updated": return say("Артефакт обновлён", "Artifact updated");
    case "goal_completed": return say("Цель завершена", "Goal completed");
  }
}

export function validateGoalProgressReport(value: unknown): string | null {
  if (!isRecord(value)) {
    return say("Отчёт должен быть объектом.", "Report must be an object.");
  }
  if (value.eventKind !== undefined && !isGoalProgressEventKind(value.eventKind)) {
    return say("Недопустимый eventKind отчёта.", "Report eventKind is invalid.");
  }
  if (!isGoalProgressStatus(value.status)) {
    return say("Недопустимый status отчёта.", "Report status is invalid.");
  }
  if (typeof value.phase !== "string" || value.phase.trim().length === 0 || [...value.phase.trim()].length > MAX_REPORT_PHASE_CHARS) {
    return say(`phase должно содержать от 1 до ${MAX_REPORT_PHASE_CHARS} знаков.`, `phase must contain 1 to ${MAX_REPORT_PHASE_CHARS} characters.`);
  }
  if (value.summary !== undefined && (typeof value.summary !== "string" || !value.summary.trim() || [...value.summary].length > MAX_REPORT_SUMMARY_CHARS)) {
    return say(`summary должно содержать от 1 до ${MAX_REPORT_SUMMARY_CHARS} знаков.`, `summary must contain 1 to ${MAX_REPORT_SUMMARY_CHARS} characters.`);
  }
  if (typeof value.summary === "string" && TERMINAL_CONTROL.test(value.summary)) {
    return say("summary не может содержать управляющие символы терминала.", "summary must not contain terminal control characters.");
  }
  if (typeof value.nextStep !== "string" || value.nextStep.trim().length === 0 || [...value.nextStep.trim()].length > MAX_REPORT_NEXT_STEP_CHARS) {
    return say(`nextStep должно содержать от 1 до ${MAX_REPORT_NEXT_STEP_CHARS} знаков.`, `nextStep must contain 1 to ${MAX_REPORT_NEXT_STEP_CHARS} characters.`);
  }
  if (value.status === "awaiting_user" && (typeof value.needUser !== "string" || value.needUser.trim().length === 0)) {
    return say("При status awaiting_user поле needUser не может быть пустым.", "needUser must be non-empty when status is awaiting_user.");
  }
  const optionalFields: Array<[keyof Omit<GoalProgressReport, "status" | "phase" | "nextStep">, number]> = [
    ["changed", MAX_REPORT_CHANGED_CHARS],
    ["completed", MAX_REPORT_COMPLETED_CHARS],
    ["problemOrDecision", MAX_REPORT_PROBLEM_CHARS],
    ["riskAndComplexity", MAX_REPORT_RISK_CHARS],
    ["verification", MAX_REPORT_VERIFICATION_CHARS],
    ["needUser", MAX_REPORT_NEED_USER_CHARS],
  ];
  for (const [field, maxLength] of optionalFields) {
    if (!isOptionalText(value[field], maxLength)) {
      return say(`${field} должно быть строкой не длиннее ${maxLength} знаков.`, `${field} must be a string of at most ${maxLength} characters.`);
    }
  }
  return null;
}

/** Validates a newly submitted report while keeping v1 replay compatibility separate. */
export function validateNewGoalProgressReport(value: unknown): string | null {
  const structuralError = validateGoalProgressReport(value);
  if (structuralError) return structuralError;
  if (!isRecord(value)) return say("Отчёт должен быть объектом.", "Report must be an object.");
  const hasMeaningfulDelta = ["changed", "completed", "problemOrDecision", "riskAndComplexity", "verification"]
    .some((field) => typeof value[field] === "string" && value[field].trim().length > 0);
  const eventKind = isGoalProgressEventKind(value.eventKind) ? value.eventKind : "progress_checkpoint";
  const has = (field: keyof GoalProgressReport): boolean => typeof value[field] === "string" && value[field].trim().length > 0;
  switch (eventKind) {
    case "goal_started":
      if (!has("changed") && !has("completed")) return say("goal_started требует changed или completed.", "goal_started requires changed or completed.");
      break;
    case "phase_changed":
      if (!has("changed")) return say("phase_changed требует changed.", "phase_changed requires changed.");
      break;
    case "verification":
      if (!has("verification")) return say("verification требует поле verification.", "verification requires verification.");
      break;
    case "blocker_opened":
      if (!has("problemOrDecision")) return say("blocker_opened требует problemOrDecision.", "blocker_opened requires problemOrDecision.");
      break;
    case "blocker_resolved":
      if (!has("problemOrDecision") && !has("completed")) return say("blocker_resolved требует problemOrDecision или completed.", "blocker_resolved requires problemOrDecision or completed.");
      break;
    case "decision_recorded":
      if (!has("problemOrDecision")) return say("decision_recorded требует problemOrDecision.", "decision_recorded requires problemOrDecision.");
      break;
    case "artifact_updated":
      if (!has("changed") && !has("completed")) return say("artifact_updated требует changed или completed.", "artifact_updated requires changed or completed.");
      break;
    case "goal_completed":
      if (!has("verification") && !has("completed")) return say("goal_completed требует verification или completed.", "goal_completed requires verification or completed.");
      break;
    case "progress_checkpoint":
      break;
  }
  switch (value.status) {
    case "verifying":
      return typeof value.verification === "string" && value.verification.trim().length > 0
        ? null
        : say("verifying требует verification.", "verifying requires verification.");
    case "blocked":
      return typeof value.problemOrDecision === "string" && value.problemOrDecision.trim().length > 0
        ? null
        : say("blocked требует problemOrDecision.", "blocked requires problemOrDecision.");
    case "awaiting_user":
      return typeof value.needUser === "string" && value.needUser.trim().length > 0
        ? null
        : say("При status awaiting_user поле needUser не может быть пустым.", "needUser must be non-empty when status is awaiting_user.");
    case "working":
      return hasMeaningfulDelta
        ? null
        : say("working требует хотя бы одно из полей changed, completed, problemOrDecision, riskAndComplexity или verification.", "working requires at least one of changed, completed, problemOrDecision, riskAndComplexity, or verification.");
    default:
      return say("Недопустимый status отчёта.", "Report status is invalid.");
  }
}

export function isGoalProgressStatus(value: unknown): value is GoalProgressStatus {
  return value === "working" || value === "verifying" || value === "blocked" || value === "awaiting_user";
}

export function isGoalProgressSemanticText(value: string | undefined): boolean {
  const normalized = value?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  return !/^(bg_wait|инструмент|завершён инструмент|ошибка инструмента|модель формирует ответ|модель работает обычно|ожидание следующего действия|tool|completed tool|tool error|model is generating response|waiting for next action)(?:\s*[:·].*)?$/u.test(normalized);
}
