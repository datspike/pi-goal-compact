import { say } from "../language.js";
import { createHash } from "node:crypto";

/**
 * Договорённость (Д1) — короткий пересказ цели, который модель пишет при создании и правке.
 * Расширение её не пересказывает и не проверяет на дословность: хранит и вставляет как есть.
 */
export interface GoalAgreement {
  /** Чего хочет владелец: результат и важные для него качества. */
  ownerWants: string;
  /** Готово, когда: критерий готовности, включая условие отрицательного итога. */
  doneWhen: string;
  /** Номер редакции; растёт с каждой правкой цели. */
  revision: number;
}

export const SELF_DECIDED_KINDS = ["assumption", "deferred_by_owner", "proposal"] as const;
export type SelfDecidedKind = (typeof SELF_DECIDED_KINDS)[number];
export const SELF_DECIDED_STATES = ["unconfirmed", "confirmed", "rejected"] as const;
export type SelfDecidedState = (typeof SELF_DECIDED_STATES)[number];

/** Пункт списка «Решаю сам — владелец не подтверждал» (Д4). */
export interface SelfDecidedItem {
  id: string;
  kind: SelfDecidedKind;
  text: string;
  state: SelfDecidedState;
  /** Запись журнала с репликой владельца, сменившей состояние; ставит расширение. */
  ownerEntryId?: string;
  createdAt: number;
}

/** Первая и третья части договорённости вместе (Т3.4). */
export const MAX_AGREEMENT_CHARS = 2000;
export const MAX_SELF_DECIDED_ITEM_CHARS = 600;
export const MAX_SELF_DECIDED_ITEMS = 30;

// Функции, а не таблицы: язык задаётся при загрузке расширения, после импорта модулей.
const kindLabel = (kind: SelfDecidedKind): string => ({
  assumption: say("допущение", "assumption"),
  deferred_by_owner: say("отложено тобой", "deferred by you"),
  proposal: say("моё предложение", "my proposal"),
})[kind];

const stateLabel = (state: SelfDecidedState): string => ({
  unconfirmed: say("не подтверждено", "not confirmed"),
  confirmed: say("подтверждено владельцем", "confirmed by the owner"),
  rejected: say("отклонено владельцем", "rejected by the owner"),
})[state];

const chars = (text: string): number => [...text].length;

export function validateAgreement(ownerWants: string, doneWhen: string): string | null {
  if (!ownerWants.trim()) return say("agreement.owner_wants не может быть пустым.", "agreement.owner_wants must not be empty.");
  if (!doneWhen.trim()) return say("agreement.done_when не может быть пустым.", "agreement.done_when must not be empty.");
  const total = chars(ownerWants.trim()) + chars(doneWhen.trim());
  if (total > MAX_AGREEMENT_CHARS) return say(`agreement.owner_wants и agreement.done_when вместе должны быть не длиннее ${MAX_AGREEMENT_CHARS} знаков (сейчас ${total}).`, `agreement.owner_wants and agreement.done_when together must be ${MAX_AGREEMENT_CHARS} characters or fewer (got ${total}).`);
  return null;
}

export function validateSelfDecidedText(text: string): string | null {
  if (!text.trim()) return say("Текст пункта self_decided не может быть пустым.", "self_decided item text must not be empty.");
  if (chars(text.trim()) > MAX_SELF_DECIDED_ITEM_CHARS) return say(`Текст пункта self_decided должен быть не длиннее ${MAX_SELF_DECIDED_ITEM_CHARS} знаков.`, `self_decided item text must be ${MAX_SELF_DECIDED_ITEM_CHARS} characters or fewer.`);
  return null;
}

export function selfDecidedItemId(goalId: string, kind: SelfDecidedKind, text: string): string {
  return `S-${createHash("sha256").update(`${goalId}\u0000${kind}\u0000${text.trim()}`).digest("hex").slice(0, 12)}`;
}

export function isGoalAgreement(value: unknown): value is GoalAgreement {
  if (!value || typeof value !== "object") return false;
  const candidate = value as GoalAgreement;
  return typeof candidate.ownerWants === "string" && typeof candidate.doneWhen === "string" && Number.isSafeInteger(candidate.revision) && candidate.revision >= 1;
}

