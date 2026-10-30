import { planLayout, encodeLayout, parseLayout, teamRegion, arrangeRegion } from "./layout.ts";
// Pane-scoped groups inside tmux; owned dedicated sessions when launched outside it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join, resolve, basename } from "node:path";
import { packageRoot } from "../shared/paths.ts";
import { clean } from "./render.ts";
import type { TreeNode, TerminalLocation } from "../shared/protocol.ts";
const exec = promisify(execFile);

export interface WatchOptions { stateDir: string; runId: string; socket?: string; node?: string; location?: TerminalLocation }
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
		try {
			if (this.opts.location) return await this.tmux("display-message", "-p", "-t", this.opts.location.leader, "#{window_id}") === this.opts.location.window;
			await this.tmux("has-session", "-t", `=${this.name}`); return true;
		}
		catch (e) {
			if (/not installed/.test((e as Error).message)) throw e;
			if (/can't find session|can't find pane|no such pane|no server running|no sessions|error connecting/.test((e as Error).message)) return false;
			throw e;
		}
	}
	async assertOwned(): Promise<void> {
		if (this.opts.location) {
			const owner = await this.tmux("show-options", "-p", "-qv", "-t", this.opts.location.leader, "@pi_team_owner");
			if (owner !== this.owner) throw new Error("Leader pane is not owned by this team; refusing to change it");
			return;
		}
		if (await this.tmux("show-options", "-qv", "-t", this.name, "@pi_team_watch") !== this.owner)
			throw new Error(`tmux session ${this.name} is not owned by this team; refusing to change it`);
	}
	command(agent: string): string[] {
		const exe = basename(process.execPath).toLowerCase();
		const node = this.opts.node ?? (/^node(\.exe)?$/.test(exe) && !("bun" in process.versions) ? process.execPath : "node");
		return [node, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(packageRoot(), "src/watch/main.ts"),
			this.opts.stateDir, this.opts.runId, agent, this.opts.socket ?? "", this.opts.location ? JSON.stringify(this.opts.location) : ""];
	}
	async panes(): Promise<Pane[]> {
		await this.assertOwned();
		const result = await this.tmux("list-panes", ...(this.opts.location ? ["-t", this.opts.location.window] : ["-s", "-t", this.name]), "-F", "#{pane_id}\t#{window_id}\t#{@pi_team_agent}\t#{pane_dead}\t#{@pi_team_owner}");
		return result.split("\n").filter((line) => !!line && (!this.opts.location || line.split("\t")[4] === this.owner)).map((line) => {
			const [id, window, agent, dead] = line.split("\t");
			return { id, window, agent, dead: dead === "1" };
		});
	}
	async tag(pane: string, agent: string): Promise<void> {
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_owner", this.owner);
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_agent", agent);
		await this.tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on");
	}
	async open(inPlacePane?: string): Promise<void> {
		if (inPlacePane) {
			if (!/^%\d+$/.test(inPlacePane)) throw new Error("Invalid leader pane ID");
			const owner = await this.tmux("show-options", "-p", "-qv", "-t", inPlacePane, "@pi_team_owner");
			if (owner && owner !== this.owner) throw new Error("This pane already belongs to another team");
			this.opts.location = { window: await this.tmux("display-message", "-p", "-t", inPlacePane, "#{window_id}"), leader: inPlacePane };
			// Only mark this pane; never take ownership of the user's session or window.
			await this.tmux("set-option", "-p", "-t", inPlacePane, "@pi_team_owner", this.owner);
			await this.tmux("set-option", "-p", "-t", inPlacePane, "@pi_team_agent", "leader");
		}
		if (this.opts.location) {
			await this.assertOwned();
			const panes = await this.panes();
			const leader = panes.find((p) => p.id === this.opts.location!.leader)!;
			const dashboard = panes.find((p) => p.agent === "dashboard");
			if (dashboard) {
				if (dashboard.dead) await this.tmux("respawn-pane", "-k", "-t", dashboard.id, ...this.command("dashboard"));
			} else {
				const horizontal = await this.prepareSplit(panes, leader);
				const pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", leader.id, ...this.command("dashboard"));
				await this.tag(pane, "dashboard");
				panes.push({ id: pane, window: leader.window, agent: "dashboard", dead: false });
				await this.arrange(panes, leader);
			}
			return;
		}
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
		if (this.opts.location) {
			const dashboard = (await this.panes()).find((p) => p.agent === "dashboard");
			if (dashboard) await this.tmux("kill-pane", "-t", dashboard.id);
			return; // Stop only the dashboard, never detach clients or kill user sessions/harnesses.
		}
		const harnesses = await this.tmux("list-panes", "-s", "-t", this.name, "-F", "#{@pi_team_harness}");
		if (harnesses.split("\n").includes("1")) {
			await this.tmux("detach-client", "-s", this.name).catch((e) => { if (!/no current client/.test((e as Error).message)) throw e; });
			return;
		}
		await this.tmux("kill-session", "-t", this.name);
	}
	/** Release only this team's UI after its members stop; preserve the human Pi pane. */
	async releaseLayout(): Promise<void> {
		if (!await this.exists()) return;
		await this.assertOwned();
		const panes = await this.panes();
		// Stop the coordinator first so it cannot recreate the panes being removed.
		for (const p of [...panes.filter((p) => p.agent === "dashboard"), ...panes.filter((p) => p.agent && p.agent !== "dashboard" && p.agent !== "leader")])
			await this.tmux("kill-pane", "-t", p.id).catch(() => {});
		for (const p of panes.filter((p) => p.agent === "leader")) {
			for (const key of ["@pi_team_owner", "@pi_team_agent", "@pi_team_harness"]) await this.tmux("set-option", "-p", "-u", "-t", p.id, key);
		}
		if (!this.opts.location && await this.exists()) await this.tmux("set-option", "-u", "-t", this.name, "@pi_team_watch");
	}

	async focus(agent = "leader"): Promise<void> {
		const all = await this.panes();
		const pane = all.find((p) => p.agent === agent) ?? (agent === "leader" ? all.find((p) => p.agent === "dashboard") : undefined);
		if (!pane) throw new Error(`No monitor pane for ${agent}; wait for discovery or check /team tree`);
		if (!this.opts.location) await this.tmux("select-window", "-t", pane.window);
		await this.tmux("select-pane", "-t", pane.id);
		if (!this.opts.location && process.env.TMUX && !this.opts.socket) await this.tmux("switch-client", "-t", this.name).catch((e) => { if (!/no current client/.test((e as Error).message)) throw e; });
	}
	async dimensions(window: string): Promise<{ width: number; height: number }> {
		const result = await this.tmux("display-message", "-p", "-t", window, "#{window_width} #{window_height}");
		const [width, height] = result.split(" ").map(Number);
		return { width, height };
	}
	async arrange(panes: Pane[], dashboard: Pane): Promise<void> {
		const current = await this.tmux("display-message", "-p", "-t", dashboard.window, "#{window_layout}\t#{window_zoomed_flag}");
		const separator = current.lastIndexOf("\t");
		if (separator < 0) throw new Error("tmux did not return a window layout and zoom state");
		if (current.slice(separator + 1) === "1") return;
		const raw = current.slice(0, separator);
		const root = parseLayout(raw);
		const members = panes.filter((p) => p.window === dashboard.window && p.id !== dashboard.id);
		const before = encodeLayout(root);
		const layout = arrangeRegion(root, dashboard.id, members.map((p) => p.id));
		if (before !== layout) await this.tmux("select-layout", "-t", dashboard.window, layout);
	}
	async sync(nodes: TreeNode[], interactive = false): Promise<void> {
		const panes = await this.panes();
		const dashboard = panes.find((p) => p.agent === "leader") ?? panes.find((p) => p.agent === "dashboard");
		if (!dashboard) throw new Error("Team dashboard pane is missing; close and reopen the watch session");
		if (!this.opts.location) {
			await this.tmux("set-option", "-w", "-t", dashboard.window, "pane-border-status", "top");
			await this.tmux("set-option", "-w", "-t", dashboard.window, "pane-border-format", "#{pane_title}");
		}
		await this.tmux("select-pane", "-t", dashboard.id, "-T", dashboard.agent === "leader" ? "Team leader — Pi" : "Team manager");
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
				if (existing.dead && !interactive) await this.tmux("respawn-pane", "-k", "-t", existing.id, ...this.command(node.agent_id));
				continue;
			}
			if (interactive) continue; // The executor owns live Pi launch/restart, never the view.
			const horizontal = await this.prepareSplit(panes, dashboard);
			const pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", dashboard.id, ...this.command(node.agent_id));
			await this.tag(pane, node.agent_id);
			await this.tmux("select-pane", "-t", pane, "-T", `${clean(node.role).replace(/\n/g, " ").slice(0, 60)} [${node.agent_id}]`);
			panes.push({ id: pane, window: dashboard.window, agent: node.agent_id, dead: false });
			await this.arrange(panes, dashboard);
		}
	}
	/** Launch a real harness in the same terminal window, replacing a legacy log viewer. */
	async launchAgent(agent: string, role: string, command: string[], cwd: string): Promise<string> {
		await this.open();
		const panes = await this.panes();
		const dashboard = (panes.find((p) => p.agent === "leader") ?? panes.find((p) => p.agent === "dashboard"))!;
		const existing = panes.find((p) => p.agent === agent);
		let pane: string | undefined;
		try {
			if (existing) {
				pane = existing.id;
				await this.tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, ...command);
			} else {
				const horizontal = await this.prepareSplit(panes, dashboard);
				pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", dashboard.id, "-c", cwd, ...command);
				panes.push({ id: pane, window: dashboard.window, agent, dead: false });
			}
			await this.tag(pane, agent);
			await this.tmux("set-option", "-p", "-t", pane, "@pi_team_harness", "1");
			await this.tmux("select-pane", "-t", pane, "-T", `${clean(role).replace(/\n/g, " ").slice(0, 60)} [${agent}] — Pi`);
			await this.arrange(panes, dashboard);
			return pane;
		} catch (error) {
			if (pane) await this.tmux("kill-pane", "-t", pane).catch(() => {});
			throw error;
		}
	}

	private async prepareSplit(panes: Pane[], dashboard: Pane): Promise<boolean> {
		const region = this.opts.location
			? teamRegion(parseLayout(await this.tmux("display-message", "-p", "-t", dashboard.window, "#{window_layout}")), panes.map((p) => p.id))
			: await this.dimensions(dashboard.window);
		const { width, height } = region;
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
