import { planLayout, encodeLayout, parseLayout, teamRegion, arrangeRegion } from "./layout.ts";
import { TerminalAllocationError } from "./terminal-error.ts";
// Pane-scoped team groups beside the leader Pi, inside the user's own tmux window.
// There is deliberately no detached/dedicated tmux session mode.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename } from "node:path";
import { packageRoot } from "../shared/paths.ts";
import { clean } from "./render.ts";
import type { TreeNode, TerminalLocation } from "../shared/protocol.ts";
import { memberDecor, nativeLabel, planDecoration } from "../terminal/decor.ts";
import { hostCapabilities } from "../terminal/host.ts";
import { teamOwner, type Pane, type PaneTag, type TerminalView, type WatchOptions } from "../terminal/view.ts";
export type { Pane, WatchOptions } from "../terminal/view.ts";
const exec = promisify(execFile);

export class TmuxWatch implements TerminalView {
	readonly backend = "tmux" as const;
	readonly memberEnvKeys = ["TMUX", "TMUX_PANE"] as const;
	opts: WatchOptions;
	owner: string;
	/** Set when opening took over a pane still tagged for another team; shown to the operator. */
	reclaimedFrom?: string;
	constructor(opts: WatchOptions) {
		this.opts = opts;
		this.owner = teamOwner(opts.stateDir, opts.runId);
	}
	async tmux(...args: string[]): Promise<string> {
		try {
			const env = { ...process.env };
			// Herdr may itself be inside tmux. Never target that outer pane through inherited markers.
			if (env.HERDR_ENV === "1") { delete env.TMUX; delete env.TMUX_PANE; }
			const result = await exec("tmux", [...(this.opts.socket ? ["-S", this.opts.socket] : []), ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 });
			return result.stdout.trim();
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			if (err.code === "ENOENT") throw new Error("tmux is not installed or is not on PATH; install tmux to use /team watch");
			throw new Error(`tmux: ${err.stderr?.trim() || err.message}`);
		}
	}
	async exists(): Promise<boolean> {
		if (!this.opts.location) return false;
		try {
			return await this.tmux("display-message", "-p", "-t", this.opts.location.leader, "#{window_id}") === this.opts.location.window;
		}
		catch (e) {
			if (/not installed/.test((e as Error).message)) throw e;
			if (/can't find session|can't find pane|no such pane|no server running|no sessions|error connecting/.test((e as Error).message)) return false;
			throw e;
		}
	}
	async assertOwned(): Promise<void> {
		const location = this.requireLocation();
		const owner = await this.tmux("show-options", "-p", "-qv", "-t", location.leader, "@pi_team_owner");
		if (owner !== this.owner) throw new Error("Leader pane is not owned by this team; refusing to change it");
	}
	private requireLocation(): TerminalLocation {
		if (!this.opts.location) throw new Error("Team panes open beside the leader Pi; run /team watch from the leader inside tmux");
		return this.opts.location;
	}
	command(agent: string): string[] {
		const exe = basename(process.execPath).toLowerCase();
		const node = this.opts.node ?? (/^node(\.exe)?$/.test(exe) && !("bun" in process.versions) ? process.execPath : "node");
		return [node, "--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(packageRoot(), "src/watch/main.ts"),
			this.opts.stateDir, this.opts.runId, agent, this.opts.socket ?? "", this.opts.location ? JSON.stringify(this.opts.location) : ""];
	}
	async panes(): Promise<Pane[]> {
		await this.assertOwned();
		const result = await this.tmux("list-panes", "-t", this.requireLocation().window, "-F", "#{pane_id}\t#{window_id}\t#{@pi_team_agent}\t#{pane_dead}\t#{@pi_team_owner}");
		return result.split("\n").filter((line) => !!line && line.split("\t")[4] === this.owner).map((line) => {
			const [id, window, agent, dead] = line.split("\t");
			return { id, window, agent, dead: dead === "1" };
		});
	}
	async readTag(pane: string): Promise<PaneTag> {
		const owner = await this.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_owner");
		const agent = await this.tmux("show-options", "-p", "-qv", "-t", pane, "@pi_team_agent");
		return { ...(owner ? { owner } : {}), ...(agent ? { agent } : {}) };
	}
	async clearTag(pane: string): Promise<void> {
		for (const key of ["@pi_team_owner", "@pi_team_agent", "@pi_team_harness"]) await this.tmux("set-option", "-p", "-u", "-t", pane, key);
	}
	async paneProcess(pane: string): Promise<number> {
		const pid = Number(await this.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"));
		if (!Number.isInteger(pid) || pid <= 0) throw new Error(`tmux pane ${pane} has no process`);
		return pid;
	}
	async killPane(pane: string): Promise<void> { await this.tmux("kill-pane", "-t", pane); }
	async serverAddress(): Promise<string> { return this.opts.socket ?? await this.tmux("display-message", "-p", "#{socket_path}"); }
	async tag(pane: string, agent: string): Promise<void> {
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_owner", this.owner);
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_agent", agent);
		await this.tmux("set-option", "-p", "-t", pane, "remain-on-exit", "on");
	}
	async open(inPlacePane?: string): Promise<void> {
		if (inPlacePane) {
			if (!/^%\d+$/.test(inPlacePane)) throw new Error("Invalid leader pane ID");
			const owner = await this.tmux("show-options", "-p", "-qv", "-t", inPlacePane, "@pi_team_owner");
			if (owner && owner !== this.owner) throw new Error(`This pane is still tagged for another team (pane ${inPlacePane}, owner ${owner.slice(0, 16)}, requested run ${this.opts.runId}). Run /team watch from the leader Pi itself so the tag can be verified and replaced; if this persists, /team version shows whether the extension and controller are current.`);
			this.opts.location = { window: await this.tmux("display-message", "-p", "-t", inPlacePane, "#{window_id}"), leader: inPlacePane };
			// Only mark this pane; never take ownership of the user's session or window.
			await this.tmux("set-option", "-p", "-t", inPlacePane, "@pi_team_owner", this.owner);
			await this.tmux("set-option", "-p", "-t", inPlacePane, "@pi_team_agent", "leader");
		}
		this.requireLocation();
		await this.assertOwned();
		await this.controls();
	}
	private async controlPanes(): Promise<Pane[]> {
		const raw = await this.tmux("list-panes", "-s", "-t", this.requireLocation().window, "-F", "#{pane_id}\t#{window_id}\t#{@pi_team_agent}\t#{pane_dead}\t#{@pi_team_owner}");
		return raw.split("\n").filter((line) => { const fields = line.split("\t"); return fields[2] === "dashboard" && fields[4] === this.owner; }).map((line) => {
			const [id, window, agent, dead] = line.split("\t"); return { id, window, agent, dead: dead === "1" };
		});
	}

	/** Normal layout has no control UI. Debug mode has one canonical dashboard. */
	private async controls(): Promise<void> {
		let panes = await this.panes();
		let controls = (await this.controlPanes()).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
		if (!this.opts.debug) {
			for (const p of controls) await this.tmux("kill-pane", "-t", p.id);
			return;
		}
		const location = this.requireLocation();
		for (const p of controls.filter((p) => p.window !== location.window)) await this.tmux("kill-pane", "-t", p.id);
		controls = controls.filter((p) => p.window === location.window);
		if (!controls.length) {
			const anchor = panes.find((p) => p.agent === "leader") ?? panes[0];
			const horizontal = await this.prepareSplit(panes, anchor);
			const pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", anchor.id, ...this.command("dashboard"));
			await this.tag(pane, "dashboard");
		}
		// Concurrent root tool calls may both request debug; converge on one pane.
		panes = await this.panes();
		controls = panes.filter((p) => p.agent === "dashboard").sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
		for (const p of controls.slice(1)) await this.tmux("kill-pane", "-t", p.id).catch(() => {});
		if (controls[0]?.dead) await this.tmux("respawn-pane", "-k", "-t", controls[0].id, ...this.command("dashboard"));
	}

	async close(): Promise<void> {
		if (!await this.exists()) return;
		await this.assertOwned();
		// Stop only the dashboard, never detach clients or kill user sessions/harnesses.
		const dashboard = (await this.panes()).find((p) => p.agent === "dashboard");
		if (dashboard) await this.tmux("kill-pane", "-t", dashboard.id);
	}
	/** Clear verified human-pane tags even when the saved layout was lost. */
	async releaseLeaderPane(pane: string): Promise<void> {
		const { owner, agent } = await this.readTag(pane);
		if (owner !== this.owner || agent !== "leader") throw new Error("Pane is not this team's leader; refusing to release it");
		await this.clearTag(pane);
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
			await this.releaseLeaderPane(p.id);
		}
	}

