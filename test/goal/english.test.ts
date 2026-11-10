import assert from "node:assert/strict";
import test from "node:test";

import { setLanguage } from "../../src/language.js";
import { completionReturnMessage } from "../../src/goal/agreement.js";
import { goalWorkingState } from "../../src/goal/format.js";
import { formatGoalSnapshot } from "../../src/goal/goal-observability.js";
import { isKnownDiagnosticRepair, lintGoalMarkdown } from "../../src/goal/goal-language-quality.js";
import { createGoalProjectionState } from "../../src/goal/goal-projection-state.js";
import { renderGoalDocument } from "../../src/goal/goal-projection-renderer.js";
import { createThreadGoal } from "../../src/goal/state.js";

const CYRILLIC = /[А-Яа-яЁё]/;

/** Английский вариант включается на время теста; язык — состояние модуля, его нельзя оставлять другим тестам. */
function inEnglish(run: () => void): void {
	setLanguage("en");
	try {
		run();
	} finally {
		setLanguage("ru");
	}
}

function englishGoal() {
	const goal = createThreadGoal("Ship the English variant", null, 1, {
		ownerWants: "The extension speaks English when configured.",
		doneWhen: "English tests pass.",
		selfDecided: [{ kind: "assumption", text: "Glossary terms stay as identifiers." }],
	});
	const state = createGoalProjectionState(goal);
	state.workState = {
		outcome: "English everywhere the owner and the model read",
		doneWhen: "Checked by tests",
		summary: "Strings are wrapped",
		nextItemId: "tests",
		activeDecisionIds: [],
		items: [{ id: "tests", title: "Add tests", status: "planned", source: "agent" }],
	};
	return { goal, state };
}

test("английский GOAL.md: служебный текст документа без кириллицы", () => {
	inEnglish(() => {
		const { state } = englishGoal();
		const document = renderGoalDocument(state);
		assert.match(document, /## Agreement \(revision 1\)/);
		assert.match(document, /\[assumption\] Glossary terms stay as identifiers\./);
		assert.doesNotMatch(document, CYRILLIC);
	});
	const { state } = englishGoal();
	assert.match(renderGoalDocument(state), /## Договорённость \(редакция 1\)/);
});

test("английский /gw и возврат закрытия на сверку без кириллицы", () => {
	inEnglish(() => {
		const { goal, state } = englishGoal();
		const lines = formatGoalSnapshot(goalWorkingState(goal, state, null), "details").join("\n");
		assert.match(lines, /^Goal: /);
		assert.match(lines, /Decided myself, not confirmed:/);
		assert.doesNotMatch(lines, CYRILLIC);
		const message = completionReturnMessage(goal);
		assert.match(message, /The goal is not closed yet/);
		assert.doesNotMatch(message, CYRILLIC);
	});
});

test("языковая проверка в английском варианте принимает английскую прозу и отвечает по-английски", () => {
	const prose = "The plan is done and verified because the checks passed after the review.";
	assert.equal(lintGoalMarkdown(prose).verdict, "repair_required");
	inEnglish(() => {
		assert.equal(lintGoalMarkdown(prose).verdict, "clean");
		const long = lintGoalMarkdown(`${"word ".repeat(150)}\n\n${"next ".repeat(150)}`);
		const diagnostic = long.diagnostics.find((item) => item.code === "long-paragraph");
		assert.ok(diagnostic);
		assert.doesNotMatch(diagnostic.repair, CYRILLIC);
		assert.doesNotMatch(long.findings.map((item) => item.message).join("\n"), CYRILLIC);
		const citation = lintGoalMarkdown("See the source [cite: 3].");
		assert.deepEqual(citation.findings.map((item) => item.message), ["chatbot citation artifact"]);
	});
});

test("журнал, записанный на другом языке, остаётся допустимым после смены языка", () => {
	const russian = lintGoalMarkdown(`${"слово ".repeat(130)}`).diagnostics[0]!;
	inEnglish(() => {
		assert.equal(isKnownDiagnosticRepair(russian.code, russian.repair), true);
		assert.equal(isKnownDiagnosticRepair(russian.code, "произвольный текст"), false);
	});
});
