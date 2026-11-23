// Pure layout for the thread graph: no React, no bb imports, so it runs under node --test.
// Threads linked by parentThreadId are laid out left to right with dagre (text in bb grows
// to the right, so depth goes right too). Threads with neither a parent nor children in the
// visible set are "floating": packed in a strip below the trees, newest first.
import dagre from "@dagrejs/dagre";

export interface GraphThread {
	id: string;
	title: string;
	parentThreadId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface GraphNode {
	id: string;
	x: number; // top-left
	y: number;
	width: number;
	height: number;
	/** No parent and no children among the visible threads. */
	floating: boolean;
	/** Has a parent that is not visible (archived, hidden, or in another project). */
	orphan: boolean;
}

export interface GraphEdge {
	from: string;
	to: string;
	points: { x: number; y: number }[];
}

export interface GraphLayout {
	nodes: GraphNode[];
	edges: GraphEdge[];
	width: number;
	height: number;
	/** Top of the floating strip, or null when nothing floats. */
	floatingTop: number | null;
}

export interface LayoutOptions {
	nodeWidth?: number;
	nodeHeight?: number;
	/** Width the floating strip wraps at; at least one node per row. */
	wrapWidth?: number;
	rankSep?: number;
	nodeSep?: number;
	gap?: number;
}

export function layoutThreads(threads: readonly GraphThread[], opts: LayoutOptions = {}): GraphLayout {
	const w = opts.nodeWidth ?? 156, h = opts.nodeHeight ?? 26, gap = opts.gap ?? 8;
	const ids = new Set(threads.map((t) => t.id));
	const hasChild = new Set<string>();
	for (const t of threads) if (t.parentThreadId && ids.has(t.parentThreadId)) hasChild.add(t.parentThreadId);
	const linked = (t: GraphThread) => (t.parentThreadId !== null && ids.has(t.parentThreadId)) || hasChild.has(t.id);
	const tree = threads.filter(linked).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const loose = threads.filter((t) => !linked(t)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

	const nodes: GraphNode[] = [], edges: GraphEdge[] = [];
	let width = 0, height = 0;
	if (tree.length) {
		const g = new dagre.graphlib.Graph();
		g.setGraph({ rankdir: "LR", ranksep: opts.rankSep ?? 28, nodesep: opts.nodeSep ?? 6, marginx: 0, marginy: 0 });
		g.setDefaultEdgeLabel(() => ({}));
		for (const t of tree) g.setNode(t.id, { width: w, height: h });
		for (const t of tree) if (t.parentThreadId && ids.has(t.parentThreadId)) g.setEdge(t.parentThreadId, t.id);
		dagre.layout(g);
		for (const t of tree) {
			const n = g.node(t.id);
			nodes.push({ id: t.id, x: n.x - w / 2, y: n.y - h / 2, width: w, height: h, floating: false, orphan: false });
		}
		for (const e of g.edges()) edges.push({ from: e.v, to: e.w, points: g.edge(e).points.map((p: { x: number; y: number }) => ({ x: p.x, y: p.y })) });
		for (const n of nodes) { width = Math.max(width, n.x + n.width); height = Math.max(height, n.y + n.height); }
	}
	let floatingTop: number | null = null;
	if (loose.length) {
		floatingTop = tree.length ? height + gap * 3 : 0;
		const perRow = Math.max(1, Math.floor(((opts.wrapWidth ?? Math.max(width, w)) + gap) / (w + gap)));
		loose.forEach((t, i) => {
			const x = (i % perRow) * (w + gap), y = floatingTop! + Math.floor(i / perRow) * (h + gap);
			nodes.push({ id: t.id, x, y, width: w, height: h, floating: true, orphan: t.parentThreadId !== null });
			width = Math.max(width, x + w); height = Math.max(height, y + h);
		});
	}
	// A child whose parent is not visible still sits in the tree area as a root; mark it.
	for (const n of nodes) {
		const t = threads.find((x) => x.id === n.id)!;
		if (!n.floating && t.parentThreadId !== null && !ids.has(t.parentThreadId)) n.orphan = true;
	}
	return { nodes, edges, width, height, floatingTop };
}

/** SVG path through dagre's edge points, as a smooth curve. */
export function edgePath(points: readonly { x: number; y: number }[]): string {
	if (!points.length) return "";
	if (points.length === 2) return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;
	let d = `M${points[0].x},${points[0].y}`;
	for (let i = 1; i < points.length - 1; i++) {
		const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
		d += `Q${points[i].x},${points[i].y} ${i === points.length - 2 ? `${points[i + 1].x},${points[i + 1].y}` : `${mid.x},${mid.y}`}`;
	}
	return d;
}

/** Scale and offset that fit the whole layout into a viewport, never zooming in past 1. */
export function fitView(layout: Pick<GraphLayout, "width" | "height">, viewport: { width: number; height: number }, pad = 8): { scale: number; x: number; y: number } {
	if (!layout.width || !layout.height) return { scale: 1, x: pad, y: pad };
	const scale = Math.max(0.25, Math.min(1, (viewport.width - pad * 2) / layout.width, (viewport.height - pad * 2) / layout.height));
	return { scale, x: pad, y: pad };
}
