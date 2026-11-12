// Decorate the existing editor instance, preserving custom editors and app keybindings.
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type UI = ExtensionContext["ui"];
type Factory = NonNullable<ReturnType<UI["getEditorComponent"]>>;
const BASE = Symbol.for("pi-recursive-team.agent-label.base");
type LabelFactory = Factory & { [BASE]?: { factory: Factory | undefined } };

export function agentDisplayName(role?: string): string {
	return stripTerminalSequences(role === "root" ? "Team leader" : role || "Agent").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Only replace trailing border strokes; never overwrite another editor's status/text. */
export function labelBorder(line: string, width: number, name: string, style: (text: string) => string): string {
	const plain = stripTerminalSequences(line);
	if (visibleWidth(line) !== width) return line;
	const trailing = plain.match(/─+$/u)?.[0].length ?? 0;
	const available = Math.min(width, trailing) - 4;
	if (available < 3 || !name) return line;
	const text = truncateToWidth(name, available);
	const cut = width - visibleWidth(text) - 4;
	return sliceByColumn(line, 0, cut) + style(` ${text} `) + sliceByColumn(line, width - 2, 2);
}

/** Install once per runtime/UI. Unwrap an earlier team wrapper after /reload. */
export function installAgentLabel(ui: UI, name: () => string | undefined): void {
	const current = ui.getEditorComponent() as LabelFactory | undefined;
	const wrapped = current?.[BASE];
	const previous = wrapped ? wrapped.factory : current;
	const factory: LabelFactory = (tui, theme, keybindings) => {
		const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const render = editor.render.bind(editor);
		editor.render = (width) => {
			const lines = render(width);
			const label = name();
			if (!label || lines.length < 2) return lines;
			const result = [...lines];
			result[0] = labelBorder(result[0], width, label, (text) => ui.theme.style(text, { fg: "accent", bold: true }));
			return result;
		};
		return editor;
	};
	factory[BASE] = { factory: previous };
	ui.setEditorComponent(factory);
}
