import assert from "node:assert/strict";
import { test } from "node:test";
import type { Model, Api } from "@earendil-works/pi-ai";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { modelCompletions, exactModel, ModelChoice } from "../../src/shell/model-choice.js";
import { asPi } from "../support/as-pi.js";

const model = (provider: string, id: string, name = id): Model<Api> => ({ provider, id, name, api: "openai-responses", baseUrl: "http://localhost", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 });
const models = [model("first", "small", "Small coding model"), model("second", "small"), model("first", "large")];
test("автодополнение повторяет формат штатного model и ищет по имени", () => {
 assert.deepEqual(modelCompletions(models, "coding"), [{ value: "first/small", label: "small", description: "first" }]);
 assert.equal(modelCompletions(models, "absent"), null);
});
test("точное имя принимает провайдера и регистр, неоднозначное короткое имя открывает выбор", () => {
 assert.equal(exactModel(models, "FIRST/SMALL"), models[0]);
 assert.equal(exactModel(models, "large"), models[2]);
 assert.equal(exactModel(models, "small"), undefined);
});
test("пикер ищет по вводу и подтверждает выбранную модель", () => {
 initTheme("dark", false);
 const theme = asPi<Theme>({ fg: (_color: string, text: string) => text });
 let selected: Model<Api> | undefined;
 const picker = new ModelChoice(models, theme, value => { selected = value; });
 picker.handleInput("coding");
 assert.ok(picker.render(100).join("\n").includes("small"));
 picker.handleInput("\r");
 assert.equal(selected, models[0]);
});
test("Esc отменяет выбор, пустой поиск не подтверждает отсутствующую модель", () => {
 initTheme("dark", false);
 const theme = asPi<Theme>({ fg: (_color: string, text: string) => text });
 const selections: Array<Model<Api> | undefined> = [];
 const picker = new ModelChoice(models, theme, value => { selections.push(value); }, "absent");
 picker.handleInput("\r");
 assert.equal(selections.length, 0);
 picker.handleInput("\u001b");
 assert.deepEqual(selections, [undefined]);
});
