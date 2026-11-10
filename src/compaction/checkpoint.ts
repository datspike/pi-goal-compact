import { Type } from "typebox";
import type { SummaryLanguage } from "./language.js";

export type ContinuationMode = "explicit_prompt" | "plan_phase" | "resume_existing_plan" | "goal_loop" | "auto_context_pressure";


type BranchEntry = {
	type?: string;
	customType?: string;
	content?: unknown;
	display?: boolean;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type?: unknown; text?: unknown } => !!part && typeof part === "object")
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function continuationCorrelation(entry: BranchEntry): string | null {
	if (entry.type !== "message" || entry.message?.role !== "user") return null;
	const match = messageText(entry.message.content).match(/<!-- pi-context-compaction:follow-up:([^\s>]+) -->/);
	return match?.[1] ?? null;
}

/** Match only service records backed by this extension's durable operation metadata. */
export function isNativeCompactionMessage(entry: BranchEntry, entries: readonly BranchEntry[]): boolean {
	const isUserMessage = entry.type === "message" && entry.message?.role === "user";
	const isHiddenCustomMessage = entry.type === "custom_message" && entry.customType === "context-compaction-native";
	if (!isUserMessage && !isHiddenCustomMessage) return false;
	const content = isUserMessage ? entry.message?.content : entry.content;
	const id = messageText(content).match(/^\[context-compaction-native:([0-9a-f-]{36})\] /)?.[1];
	return !!id && entries.some((candidate) => candidate.type === "custom" && candidate.customType === "context-compaction-native" && (candidate.data as { id?: unknown; phase?: unknown } | undefined)?.id === id && (candidate.data as { phase?: unknown }).phase === "queued");
}

type ServiceMessage = { role?: string; customType?: string; content?: unknown };

/**
 * В сессиях прежнего `context-compaction` мог остаться незавершённый служебный запрос append-сжатия.
 * Это инструкция расширению, а не модели: вместе с ответами на неё до следующей реплики она убирается
 * из окна модели и из входа сводки. Возвращает undefined, если убирать нечего.
 */
export function withoutLegacyServiceTurns<T extends ServiceMessage>(messages: readonly T[], branch: readonly BranchEntry[]): T[] | undefined {
	let service = false;
	let changed = false;
	const kept = messages.filter((message) => {
		if (message.role === "user" || message.role === "custom") {
			const entry: BranchEntry = message.role === "custom"
				? { type: "custom_message", ...(message.customType === undefined ? {} : { customType: message.customType }), content: message.content }
				: { type: "message", message: { role: "user", content: message.content } };
			service = isNativeCompactionMessage(entry, branch);
		}
		const drop = service && message.role !== "system";
		if (drop) changed = true;
		return !drop;
	});
	return changed ? kept : undefined;
}

/** Отличает продолжение прежнего расширения сжатия от настоящей реплики владельца по его журналу отправки. */
export function isHumanUserMessage(entry: BranchEntry, entries: readonly BranchEntry[]): boolean {
	if (entry.type !== "message" || entry.message?.role !== "user") return false;
	if (isNativeCompactionMessage(entry, entries)) return false;
	const correlation = continuationCorrelation(entry);
	if (!correlation) return true;
	return !entries.some((candidate) => {
		const audit = candidate.type === "custom" && candidate.customType === "context-compaction-audit" && candidate.data && typeof candidate.data === "object"
			? candidate.data as { correlation?: unknown; phase?: unknown; origin?: unknown }
			: undefined;
		return audit?.correlation === correlation && audit.phase === "send-attempted" && (audit.origin === "manual-tool" || audit.origin === "planned");
	});
}

export interface CheckpointParams {
	mainObjective: string;
	completedCheckpoint: string;
	continuationMode?: ContinuationMode;
	continuationTarget: string;
	planPath?: string;
	currentPhase?: string;
	nextPhase?: string;
	importantFiles?: string[];
	verificationState?: string;
	blockers?: string;
	doNotDo?: string[];
	extraContext?: string;
}

