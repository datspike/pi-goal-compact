import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { MAX_COMPACT_PAYLOAD_CHARS, calculateCompactBudget, type CompactCapability } from "./compact-budget.js";
import type { Api, AssistantMessage, Model, ModelsApiStreamOptions, TextContent, Usage } from "@earendil-works/pi-ai";
import { language, type Language } from "../language.js";
import { carryFileHints, collectFileLists, formatFileHints, withoutFileTracking, withoutMessageFileTracking, type AgentMessage } from "./file-hints.js";
import {
	convertToLlm,
	prepareBranchEntries,
	serializeConversation,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeEvent,
	type SessionBeforeTreeResult,
} from "@earendil-works/pi-coding-agent";

const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Do not continue the conversation. Output only the requested structured summary.";
const DEFAULT_RESERVE_TOKENS = 16_384;
const NATIVE_BRANCH_SUMMARY_PREAMBLE = "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

/** Разделы истории собраны до начала текущего хода; явное старшинство нужно, иначе прошлая цель и шаги выглядят действующими. */
export const SPLIT_TURN_HEADER = "**Контекст разрезанного хода:**\nЭтот ход начат после истории выше. Если его запрос меняет цель, ограничения или следующие шаги, действует он; разделы выше описывают состояние до хода.";

export const RUSSIAN_COMPACTION_FOCUS = `
Пиши весь естественный текст итогового summary на русском языке.
Сохрани смысл и структуру стандартного checkpoint summary, но используй такие русские разделы:
- ## Цель
- ## Ограничения и предпочтения
- ## Прогресс
- ### Готово
- ### В работе
- ### Заблокировано
- ## Ключевые решения
- ## Следующие шаги
- ## Критический контекст

Не продолжай разговор и не отвечай на вопросы из истории: выведи только структурированное summary. Будь кратким, но не выбрасывай незавершённую работу, ограничения, принятые решения, причины решений, ошибки, критерии завершения и достаточности из истории и данные, необходимые для продолжения.
В «## Следующие шаги» помечай источник каждого шага: «решение пользователя» или «предложение агента». Не записывай как шаг закрытие с отрицательным итогом, fallback или остановку, если пользователь этого не решал.
В «## Ключевые решения» сохраняй испробованные пути с причиной отказа, ещё не проверенные альтернативы и израсходованный и оставшийся бюджет.
В «## Ключевые решения» каждому решению явно ставь статус: «принято», «открыто» или «отклонено». Открытое решение не описывай как принятое, а отклонённый путь не возвращай как действующий. Если пользователь изменил прежнее решение, новое помечай действующим, а прежнее — заменённым.
Если работа затрагивает несколько связанных объектов — MR, веток, целевых окружений, репозиториев или артефактов с разными версиями — перечисли их все в «## Критический контекст»: идентификатор, source, target и соответствующий артефакт. Не сворачивай набор в один пример, даже когда изменения функционально одинаковые.
Высказывания пользователя о цели и достижимости результата сохраняй дословно.
Пиши по-русски также контекст разрезанного хода. Для него используй разделы «## Исходный запрос», «## Прогресс на текущий момент» и «## Контекст для продолжения».
Не переводи и не изменяй точные технические фрагменты: пути, имена файлов, команды, идентификаторы, имена функций, API, сообщения ошибок и код. Сохраняй в смысловом тексте точные пути, необходимые для незавершённой работы, проверок и ограничений. Не создавай блоки <read-files>, <modified-files> или <file-hints>: расширение добавит ограниченные файловые наводки отдельно.`.trim();

export const RUSSIAN_TREE_SUMMARY_INSTRUCTIONS = `Составь краткое структурированное summary оставляемой ветки, чтобы к ней можно было вернуться позже.

Пиши весь естественный текст на русском языке и используй ровно этот формат:

## Цель
[Чего пользователь пытался добиться в этой ветке]

## Ограничения и предпочтения
- [Ограничения, предпочтения и требования]
- [Или «(нет)», если их не было]

## Прогресс
### Готово
- [x] [Завершённые действия и изменения]

### В работе
- [ ] [Начатая, но не завершённая работа]

### Заблокировано
- [Проблемы, которые мешают продолжению, или «(нет)»]

## Ключевые решения
- **[Решение]**: [Краткая причина]

## Следующие шаги
1. [Что нужно сделать дальше]

Сохраняй точные пути, имена файлов, функции, команды и сообщения ошибок. Не продолжай разговор и не добавляй ответов на вопросы из истории; выведи только summary. Сохраняй в смысловом тексте точные пути для незавершённой работы и проверок. Не создавай блоки <read-files>, <modified-files> или <file-hints>: расширение добавит файловые наводки отдельно.`.trim();

