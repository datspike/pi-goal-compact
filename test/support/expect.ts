/**
 * Переходник `expect` поверх `node:test` и `node:assert`.
 *
 * Тесты прежнего расширения сжатия написаны под `bun:test`. Они переносятся
 * построчно, меняется только строка импорта: так видно, что поведение
 * проверяется теми же утверждениями.
 */
import assert from "node:assert/strict";
import { describe as nodeDescribe, test as nodeTest } from "node:test";

/** `test.each` из `bun:test`: строки таблицы подставляются в имя по `%p`. */
function each<Row extends unknown[]>(rows: readonly Row[]) {
  return (name: string, run: (...args: Row) => unknown): void => {
    for (const row of rows) {
      let index = 0;
      const title = name.replace(/%[psdi]/g, () => String(row[index++]));
      void nodeTest(title, () => run(...row) as void | Promise<void>);
    }
  };
}

export const test = Object.assign(nodeTest, { each });
export const describe = nodeDescribe;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Частичное совпадение: в объекте есть все поля образца с совпадающими значениями. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === "string" && expected.test(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matchesObject(actual[index], item));
  }
  if (isObject(expected)) {
    return isObject(actual) && Object.entries(expected).every(([key, value]) => matchesObject(actual[key], value));
  }
  return Object.is(actual, expected);
}

function hasPath(value: unknown, path: string): boolean {
  let current = value;
  for (const key of path.split(".")) {
    if (!isObject(current) || !(key in current)) return false;
    current = current[key];
  }
  return true;
}

function contains(actual: unknown, item: unknown): boolean {
  if (typeof actual === "string") return typeof item === "string" && actual.includes(item);
  if (Array.isArray(actual)) return actual.some((entry) => Object.is(entry, item) || (isObject(item) && matchesObject(entry, item) && matchesObject(item, entry)));
  return false;
}

function throwsLike(run: () => unknown, expected?: string | RegExp): boolean {
  try {
    run();
    return false;
  } catch (error) {
    if (expected === undefined) return true;
    const message = error instanceof Error ? error.message : String(error);
    return typeof expected === "string" ? message.includes(expected) : expected.test(message);
  }
}

function matchers(actual: unknown, negate: boolean) {
  const check = (pass: boolean, description: string): void => {
    if (pass === negate) assert.fail(`${negate ? "не ожидалось" : "ожидалось"}: ${description}; получено ${JSON.stringify(actual)?.slice(0, 2000)}`);
  };
  const deepEqual = (expected: unknown): boolean => {
    try {
      assert.deepStrictEqual(actual, expected);
      return true;
    } catch {
      return false;
    }
  };
  return {
    toBe: (expected: unknown) => check(Object.is(actual, expected), `toBe ${JSON.stringify(expected)}`),
    toEqual: (expected: unknown) => check(deepEqual(expected), `toEqual ${JSON.stringify(expected)?.slice(0, 2000)}`),
    toStrictEqual: (expected: unknown) => check(deepEqual(expected), "toStrictEqual"),
    toMatchObject: (expected: unknown) => check(matchesObject(actual, expected), `toMatchObject ${JSON.stringify(expected)?.slice(0, 2000)}`),
    toContain: (item: unknown) => check(contains(actual, item), `toContain ${JSON.stringify(item)?.slice(0, 500)}`),
    toHaveLength: (length: number) => check(isObject(actual) && "length" in actual && actual.length === length || typeof actual === "string" && actual.length === length, `toHaveLength ${length}`),
    toHaveProperty: (path: string) => check(hasPath(actual, path), `toHaveProperty ${path}`),
    toBeUndefined: () => check(actual === undefined, "toBeUndefined"),
    toBeDefined: () => check(actual !== undefined, "toBeDefined"),
    toBeNull: () => check(actual === null, "toBeNull"),
    toBeTruthy: () => check(Boolean(actual), "toBeTruthy"),
    toBeFalsy: () => check(!actual, "toBeFalsy"),
    toEndWith: (suffix: string) => check(typeof actual === "string" && actual.endsWith(suffix), `toEndWith ${suffix}`),
    toStartWith: (prefix: string) => check(typeof actual === "string" && actual.startsWith(prefix), `toStartWith ${prefix}`),
    toMatch: (pattern: string | RegExp) => check(typeof actual === "string" && (typeof pattern === "string" ? actual.includes(pattern) : pattern.test(actual)), `toMatch ${String(pattern)}`),
    toBeGreaterThan: (bound: number) => check(typeof actual === "number" && actual > bound, `> ${bound}`),
    toBeGreaterThanOrEqual: (bound: number) => check(typeof actual === "number" && actual >= bound, `>= ${bound}`),
    toBeLessThan: (bound: number) => check(typeof actual === "number" && actual < bound, `< ${bound}`),
    toBeLessThanOrEqual: (bound: number) => check(typeof actual === "number" && actual <= bound, `<= ${bound}`),
    toThrow: (expected?: string | RegExp) => check(typeof actual === "function" && throwsLike(actual as () => unknown, expected), `toThrow ${String(expected ?? "")}`),
  };
}

export function expect(actual: unknown) {
  return {
    ...matchers(actual, false),
    not: matchers(actual, true),
    resolves: {
      toBe: async (expected: unknown) => matchers(await actual, false).toBe(expected),
      toEqual: async (expected: unknown) => matchers(await actual, false).toEqual(expected),
      toMatchObject: async (expected: unknown) => matchers(await actual, false).toMatchObject(expected),
    },
    rejects: {
      toThrow: async (expected?: string | RegExp) => {
        await assert.rejects(actual as Promise<unknown>, (error: unknown) => {
          if (expected === undefined) return true;
          const message = error instanceof Error ? error.message : String(error);
          return typeof expected === "string" ? message.includes(expected) : expected.test(message);
        });
      },
    },
  };
}
