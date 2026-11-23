// Rex (Superlogical) member blocks, split in place beside the leader's block.
// Rex blocks have labels but no per-block user options, so ownership tags live in the
// controller state directory, one file per block (the equivalent of tmux @pi_team_* options).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findExecutable } from "../shared/environment.ts";
import type { TerminalLocation, TreeNode } from "../shared/protocol.ts";
import { TerminalAllocationError } from "../watch/terminal-error.ts";
import { memberDecor, nativeLabel, planDecoration } from "./decor.ts";
import { BACKENDS } from "./backends.ts";
import { teamOwner, type Pane, type PaneTag, type TerminalView, type WatchOptions } from "./view.ts";
const exec = promisify(execFile);

const BLOCK = /^block:[0-9a-f-]+$/i;
const WINDOW = /^window:[0-9a-f-]+$/i;
// Leader keeps about 60% of its block; later members split the roomiest member block.
const FIRST_MEMBER_PERCENT = 40;
const MIN_COLUMNS = 20;
const MIN_ROWS = 5;

interface BlockInfo { session_id: string; window_id?: string; label?: string; placement?: string }
interface ProcessInfo { child?: { pid: number }; last_exit?: { exit_code: number } | null }

export function rexExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return findExecutable("rex", env) ?? (env.REX_BIN_DIR ? findExecutable(join(env.REX_BIN_DIR, "rex"), env) : undefined);
}

export class RexView implements TerminalView {
	readonly backend = "rex" as const;
	readonly memberEnvKeys = ["REX_SERVER", "REX_SESSION", "REX_BLOCK", "REX_BIN_DIR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"] as const;
	opts: WatchOptions;
	owner: string;
	reclaimedFrom?: string;
	private session?: string;

	constructor(opts: WatchOptions) {
		this.opts = opts;
		this.owner = teamOwner(opts.stateDir, opts.runId);
	}

