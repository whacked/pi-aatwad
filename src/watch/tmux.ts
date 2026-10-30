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
		const pane = await this.tmux("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", this.name, "-e", `PATH=${process.env.PATH ?? "/usr/bin:/bin"}`, "-n", "team", "-x", "200", "-y", "60", ...this.command("dashboard"));
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
	async sync(nodes: TreeNode[]): Promise<void> {
		const panes = await this.panes();
		for (const node of nodes) {
			const existing = panes.find((p) => p.agent === node.agent_id);
			if (existing) {
				if (existing.dead) await this.tmux("respawn-pane", "-k", "-t", existing.id, ...this.command(node.agent_id));
				continue;
			}
			const counts = new Map<string, number>();
			for (const p of panes.filter((p) => p.agent && p.agent !== "dashboard")) counts.set(p.window, (counts.get(p.window) ?? 0) + 1);
			const window = [...counts].find(([, n]) => n < 4)?.[0];
			const pane = window
				? await this.tmux("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", window, ...this.command(node.agent_id))
				: await this.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${this.name}:`, "-n", `members-${counts.size + 1}`, ...this.command(node.agent_id));
			await this.tag(pane, node.agent_id);
			await this.tmux("select-pane", "-t", pane, "-T", `${clean(node.role).replace(/\n/g, " ").slice(0, 60)} [${node.agent_id}]`);
			const newWindow = await this.tmux("display-message", "-p", "-t", pane, "#{window_id}");
			await this.tmux("set-option", "-w", "-t", newWindow, "pane-border-status", "top");
			await this.tmux("set-option", "-w", "-t", newWindow, "pane-border-format", "#{pane_title}");
			await this.tmux("select-layout", "-t", newWindow, "tiled");
			panes.push({ id: pane, window: newWindow, agent: node.agent_id, dead: false });
		}
	}
}

export function flatten(root: TreeNode): TreeNode[] {
	return [root, ...root.children.flatMap(flatten)];
}