const RUSSIAN_TURN_PREFIX_INSTRUCTIONS = `Это ранняя часть пользовательского хода, а его недавняя часть сохранена отдельно. Составь краткий контекст для продолжения на русском языке и используй ровно этот формат:

## Исходный запрос
[Что пользователь просил в этом ходу; ключевые фразы о цели и достижимости — дословно. Если запрос отменяет или меняет прежнюю цель, ограничения или план, назови, что именно]

## Прогресс на текущий момент
- [Ключевые решения и действия в ранней части]

## Контекст для продолжения
- [Что нужно знать, чтобы понять сохранённую недавнюю часть]

Сохраняй точные пути, команды, имена функций и сообщения ошибок. Выведи только summary.`;

/** Английский вариант (Т11.3): те же правила, что у русских инструкций выше, в переводе. */
export const ENGLISH_COMPACTION_FOCUS = `
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Do not continue the conversation and do not answer questions from the history: output only the structured summary. Be concise, but do not drop unfinished work, constraints, decisions made, reasons for decisions, errors, completion and sufficiency criteria from the history, or data needed to continue.
In "## Next Steps", mark the source of each step: "user decision" or "agent proposal". Do not record closing with a negative result, a fallback or stopping as a step unless the user decided it.
In "## Key Decisions", keep the paths already tried with the reason they were rejected, alternatives not yet checked, and the budget spent and remaining.
In "## Key Decisions", give every decision an explicit status: "accepted", "open" or "rejected". Do not describe an open decision as accepted, and do not bring a rejected path back as current. If the user changed an earlier decision, mark the new one as current and the earlier one as replaced.
If the work touches several related objects — MRs, branches, target environments, repositories or artifacts with different versions — list all of them in "## Critical Context": identifier, source, target and the matching artifact. Do not collapse the set into one example, even when the changes are functionally the same.
Keep the user's statements about the goal and about whether the result is achievable verbatim.
For a split turn, use the sections "## Original Request", "## Progress So Far" and "## Context Needed to Continue".
Do not translate or alter exact technical fragments: paths, file names, commands, identifiers, function names, APIs, error messages and code. Keep in the prose the exact paths needed for unfinished work, checks and constraints. Do not create <read-files>, <modified-files> or <file-hints> blocks: the extension adds bounded file hints separately.`.trim();

export const ENGLISH_TREE_SUMMARY_INSTRUCTIONS = `Write a brief structured summary of the branch being left so that it can be resumed later.

Use exactly this format:

## Goal
[What the user was trying to accomplish in this branch]

## Constraints & Preferences
- [Constraints, preferences and requirements]
- [Or "(none)" if there were none]

## Progress
### Done
- [x] [Completed actions and changes]

### In Progress
- [ ] [Work started but not finished]

### Blocked
- [Issues preventing progress, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next]

Preserve exact paths, file names, functions, commands and error messages. Do not continue the conversation and do not add answers to questions from the history; output only the summary. Keep in the prose the exact paths for unfinished work and checks. Do not create <read-files>, <modified-files> or <file-hints> blocks: the extension adds file hints separately.`.trim();

const ENGLISH_TURN_PREFIX_INSTRUCTIONS = `This is the early part of a user turn; its recent part is kept separately. Write a brief context for continuing and use exactly this format:

## Original Request
[What the user asked for in this turn; key phrases about the goal and achievability verbatim. If the request cancels or changes the earlier goal, constraints or plan, name what exactly]

## Progress So Far
- [Key decisions and actions in the early part]

## Context Needed to Continue
- [What is needed to understand the kept recent part]

Preserve exact paths, commands, function names and error messages. Output only the summary.`;

interface SummaryText {
	focus: string;
	tree: string;
	turnPrefix: string;
	splitTurnHeader: string;
	extraCompaction: string;
	extraTree: string;
	noHistory: string;
}