/** Defines the same tool arguments in both languages without changing parameter names. */
export function checkpointParamsSchema(language: SummaryLanguage) {
	const en = language === "en";
	return Type.Object({
		mainObjective: Type.String({ description: en ? "The main user objective to continue after compaction." : "Главная цель пользователя, которую нужно продолжить после compact." }),
		completedCheckpoint: Type.String({ description: en ? "Work already completed before compaction." : "Что уже завершено перед compact." }),
		continuationMode: Type.Optional(Type.Union([
			Type.Literal("explicit_prompt"), Type.Literal("plan_phase"), Type.Literal("resume_existing_plan"),
			Type.Literal("goal_loop"), Type.Literal("auto_context_pressure"),
		])),
		continuationTarget: Type.String({ description: en ? "The next concrete step after compaction." : "Следующий конкретный шаг после compact." }),
		planPath: Type.Optional(Type.String()),
		currentPhase: Type.Optional(Type.String()),
		nextPhase: Type.Optional(Type.String()),
		importantFiles: Type.Optional(Type.Array(Type.String())),
		verificationState: Type.Optional(Type.String()),
		blockers: Type.Optional(Type.String()),
		doNotDo: Type.Optional(Type.Array(Type.String())),
		extraContext: Type.Optional(Type.String()),
	});
}

/** Проверяет, был ли compact после последнего настоящего user message. */
export function compactedSinceLastUserMessage(ctx: { sessionManager: { getBranch(): readonly BranchEntry[] } }): boolean {
	const entries = ctx.sessionManager.getBranch();
	let user = -1;
	let compact = -1;
	for (const [index, entry] of entries.entries()) {
		if (isHumanUserMessage(entry, entries)) user = index;
		if (entry.type === "compaction") compact = index;
	}
	return compact > user;
}

/** Builds the manual checkpoint ledger in the configured language. */
export function buildLedger(params: CheckpointParams, language: SummaryLanguage = "ru"): string {
	const optional = (name: string, value?: string) => value?.trim() ? `\n\n## ${name}\n${value.trim()}` : "";
	const list = (name: string, value?: string[]) => value?.length ? `\n\n## ${name}\n${value.map((item) => `- ${item}`).join("\n")}` : "";
	const [objective, completed, next, mode, plan, files, verification, blockers, doNotDo, extra] = language === "ru"
		? ["Главная цель", "Завершённый checkpoint", "Следующий шаг", "Режим продолжения", "План", "Важные файлы", "Проверка", "Блокеры", "Не повторять", "Дополнительный контекст"] as const
		: ["Main objective", "Completed checkpoint", "Next step", "Continuation mode", "Plan", "Important files", "Verification", "Blockers", "Do not repeat", "Additional context"] as const;
	return `## ${objective}\n${params.mainObjective}\n\n## ${completed}\n${params.completedCheckpoint}\n\n## ${next}\n${params.continuationTarget}`
		+ optional(mode, params.continuationMode)
		+ optional(plan, [params.planPath, params.currentPhase, params.nextPhase].filter(Boolean).join("; "))
		+ list(files, params.importantFiles)
		+ optional(verification, params.verificationState)
		+ optional(blockers, params.blockers)
		+ list(doNotDo, params.doNotDo)
		+ optional(extra, params.extraContext);
}

export function buildInstructions(ledger: string, language: SummaryLanguage = "ru"): string {
	const instruction = language === "ru"
		? "Сформируй компактную карточку продолжения текущей задачи. Сохрани цель, ограничения, изменения, проверки, блокеры и ближайший шаг. Не копируй пустые разделы."
		: "Write a concise continuation note in English. Preserve the objective, constraints, changes, checks, blockers and next action. Omit empty sections.";
	return `${instruction}\n\n${ledger}`;
}

export function continuationPrompt(params: CheckpointParams, language: SummaryLanguage = "ru"): string {
	if (language === "en") return `Continue the main objective from the next unfinished step in the summary: ${params.continuationTarget}.${params.continuationMode ? ` Continuation mode: ${params.continuationMode}.` : ""} Do not replan from scratch. Before any external action, list every related object the task touches (merge requests, branches, target environments, versioned artifacts) and verify the set is complete; if the summary lacks them, first recover the data from the session history or the working artifact, and do not act on one object when the task spans several. Read each decision status explicitly: accepted, open or rejected. An open decision is not accepted, and a rejected option does not come back.`;
	const mode = params.continuationMode ? ` Режим продолжения: ${params.continuationMode}.` : "";
	return `Продолжи основную цель по краткой сводке с ближайшего незавершённого действия: ${params.continuationTarget}.${mode} Не перепланируй работу с нуля. Перед любым внешним действием перечисли все связанные объекты задачи — MR, ветки, целевые окружения и артефакты с версиями — и проверь, что набор полон: если в сводке их нет, сначала восстанови данные из истории сессии или рабочего артефакта, и не действуй по одному объекту, когда задача затрагивает несколько. Статус решения бери из сводки явно: принято, открыто или отклонено. Открытое решение не считай принятым и не выбирай за пользователя, а отклонённый вариант не возвращай.`;
}
