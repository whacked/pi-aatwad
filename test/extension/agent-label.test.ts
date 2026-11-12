import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { agentDisplayName, installAgentLabel, labelBorder } from "../../src/extension/agent-label.ts";

const style = (s: string) => `\x1b[1;36m${s}\x1b[0m`;

test("agent label is right-aligned, accented/bold and width safe, including Unicode and tiny terminals", () => {
	for (let width = 0; width <= 100; width++) {
		for (const name of ["ResumeReviewer", "代理🤖e\u0301", "A".repeat(200)]) {
			const line = labelBorder("─".repeat(width), width, name, style);
			assert.equal(visibleWidth(line), width, `${width}: ${line}`);
			if (width >= 30 && name === "ResumeReviewer") {
				assert.ok(line.includes("\x1b[1;36m"));
				assert.ok(stripTerminalSequences(line).endsWith(" ResumeReviewer ──"));
			}
		}
	}
	assert.equal(agentDisplayName("root"), "Team leader");
	assert.equal(agentDisplayName("\x1b[31mBad\x1b[0m\nName"), "Bad Name");
});

test("labels preserve existing border indicators and leave non-border editors untouched", () => {
	const line = "── working ↑ 3 more " + "─".repeat(55);
	const labeled = labelBorder(line, visibleWidth(line), "Reviewer", style);
	assert.ok(stripTerminalSequences(labeled).startsWith("── working ↑ 3 more "));
	assert.equal(visibleWidth(labeled), visibleWidth(line));
	for (const line of ["custom editor prompt", "── status ──", "text ━━━━━"]) {
		assert.equal(labelBorder(line, visibleWidth(line), "Reviewer", style), line);
	}
});

test("default editor preserves embedded working status, draft text and application escape binding", () => {
	let factory: any;
	const ui: any = { getEditorComponent: () => undefined, setEditorComponent: (f: any) => { factory = f; }, theme: { style } };
	installAgentLabel(ui, () => "Reviewer");
	const editor = factory({ terminal: { rows: 30, columns: 80 }, requestRender() {} }, { borderColor: (s: string) => s, selectList: {} }, { matches: (_data: string, action: string) => action === "app.interrupt" });
	assert.equal(editor.embedWorkingStatus, true);
	editor.setWorkingStatusIndicator({ renderInBorder: () => "⠋ working", renderSpinnerInBorder: () => "⠋" });
	editor.setText("draft text");
	const lines = editor.render(80);
	assert.match(stripTerminalSequences(lines[0]), /working.*Reviewer/);
	assert.equal(editor.getText(), "draft text");
	let escaped = false;
	editor.onEscape = () => { escaped = true; };
	editor.handleInput("\x1b");
	assert.equal(escaped, true);
});

test("editor decoration composes with custom editors, follows identity/theme and does not stack on reload", () => {
	let name: string | undefined = "Alpha";
	let color = style;
	let inputs = "";
	const previous = () => ({
		render: (width: number) => ["─".repeat(width), "user text", "─".repeat(width)],
		handleInput: (data: string) => { inputs += data; },
		getText: () => "user text",
		invalidate: () => {},
	});
	let factory: any = previous;
	const ui: any = { getEditorComponent: () => factory, setEditorComponent: (f: any) => { factory = f; }, theme: { style: (s: string) => color(s) } };
	installAgentLabel(ui, () => name);
	const editor = factory();
	editor.handleInput("abc");
	assert.equal(inputs, "abc");
	assert.equal(editor.getText(), "user text");
	assert.equal(editor.render(40)[1], "user text");
	assert.match(editor.render(40)[0], /Alpha/);
	name = "Beta";
	color = (s) => `\x1b[1;35m${s}\x1b[0m`;
	assert.match(editor.render(40)[0], /\x1b\[1;35m Beta /);
	installAgentLabel(ui, () => "Gamma");
	const reloaded = factory();
	assert.match(reloaded.render(60)[0], /Gamma/);
	assert.doesNotMatch(reloaded.render(60)[0], /Beta|Alpha/);
	name = undefined;
	assert.equal(editor.render(40)[0], "─".repeat(40), "detached identity removes label without replacing the editor");
});