const SUMMARY_TEXT: Readonly<Record<Language, SummaryText>> = {
	ru: {
		focus: RUSSIAN_COMPACTION_FOCUS, tree: RUSSIAN_TREE_SUMMARY_INSTRUCTIONS, turnPrefix: RUSSIAN_TURN_PREFIX_INSTRUCTIONS,
		splitTurnHeader: SPLIT_TURN_HEADER,
		extraCompaction: "Дополнительный checkpoint-контекст и инструкции текущей операции:",
		extraTree: "Дополнительные инструкции текущего перехода по дереву:",
		noHistory: "Предыдущей истории нет.",
	},
	en: {
		focus: ENGLISH_COMPACTION_FOCUS, tree: ENGLISH_TREE_SUMMARY_INSTRUCTIONS, turnPrefix: ENGLISH_TURN_PREFIX_INSTRUCTIONS,
		splitTurnHeader: "**Turn Context (split turn):**\nThis turn started after the history above. If its request changes the goal, constraints or next steps, it takes precedence; the sections above describe the state before the turn.",
		extraCompaction: "Additional checkpoint context and instructions for this operation:",
		extraTree: "Additional instructions for this tree navigation:",
		noHistory: "No previous history.",
	},
};

/** Инструкции и служебные строки сводки на языке расширения. */
export function summaryText(): SummaryText {
	return SUMMARY_TEXT[language()];
}

/** Обе границы есть в сохранённых сводках, в том числе после смены языка. */
export function isSplitTurnBoundary(line: string): boolean {
  return Object.values(SUMMARY_TEXT).some(({ splitTurnHeader }) => splitTurnHeader.startsWith(`${line}\n`));
}

const SUMMARY_HEADINGS: Readonly<Record<string, string>> = {
	"## Goal": "## Цель",
	"## Constraints & Preferences": "## Ограничения и предпочтения",
	"## Progress": "## Прогресс",
	"### Done": "### Готово",
	"### In Progress": "### В работе",
	"### Blocked": "### Заблокировано",
	"## Key Decisions": "## Ключевые решения",
	"## Next Steps": "## Следующие шаги",
	"## Critical Context": "## Критический контекст",
	"## Original Request": "## Исходный запрос",
	"## Progress So Far": "## Прогресс на текущий момент",
	"## Context Needed to Continue": "## Контекст для продолжения",
	"## Early Progress": "## Ранний прогресс",
	"## Context for Suffix": "## Контекст для сохранённой части",
	"**Turn Context (split turn):**": "**Контекст разрезанного хода:**",
};

type SummaryLine = { line: string; protected: boolean; fileBlockStart?: true };
type FenceState = { character: "`" | "~"; length: number };

