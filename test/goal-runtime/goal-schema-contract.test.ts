import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fakePi } from "../support/pi-fake.js";
import { inLanguage } from "../../src/language.js";
import { retainedAgreementNotice } from "../../src/goal/window.js";

// Отпечатки формы схем без описаний: поля, обязательность, enum и ограничения не сокращаются.
const shapes: Record<string, string> = {
  create_goal: "69fca4e584c7dc8e46919b2f3203cbf2bd8554724766644a7cb64e1690563847",
  update_goal_work: "eb3eadeac5715a8640d497aca9333da50e6037c13c1eff7035fa42b4a31f8436",
  amend_goal: "40a34a268640630646dce815686c4a4c31c38336c978b2527ff57da929fe630a",
  record_goal_note: "1b9b11cd336dcd593113a99373a6cd674be131baa82738a1dfe05f2e0a266ee9",
  report_goal_progress: "7e4e8dad497a646f31c86cb98df705ae16840bbf56ad9bc4114e546bb0ae9956",
  update_goal: "8a1df47dc12d5de0951fa190fb86e915e72cd54b5db44d4363265bc377509534",
  resume_goal: "9b206d5d78c6a8f657441dbf2363502e35c91bac6c13ac503d65a927939032fd",
  get_goal: "ffd5199bdeb6d3e43b01a46c25015f4a6a889f6b7a9d0575764277c98df1ff82",
};

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description").map(([key, item]) => [key, withoutDescriptions(item)]));
  return value;
}

for (const language of ["ru", "en"] as const) {
  test(`Сокращённые схемы сохраняют форму и обязательные правила (${language})`, () => {
    const runtime = fakePi({ language });
    const text = (name: string) => JSON.stringify(runtime.tools.get(name));
    for (const [name, hash] of Object.entries(shapes)) {
      const schema = runtime.tools.get(name)!.parameters;
      assert.equal(createHash("sha256").update(JSON.stringify(withoutDescriptions(schema))).digest("hex"), hash, name);
    }
    const rules = language === "ru" ? {
      update_goal: [/каждое явное требование полного договора/, /конкретным доказательством/, /Не вызывай update_goal только потому/, /не заменяет обязательную работу или доказательство/],
      amend_goal: [/настоящей реплики владельца/, /полная новая редакция/],
      resume_goal: [/requiresUserDecision/, /настоящий ответ/, /вопроса о статусе недостаточно/],
      update_goal_work: [/expected_revision/, /workRevision/, /не меняет одобренную цель/, /отмена пункта требует одобрения/],
    } : {
      update_goal: [/every explicit requirement of the full contract/, /concrete evidence/, /Do not use update_goal merely because/, /cannot replace required work or evidence/],
      amend_goal: [/real owner reply/, /complete new edition/],
      resume_goal: [/requiresUserDecision/, /actual answer/, /status question is not enough/],
      update_goal_work: [/expected_revision/, /workRevision/, /does not replace or amend/, /cancelling an item needs user approval/],
    };
    for (const [name, phrases] of Object.entries(rules)) for (const phrase of phrases) assert.match(text(name), phrase, name);
    const warning = inLanguage(language, retainedAgreementNotice);
    assert.match(warning, language === "ru" ? /только как история.*Цель закрыта.*следующую работу задаёт владелец/ : /only as history.*goal is closed.*owner sets the next work/);
  });
}
