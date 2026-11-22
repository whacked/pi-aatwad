import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { memberColor, memberDecor, nativeLabel, planDecoration } from "../../src/terminal/decor.ts";
import { installMemberHeader, MEMBER_HEADER_WIDGET, renderMemberHeader, renderMemberStrip } from "../../src/extension/agent-label.ts";
import type { DecorationMode } from "../../src/terminal/host.ts";

test("decoration dispatch: native components replace the self-drawn header; weaker hosts keep it", () => {
	assert.deepEqual(planDecoration("components"), { native: "components", selfHeader: false });
	assert.deepEqual(planDecoration("border-title"), { native: "border-title", selfHeader: true });
	assert.deepEqual(planDecoration("label"), { native: "label", selfHeader: true });
	assert.deepEqual(planDecoration("self"), { selfHeader: true });
});

test("member decor is stable per agent, sanitized, and labels fit host limits", () => {
	assert.equal(memberColor("river-maple-1"), memberColor("river-maple-1"));
	const colors = new Set(Array.from({ length: 40 }, (_, i) => memberColor(`agent-${i}`)));
	assert.ok(colors.size > 4, "members are spread across the palette");
	const decor = memberDecor("river-maple-1", "\x1b[31mReviewer\x1b[0m\nTwo");
	assert.equal(decor.name, "Reviewer Two");
	assert.equal(nativeLabel(decor), "Reviewer Two [river-maple-1]");
	assert.equal(nativeLabel(memberDecor("x", "A".repeat(200)), 20).length, 20);
	assert.equal(nativeLabel(memberDecor("root-1", undefined, true)), "Team leader");
});

test("self-drawn header is exactly the terminal width, including wide characters and tiny terminals", () => {
	for (const name of ["Reviewer", "代理🤖é", "A".repeat(300)]) {
		const decor = memberDecor("river-maple-1", name);
		for (let width = 0; width <= 120; width++) {
			const lines = renderMemberHeader(decor, width);
			if (width < 4) { assert.deepEqual(lines, []); continue; }
			assert.equal(lines.length, 1);
			assert.equal(visibleWidth(lines[0]), width, `${name} @ ${width}`);
		}
	}
	assert.match(stripTerminalSequences(renderMemberHeader(memberDecor("river-maple-1", "Reviewer"), 80)[0]), /Reviewer {2}team member · river-maple-1/);
});

test("member header widget follows the dispatch plan and the current identity", () => {
	const widgets = new Map<string, any>();
	const ui: any = { setWidget: (key: string, content: unknown) => widgets.set(key, content) };
	let decor: ReturnType<typeof memberDecor> | undefined;
	for (const mode of ["self", "label", "border-title"] as DecorationMode[]) {
		assert.equal(installMemberHeader(ui, () => decor, mode), true, mode);
		const widget = widgets.get(MEMBER_HEADER_WIDGET)({}, {});
		decor = undefined;
		assert.deepEqual(widget.render(80), [], "nothing until a member identity exists");
		decor = memberDecor("river-maple-1", "Reviewer");
		assert.equal(visibleWidth(widget.render(80)[0]), 80);
	}
	assert.equal(installMemberHeader(ui, () => decor, "components"), false);
	assert.equal(widgets.get(MEMBER_HEADER_WIDGET), undefined, "native components remove the self-drawn header");
});

test("leader member strip lists running members with their colors, dims stopped ones and fits the width", () => {
	assert.deepEqual(renderMemberStrip([], 80), []);
	const members = [{ agent_id: "a-1", role: "Alpha", live: true }, { agent_id: "b-2", role: "Beta", live: false }];
	const [line] = renderMemberStrip(members, 120);
	assert.equal(stripTerminalSequences(line), " team: ● Alpha  ○ Beta  · /team watch focus <name> switches");
	assert.ok(line.includes(`\x1b[38;5;${memberColor("a-1")}m●`), "member color matches its header");
	for (let width = 10; width < 80; width++) assert.ok(visibleWidth(renderMemberStrip(members, width)[0]) <= width, String(width));
});

test("member header can carry the way back to the leader", () => {
	const [line] = renderMemberHeader({ ...memberDecor("m-1", "Alpha"), hint: "/team back returns to the leader" }, 120);
	assert.match(stripTerminalSequences(line), /Alpha {2}team member · m-1 {2}· {2}\/team back returns to the leader/);
});

test("the member strip marks linked teams and only offers focus for the leader's own members", () => {
	const [mixed] = renderMemberStrip([{ agent_id: "a-1", role: "Alpha", live: true }, { agent_id: "t-9", role: "Contractor", live: true, linked: true }], 140);
	assert.equal(stripTerminalSequences(mixed), " team: ● Alpha  ● Contractor ⇢  · /team watch focus <name> switches · ⇢ = linked team");
	const [onlyLinked] = renderMemberStrip([{ agent_id: "t-9", role: "Contractor", live: false, linked: true }], 140);
	assert.equal(stripTerminalSequences(onlyLinked), " team: ○ Contractor ⇢  · ⇢ = linked team");
});

test("trees show teams linked under their leads", async () => {
	const { formatTree } = await import("../../src/extension/format.ts");
	const node = (id: string, role: string, children: any[] = [], run_id?: string) => ({ agent_id: id, role, status: "RUNNING", desired_state: "RUNNING", observed_state: "LIVE", model: null, parent_id: null, children, ...(run_id ? { run_id } : {}) });
	const out = formatTree({ run_id: "run-lead", topology_version: 1, root: node("lead", "root", [node("m-1", "Alpha"), node("sub", "Contractor", [], "run-sub")]), history: [] } as any, "lead");
	assert.match(out, /├─ Alpha \[m-1\] RUNNING\/LIVE/);
	assert.match(out, /└─ Contractor \[sub\] ⇢ team run-sub RUNNING\/LIVE/);
});
