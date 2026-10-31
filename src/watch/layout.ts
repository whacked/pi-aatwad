// tmux's portable text layout format, including its rotating 16-bit checksum.
export interface Cell { pane: string; width: number; height: number; x: number; y: number }
export interface Plan { layout: string; cells: Cell[]; orientation: "side" | "stack" }
interface Box { width: number; height: number; x: number; y: number }
const MIN_WIDTH = 4;
const MIN_HEIGHT = 3; // Includes room for the pane title border.
function head(b: Box): string { return `${b.width}x${b.height},${b.x},${b.y}`; }
function checksum(text: string): string {
	let sum = 0;
	for (const char of text) sum = (((sum >> 1) | ((sum & 1) << 15)) + char.charCodeAt(0)) & 0xffff;
	return sum.toString(16).padStart(4, "0");
}
function segments(size: number, count: number): number[] {
	const available = size - count + 1;
	return Array.from({ length: count }, (_, i) => Math.floor(available / count) + (i < available % count ? 1 : 0));
}

/** Leader gets 60% of the area; members share the remaining region in a balanced grid. */
export function planLayout(width: number, height: number, leader: string, members: string[], leaderShare = 0.6): Plan | undefined {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_WIDTH || height < MIN_HEIGHT) return;
	const root: Box = { width, height, x: 0, y: 0 };
	if (!members.length) {
		const body = `${head(root)},${leader.replace(/^%/, "")}`;
		return { layout: `${checksum(body)},${body}`, cells: [{ ...root, pane: leader }], orientation: "side" };
	}
	let best: { score: number; plan: Plan } | undefined;
	for (const orientation of ["side", "stack"] as const) {
		const side = orientation === "side";
		const total = side ? width : height;
		const mainSize = Math.round((total - 1) * leaderShare);
		const leaderBox: Box = { ...root, ...(side ? { width: mainSize } : { height: mainSize }) };
		const region: Box = side ? { ...root, width: total - mainSize - 1, x: mainSize + 1 }
			: { ...root, height: total - mainSize - 1, y: mainSize + 1 };
		if (leaderBox.width < MIN_WIDTH || leaderBox.height < MIN_HEIGHT) continue;
		for (let columns = 1; columns <= members.length; columns++) {
			const columnWidths = segments(region.width, columns);
			const rowCounts = Array.from({ length: columns }, (_, c) => Math.floor(members.length / columns) + (c < members.length % columns ? 1 : 0));
			if (Math.min(...columnWidths) < MIN_WIDTH || rowCounts.some((n) => Math.min(...segments(region.height, n)) < MIN_HEIGHT)) continue;
			const cells: Cell[] = [{ ...leaderBox, pane: leader }];
			let index = 0, x = region.x;
			const columnLayouts: string[] = [];
			const scores: number[] = [];
			for (let c = 0; c < columns; c++) {
				let y = region.y;
				const heights = segments(region.height, rowCounts[c]);
				const rows = heights.map((h) => {
					const cell = { width: columnWidths[c], height: h, x, y, pane: members[index++] };
					cells.push(cell);
					// Favor legible terminal proportions (roughly 40 columns by 10 rows).
					scores.push(Math.abs(Math.log(cell.width / cell.height / 4)));
					y += h + 1;
					return `${head(cell)},${cell.pane.replace(/^%/, "")}`;
				});
				columnLayouts.push(rows.length === 1 ? rows[0] : `${head({ ...region, width: columnWidths[c], x })}[${rows.join(",")}]`);
				x += columnWidths[c] + 1;
			}
			const grid = columns === 1 ? columnLayouts[0] : `${head(region)}{${columnLayouts.join(",")}}`;
			const main = `${head(leaderBox)},${leader.replace(/^%/, "")}`;
			const body = `${head(root)}${side ? "{" : "["}${main},${grid}${side ? "}" : "]"}`;
			// Keep the leader readable too, especially on narrow terminals.
			const score = scores.reduce((a, b) => a + b, 0) / scores.length + Math.abs(Math.log(leaderBox.width / leaderBox.height / 3)) * 0.3;
			if (!best || score < best.score) best = { score, plan: { layout: `${checksum(body)},${body}`, cells, orientation } };
		}
	}
	return best?.plan;
}