function scanSummary(summary: string): { lines: SummaryLine[]; fence: FenceState | undefined } {
	let fence: FenceState | undefined;
	let machineBlock: string | undefined;
	const lines = summary.split("\n").map((line): SummaryLine => {
		const trimmed = line.trim();
		if (fence) {
			const close = trimmed.match(/^(`+|~+)\s*$/)?.[1];
			const closesFence = close && close[0] === fence.character && close.length >= fence.length;
			if (closesFence) fence = undefined;
			return { line, protected: true };
		}
		if (machineBlock) {
			if (trimmed === machineBlock) machineBlock = undefined;
			return { line, protected: true };
		}
		const openingFence = trimmed.match(/^(`{3,}|~{3,})/)?.[1];
		if (openingFence) {
			fence = { character: openingFence[0] as "`" | "~", length: openingFence.length };
			return { line, protected: true };
		}
		const fileTag = /^<(read-files|modified-files|file-hints)>$/.exec(line.trimEnd())?.[1];
		if (fileTag) {
			machineBlock = `</${fileTag}>`;
			return { line, protected: true, fileBlockStart: true };
		}
		return { line, protected: false };
	});
	return { lines, fence };
}

/** Отделяет строки структуры сводки от кода и машинных блоков. */
export function classifySummaryLines(summary: string): SummaryLine[] {
	return scanSummary(summary).lines;
}

/** Наша граница или приложение не должны стать частью незакрытого примера сводчика. */
function closeFenceBeforeAppend(summary: string): string {
	const { fence } = scanSummary(summary);
	return fence ? `${summary}\n${fence.character.repeat(fence.length)}` : summary;
}

/**
 * Переводит только известные структурные заголовки вне code и machine-readable блоков.
 * В английском варианте заголовки уже английские, и сводка не меняется.
 */
export function localizeSummaryStructure(summary: string): string {
	if (language() === "en") return summary;
	return classifySummaryLines(summary)
		.map(({ line, protected: isProtected }) => !isProtected ? SUMMARY_HEADINGS[line] ?? line : line)
		.join("\n");
}

/** Убирает только точную англоязычную приписку native branch summarizer. */
export function stripBranchSummaryPreamble(summary: string): string {
	return summary.startsWith(NATIVE_BRANCH_SUMMARY_PREAMBLE)
		? summary.slice(NATIVE_BRANCH_SUMMARY_PREAMBLE.length).trimStart()
		: summary.trim();
}

export function hasStructuralHeading(summary: string, headings: string[]): boolean {
	return classifySummaryLines(summary).some(({ line, protected: isProtected }) => !isProtected && headings.includes(line));
}

// Заголовки обоих языков: прежняя сводка могла быть написана до смены языка.
function hasLocalizedSummaryStructure(summary: string, allowSplitTurn: boolean): boolean {
	return hasStructuralHeading(summary, allowSplitTurn ? ["## Цель", "## Goal", "## Исходный запрос", "## Original Request"] : ["## Цель", "## Goal"]);
}

function hasLocalizedPrefixStructure(summary: string): boolean {
	return hasStructuralHeading(summary, ["## Исходный запрос", "## Original Request"]);
}

type SummaryResponse = {
    text: string;
    usage?: Usage | undefined;
};

export type CompactionFailureReason = "aborted" | "context-changed" | "invalid-response" | "request-failed" | "insufficient-window" | "unsupported" | "request-too-large";

export type CompactionSummaryOptions = {
    capability?: CompactCapability;
    model?: Model<Api>;
    isCurrent?: () => boolean;
    /** Паузы перед повторами запроса сводки после сбоя запроса; без них повторов нет. */
    retryDelaysMs?: readonly number[];
    onRetry?: (attempt: number, attempts: number, detail?: string) => void;
    onFailure?: (reason: string, detail?: string) => void;
};

export type CompactionSummaryResult = {
    compaction: NonNullable<SessionBeforeCompactResult["compaction"]>;
} | {
    cancel: true;
};

class SummaryFailure extends Error {
    /** detail — слова провайдера или сети: без них сбой запроса нельзя разобрать по журналу. */
    constructor(readonly reason: CompactionFailureReason, readonly detail?: string) {
        super(reason);
        this.name = "SummaryFailure";
    }
}

type ModelIdentity = {
    provider: unknown;
    id: unknown;
    api: unknown;
    baseUrl: unknown;
};

type RouteIdentity = {
    registry: unknown;
    provider: unknown;
    model: ModelIdentity;
};

type SessionIdentity = {
    sessionId: unknown;
    sessionFile: unknown;
    tree: readonly string[] | undefined;
};

type OperationSnapshot = {
    signal: AbortSignal;
    activeModel: ModelIdentity | undefined;
    activeRoute: RouteIdentity | undefined;
    serviceModel: ModelIdentity;
    serviceModelRef: Model<Api>;
    serviceRoute: RouteIdentity;
    session: SessionIdentity;
};

type CompactionRequestGuard = {
    capability?: CompactCapability;
    model: Model<Api>;
    signal: AbortSignal;
    validate: () => void;
    retryDelaysMs?: readonly number[];
    onRetry?: (attempt: number, attempts: number, detail?: string) => void;
};

function modelIdentity(model: Model<Api> | undefined): ModelIdentity | undefined {
    if (!model)
        return undefined;
    return { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl };
}

function sameModelIdentity(left: ModelIdentity | undefined, right: ModelIdentity | undefined): boolean {
    return left?.provider === right?.provider && left?.id === right?.id && left?.api === right?.api && left?.baseUrl === right?.baseUrl;
}

function routeIdentity(ctx: ExtensionContext, model: Model<Api> | undefined): RouteIdentity | undefined {
    const identity = modelIdentity(model);
    if (!model || !identity)
        return undefined;
    // Тестовые и старые реестры моделей могут не иметь getProvider; тогда маршрут сравнивается без провайдера.
    const registry: Partial<ExtensionContext["modelRegistry"]> | undefined = ctx.modelRegistry;
    const provider = typeof registry?.getProvider === "function" ? registry.getProvider(model.provider) : undefined;
    return { registry, provider, model: identity };
}

function sameRoute(left: RouteIdentity | undefined, right: RouteIdentity | undefined): boolean {
    return left?.registry === right?.registry && left?.provider === right?.provider && sameModelIdentity(left?.model, right?.model);
}

/** Extension state, session names and usage records never reach the model, so other extensions may append them during a summary request. */
export function isContextEntry(entry: { type?: unknown } | null | undefined): boolean {
    return entry?.type !== "custom" && entry?.type !== "session_info" && entry?.type !== "usage";
}

type SessionReader = Partial<ExtensionContext["sessionManager"]> | undefined;

function branchIdentity(ctx: ExtensionContext): readonly string[] | undefined {
    const manager: SessionReader = ctx.sessionManager;
    if (!manager || typeof manager.getBranch !== "function")
        return undefined;
    const branch = manager.getBranch();
    if (!Array.isArray(branch))
        return undefined;
    // Лист сдвигается с каждой записью; суммируемый контекст определяет упорядоченный список видимых модели записей.
    return branch.filter(isContextEntry).map((entry) => JSON.stringify([entry?.id ?? null, entry?.type ?? null]));
}

function sessionIdentity(ctx: ExtensionContext): SessionIdentity {
    const manager: SessionReader = ctx.sessionManager;
    return {
        sessionId: manager && typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined,
        sessionFile: manager && typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined,
        tree: branchIdentity(ctx),
    };
}

/**
 * Записи, дописанные в конец ветки во время сводки (уведомления сабагентов и подобное), сжатие не отменяют:
 * Pi ставит запись сжатия после них, а окно собирает от `firstKeptEntryId`, так что они идут сразу после сводки.
 * Изменённая или другая ветка меняет суммируемое начало и по-прежнему отменяет сжатие, как и дописанная правка `context_edit`.
 */
function sameSession(before: SessionIdentity, now: SessionIdentity): boolean {
    if (before.sessionId !== now.sessionId || before.sessionFile !== now.sessionFile)
        return false;
    const earlier = before.tree;
    const current = now.tree;
    if (!earlier || !current)
        return earlier === current;
    if (current.length < earlier.length || !earlier.every((entry, index) => entry === current[index]))
        return false;
    // `context_edit` дописывается в конец, но меняет или удаляет запись из суммируемой части.
    return current.slice(earlier.length).every((entry) => !entry.endsWith(',"context_edit"]'));
}

function operationSnapshot(ctx: ExtensionContext, signal: AbortSignal, activeModel: Model<Api> | undefined, serviceModel: Model<Api>): OperationSnapshot {
    return {
        signal,
        activeModel: modelIdentity(activeModel),
        activeRoute: routeIdentity(ctx, activeModel),
        serviceModel: modelIdentity(serviceModel)!,
        serviceModelRef: serviceModel,
        serviceRoute: routeIdentity(ctx, serviceModel)!,
        session: sessionIdentity(ctx),
    };
}

function signalAborted(ctx: ExtensionContext, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted) || Boolean(ctx.signal?.aborted);
}

