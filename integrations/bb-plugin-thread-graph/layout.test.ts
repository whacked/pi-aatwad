import { test } from "node:test";
import assert from "node:assert/strict";
import { edgePath, fitView, layoutThreads, type GraphThread } from "./layout.ts";

const t = (id: string, parentThreadId: string | null, at: number): GraphThread => ({ id, title: id, parentThreadId, createdAt: at, updatedAt: at });

test("parent/child threads lay out left to right; parentless singletons float below, newest first", () => {
	const layout = layoutThreads([
		t("lead", null, 1), t("a", "lead", 2), t("b", "lead", 3), t("a1", "a", 4),
		t("old", null, 5), t("new", null, 9),
	], { nodeWidth: 100, nodeHeight: 20, wrapWidth: 100 });
	const n = Object.fromEntries(layout.nodes.map((x) => [x.id, x]));
	assert.ok(n.lead.x < n.a.x && n.a.x < n.a1.x, "depth goes right");
	assert.equal(n.a.x, n.b.x, "siblings share a column");
	assert.notEqual(n.a.y, n.b.y);
	assert.deepEqual(layout.edges.map((e) => `${e.from}>${e.to}`).sort(), ["a>a1", "lead>a", "lead>b"]);
	assert.ok(layout.edges.every((e) => e.points.length >= 2));
	assert.equal(n.lead.floating, false);
	assert.equal(n.new.floating && n.old.floating, true);
	const treeBottom = Math.max(...["lead", "a", "b", "a1"].map((id) => n[id].y + n[id].height));
	assert.ok(layout.floatingTop! >= treeBottom && n.new.y >= layout.floatingTop!, "floating strip sits below the trees");
	assert.ok(n.new.y < n.old.y, "newest floating thread first; one per row at this wrap width");
	assert.ok(layout.width >= n.a1.x + n.a1.width && layout.height >= n.old.y + n.old.height);
});

test("a child whose parent is not visible is marked; floating rows wrap to the width", () => {
	const lone = layoutThreads([t("x", "gone", 1), t("y", null, 2), t("z", null, 3)], { nodeWidth: 50, nodeHeight: 10, gap: 10, wrapWidth: 200 });
	const n = Object.fromEntries(lone.nodes.map((x) => [x.id, x]));
	assert.equal(n.x.orphan, true);
	assert.equal(n.x.floating, true, "no visible parent or children: it floats");
	assert.equal(n.y.orphan, false);
	assert.equal(new Set(lone.nodes.map((x) => x.y)).size, 1, "three 50px nodes fit one 200px row");
	assert.equal(lone.floatingTop, 0);
	const tree = layoutThreads([t("p", "gone", 1), t("c", "p", 2)]);
	assert.equal(tree.nodes.find((x) => x.id === "p")!.orphan, true, "a hidden parent is flagged on a tree root too");
	assert.deepEqual(layoutThreads([]), { nodes: [], edges: [], width: 0, height: 0, floatingTop: null });
});

test("edge paths and fitting", () => {
	assert.equal(edgePath([{ x: 0, y: 0 }, { x: 10, y: 5 }]), "M0,0L10,5");
	assert.match(edgePath([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 10 }]), /^M0,0Q5,0 10,10$/);
	assert.deepEqual(fitView({ width: 400, height: 100 }, { width: 216, height: 300 }), { scale: 0.5, x: 8, y: 8 });
	assert.equal(fitView({ width: 50, height: 50 }, { width: 300, height: 300 }).scale, 1, "never zooms in");
});
