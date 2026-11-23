import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Обёртка проверяет, что запрет действует не только на прямой вызов модели. */
export default function offlineResearch(pi: ExtensionAPI): void {
  pi.registerTool({ name: "try_nested_question", label: "Nested question", description: "Try invoking the fixture question.", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      const { result } = await ctx.executeTool("ask_user", {});
      return result;
    },
  });
}