function abortError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || /\babort(?:ed|ing)?\b/i.test(error.message));
}

function assertCurrent(ctx: ExtensionContext, snapshot: OperationSnapshot, owner?: () => boolean): void {
    if (signalAborted(ctx, snapshot.signal))
        throw new SummaryFailure("aborted");
    if (!sameSession(snapshot.session, sessionIdentity(ctx))
        || !sameModelIdentity(snapshot.activeModel, modelIdentity(ctx.model))
        || !sameRoute(snapshot.activeRoute, routeIdentity(ctx, ctx.model))
        || !sameRoute(snapshot.serviceRoute, routeIdentity(ctx, snapshot.serviceModelRef))) {
        throw new SummaryFailure("context-changed");
    }
    if (owner) {
        try {
            if (!owner())
                throw new SummaryFailure("context-changed");
        }
        catch (error) {
            if (error instanceof SummaryFailure)
                throw error;
            throw new SummaryFailure("context-changed");
        }
    }
}

function guardFor(ctx: ExtensionContext, snapshot: OperationSnapshot, options?: CompactionSummaryOptions): CompactionRequestGuard {
    return {
        ...(options?.capability ? { capability: options.capability } : {}),
        ...(options?.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        ...(options?.onRetry ? { onRetry: options.onRetry } : {}),
        model: snapshot.serviceModelRef, signal: snapshot.signal, validate: () => assertCurrent(ctx, snapshot, options?.isCurrent),
    };
}

function reportFailure(options: CompactionSummaryOptions | undefined, reason: CompactionFailureReason, detail?: string): CompactionSummaryResult {
    try {
        options?.onFailure?.(reason, detail);
    }
    catch { /* diagnostics must not alter the explicit outcome */ }
    return { cancel: true };
}

function reasonForFailure(error: unknown, ctx: ExtensionContext, guard: CompactionRequestGuard | undefined): CompactionFailureReason {
    if (error instanceof SummaryFailure)
        return error.reason;
    if (guard) {
        if (signalAborted(ctx, guard.signal) || abortError(error))
            return "aborted";
        try {
            guard.validate();
        }
        catch {
            return "context-changed";
        }
    }
    return abortError(error) ? "aborted" : "request-failed";
}

export function combineUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
    if (!first)
        return second;
    if (!second)
        return first;
    const sum = (left: unknown, right: unknown): number => (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0);
    const cost = first.cost && second.cost ? {
        input: sum(first.cost.input, second.cost.input),
        output: sum(first.cost.output, second.cost.output),
        cacheRead: sum(first.cost.cacheRead, second.cost.cacheRead),
        cacheWrite: sum(first.cost.cacheWrite, second.cost.cacheWrite),
        total: sum(first.cost.total, second.cost.total),
    } : first.cost ?? second.cost;
    const combined: Usage = {
        ...first,
        ...second,
        input: sum(first.input, second.input),
        output: sum(first.output, second.output),
        cacheRead: sum(first.cacheRead, second.cacheRead),
        cacheWrite: sum(first.cacheWrite, second.cacheWrite),
        totalTokens: sum(first.totalTokens, second.totalTokens),
        cost,
    };
    if (first.reasoning !== undefined || second.reasoning !== undefined)
        combined.reasoning = sum(first.reasoning, second.reasoning);
    if (first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined)
        combined.cacheWrite1h = sum(first.cacheWrite1h, second.cacheWrite1h);
    return combined;
}

