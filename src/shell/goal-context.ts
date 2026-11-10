import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { withCurrentRecordNames } from "../records.js";

/**
 * Контекст Pi для модулей цели: ветка журнала отдаётся с новыми именами записей,
 * а пустой `cwd` заменяется каталогом процесса.
 *
 * Перевод прежних имён (`pi-codex-goal*`) сделан здесь, в одной точке чтения ветки,
 * чтобы модули цели знали одно имя записи и сессии прежнего расширения продолжались.
 * Используется Proxy, а не копия объекта: методы контекста Pi вызываются на исходном объекте.
 */
export function goalContext<T extends ExtensionContext>(ctx: T): T {
  const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  const sessionManager = ctx.sessionManager
    ? new Proxy(ctx.sessionManager, {
      get(target, key) {
        if (key === "getBranch") return () => withCurrentRecordNames(target.getBranch());
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    })
    : ctx.sessionManager;
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "cwd") return cwd;
      if (key === "sessionManager") return sessionManager;
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
