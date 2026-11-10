/**
 * Язык расширения (требование Т11.1): одна настройка управляет всем, что читают владелец и модель.
 *
 * Язык читается из настроек Pi один раз при загрузке расширения и до `/reload` не меняется,
 * поэтому он хранится здесь, а не протаскивается параметром через все функции вывода.
 * Русская строка — источник истины, английская — её перевод.
 */
export type Language = "ru" | "en";

/** Выбор строки по языку расширения. */
export type Say = (ru: string, en: string) => string;

let current: Language = "ru";

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

export const say: Say = (ru, en) => current === "ru" ? ru : en;

export function sayFor(target: Language): Say {
  return (ru, en) => target === "ru" ? ru : en;
}