export function isSelfDecidedItem(value: unknown): value is SelfDecidedItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as SelfDecidedItem;
  return typeof candidate.id === "string" && typeof candidate.text === "string" && typeof candidate.createdAt === "number" &&
    (SELF_DECIDED_KINDS as readonly string[]).includes(candidate.kind) && (SELF_DECIDED_STATES as readonly string[]).includes(candidate.state) &&
    (candidate.ownerEntryId === undefined || typeof candidate.ownerEntryId === "string");
}

/** Нумерованный список «Решаю сам», который видят и владелец, и модель (Т4.3). */
export function renderSelfDecided(items: readonly SelfDecidedItem[]): string {
  if (items.length === 0) return say("Пунктов нет.", "No items.");
  return items.map((item, index) => {
    const state = item.state === "unconfirmed" ? "" : ` — ${stateLabel(item.state)}`;
    return `${index + 1}. [${kindLabel(item.kind)}${state}] ${item.text} (${item.id})`;
  }).join("\n");
}

export interface AgreementSource {
  objective: string;
  agreement?: GoalAgreement;
  selfDecided?: readonly SelfDecidedItem[];
}

/**
 * Договорённость в том виде, в каком она стоит в окне модели и возвращается первой попыткой закрытия.
 * У цели, созданной прежней парой расширений, договорённости нет: вместо неё идёт прежний договор (Т10.3).
 */
export function renderAgreement(goal: AgreementSource): string {
  if (!goal.agreement) return say(`## Договорённость\n\nДоговорённость не записана; действует договор цели:\n\n${goal.objective}`, `## Agreement\n\nNo agreement is recorded; the goal contract applies:\n\n${goal.objective}`);
  return [
    say(`## Договорённость (редакция ${goal.agreement.revision})`, `## Agreement (revision ${goal.agreement.revision})`),
    say("### Чего хочет владелец", "### What the owner wants"),
    goal.agreement.ownerWants,
    say("### Решаю сам — владелец не подтверждал", "### Decided myself — not confirmed by the owner"),
    renderSelfDecided(goal.selfDecided ?? []),
    say("### Готово, когда", "### Done when"),
    goal.agreement.doneWhen,
  ].join("\n\n");
}

export function unconfirmedSelfDecided(goal: AgreementSource): SelfDecidedItem[] {
  return (goal.selfDecided ?? []).filter((item) => item.state === "unconfirmed");
}

/** Отпечаток для закрытия в два шага: меняется при любой правке договорённости, списка или плана. */
export function completionFingerprint(goal: AgreementSource, planRevision: number): string {
  const payload = JSON.stringify({ objective: goal.objective, agreement: goal.agreement ?? null,
    items: (goal.selfDecided ?? []).map((item) => [item.id, item.state, item.text]), planRevision });
  return createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

/**
 * Ответ на первую попытку закрытия (Т6.1): договорённость, неподтверждённые пункты и просьба
 * сверить работу. Вторая попытка при тех же договорённости и плане закрывает цель.
 */
export function completionReturnMessage(goal: AgreementSource): string {
  const unconfirmed = unconfirmedSelfDecided(goal);
  return [
    say("Цель ещё не закрыта: сначала сверь работу с договорённостью.", "The goal is not closed yet: first check the work against the agreement."),
    renderAgreement(goal),
    say("По каждому пункту «Готово, когда» назови доказательство. Назови, что из «Чего хочет владелец» не сделано; если что-то не сделано, продолжай работу.", "Name the evidence for each point of \"Done when\". Name what from \"What the owner wants\" is not done; if anything is not done, keep working."),
    unconfirmed.length > 0 ? say(`Владелец не подтверждал ${unconfirmed.length} пункт(ов) «Решаю сам»; при закрытии он увидит их список.`, `The owner has not confirmed ${unconfirmed.length} \"Decided myself\" item(s); they will see the list at completion.`) : "",
    say("Если всё сделано, вызови update_goal(complete) ещё раз, не меняя договорённость и план.", "If everything is done, call update_goal(complete) again without changing the agreement or the plan."),
  ].filter(Boolean).join("\n\n");
}
