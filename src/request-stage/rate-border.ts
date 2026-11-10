import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Часть интерфейса Pi, через которую рамка подменяет редактор. */
export type EditorHost = Pick<ExtensionContext["ui"], "getEditorComponent" | "setEditorComponent">;

/** Places the readout on the existing top border without changing editor geometry. */
export function createRateBorder() {
	let rate: string | undefined;
	let redraw: (() => void) | undefined;
	let installedUi: EditorHost | undefined;
	let installedFactory: ReturnType<EditorHost["getEditorComponent"]>;
	let previousFactory: ReturnType<EditorHost["getEditorComponent"]>;

	return {
		install(ui: EditorHost) {
			if (installedFactory && ui.getEditorComponent?.() === installedFactory) { installedUi = ui; return; }
			if (typeof ui.setEditorComponent !== "function" || typeof ui.getEditorComponent !== "function") return;
			previousFactory = ui.getEditorComponent();
			// Only the known inline-slash factory is composed; unrelated editors keep ownership.
			if (previousFactory && !/\bnew\s+InlineSlashEditor\s*\(/.test(Function.prototype.toString.call(previousFactory))) return;
			installedUi = ui;
			const previous = previousFactory;
			installedFactory = (tui, theme, keybindings) => {
				const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
				if (previous) {
					const proto = Object.getPrototypeOf(editor);
					const base = proto && Object.getPrototypeOf(proto);
					if (proto?.constructor?.name !== "InlineSlashEditor" || base?.constructor?.name !== "CustomEditor"
						|| Object.hasOwn(proto, "render") || Object.hasOwn(proto, "renderTopBorder")
						|| !("embedWorkingStatus" in editor) || !("setWorkingStatusIndicator" in editor)
						|| typeof editor.setWorkingStatusIndicator !== "function") return editor;
					// В типах Pi поле только для чтения, но редактор читает его при отрисовке; ставим до первого кадра.
					try { if (!Reflect.set(editor, "embedWorkingStatus", true)) return editor; } catch { return editor; }
				}
				const render = editor.render.bind(editor);
				redraw = () => tui.requestRender();
				editor.render = (width: number) => {
					const lines = render(width);
					const first = lines[0];
					if (!rate || first === undefined) return lines;
					const label = ` ${rate} `;
					const labelWidth = visibleWidth(label);
					const plain = first.replace(/\x1b\[[0-9;]*m/g, "");
					if (!plain.startsWith("─")) return lines;
					// Preserve both Pi's working status and its scroll indicator before adding the label.
					const protectedWidth = Math.max(1, visibleWidth(plain.replace(/─+\s*$/, "").trimEnd()));
					const remaining = width - labelWidth - 1;
					if (remaining < protectedWidth) return lines;
					lines[0] = `${truncateToWidth(first, remaining, "")}${label}${editor.borderColor?.("─") ?? "─"}`;
					return lines;
				};
				return editor;
			};
			ui.setEditorComponent(installedFactory);
		},
		setRate(value: string | undefined) {
			if (rate === value) return;
			rate = value;
			redraw?.();
		},
		uninstall() {
			if (installedUi && installedUi.getEditorComponent?.() === installedFactory) installedUi.setEditorComponent(previousFactory);
			installedUi = undefined;
			installedFactory = undefined;
			previousFactory = undefined;
			redraw = undefined;
			rate = undefined;
		},
	};
}
