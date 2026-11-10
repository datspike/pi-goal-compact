const DEFAULT_AGREEMENT = { owner_wants: "Довести цель теста до проверенного итога.", done_when: "Проверка теста проходит." };

/**
 * Тесты, написанные до договорённости, вызывают `create_goal` и `amend_goal` без неё. Обвязка
 * подставляет договорённость и пустой список «Решаю сам» на границе; явные значения проверяются как есть.
 */
export function withAgreementDefaults<T>(name: string, params: T): T {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const input = params as Record<string, unknown>;
  if (name === "create_goal") {
    return { ...input, ...("agreement" in input ? {} : { agreement: DEFAULT_AGREEMENT }), ...("self_decided" in input ? {} : { self_decided: [] }) } as T;
  }
  if (name === "amend_goal" && typeof input.amendment === "string" && !("agreement" in input)) return { ...input, agreement: DEFAULT_AGREEMENT } as T;
  return params;
}
