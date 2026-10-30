import { planLayout } from "./layout.ts";
// A dedicated, owned tmux session. Monitoring never owns the worker processes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { packageRoot } from "../shared/paths.ts";
import { clean } from "./render.ts";
import type { TreeNode } from "../shared/protocol.ts";
const exec = promisify(execFile);

export interface WatchOptions { stateDir: string; runId: string; socket?: string; node?: string }
export interface Pane { id: string; window: string; agent: string; dead: boolean }
export class TmuxWatch {
	opts: WatchOptions;
	name: string;
	owner: string;
	constructor(opts: WatchOptions) {
		this.opts = opts;
		this.owner = createHash("sha256").update(resolve(opts.stateDir)).update("\0").update(opts.runId).digest("hex");
		this.name = `pi-team-${this.owner.slice(0, 16)}`;
	}
	async tmux(...args: string[]): Promise<string> {
		try {
			const result = await exec("tmux", [...(this.opts.socket ? ["-S", this.opts.socket] : []), ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
			return result.stdout.trim();
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			if (err.code === "ENOENT") throw new Error("tmux is not installed or is not on PATH; install tmux to use /team watch");
			throw new Error(`tmux: ${err.stderr?.trim() || err.message}`);
		}
	}
	async exists(): Promise<boolean> {
		try { await this.tmux("has-session", "-t", `=${this.name}`); return true; }
		catch (e) {
			if (/not installed/.test((e as Error).message)) throw e;
			if (/can't find session|no server running|no sessions|error connecting/.test((e as Error).message)) return false;
			throw e;
		}
	}
	async assertOwned(): Promise<void> {
		if (await this.tmux("show-options", "-qv", "-t", this.name, "@pi_team_watch") !== this.owner)
			throw new Error(`tmux session ${this.name} is not owned by this team; refusing to change it`);
	}
	command(agent: string): string[] {
		const exe = basename(process.execPath).toLowerCase();
		const node = this.opts.node ?? (/^node(\.exe)?$/.test(exe) && !("bun" in process.versions) ? process.execPath : "node");
		return [node, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(packageRoot(), "src/watch/main.ts"),
			this.opts.stateDir, this.opts.runId, agent, this.opts.socket ?? ""];
	}
	async panes(): Promise<Pane[]> {
		await this.assertOwned();
		const result = await this.tmux("list-panes", "-s", "-t", this.name, "-F", "#{pane_id}\t#{window_id}\t#{@pi_team_agent}\t#{pane_dead}");
		return result.split("\n").filter(Boolean).map((line) => {
			const [id, window, agent, dead] = line.split("\t");
			return { id, window, agent, dead: dead === "1" };
		});
	}
	async tag(pane: string, agent: string): Promise<void> {
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_agent", agent);
		await this.tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on");
	}
	async open(): Promise<void> {
		if (await this.exists()) {
			const dashboard = (await this.panes()).find((p) => p.agent === "dashboard");
			if (!dashboard) throw new Error("Team dashboard pane is missing; close and reopen the watch session");
			if (dashboard.dead) await this.tmux("respawn-pane", "-k", "-t", dashboard.id, ...this.command("dashboard"));
			return;
		}
		let width = process.stdout.columns || process.stderr.columns || 120, height = process.stdout.rows || process.stderr.rows || 40;
		if (process.env.TMUX && !this.opts.socket) {
			const size = await this.tmux("display-message", "-p", "#{window_width} #{window_height}");
			[width, height] = size.split(" ").map(Number);
		}
		const pane = await this.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", this.name, "-e", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "-n", "team", "-x", String(width), "-y", String(height), ...this.command("dashboard"));
		await this.tmux("set-option", "-t", this.name, "@pi_team_watch", this.owner);
		await this.tag(pane, "dashboard");
	}
	async close(): Promise<void> {
		if (!await this.exists()) return;
		await this.assertOwned();
		await this.tmux("kill-session", "-t", this.name);
	}
	async focus(agent = "dashboard"): Promise<void> {
		const pane = (await this.panes()).find((p) => p.agent === agent);
		if (!pane) throw new Error(`No monitor pane for ${agent}; wait for discovery or check /team tree`);
		await this.tmux("select-window", "-t", pane.window);
		await this.tmux("select-pane", "-t", pane.id);
		if (process.env.TMUX && !this.opts.socket) await this.tmux("switch-client", "-t", this.name);
	}
	async dimensions(window: string): Promise<{ width: number; height: number }> {
		const result = await this.tmux("display-message", "-p", "-t", window, "#{window_width} #{window_height}");
		const [width, height] = result.split(" ").map(Number);
		return { width, height };
	}
	async arrange(panes: Pane[], dashboard: Pane): Promise<void> {
		const { width, height } = await this.dimensions(dashboard.window);
		const members = panes.filter((p) => p.window === dashboard.window && p.id !== dashboard.id);
		const plan = planLayout(width, height, dashboard.id, members.map((p) => p.id));
		if (!plan) throw new Error(`Monitor window ${width}x${height} is too small for ${members.length} members; enlarge the terminal`);
		const current = await this.tmux("display-message", "-p", "-t", dashboard.window, "#{window_layout} #{window_zoomed_flag}");
		// Respect a user zooming a pane; layout catches up after they unzoom.
		if (current.endsWith(" 1")) return;
		if (current.split(" ")[0] !== plan.layout) await this.tmux("select-layout", "-t", dashboard.window, plan.layout);
	}
	async sync(nodes: TreeNode[]): Promise<void> {
		const panes = await this.panes();
		const dashboard = panes.find((p) => p.agent === "dashboard");
		if (!dashboard) throw new Error("Team dashboard pane is missing; close and reopen the watch session");
		await this.tmux("set-option", "-w", "-t", dashboard.window, "pane-border-status", "top");
		await this.tmux("set-option", "-w", "-t", dashboard.window, "pane-border-format", "#{pane_title}");
		await this.tmux("select-pane", "-t", dashboard.id, "-T", "Team leader / manager");
		// Migrate panes created by older versions into the leader window, retaining processes.
		for (const p of panes.filter((p) => p.window !== dashboard.window && p.agent)) {
			const horizontal = await this.prepareSplit(panes, dashboard);
			await this.tmux("join-pane", "-d", horizontal ? "-h" : "-v", "-s", p.id, "-t", dashboard.id);
			p.window = dashboard.window;
			await this.arrange(panes, dashboard);
		}
		await this.arrange(panes, dashboard);
		for (const node of nodes) {
			const existing = panes.find((p) => p.agent === node.agent_id);
			if (existing) {
				if (existing.dead) await this.tmux("respawn-pane", "-k", "-t", existing.id, ...this.command(node.agent_id));
				continue;
			}
			const horizontal = await this.prepareSplit(panes, dashboard);
			const pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", dashboard.id, ...this.command(node.agent_id));
			await this.tag(pane, node.agent_id);
			await this.tmux("select-pane", "-t", pane, "-T", `${clean(node.role).replace(/\n/g, " ").slice(0, 60)} [${node.agent_id}]`);
			panes.push({ id: pane, window: dashboard.window, agent: node.agent_id, dead: false });
			await this.arrange(panes, dashboard);
		}
	}
	private async prepareSplit(panes: Pane[], dashboard: Pane): Promise<boolean> {
		const { width, height } = await this.dimensions(dashboard.window);
		const members = panes.filter((p) => p.window === dashboard.window && p.id !== dashboard.id).map((p) => p.id);
		if (!planLayout(width, height, dashboard.id, [...members, "%999999"]))
			throw new Error(`Monitor window ${width}x${height} is too small for another member; enlarge the terminal. No extra window will be created.`);
		await this.arrange(panes, dashboard);
		const size = await this.tmux("display-message", "-p", "-t", dashboard.id, "#{pane_width} #{pane_height} #{window_zoomed_flag}");
		const [w, h, zoom] = size.split(" ").map(Number);
		if (zoom) throw new Error("Unzoom the monitor pane to allocate new member panes");
		return h < 7 || (w >= 9 && w >= h * 2);
	}

}

export function flatten(root: TreeNode): TreeNode[] {
	return [root, ...root.children.flatMap(flatten)];
}
