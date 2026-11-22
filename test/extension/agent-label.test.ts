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

test("the exit guard asks before quitting while members work, and quits at once when they are idle", async () => {
	let factory: any;
	let busy = 1, confirmAnswer = false;
	const calls: string[] = [];
	const registered = new Map<string, () => void>();
	// A stand-in for whatever editor is installed: records action handlers the way CustomEditor does.
	const previous = () => ({ render: (w: number) => ["─".repeat(w), "", "─".repeat(w)], handleInput() {}, invalidate() {}, getText: () => "",
		onAction(action: string, handler: () => void) { registered.set(action, handler); } });
	const ui: any = { getEditorComponent: () => previous, setEditorComponent: (f: any) => { factory = f; }, theme: { style: (s: string) => s } };
	installAgentLabel(ui, () => "Leader", {
		check: async () => ({ busy, title: "Members working", detail: `${busy} working` }),
		confirm: async (title) => { calls.push(`confirm:${title}`); return confirmAnswer; },
		quit: () => calls.push("quit"),
		notify: (text) => calls.push(`notify:${text.slice(0, 11)}`),
	});
	const editor = factory({}, {}, {});
	const settle = () => new Promise((r) => setTimeout(r, 10));
	// Pi wires its own quit handlers onto the editor after creating it.
	editor.onCtrlD = () => calls.push("pi-ctrl-d");
	editor.onSubmit = (text: string) => calls.push(`pi-submit:${text}`);
	editor.onAction("app.clear", () => calls.push("pi-clear"));
	const clear = registered.get("app.clear")!;

	editor.onCtrlD(); await settle();
	assert.deepEqual(calls.splice(0), ["confirm:Members working", "notify:Not quittin"], "declined: Pi's quit never runs");
	confirmAnswer = true;
	editor.onSubmit("/quit"); await settle();
	assert.deepEqual(calls.splice(0), ["confirm:Members working", "pi-submit:/quit"]);
	editor.onSubmit("hello"); await settle();
	assert.deepEqual(calls.splice(0), ["pi-submit:hello"], "ordinary prompts pass straight through");
	busy = 0;
	editor.onCtrlD(); await settle();
	assert.deepEqual(calls.splice(0), ["pi-ctrl-d"], "idle team: no question");
	clear(); clear(); await settle();
	assert.deepEqual(calls.splice(0), ["pi-clear", "quit"], "the second clear within 500ms quits through the guard");
	busy = 2; confirmAnswer = false;
	clear(); clear(); await settle();
	assert.deepEqual(calls.splice(0), ["pi-clear", "confirm:Members working", "notify:Not quittin"]);
});
