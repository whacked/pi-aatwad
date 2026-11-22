// Decorate the existing editor instance, preserving custom editors and app keybindings.
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { headerText, memberDecor, planDecoration, type MemberDecor } from "../terminal/decor.ts";
import { hostCapabilities, type DecorationMode } from "../terminal/host.ts";

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

/** What the exit guard needs: who is working, and how to quit once the human agrees. */
export interface ExitGuard {
	/** Undefined when nothing could be working (no team, not its leader, or the controller is unreachable). */
	check(): Promise<{ busy: number; title: string; detail: string } | undefined>;
	confirm(title: string, detail: string): Promise<boolean>;
	quit(): void;
	notify(text: string): void;
}

/**
 * Pi has no cancellable quit event, but every interactive quit goes through the editor:
 * Ctrl+D on an empty editor, a second Ctrl+C within 500ms, and a submitted /quit.
 * While members are working, those ask for confirmation first; otherwise they quit at once.
 */
function guardExits(editor: any, guard: ExitGuard): void {
	const guarded = async (proceed: () => void) => {
		let state: Awaited<ReturnType<ExitGuard["check"]>>;
		try { state = await guard.check(); } catch { state = undefined; }
		if (!state || state.busy === 0) { proceed(); return; }
		if (await guard.confirm(state.title, state.detail)) proceed();
		else guard.notify("Not quitting. The team keeps working; /team list shows its state.");
	};
	let ctrlD: (() => void) | undefined = editor.onCtrlD;
	Object.defineProperty(editor, "onCtrlD", { configurable: true, enumerable: true,
		get: () => ctrlD && (() => void guarded(() => ctrlD!())), set: (fn) => { ctrlD = fn; } });
	let submit: ((text: string) => unknown) | undefined = editor.onSubmit;
	Object.defineProperty(editor, "onSubmit", { configurable: true, enumerable: true,
		get: () => submit && ((text: string) => text.trim() === "/quit" ? void guarded(() => void submit!(text)) : submit!(text)),
		set: (fn) => { submit = fn; } });
	if (typeof editor.onAction === "function") {
		const onAction = editor.onAction.bind(editor);
		editor.onAction = (action: string, handler: () => void) => {
			if (action !== "app.clear") return onAction(action, handler);
			let last = 0;
			return onAction(action, () => {
				const now = Date.now();
				// Pi quits on the second clear within 500ms; ask first when members are working.
				if (now - last < 500) { last = 0; void guarded(() => guard.quit()); return; }
				last = now;
				handler();
			});
		};
	}
}

/** Install once per runtime/UI. Unwrap an earlier team wrapper after /reload. */
export function installAgentLabel(ui: UI, name: () => string | undefined, exit?: ExitGuard): void {
	const current = ui.getEditorComponent() as LabelFactory | undefined;
	const wrapped = current?.[BASE];
	const previous = wrapped ? wrapped.factory : current;
	const factory: LabelFactory = (tui, theme, keybindings) => {
		const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		if (exit) guardExits(editor, exit);
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

export const MEMBER_HEADER_WIDGET = "pi-recursive-team.member-header";

/** Width-safe, colored self-drawn header for hosts without richer native decoration. */
export function renderMemberHeader(decor: MemberDecor, width: number): string[] {
	if (width < 4) return [];
	const text = headerText(decor);
	const fitted = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
	return [`\x1b[1;38;5;15;48;5;${decor.color}m${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}\x1b[0m`];
}

/** Dispatch on what the host renders natively; draw a header only where the plan asks for one. */
export function installMemberHeader(ui: UI, decor: () => MemberDecor | undefined, mode: DecorationMode = hostCapabilities().decoration): boolean {
	if (!planDecoration(mode).selfHeader) { ui.setWidget(MEMBER_HEADER_WIDGET, undefined); return false; }
	ui.setWidget(MEMBER_HEADER_WIDGET, () => ({
		render: (width: number) => { const d = decor(); return d ? renderMemberHeader(d, width) : []; },
		invalidate: () => {},
	}), { placement: "aboveEditor" });
	return true;
}

export const MEMBER_STRIP_WIDGET = "pi-recursive-team.members";
/** linked: leads its own team linked under you; switch to it in its own terminal, not with focus. */
export interface StripMember { agent_id: string; role: string; live: boolean; linked?: boolean }

/** One line under the leader's editor: who is running and how to switch to them. */
export function renderMemberStrip(members: StripMember[], width: number): string[] {
	if (!members.length || width < 10) return [];
	const parts = members.map((m) => {
		const decor = memberDecor(m.agent_id, m.role);
		const dot = m.live ? `\x1b[38;5;${decor.color}m●\x1b[39m` : "\x1b[2m○\x1b[22m";
		const name = `${decor.name}${m.linked ? " ⇢" : ""}`;
		return `${dot} ${m.live ? name : `\x1b[2m${name}\x1b[22m`}`;
	});
	const own = members.some((m) => !m.linked), linked = members.some((m) => m.linked);
	const hint = [own ? "/team watch focus <name> switches" : "", linked ? "⇢ = linked team" : ""].filter(Boolean).join(" · ");
	const line = ` team: ${parts.join("  ")}  \x1b[2m· ${hint}\x1b[22m`;
	return [visibleWidth(line) > width ? truncateToWidth(line, width) : line];
}

export function installMemberStrip(ui: UI, members: () => StripMember[]): void {
	ui.setWidget(MEMBER_STRIP_WIDGET, () => ({ render: (width: number) => renderMemberStrip(members(), width), invalidate: () => {} }), { placement: "belowEditor" });
}