export interface LayoutNode extends Box { pane?: string; direction?: "{" | "["; children?: LayoutNode[]; json?: Record<string, unknown>; document?: Record<string, unknown> }
export function parseLayout(layout: string): LayoutNode {
	layout = layout.trim();
	if (layout.startsWith("{")) {
		let document: Record<string, unknown>;
		try { document = JSON.parse(layout); } catch { throw new Error("Cannot parse tmux JSON window layout"); }
		if (document.V !== 2) throw new Error(`Unsupported tmux layout version ${document.V}`);
		function cell(value: unknown): LayoutNode {
			if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tmux JSON layout cell");
			const n = value as Record<string, unknown>;
			if (![n.w, n.h, n.x, n.y].every(Number.isInteger) || Number(n.w) < 1 || Number(n.h) < 1) throw new Error("Invalid tmux JSON layout geometry");
			const node: LayoutNode = { width: Number(n.w), height: Number(n.h), x: Number(n.x), y: Number(n.y), json: { ...n } };
			if (n.t === "p" && typeof n.I === "string" && /^%\d+$/.test(n.I)) node.pane = n.I;
			else if ((n.t === "h" || n.t === "v") && Array.isArray(n.c) && n.c.length) {
				node.direction = n.t === "h" ? "{" : "[";
				node.children = n.c.map(cell);
			} else throw new Error("Invalid tmux JSON layout type or pane ID");
			return node;
		}
		const root = cell(document.L);
		root.document = document;
		return root;
	}
	if (!/^[0-9a-f]{4},/i.test(layout)) throw new Error("Cannot parse tmux window layout: expected checksummed text or version 2 JSON");
	const body = layout.slice(layout.indexOf(",") + 1);
	let offset = 0;
	function read(): LayoutNode {
		const m = /^(\d+)x(\d+),(-?\d+),(-?\d+)/.exec(body.slice(offset));
		if (!m) throw new Error("Cannot parse tmux window layout");
		offset += m[0].length;
		const node: LayoutNode = { width: +m[1], height: +m[2], x: +m[3], y: +m[4] };
		const separator = body[offset++];
		if (separator === ",") {
			const id = /^\d+/.exec(body.slice(offset));
			if (!id) throw new Error("Missing tmux pane ID");
			node.pane = `%${id[0]}`; offset += id[0].length;
		} else if (separator === "{" || separator === "[") {
			node.direction = separator; node.children = [];
			do { node.children.push(read()); } while (body[offset++] === ",");
		} else throw new Error("Invalid tmux layout cell");
		return node;
	}
	const node = read();
	if (offset !== body.length) throw new Error("Unexpected tmux layout suffix");
	return node;
}
export function encodeLayout(root: LayoutNode): string {
	if (root.document) {
		function json(n: LayoutNode): Record<string, unknown> {
			const { t: _t, w: _w, h: _h, x: _x, y: _y, c: _c, I, i, a, l, z, ...extra } = n.json ?? {};
			const value: Record<string, unknown> = { ...extra, t: n.pane ? "p" : n.direction === "{" ? "h" : "v", w: n.width, h: n.height, x: n.x, y: n.y };
			if (n.pane) {
				if (a !== undefined) value.a = a;
				if (l !== undefined) value.l = l;
				if (i !== undefined) value.i = i;
				if (z !== undefined) value.z = z;
				value.I = n.pane;
			} else value.c = n.children!.map(json);
			return value;
		}
		return JSON.stringify({ ...root.document, L: json(root) });
	}
	function encode(n: LayoutNode): string {
		return n.pane ? `${head(n)},${n.pane.slice(1)}` : `${head(n)}${n.direction}${n.children!.map(encode).join(",")}${n.direction === "{" ? "}" : "]"}`;
	}
	const text = encode(root);
	return `${checksum(text)},${text}`;
}
/** Find the team-only subtree; never resize or reorder unrelated panes. */
export function teamRegion(root: LayoutNode, paneIds: string[]): LayoutNode {
	const wanted = new Set(paneIds);
	function leaves(n: LayoutNode): string[] { return n.pane ? [n.pane] : n.children!.flatMap(leaves); }
	function find(n: LayoutNode): LayoutNode | undefined {
		const ids = leaves(n);
		if (ids.length === wanted.size && ids.every((id) => wanted.has(id))) return n;
		for (const child of n.children ?? []) { const found = find(child); if (found) return found; }
		// tmux flattens adjacent splits with the same orientation. Reconstruct a
		// contiguous team-only sibling group without including unrelated panes.
		const children = n.children ?? [];
		const selected = children.map((c, i) => ({ c, i, ids: leaves(c) })).filter(({ ids }) => ids.every((id) => wanted.has(id)));
		if (selected.length && selected.flatMap((s) => s.ids).length === wanted.size && selected.every((s, i) => s.i === selected[0].i + i)) {
			const cells = selected.map((s) => s.c);
			const x = Math.min(...cells.map((c) => c.x)), y = Math.min(...cells.map((c) => c.y));
			const group: LayoutNode = { x, y, width: Math.max(...cells.map((c) => c.x + c.width)) - x,
				height: Math.max(...cells.map((c) => c.y + c.height)) - y, direction: n.direction, children: cells };
			children.splice(selected[0].i, selected.length, group);
			return group;
		}
	}
	const region = find(root);
	if (!region) throw new Error("Team panes no longer form a separate region; refusing to rearrange unrelated tmux panes");
	return region;
}
export function arrangeRegion(root: LayoutNode, leader: string, members: string[], leaderShare = 0.6): string {
	const region = teamRegion(root, [leader, ...members]);
	const plan = planLayout(region.width, region.height, leader, members, leaderShare);
	if (!plan) throw new Error(`Team pane region ${region.width}x${region.height} is too small; enlarge it`);
	const metadata = new Map<string, Record<string, unknown>>();
	function remember(n: LayoutNode): void { if (n.pane && n.json) metadata.set(n.pane, n.json); n.children?.forEach(remember); }
	remember(region);
	const replacement = parseLayout(plan.layout);
	function restore(n: LayoutNode): void { if (n.pane) n.json = metadata.get(n.pane); n.children?.forEach(restore); }
	restore(replacement);
	function shift(n: LayoutNode): void { n.x += region.x; n.y += region.y; n.children?.forEach(shift); }
	shift(replacement);
	const document = region.document;
	Object.assign(region, replacement);
	if (document) region.document = document;
	if (replacement.pane) { delete region.children; delete region.direction; } else delete region.pane;
	return encodeLayout(root);
}