	async focus(agent = "leader"): Promise<void> {
		const all = await this.panes();
		const pane = all.find((p) => p.agent === agent) ?? (agent === "leader" ? (all.find((p) => p.agent === "dashboard") ?? all[0]) : undefined);
		if (!pane) throw new Error(`No monitor pane for ${agent}; wait for discovery or check /team tree`);
		await this.tmux("select-pane", "-t", pane.id);
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
		const layout = arrangeRegion(root, dashboard.id, members.map((p) => p.id), 0.6);
		if (before !== layout) await this.tmux("select-layout", "-t", dashboard.window, layout);
	}
	async sync(nodes: TreeNode[], interactive = false): Promise<void> {
		await this.controls();
		const panes = await this.panes();
		const dashboard = panes.find((p) => p.agent === "leader") ?? panes.find((p) => p.agent === "dashboard") ?? panes[0];
		if (!dashboard) throw new Error("Team dashboard pane is missing; close and reopen the watch session");
		if (dashboard.agent === "leader" || dashboard.agent === "dashboard") await this.tmux("select-pane", "-t", dashboard.id, "-T", dashboard.agent === "leader" ? "Team leader — Pi" : "Team control (debug)");
		await this.arrange(panes, dashboard);
		for (const node of nodes) {
			const existing = panes.find((p) => p.agent === node.agent_id);
			if (existing) {
				await this.decorate(existing.id, node.agent_id, node.role);
				if (existing.dead && !interactive) await this.tmux("respawn-pane", "-k", "-t", existing.id, ...this.command(node.agent_id));
				continue;
			}
			if (interactive) continue; // The executor owns live Pi launch/restart, never the view.
			const horizontal = await this.prepareSplit(panes, dashboard);
			const pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", dashboard.id, ...this.command(node.agent_id));
			await this.tag(pane, node.agent_id);
			await this.decorate(pane, node.agent_id, node.role);
			panes.push({ id: pane, window: dashboard.window, agent: node.agent_id, dead: false });
			await this.arrange(panes, dashboard);
		}
	}
	/** Launch a real harness in the same terminal window, replacing a legacy log viewer. */
	async launchAgent(agent: string, role: string, command: string[], cwd: string): Promise<string> {
		let pane: string | undefined;
		try {
			await this.open();
			const panes = await this.panes();
			const dashboard = (panes.find((p) => p.agent === "leader") ?? panes.find((p) => p.agent === "dashboard") ?? panes[0])!;
			const existing = panes.find((p) => p.agent === agent);
			if (existing) {
				pane = existing.id;
				await this.tmux("respawn-pane", "-k", "-t", pane, "-c", cwd, ...command);
				existing.agent = agent; existing.dead = false;
			} else {
				const horizontal = await this.prepareSplit(panes, dashboard);
				pane = await this.tmux("split-window", "-d", horizontal ? "-h" : "-v", "-P", "-F", "#{pane_id}", "-t", dashboard.id, "-c", cwd, ...command);
				panes.push({ id: pane, window: dashboard.window, agent, dead: false });
			}
			await this.tag(pane, agent);
			await this.tmux("set-option", "-p", "-t", pane, "@pi_team_harness", "1");
			await this.decorate(pane, agent, role);
			await this.arrange(panes, dashboard);
			return pane;
		} catch (error) {
			if (pane) await this.tmux("kill-pane", "-t", pane).catch(() => {});
			throw new TerminalAllocationError((error as Error).message, { cause: error });
		}
	}

	/** Apply whatever native decoration the dispatch plan assigns to tmux (currently the pane title). */
	async decorate(pane: string, agent: string, role: string): Promise<void> {
		const plan = planDecoration(hostCapabilities("tmux").decoration);
		if (plan.native !== "label" && plan.native !== "border-title") return;
		const label = nativeLabel(memberDecor(agent, clean(role)));
		await this.tmux("set-option", "-p", "-t", pane, "@pi_team_name", label);
		await this.tmux("select-pane", "-t", pane, "-T", label);
	}
	async removeMember(agent: string): Promise<void> {
		const pane = (await this.panes()).find((p) => p.agent === agent);
		if (!pane || pane.agent === "leader") return;
		await this.tmux("kill-pane", "-t", pane.id);
	}

	private async prepareSplit(panes: Pane[], dashboard: Pane): Promise<boolean> {
		const region = teamRegion(parseLayout(await this.tmux("display-message", "-p", "-t", dashboard.window, "#{window_layout}")), panes.map((p) => p.id));
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