	async rex(...args: string[]): Promise<string> {
		const bin = rexExecutable();
		if (!bin) throw new Error("the Rex CLI (rex) is not on PATH; start Pi from a Rex terminal or add Rex's bin directory to PATH");
		const server = this.opts.socket ?? process.env.REX_SERVER;
		const env = { ...process.env };
		// Never let inherited markers pick a target implicitly. REX_SESSION also scopes block
		// lookups to the caller's session, which would hide another session's full block IDs.
		delete env.REX_BLOCK;
		delete env.REX_SESSION;
		try {
			const result = await exec(bin, [...(server ? ["-S", server] : []), "--autostart=false", ...args], { env, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
			return result.stdout.trim();
		} catch (e) {
			const err = e as NodeJS.ErrnoException & { stderr?: string };
			throw new Error(`rex: ${err.stderr?.trim().replace(/^Error:\s*/, "") || err.message}`);
		}
	}
	private async json<T>(...args: string[]): Promise<T> {
		return JSON.parse(await this.rex(...args)) as T;
	}

	private async blockInfo(block: string): Promise<BlockInfo | undefined> {
		try {
			const result = await this.json<{ session_id: string; block: { window_id?: string; label?: string; placement?: string } }>("block", "inspect", block, "--json");
			return { session_id: result.session_id, ...result.block };
		} catch (e) {
			if (/not found/i.test((e as Error).message)) return undefined;
			throw e;
		}
	}
	private async processInfo(block: string): Promise<ProcessInfo> {
		return this.json<ProcessInfo>("block", "call", "-b", block, "process");
	}
	private async size(block: string): Promise<{ columns: number; rows: number }> {
		return this.json<{ columns: number; rows: number }>("block", "call", "-b", block, "size");
	}

	// Ownership tags: one 0600 file per block in the 0700 controller state directory.
	private tagFile(block: string): string {
		if (!BLOCK.test(block)) throw new Error(`Invalid Rex block ID ${block}`);
		return join(this.opts.stateDir, "rex-tags", `${block.replace(":", "-")}.json`);
	}
	async readTag(block: string): Promise<PaneTag> {
		try {
			const tag = JSON.parse(readFileSync(this.tagFile(block), "utf8")) as PaneTag;
			return { ...(typeof tag.owner === "string" ? { owner: tag.owner } : {}), ...(typeof tag.agent === "string" ? { agent: tag.agent } : {}) };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw e;
		}
	}
	async tag(block: string, agent: string): Promise<void> {
		const file = this.tagFile(block);
		mkdirSync(join(this.opts.stateDir, "rex-tags"), { recursive: true, mode: 0o700 });
		const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(temp, JSON.stringify({ owner: this.owner, agent }), { mode: 0o600 });
		renameSync(temp, file);
	}
	async clearTag(block: string): Promise<void> {
		rmSync(this.tagFile(block), { force: true });
	}

	private requireLocation(): TerminalLocation {
		if (!this.opts.location) throw new Error("Team blocks open beside the leader Pi; run /team watch from the leader in Rex");
		return this.opts.location;
	}
	async exists(): Promise<boolean> {
		if (!this.opts.location) return false;
		const info = await this.blockInfo(this.opts.location.leader);
		return info?.window_id === this.opts.location.window && info.placement !== "detached";
	}
	async assertOwned(): Promise<void> {
		const { leader } = this.requireLocation();
		if ((await this.readTag(leader)).owner !== this.owner) throw new Error("Leader block is not owned by this team; refusing to change it");
	}
	private async sessionId(): Promise<string> {
		if (this.session) return this.session;
		const info = await this.blockInfo(this.requireLocation().leader);
		if (!info) throw new Error("The leader's Rex block no longer exists");
		return this.session = info.session_id;
	}
	async panes(): Promise<Pane[]> {
		await this.assertOwned();
		const { window, leader } = this.requireLocation();
		const listed = await this.json<{ blocks: Array<{ block_id: string; window_id?: string }> }>("block", "ls", "-s", await this.sessionId(), "--json");
		const panes: Pane[] = [];
		for (const block of listed.blocks.filter((b) => b.window_id === window)) {
			const tag = await this.readTag(block.block_id);
			if (tag.owner !== this.owner || !tag.agent) continue;
			let dead = false;
			if (block.block_id !== leader) {
				// A concurrent replacement or removal can close a listed block; it is simply gone.
				const info = await this.processInfo(block.block_id).catch((e: Error) => { if (/not found/i.test(e.message)) return undefined; throw e; });
				if (!info) continue;
				dead = !info.child;
			}
			panes.push({ id: block.block_id, window, agent: tag.agent, dead });
		}
		return panes;
	}

	async open(leader?: string): Promise<void> {
		if (this.opts.debug) throw new Error("The debug control pane is tmux-only; use /team watch open in Rex");
		if (leader) {
			if (!BLOCK.test(leader)) throw new Error("Invalid leader block ID");
			const { owner } = await this.readTag(leader);
			if (owner && owner !== this.owner) throw new Error(`This block is still tagged for another team (block ${leader}, owner ${owner.slice(0, 16)}, requested run ${this.opts.runId}). Run /team watch from the leader Pi itself so the tag can be verified and replaced.`);
			const info = await this.blockInfo(leader);
			if (!info?.window_id || !WINDOW.test(info.window_id)) throw new Error("The leader's Rex block is not placed in a window");
			this.opts.location = { window: info.window_id, leader };
			this.session = info.session_id;
			await this.tag(leader, "leader");
		}
		this.requireLocation();
		await this.assertOwned();
	}
	async close(): Promise<void> {
		// Rex views have no optional chrome; member blocks keep running.
		if (await this.exists()) await this.assertOwned();
	}

	async focus(agent = "leader"): Promise<void> {
		const pane = (await this.panes()).find((p) => p.agent === agent);
		if (!pane) throw new Error(`No member block for ${agent}; wait for it to start or check /team tree`);
		await this.rex("focus", pane.id);
	}

	/** Anchor and direction for the next member, keeping every block legible. */
	private async placement(panes: Pane[]): Promise<{ anchor: string; direction: "right" | "below"; percent: number }> {
		const { leader } = this.requireLocation();
		const members = panes.filter((p) => p.id !== leader);
		if (!members.length) {
			const { columns, rows } = await this.size(leader);
			const direction = columns >= rows * 2.5 ? "right" : "below";
			const room = direction === "right" ? Math.floor(columns * FIRST_MEMBER_PERCENT / 100) : Math.floor(rows * FIRST_MEMBER_PERCENT / 100);
			if (room < (direction === "right" ? MIN_COLUMNS : MIN_ROWS)) throw new Error(`Leader block ${columns}x${rows} is too small for a member; enlarge the window.`);
			return { anchor: leader, direction, percent: FIRST_MEMBER_PERCENT };
		}
		let best: { anchor: string; columns: number; rows: number } | undefined;
		for (const member of members) {
			const { columns, rows } = await this.size(member.id);
			if (!best || columns * rows > best.columns * best.rows) best = { anchor: member.id, columns, rows };
		}
		const direction = best!.columns >= best!.rows * 2.5 ? "right" : "below";
		if (direction === "right" ? best!.columns / 2 < MIN_COLUMNS : best!.rows / 2 < MIN_ROWS)
			throw new Error(`Member blocks are too small for another member (largest ${best!.columns}x${best!.rows}); enlarge the window.`);
		return { anchor: best!.anchor, direction, percent: 50 };
	}
	private async split(anchor: string, direction: "right" | "below", percent: number, label: string, cwd: string, command: string[]): Promise<string> {
		const created = await this.json<{ block_ids?: string[] }>("split", "-b", anchor, "--split", direction, "--ratio", String(percent),
			"--focus=false", "--keep-open", "--shell=none", "--label", label, "-c", cwd, "--json", "--", ...command);
		const block = created.block_ids?.[0];
		if (!block || !BLOCK.test(block)) throw new Error("Rex did not report the new block");
		return block;
	}

	async launchAgent(agent: string, role: string, command: string[], cwd: string): Promise<string> {
		let block: string | undefined;
		try {
			await this.open();
			const panes = await this.panes();
			const label = nativeLabel(memberDecor(agent, role));
			const existing = panes.find((p) => p.agent === agent);
			if (existing) {
				// No respawn in Rex: split the old block, then close it so the new one fills its place.
				block = await this.split(existing.id, "right", 50, label, cwd, command);
				await this.tag(block, agent);
				await this.killPane(existing.id);
			} else {
				const { anchor, direction, percent } = await this.placement(panes);
				block = await this.split(anchor, direction, percent, label, cwd, command);
				await this.tag(block, agent);
			}
			await this.decorate(block, agent, role);
			return block;
		} catch (error) {
			if (block) await this.killPane(block).catch(() => {});
			throw new TerminalAllocationError((error as Error).message, { cause: error });
		}
	}

	/** Apply the native decoration the dispatch plan assigns to Rex (currently the block label). */
	async decorate(block: string, agent: string, role: string): Promise<void> {
		const plan = planDecoration(BACKENDS.rex.decoration);
		if (plan.native !== "label" && plan.native !== "border-title") return;
		const label = nativeLabel(memberDecor(agent, role));
		const info = await this.blockInfo(block);
		if (info && info.label !== label) await this.rex("block", "rename", block, label);
	}

	async sync(nodes: TreeNode[], _interactive = true): Promise<void> {
		// Rex hosts only live Pi harnesses; the executor owns their launch and restart.
		const panes = await this.panes();
		for (const node of nodes) {
			const existing = panes.find((p) => p.agent === node.agent_id);
			if (existing) await this.decorate(existing.id, node.agent_id, node.role);
		}
	}
	async removeMember(agent: string): Promise<void> {
		const pane = (await this.panes()).find((p) => p.agent === agent);
		if (!pane || pane.agent === "leader") return;
		await this.killPane(pane.id);
	}
	async releaseLeaderPane(block: string): Promise<void> {
		const { owner, agent } = await this.readTag(block);
		if (owner !== this.owner || agent !== "leader") throw new Error("Block is not this team's leader; refusing to release it");
		await this.clearTag(block);
	}
	async paneProcess(block: string): Promise<number> {
		const pid = (await this.processInfo(block)).child?.pid;
		if (!Number.isInteger(pid) || pid! <= 0) throw new Error(`Rex block ${block} has no running process`);
		return pid!;
	}
	async killPane(block: string): Promise<void> {
		try { await this.rex("block", "close", block); }
		catch (e) { if (!/not found/i.test((e as Error).message)) throw e; }
		await this.clearTag(block);
	}
	async serverAddress(): Promise<string> {
		const server = this.opts.socket ?? process.env.REX_SERVER;
		if (!server) throw new Error("REX_SERVER is not set; open member blocks from a leader Pi running in Rex");
		return server;
	}
}
