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

/** Выбор значения по языку расширения: строки, списка правил или таблицы. */
export function say<T>(ru: T, en: T): T {
  return current === "ru" ? ru : en;
}

/**
 * Выполняет `run` на заданном языке и возвращает прежний. Нужно, чтобы распознать текст,
 * записанный в журнал при другой настройке языка; вызов синхронный, поэтому язык не протекает.
 */
export function inLanguage<T>(target: Language, run: () => T): T {
  const prior = current;
  current = target;
  try {
    return run();
  } finally {
    current = prior;
  }
}

export function sayFor(target: Language): Say {
  return (ru, en) => target === "ru" ? ru : en;
}
