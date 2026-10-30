import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayout } from "../../src/watch/layout.ts";

test("adaptive layout reserves the majority for the leader and fits nonoverlapping members", () => {
	for (const [width, height] of [[200, 60], [120, 40], [80, 24], [60, 80], [40, 100]]) {
		for (const count of [1, 2, 5, 11]) {
			const plan = planLayout(width, height, "%0", Array.from({ length: count }, (_, i) => `%${i + 1}`))!;
			assert.ok(plan, `${width}x${height} / ${count}`);
			assert.equal(plan.cells.length, count + 1);
			assert.ok(plan.cells[0].width * plan.cells[0].height > width * height * 0.5);
			for (const cell of plan.cells) {
				assert.ok(cell.width >= 4 && cell.height >= 3);
				assert.ok(cell.x >= 0 && cell.y >= 0 && cell.x + cell.width <= width && cell.y + cell.height <= height);
			}
			for (let i = 0; i < plan.cells.length; i++) for (let j = i + 1; j < plan.cells.length; j++) {
				const a = plan.cells[i], b = plan.cells[j];
				assert.ok(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
			}
		}
	}
	assert.notEqual(planLayout(200, 40, "%0", ["%1", "%2"])!.orientation, planLayout(40, 100, "%0", ["%1", "%2"])!.orientation);
});

test("layout handles no members and rejects physically impossible allocations", () => {
	assert.equal(planLayout(80, 24, "%0", [])!.cells.length, 1);
	assert.equal(planLayout(8, 3, "%0", ["%1", "%2"]), undefined);
});

test("reads and rewrites tmux 3.8 JSON layouts without losing pane metadata or unrelated geometry", async () => {
	const { parseLayout, encodeLayout, arrangeRegion } = await import("../../src/watch/layout.ts");
	const source = { V: 2, L: { t: "h", w: 160, h: 48, x: 0, y: 0, c: [
		{ t: "p", w: 59, h: 48, x: 0, y: 0, a: true, i: 0, I: "%10" },
		{ t: "p", w: 59, h: 48, x: 60, y: 0, l: 0, i: 1, I: "%11" },
		{ t: "p", w: 40, h: 48, x: 120, y: 0, i: 2, I: "%12" },
	] } };
	// Pretty-printed input also guards against treating spaces as layout delimiters.
	const root = parseLayout(JSON.stringify(source, null, 2));
	assert.deepEqual(JSON.parse(encodeLayout(root)), source);
	const arranged = JSON.parse(arrangeRegion(root, "%10", ["%11"]));
	const leaves = (n: any): any[] => n.t === "p" ? [n] : n.c.flatMap(leaves);
	const panes = leaves(arranged.L);
	assert.deepEqual(panes.find((p) => p.I === "%12"), source.L.c[2]);
	assert.equal(panes.find((p) => p.I === "%10").a, true);
	assert.equal(panes.find((p) => p.I === "%10").i, 0);
	assert.equal(panes.find((p) => p.I === "%11").l, 0);
	assert.equal(panes.find((p) => p.I === "%11").i, 1);
	assert.equal(arranged.V, 2);
	assert.equal(encodeLayout(parseLayout(JSON.stringify(arranged))), JSON.stringify(arranged));
});

test("retains legacy format and gives useful errors for unsupported layout data", async () => {
	const { parseLayout, encodeLayout } = await import("../../src/watch/layout.ts");
	const old = planLayout(80, 24, "%0", ["%1"])!.layout;
	assert.equal(encodeLayout(parseLayout(old)), old);
	assert.throws(() => parseLayout('{"V":3,"L":{}}'), /Unsupported tmux layout version 3/);
	assert.throws(() => parseLayout('{"V":2,"L":{"t":"p"}}'), /geometry/);
	assert.throws(() => parseLayout("not a layout"), /checksummed text or version 2 JSON/);
});