/** Ждёт паузу перед повтором; отмена сжатия будит сразу, а отказ оформит следующая проверка актуальности. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted || ms <= 0) { resolve(); return; }
        const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
    });
}

/**
 * Запрос сводки с повтором после сбоя запроса: один сетевой сбой не должен стоить владельцу всего сжатия.
 * Повторяется только `request-failed`; перед каждым повтором сжатие заново проверяется на актуальность.
 */
async function completeSummary(ctx: ExtensionContext, prompt: string, maxTokens: number, signal: AbortSignal, guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    const delays = guard?.retryDelaysMs ?? [];
    for (let attempt = 0; ; attempt++) {
        try {
            return await requestSummary(ctx, prompt, maxTokens, signal, guard);
        }
        catch (error) {
            const delay = delays[attempt];
            if (!guard || delay === undefined || !(error instanceof SummaryFailure) || error.reason !== "request-failed") throw error;
            guard.onRetry?.(attempt + 1, delays.length, error.detail);
            await pause(delay, signal);
            guard.validate();
        }
    }
}

async function requestSummary(ctx: ExtensionContext, prompt: string, maxTokens: number, signal: AbortSignal, guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    const model = guard?.model ?? ctx.model;
    if (!model)
        throw new Error("No model selected");
    if (guard)
        guard.validate();
    let inputTokens = 0;
    if (guard?.capability) {
        inputTokens = estimateTokens({ role: "user", content: `<instructions>\n${SUMMARIZATION_SYSTEM_PROMPT}\n</instructions>\n\n${prompt}`, timestamp: 0 });
        const budget = calculateCompactBudget({ capability: guard.capability, inputTokens, taskTokens: 0, requestedOutputTokens: maxTokens, modelMaxTokens: model.maxTokens });
        if (!budget.allowed)
            throw new SummaryFailure(budget.reason!);
    }
    let payloadFailure: unknown;
    const options: ModelsApiStreamOptions<Api> = { maxTokens, signal, cacheRetention: "none" };
    if (guard) {
        options.maxRetries = 0;
        options.transport = "sse";
        options.onPayload = (payload: unknown) => {
            try {
                guard.validate();
                const serializedChars = JSON.stringify(payload).length;
                if (guard.capability) {
                    const budget = calculateCompactBudget({ capability: guard.capability, inputTokens, taskTokens: 0, requestedOutputTokens: maxTokens, modelMaxTokens: model.maxTokens, serializedChars });
                    if (!budget.allowed) throw new SummaryFailure(budget.reason!);
                } else if (serializedChars > MAX_COMPACT_PAYLOAD_CHARS) throw new SummaryFailure("request-too-large");
                return payload;
            } catch (error) {
                // Providers may convert hook failures into error messages; retain the original refusal.
                payloadFailure = error;
                throw error;
            }
        };
        const manager: SessionReader = ctx.sessionManager;
        const sessionId = manager?.getSessionId?.();
        if (typeof sessionId === "string" && sessionId)
            options.sessionId = sessionId;
    }
    let response: AssistantMessage | undefined;
    try {
        response = await ctx.modelRegistry.complete(model, {
            messages: [{
                    role: "user",
                    content: [{ type: "text", text: `<instructions>\n${SUMMARIZATION_SYSTEM_PROMPT}\n</instructions>\n\n${prompt}` }],
                    timestamp: Date.now(),
                }],
        }, options);
    }
    catch (error) {
        if (payloadFailure) throw payloadFailure;
        if (!guard)
            throw error;
        if (signalAborted(ctx, signal) || abortError(error))
            throw new SummaryFailure("aborted");
        guard.validate();
        throw new SummaryFailure("request-failed", error instanceof Error ? error.message : String(error));
    }
    if (payloadFailure) throw payloadFailure;
    if (guard)
        guard.validate();
    if (response?.stopReason === "aborted") {
        if (guard)
            throw new SummaryFailure("aborted");
        throw new Error("Summary generation aborted");
    }
    if (response?.stopReason === "error") {
        if (guard)
            throw new SummaryFailure("request-failed", response.errorMessage);
        throw new Error(response.errorMessage ?? "Summary generation failed");
    }
    if (response?.stopReason === "length" || !Array.isArray(response?.content)) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary generation failed");
    }
    if (response.content.some((block) => block?.type === "toolCall")) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary attempted to call a tool");
    }
    const rawText = response.content.filter((block): block is TextContent => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    const text = withoutFileTracking(rawText);
    if (!text.trim()) {
        if (guard)
            throw new SummaryFailure("invalid-response");
        throw new Error("Summary was empty");
    }
    return { text, usage: response.usage };
}

