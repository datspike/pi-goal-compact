import { readFileSync } from "node:fs";
import { parseSessionEntries, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";

import { say } from "../language.js";
import { RECORD, withCurrentRecordNames } from "../records.js";

interface ChildGoalScope {
  sessionId: string;
  inheritedThrough: string | null;
}

function ownScope(branch: SessionEntry[], sessionId: string): ChildGoalScope | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry || entry.type !== "custom" || entry.customType !== RECORD.childScope) continue;
    const data = entry.data as Partial<ChildGoalScope> | null;
    if (data?.sessionId === sessionId && (data.inheritedThrough === null || typeof data.inheritedThrough === "string")) {
      return { sessionId, inheritedThrough: data.inheritedThrough };
    }
  }
  return undefined;
}

/** Один экземпляр расширения читает родительскую историю как контекст, а не как собственную Goal. */
export function createGoalContext(pi: ExtensionAPI) {
  // В native SDK окружение может быть восстановлено до прихода событий сессии.
  const isChild = process.env.PI_SUBAGENT_CHILD === "1";
  return <T extends ExtensionContext>(ctx: T): T => {
    const parent = isChild ? ctx.sessionManager.getHeader()?.parentSession : undefined;
    if (!parent) return goalContext(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    let scope = ownScope(branch, sessionId);
    if (!scope) {
      try {
        // SDK loadEntriesFromFile чинит завершающий LF: здесь нужен только чистый парсер.
        const source = parseSessionEntries(readFileSync(parent, "utf8"));
        if (source[0]?.type !== "session" || typeof source[0].id !== "string") throw new Error("Invalid parent session header");
        const inherited = new Set(source.filter(entry => entry?.type !== "session").map(entry => entry?.id));
        let inheritedThrough: string | null = null;
        for (let i = branch.length - 1; i >= 0; i--) {
          const entry = branch[i];
          if (entry && inherited.has(entry.id)) { inheritedThrough = entry.id; break; }
        }
        scope = { sessionId, inheritedThrough };
        pi.appendEntry(RECORD.childScope, scope);
      } catch (cause) {
        throw new Error(say("Не удалось установить границу родительской цели в дочерней сессии.", "Cannot establish the inherited Goal boundary in the child session."), { cause });
      }
    }
    return goalContext(ctx, scope);
  };
}

/**
 * Контекст модулей цели: нормализует прежние имена и cwd, не меняя историю Pi.
 * В дочернем форке виден только собственный участок; остальные методы связаны с исходным объектом.
 */
function goalContext<T extends ExtensionContext>(ctx: T, scope?: ChildGoalScope): T {
  const cwd = typeof (ctx as { cwd?: unknown }).cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  const sessionManager = ctx.sessionManager
    ? new Proxy(ctx.sessionManager, {
      get(target, key) {
        if (key === "getBranch") return () => {
          const branch = target.getBranch();
          const cutoff = scope?.inheritedThrough;
          const index = cutoff == null ? -1 : branch.findIndex(entry => entry.id === cutoff);
          const own = cutoff == null ? branch : index < 0 ? [] : branch.slice(index + 1);
          return withCurrentRecordNames(own);
        };
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
