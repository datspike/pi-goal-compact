import { describe, expect, test } from "../support/expect.js";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createRateBorder, type EditorHost } from "../../src/request-stage/rate-border.js";
import { asPi } from "../support/as-pi.js";

type EditorFactory = NonNullable<ReturnType<EditorHost["getEditorComponent"]>>;
type FactoryArgs = Parameters<EditorFactory>;

/** Хост редактора, как в Pi: хранит текущую фабрику и отдаёт её обратно. */
function editorHost(initial?: EditorFactory) {
	let factory = initial;
	const ui: EditorHost = { getEditorComponent: () => factory, setEditorComponent: (next) => { factory = next; } };
	return { ui, factory: () => factory };
}

/** Создаёт редактор текущей фабрикой на подделке терминала; ждём редактор Pi. */
function openEditor(factory: EditorFactory | undefined, requestRender = () => {}): CustomEditor {
	if (!factory) throw new Error("фабрика редактора не установлена");
	const tui = asPi<FactoryArgs[0]>({ terminal: { rows: 20 }, requestRender });
	const theme = asPi<FactoryArgs[1]>({ borderColor: (s: string) => s });
	const keys = asPi<FactoryArgs[2]>({ matches: () => false });
	const editor = factory(tui, theme, keys);
	if (!(editor instanceof CustomEditor)) throw new Error("фабрика вернула не редактор Pi");
	return editor;
}

/** Строка работы Pi в рамке: подменяем только то, что рисуется. */
const statusIndicator = (text: string) => asPi<NonNullable<Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]>>({ renderInBorder: () => text, renderSpinnerInBorder: () => "⠋" });

function setup() {
	let renders = 0;
	const host = editorHost();
	const border = createRateBorder();
	border.install(host.ui);
	const editor = openEditor(host.factory(), () => { renders++; });
	return { ui: host.ui, border, editor, getFactory: host.factory, renders: () => renders };
}

describe("rate border", () => {
	test("preserves the stock embedded working status, scrolling and editor contents", () => {
		const { border, editor, renders, getFactory } = setup();
		expect(editor.embedWorkingStatus).toBe(true);
		editor.setWorkingStatusIndicator(statusIndicator("РАБОТА"));
		editor.setText(Array.from({ length: 14 }, (_, i) => `line ${i}`).join("\n"));
		const before = editor.render(80);
		expect(before[0]).toContain("РАБОТА");
		expect(before[0]).toMatch(/↑\s*\d+\s+more/);
		border.setRate("ср. 65 / 48 ток/с");
		const after = editor.render(80);
		expect(after[0]).toContain("РАБОТА");
		expect(after[0]).toMatch(/↑\s*\d+\s+more/);
		expect(after[0]).toContain("ср. 65 / 48 ток/с");
		expect(after.slice(1)).toEqual(before.slice(1));
		expect(renders()).toBe(1);
		border.uninstall();
		expect(getFactory()).toBeUndefined();
	});

	test("does not truncate a long working status to make room for the rate", () => {
		const { border, editor } = setup();
		editor.setWorkingStatusIndicator(statusIndicator("длинная рабочая стадия запроса"));
		const before = editor.render(50)[0];
		border.setRate("ср. 65 / 48 ток/с");
		expect(editor.render(50)[0]).toBe(before);
	});

	test("does not replace or mutate a foreign editor, including a border-like header", () => {
		const editor = { render: () => ["──── foreign status ─────────────", "text"] };
		const previous = asPi<EditorFactory>(() => editor);
		const host = editorHost(previous);
		const border = createRateBorder();
		border.install(host.ui);
		border.setRate("ср. 65 / 48 ток/с");
		expect(host.factory()).toBe(previous);
		expect(editor.render()[0]).toBe("──── foreign status ─────────────");
		border.uninstall();
		expect(host.factory()).toBe(previous);
	});

	test("composes the inline slash editor without changing its input handling", () => {
		class InlineSlashEditor extends CustomEditor {
			override handleInput(data: string) { super.handleInput(data); }
		}
		const previous: EditorFactory = (tui, theme, keys) => new InlineSlashEditor(tui, theme, keys);
		const host = editorHost(previous);
		const border = createRateBorder();
		border.install(host.ui);
		const editor = openEditor(host.factory());
		border.setRate("ср. 65 / 48 ток/с");
		editor.handleInput("x");
		expect(editor.getText()).toBe("x");
		expect(editor.embedWorkingStatus).toBe(true);
		expect(editor.render(80)[0]).toContain("ср. 65 / 48 ток/с");
		border.uninstall();
		expect(host.factory()).toBe(previous);
	});

	test("reinstalls after inline slash replaces the default factory", () => {
		class InlineSlashEditor extends CustomEditor {}
		const previous: EditorFactory = (tui, theme, keys) => new InlineSlashEditor(tui, theme, keys);
		const host = editorHost();
		const border = createRateBorder();
		border.install(host.ui);
		host.ui.setEditorComponent(previous);
		border.install(host.ui);
		const editor = openEditor(host.factory());
		border.setRate("ср. 65 / 48 ток/с");
		expect(editor.render(80)[0]).toContain("ср. 65 / 48 ток/с");
		border.uninstall();
		expect(host.factory()).toBe(previous);
	});

	test("does not modify an inline-named editor with its own rendering", () => {
		class InlineSlashEditor extends CustomEditor {
			override render(_width: number) { return ["──── foreign status ─────────────"]; }
		}
		const previous: EditorFactory = (tui, theme, keys) => new InlineSlashEditor(tui, theme, keys);
		const host = editorHost(previous);
		const border = createRateBorder();
		border.install(host.ui);
		const editor = openEditor(host.factory());
		border.setRate("ср. 65 / 48 ток/с");
		expect(editor.render(80)[0]).toBe("──── foreign status ─────────────");
		expect(editor.embedWorkingStatus).toBe(false);
		border.uninstall();
		expect(host.factory()).toBe(previous);
	});

	test("does not restore over a factory installed after this one", () => {
		const { ui, border, getFactory } = setup();
		const other = asPi<EditorFactory>(() => ({}));
		ui.setEditorComponent(other);
		border.uninstall();
		expect(getFactory()).toBe(other);
	});
});
