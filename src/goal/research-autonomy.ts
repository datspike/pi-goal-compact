import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import { say } from "../language.js";
import type { ThreadGoal } from "./types.js";

export const RESEARCH_QUESTION_TOOL = "ask_user";

export function isAutonomousResearch(goal: ThreadGoal | null): goal is ThreadGoal {
  return goal?.mode === "research" && goal.status === "active";
}

export const researchStartRule = (): string => say(
  "При явной просьбе запустить research не вызывай ask_user перед созданием. Разреши рабочие развилки по нашей памяти и прошлым сессиям, существенные допущения запиши в self_decided.",
  "When explicitly asked to start research, do not call ask_user before creating it. Resolve working decisions from our memory and past sessions; record material assumptions in self_decided.",
);

export const researchQuestionBlocked = (): string => say(
  "В активной исследовательской цели ask_user недоступен. Продолжай полезную работу в пределах поручения; если доступных шагов нет, назови конкретный блокер без анкеты.",
  "ask_user is unavailable during an active research goal. Continue useful work within scope; if no authorized step remains, state the specific blocker without opening a questionnaire.",
);

const autonomyText = (): string => say([
  "Веди исследование как инженерный соавтор и «двойник» владельца. Он наблюдает; порядок, гипотезы и обратимые шаги выбираешь ты.",
  "Рабочие развилки решай с опорой на нашу память и решения владельца в прошлых сессиях. Если прошлый выбор меняет следующий шаг, открой первичный эпизод и проверь, применим ли он здесь и не был ли пересмотрен. Смотри и на то, как мы работали: где заходили не с того конца, повторяли проверки или ждали, хотя могли продвинуть другую ветку. Бери только то, что меняет действие.",
  "Если подход не сработал, поднимись на ступеньку выше: по результатам и трассам выясни, не сработала гипотеза, способ проверки или само направление. Выбери и начни следующий полезный шаг, который может изменить вывод. Не повторяй тот же путь ради времени и не заканчивай исследование только потому, что первый кандидат провалился.",
  "Не вызывай ask_user и не жди ответов владельца. Прошлые решения помогают выбрать путь, но не дают новых полномочий. Если одна ветка требует новых полномочий или ждёт зависимости, продолжай независимую работу. Если полезных разрешённых шагов больше нет, не додумывай решение: сообщи конкретный блокер и что уже проверено, не объявляй успех.",
].join("\n\n"), [
  "Lead the research as the owner's engineering coauthor and ‘double’. The owner observes; you choose the order, hypotheses, and reversible steps.",
  "Resolve working decisions from our memory and the owner's decisions in past sessions. If a past choice changes your next step, open the source episode and check that it applies here and was not superseded. Look at how we worked as well as what we decided: where we approached the problem poorly, repeated checks, or waited when another branch could move forward. Retrieve only what changes the action.",
  "If an approach fails, step back and use the results and traces to tell whether the hypothesis, the way you tested it, or the direction itself failed. Choose and start a useful next step that could change the conclusion. Do not repeat the same path to fill time or end the research just because the first candidate failed.",
  "Do not call ask_user or wait for the owner's answers. Prior decisions inform your choices but do not grant new authority. If one branch needs new permission or is waiting on a dependency, continue independent work. If no useful authorized step remains, do not guess: state the specific blocker and what is already verified, without declaring success.",
].join("\n\n"));

/** Проекция одного запроса: сохранённый набор инструментов и журнал не меняются. */
export function researchModelInput(messages: ContextWithSystemEvent["messages"], goal: ThreadGoal): ContextWithSystemEvent["messages"] {
  const projected = messages.map(message => {
    if (message.role !== "system" || !message.toolsAdded?.some(tool => tool.name === RESEARCH_QUESTION_TOOL)) return message;
    return { ...message, toolsAdded: message.toolsAdded.filter(tool => tool.name !== RESEARCH_QUESTION_TOOL) };
  });
  projected.splice(1, 0, { role: "custom", customType: "goal-compact-research-autonomy", content: autonomyText(), display: false, timestamp: goal.createdAt * 1000 });
  return projected;
}
