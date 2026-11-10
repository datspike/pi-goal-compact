import { Type, type TUnsafe } from "typebox";

/**
 * Строковое перечисление в виде `{ type: "string", enum }`, как `StringEnum` из pi-ai.
 * Провайдеры хуже понимают `anyOf` из литералов; а `StringEnum` в pi-ai 1.5 возвращает
 * свой тип схемы, и TypeBox теряет тип значения.
 */
export function stringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}
