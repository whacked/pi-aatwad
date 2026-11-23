// bb member threads: each member is a child thread of the leader's bb thread.
// bb starts and hosts the member's Pi itself (we never get a terminal or its pid), so the executor
// launches members through launchBbMember (src/executor/bb.ts) instead of launchAgent. This view
// covers everything else: where the team lives, which thread hosts which member, focus and cleanup.
// The agent -> thread map lives in the controller state dir, one file per member.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalLocation, TreeNode } from "../shared/protocol.ts";
import { bb, bbControlFrom, bbJson, showThread, threadUsable, type BbControl, type BbThread } from "./bb-cli.ts";
import { teamOwner, type Pane, type PaneTag, type TerminalView, type WatchOptions } from "./view.ts";

export const BB_THREAD = /^thr_[0-9a-z]+$/i;
export const BB_PROJECT = /^proj_[0-9a-z]+$/i;
const SAFE = /^[A-Za-z0-9._-]+$/;

export interface BbMemberRecord { thread: string; agent: string }

function membersDir(stateDir: string, owner: string): string { return join(stateDir, "bb-threads", owner); }

/** The bb thread recorded for a member, if any. */
export function readMemberThread(stateDir: string, owner: string, agent: string): string | undefined {
	if (!SAFE.test(agent)) return undefined;
	try {
		const r = JSON.parse(readFileSync(join(membersDir(stateDir, owner), `${agent}.json`), "utf8")) as BbMemberRecord;
		return typeof r.thread === "string" && BB_THREAD.test(r.thread) ? r.thread : undefined;
	} catch { return undefined; }
}

export function writeMemberThread(stateDir: string, owner: string, agent: string, thread: string): void {
	if (!SAFE.test(agent)) throw new Error(`unsafe agent id ${agent}`);
	const dir = membersDir(stateDir, owner);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${agent}.json`), temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(temp, JSON.stringify({ thread, agent } satisfies BbMemberRecord), { mode: 0o600 });
	renameSync(temp, file);
}

function listMembers(stateDir: string, owner: string): BbMemberRecord[] {
	let names: string[];
	try { names = readdirSync(membersDir(stateDir, owner)).filter((n) => n.endsWith(".json")); } catch { return []; }
	const out: BbMemberRecord[] = [];
	for (const n of names) {
		const agent = n.slice(0, -5), thread = readMemberThread(stateDir, owner, agent);
		if (thread) out.push({ agent, thread });
	}
	return out;
}

export class BbView implements TerminalView {
	readonly backend = "bb" as const;
	/** bb gives every member its own thread env; nothing is carried over from the leader. */
	readonly memberEnvKeys = [] as const;
	opts: WatchOptions;
	owner: string;
	reclaimedFrom?: string;
	readonly control: BbControl;

	constructor(opts: WatchOptions) {
		// Controller side: the saved env. Leader side: the leader thread's own env.
		this.control = { ...bbControlFrom(process.env), ...opts.env };
		this.opts = { ...opts, env: { ...this.control } as Record<string, string> };
		this.owner = teamOwner(opts.stateDir, opts.runId);
	}

	private requireLocation(): TerminalLocation {
		if (!this.opts.location) throw new Error("Member threads open beside the leader; run /team watch from the leader Pi in its bb thread");
		return this.opts.location;
	}
	async exists(): Promise<boolean> {
		if (!this.opts.location) return false;
		return threadUsable(await showThread(this.control, this.opts.location.leader));
	}
	/** The leader thread is the team's anchor; bb threads are not shared between teams. */
	async assertOwned(): Promise<void> { this.requireLocation(); }

	async panes(): Promise<Pane[]> {
		const members = listMembers(this.opts.stateDir, this.owner);
		if (!members.length) return [];
		const window = this.opts.location?.window ?? "";
		const live = new Map<string, BbThread>();
		// One call for all members; deleted threads are left out, archived ones are flagged.
		for (let i = 0; i < members.length; i += 200) {
			const batch = members.slice(i, i + 200);
			const threads = await bbJson<BbThread[]>(this.control, ["thread", "list", "--include-archived", "--include-hidden", ...batch.flatMap((m) => ["--thread", m.thread])]);
			for (const t of threads) live.set(t.id, t);
		}
		return members.map((m) => {
			const t = live.get(m.thread);
			return { id: m.thread, window, agent: m.agent, dead: !t || !!t.archivedAt || !!t.deletedAt };
		});
	}

	async open(leader?: string): Promise<void> {
		const id = leader ?? this.requireLocation().leader;
		const d = await showThread(this.control, id);
		if (!threadUsable(d)) throw new Error(`bb thread ${id} is missing or archived`);
		this.opts.location = { window: d.thread.projectId, leader: id };
	}
	async close(): Promise<void> {}
	async focus(agent = "leader"): Promise<void> {
		const thread = agent === "leader" ? this.requireLocation().leader : readMemberThread(this.opts.stateDir, this.owner, agent);
		if (!thread) throw new Error(`${agent} has no bb thread`);
		await bb(this.control, ["thread", "open", thread]);
	}
	async launchAgent(): Promise<string> {
		throw new Error("bb starts member Pi itself; members are launched with launchBbMember");
	}
	/** Thread titles belong to bb and the human; nothing to redraw. */
	async sync(_nodes: TreeNode[]): Promise<void> {}
	async removeMember(agent: string): Promise<void> {
		const thread = readMemberThread(this.opts.stateDir, this.owner, agent);
		if (thread) await this.killPane(thread);
		if (SAFE.test(agent)) rmSync(join(membersDir(this.opts.stateDir, this.owner), `${agent}.json`), { force: true });
	}
	async readTag(): Promise<PaneTag> { return {}; }
	async tag(): Promise<void> {}
	async clearTag(): Promise<void> {}
	async releaseLeaderPane(): Promise<void> {}
	async paneProcess(): Promise<number> { throw new Error("bb does not expose the process of a member thread"); }
	/** Archive: bb stops the member's Pi and keeps the transcript readable. */
	async killPane(thread: string): Promise<void> {
		if (!BB_THREAD.test(thread)) return;
		try { await bb(this.control, ["thread", "archive", thread]); }
		catch (e) { if (!/not.?found|archived/i.test((e as Error).message)) throw e; }
	}
	async serverAddress(): Promise<string> { return this.control.BB_SERVER_URL ?? ""; }
}