function conversationPrompt(messages: AgentMessage[], instructions: string, previousSummary?: string, sources: readonly unknown[] = []): string {
    const conversationText = serializeConversation(convertToLlm(withoutMessageFileTracking(messages, sources)));
    const previous = previousSummary ? withoutFileTracking(previousSummary, sources) : undefined;
    return `<conversation>\n${conversationText}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${instructions}`;
}

async function summarizeMessages(ctx: ExtensionContext, messages: AgentMessage[], instructions: string, previousSummary: string | undefined, maxTokens: number, signal: AbortSignal, sources: readonly unknown[], guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    return completeSummary(ctx, conversationPrompt(messages, instructions, previousSummary, sources), maxTokens, signal, guard);
}

async function summarizeTurnPrefix(ctx: ExtensionContext, messages: AgentMessage[], signal: AbortSignal, maxTokens: number, sources: readonly unknown[], customInstructions: string | undefined, guard?: CompactionRequestGuard): Promise<SummaryResponse> {
    const instructions = summaryText().turnPrefix;
    const focusedInstructions = customInstructions ? `${instructions}\n\n${summaryText().extraCompaction}\n${customInstructions}` : instructions;
    return summarizeMessages(ctx, messages, focusedInstructions, undefined, maxTokens, signal, sources, guard);
}

