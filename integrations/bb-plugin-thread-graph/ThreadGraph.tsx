import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
	experimental_ThreadStatusGlyph as ThreadStatusGlyph,
	experimental_useSidebarThreads,
	useBbContext,
	useBbNavigate,
	type ExperimentalSidebarNavigationProps,
	type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { edgePath, fitView, layoutThreads, type GraphLayout } from "./layout.js";

const NODE_W = 128, NODE_H = 26, MIN_H = 80, DEFAULT_H = 240, MIN_SCALE = 0.25, MAX_SCALE = 2;
const KEY = "bb-plugin-thread-graph:";

function stored<T>(key: string, fallback: T): T {
	try { const v = localStorage.getItem(KEY + key); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
}
function store(key: string, value: unknown): void {
	try { localStorage.setItem(KEY + key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}

type View = { scale: number; x: number; y: number };

/** bb's own Top list rows, then the graph. bb's thread list stays below, unchanged. */
export function ThreadGraphNavigation(props: ExperimentalSidebarNavigationProps) {
	const Original = props.experimental_Original;
	return (
		<div className="flex flex-col">
			{Original ? <Original /> : null}
			<ThreadGraph />
		</div>
	);
}

export function ThreadGraph() {
	const { threads, status } = experimental_useSidebarThreads();
	const { projectId, threadId: activeId } = useBbContext();
	const navigate = useBbNavigate();
	const [allProjects, setAllProjects] = useState<boolean>(() => stored("all", false));
	const [collapsed, setCollapsed] = useState<boolean>(() => stored("collapsed", false));
	const [height, setHeight] = useState<number>(() => stored("height", DEFAULT_H));
	const [width, setWidth] = useState(240);
	const [view, setView] = useState<View | null>(null);
	const box = useRef<HTMLDivElement>(null);

	const visible = useMemo(() => threads.filter((t) => !t.isHidden && !t.isArchived && (allProjects || !projectId || t.projectId === projectId)), [threads, allProjects, projectId]);
	const byId = useMemo(() => new Map<string, PluginSidebarThread>(visible.map((t) => [t.id, t])), [visible]);
	const layout: GraphLayout = useMemo(() => layoutThreads(
		visible.map((t) => ({ id: t.id, title: t.displayTitle, parentThreadId: t.parentThreadId, createdAt: t.createdAt, updatedAt: t.updatedAt })),
		{ nodeWidth: NODE_W, nodeHeight: NODE_H, wrapWidth: Math.max(NODE_W, width - 16) },
	), [visible, width]);

	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		setWidth(el.clientWidth);
		return () => ro.disconnect();
	}, [collapsed]);

	/** Keep a view, but pan so the open thread is on screen. */
	const reveal = useCallback((v: View): View => {
		const n = activeId ? layout.nodes.find((x) => x.id === activeId) : undefined;
		if (!n) return v;
		const left = n.x * v.scale + v.x, top = n.y * v.scale + v.y;
		if (left >= 0 && top >= 0 && left + n.width * v.scale <= width && top + n.height * v.scale <= height) return v;
		return { ...v, x: Math.min(8, width / 2 - (n.x + n.width / 2) * v.scale), y: Math.min(8, height / 2 - (n.y + n.height / 2) * v.scale) };
	}, [activeId, layout, width, height]);
	const fit = useCallback(() => {
		const f = fitView(layout, { width, height });
		setView(reveal({ ...f, scale: Math.max(0.85, f.scale) })); // stay readable; pan for the rest
	}, [layout, width, height, reveal]);
	// First layout fits once; afterwards the user's pan and zoom are kept across updates.
	useEffect(() => { if (!view && layout.nodes.length) fit(); }, [view, layout, fit]);
	// Bring the open thread into view when it changes (e.g. picked from bb's list).
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(() => { if (view) setView(reveal(view)); }, [activeId]);

	// Plain wheel or two-finger scroll pans; pinch (ctrl+wheel) zooms around the pointer.
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const onWheel = (e: WheelEvent) => {
			e.preventDefault();
			setView((v) => {
				const cur = v ?? { scale: 1, x: 8, y: 8 };
				if (!e.ctrlKey && !e.metaKey) return { ...cur, x: cur.x - e.deltaX, y: cur.y - e.deltaY };
				const r = el.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
				const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cur.scale * Math.exp(-e.deltaY / 200)));
				return { scale, x: px - (px - cur.x) * (scale / cur.scale), y: py - (py - cur.y) * (scale / cur.scale) };
			});
		};
		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, [collapsed]);

	const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
	const onPointerDown = (e: ReactPointerEvent) => {
		if (e.button !== 0) return;
		const v = view ?? { scale: 1, x: 8, y: 8 };
		drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false };
	};
	const onPointerMove = (e: ReactPointerEvent) => {
		const d = drag.current;
		if (!d) return;
		const dx = e.clientX - d.x, dy = e.clientY - d.y;
		if (!d.moved && Math.hypot(dx, dy) < 4) return;
		if (!d.moved) { d.moved = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
		setView((v) => ({ scale: v?.scale ?? 1, x: d.vx + dx, y: d.vy + dy }));
	};
	const onPointerUp = () => { setTimeout(() => { drag.current = null; }, 0); };
	const open = (id: string, split: boolean) => { if (!drag.current?.moved) navigate.toThread(id, { split }); };

	const resize = useRef<{ y: number; h: number } | null>(null);
	const v = view ?? { scale: 1, x: 8, y: 8 };
	const toggleScope = () => { setAllProjects(!allProjects); store("all", !allProjects); setView(null); };
	const toggleCollapsed = () => { setCollapsed(!collapsed); store("collapsed", !collapsed); };
	const linked = layout.nodes.filter((n) => !n.floating).length;

	return (
		<section className="mx-2 my-1 rounded-md border border-sidebar-border text-sidebar-foreground" aria-label="Thread graph">
			<div className="flex items-center gap-1 px-2 py-1 text-xs">
				<button type="button" className="font-medium hover:underline" onClick={toggleCollapsed} aria-expanded={!collapsed}>
					{collapsed ? "▸" : "▾"} Thread graph
				</button>
				<span className="text-sidebar-foreground/50 truncate">{status === "loading" ? "loading…" : `${linked} linked · ${layout.nodes.length - linked} floating`}</span>
				<span className="flex-1" />
				{!collapsed && <>
					<button type="button" className="rounded px-1 hover:bg-sidebar-accent" title={allProjects ? "Showing every project; show only this one" : "Showing this project; show every project"} onClick={toggleScope}>{allProjects ? "all" : "project"}</button>
					<button type="button" className="rounded px-1 hover:bg-sidebar-accent" title="Fit the graph" onClick={fit}>fit</button>
				</>}
			</div>
			{!collapsed && <>
				<div
					ref={box}
					className="relative overflow-hidden border-t border-sidebar-border cursor-grab active:cursor-grabbing select-none touch-none"
					style={{ height }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
				>
					{layout.nodes.length === 0 && <div className="p-3 text-xs text-sidebar-foreground/50">{status === "loading" ? "Loading threads…" : "No threads here yet."}</div>}
					<div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${v.x}px, ${v.y}px) scale(${v.scale})`, width: layout.width, height: layout.height }}>
						<svg width={layout.width} height={layout.height} style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} aria-hidden>
							{layout.edges.map((e) => <path key={`${e.from}>${e.to}`} d={edgePath(e.points)} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.25} />)}
							{layout.floatingTop !== null && layout.edges.length > 0 && <line x1={0} x2={layout.width} y1={layout.floatingTop - 12} y2={layout.floatingTop - 12} stroke="currentColor" strokeOpacity={0.15} strokeDasharray="3 3" />}
						</svg>
						{layout.nodes.map((n) => {
							const t = byId.get(n.id)!;
							const active = n.id === activeId;
							return (
								<button
									key={n.id}
									type="button"
									title={`${t.displayTitle}${n.orphan ? " (parent not shown)" : ""}\nClick to open · ⌘/Ctrl-click to open in a split`}
									aria-current={active ? "page" : undefined}
									onClick={(e) => open(n.id, e.metaKey || e.ctrlKey)}
									className={[
										"absolute flex items-center gap-1 rounded px-1.5 text-left text-xs",
										"bg-sidebar hover:bg-sidebar-accent",
										n.floating ? "border border-dashed border-sidebar-border" : "border border-sidebar-border",
										active ? "ring-1 ring-sidebar-ring bg-sidebar-accent" : "",
										t.isUnread ? "font-semibold" : "",
									].join(" ")}
									style={{ left: n.x, top: n.y, width: n.width, height: n.height }}
								>
									<ThreadStatusGlyph indicator={t.indicator} />
									{n.orphan && <span className="text-sidebar-foreground/40" aria-hidden>↰</span>}
									<span className="truncate">{t.displayTitle}</span>
								</button>
							);
						})}
					</div>
				</div>
				<div
					className="h-1.5 cursor-row-resize hover:bg-sidebar-accent"
					role="separator"
					aria-orientation="horizontal"
					aria-label="Resize thread graph"
					onPointerDown={(e) => { resize.current = { y: e.clientY, h: height }; e.currentTarget.setPointerCapture(e.pointerId); }}
					onPointerMove={(e) => { const r = resize.current; if (r) setHeight(Math.max(MIN_H, Math.min(900, r.h + e.clientY - r.y))); }}
					onPointerUp={() => { resize.current = null; store("height", height); }}
				/>
			</>}
		</section>
	);
}