/** Генерирует summary на языке расширения для automatic/manual compaction; отказ всегда имеет явный исход. */
export async function summarizeCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, options?: CompactionSummaryOptions): Promise<CompactionSummaryResult> {
    const serviceModel = options?.model ?? ctx.model;
    if (!serviceModel)
        return reportFailure(options, signalAborted(ctx, event.signal) ? "aborted" : "request-failed");
    let guard: CompactionRequestGuard | undefined;
    try {
        const snapshot = operationSnapshot(ctx, event.signal, ctx.model, serviceModel);
        guard = guardFor(ctx, snapshot, options);
        guard.validate();
        const preparation = event.preparation;
        const sources = event.branchEntries.flatMap((entry) => entry.type === "compaction" || entry.type === "branch_summary" ? [entry.details] : []);
        const text = summaryText();
        const instructions = event.customInstructions
            ? `${text.focus}\n\n${text.extraCompaction}\n${event.customInstructions}`
            : text.focus;
        const serviceMaxTokens = serviceModel.maxTokens;
        const maxTokens = Math.min(Math.floor(preparation.settings.reserveTokens * 0.8), serviceMaxTokens > 0 ? serviceMaxTokens : Number.POSITIVE_INFINITY);
        let summary: string;
        let usage: Usage | undefined;
        const unchangedHistory = preparation.turnPrefixMessages.length === 0 && preparation.messagesToSummarize.length === 0 && !event.customInstructions
            ? preparation.previousSummary
            : undefined;
        if (unchangedHistory) {
            // После фильтра в сжатой части могли остаться только данные прежней сводки.
            summary = unchangedHistory;
        }
        else if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
            let historyText = preparation.previousSummary ? localizeSummaryStructure(withoutFileTracking(preparation.previousSummary, sources)) : text.noHistory;
            let historyUsage: Usage | undefined;
            if (preparation.messagesToSummarize.length > 0) {
                const history = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal, sources, guard);
                guard.validate();
                historyText = localizeSummaryStructure(history.text);
                historyUsage = history.usage;
                if (!hasLocalizedSummaryStructure(historyText, false))
                    throw new SummaryFailure("invalid-response");
            }
            else if (preparation.previousSummary && !hasLocalizedSummaryStructure(historyText, false) && !hasLocalizedPrefixStructure(historyText)) {
                throw new SummaryFailure("invalid-response");
            }
            const prefix = await summarizeTurnPrefix(ctx, preparation.turnPrefixMessages, event.signal, Math.min(Math.floor(preparation.settings.reserveTokens * 0.5), serviceMaxTokens > 0 ? serviceMaxTokens : Number.POSITIVE_INFINITY), sources, event.customInstructions, guard);
            guard.validate();
            const prefixText = localizeSummaryStructure(prefix.text);
            if (!hasLocalizedPrefixStructure(prefixText))
                throw new SummaryFailure("invalid-response");
            summary = `${closeFenceBeforeAppend(historyText)}\n\n${text.splitTurnHeader}\n${prefixText}`;
            usage = combineUsage(historyUsage, prefix.usage);
        }
        else {
            const result = await summarizeMessages(ctx, preparation.messagesToSummarize, instructions, preparation.previousSummary, maxTokens, event.signal, sources, guard);
            guard.validate();
            summary = localizeSummaryStructure(result.text);
            usage = result.usage;
            if (!hasLocalizedSummaryStructure(summary, false))
                throw new SummaryFailure("invalid-response");
        }
        guard.validate();
        summary = withoutFileTracking(summary, unchangedHistory ? sources : []);
        if (unchangedHistory && !hasLocalizedSummaryStructure(summary, true))
            throw new SummaryFailure("invalid-response");
        const files = collectFileLists(preparation.fileOps, event.branchEntries);
        const carriedHints = unchangedHistory && carryFileHints(unchangedHistory, summary, files, event.branchEntries);
        const hints = carriedHints ?? formatFileHints(files, [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages], summary);
        guard.validate();
        return {
            compaction: {
                summary: `${hints && !unchangedHistory ? closeFenceBeforeAppend(summary) : summary}${hints}`,
                firstKeptEntryId: preparation.firstKeptEntryId,
                tokensBefore: preparation.tokensBefore,
                ...(usage ? { usage } : {}),
                details: files,
            },
        };
    }
    catch (error) {
        const reason = reasonForFailure(error, ctx, guard);
        return reportFailure(options, reason, error instanceof SummaryFailure && error.reason === reason ? error.detail : undefined);
    }
}

/** Генерирует summary на языке расширения для /tree, сохраняя native token budget, usage и cumulative file tracking. */
export async function summarizeTree(event: SessionBeforeTreeEvent, ctx: ExtensionContext): Promise<SessionBeforeTreeResult | undefined> {
	if (!event.preparation.userWantsSummary || !ctx.model) return undefined;
	try {
		const reserveTokens = DEFAULT_RESERVE_TOKENS;
		const tokenBudget = Math.max(0, (ctx.model.contextWindow || 128_000) - reserveTokens);
		const entries = event.preparation.entriesToSummarize.map((entry) => entry.type === "compaction" || entry.type === "branch_summary"
			? { ...entry, summary: withoutFileTracking(entry.summary, [entry.details]) } : entry);
		const prepared = prepareBranchEntries(entries, tokenBudget);
		if (prepared.messages.length === 0) return undefined;
		const replaceInstructions = Boolean(event.preparation.replaceInstructions && event.preparation.customInstructions);
		const instructions = replaceInstructions
			? event.preparation.customInstructions!
			: event.preparation.customInstructions
				? `${summaryText().tree}\n\n${summaryText().extraTree}\n${event.preparation.customInstructions}`
				: summaryText().tree;
		const result = await completeSummary(ctx, conversationPrompt(prepared.messages, instructions), Math.min(4096, ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY), event.signal);
		const summary = withoutFileTracking(localizeSummaryStructure(stripBranchSummaryPreamble(result.text)));
		if (!replaceInstructions && !hasLocalizedSummaryStructure(summary, false)) return undefined;
		const files = collectFileLists(prepared.fileOps, event.preparation.entriesToSummarize);
		const hints = formatFileHints(files, prepared.messages, summary);
		return {
			summary: {
				summary: hints ? `${closeFenceBeforeAppend(summary)}${hints}` : summary,
				...(result.usage ? { usage: result.usage } : {}),
				details: files,
			},
		};
	} catch {
		return undefined;
	}
}