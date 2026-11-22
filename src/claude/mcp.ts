// Claude Code adapter: a dependency-free MCP stdio server exposing team tools and owning this session's
// liveness heartbeat. Claude Code joins teams through the same controller protocol as Pi, so a Claude Code
// session can found a team, lead an existing one, join as a member, report to another leader (sub-team),
// and be reparented or transferred like any Pi agent.
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { statePaths, type StatePaths } from "../shared/paths.ts";
import { ensureController, readOperatorToken, TeamApiError, type TeamClient } from "../shared/client.ts";
import { HEARTBEAT_INTERVAL_MS, type MessageType } from "../shared/protocol.ts";
import { LOADED_VERSION } from "../shared/version.ts";
import { formatAttention, handoffText } from "../shared/attention-format.ts";
import { formatEnvelope, formatOrgContext, formatTree } from "../extension/format.ts";
import { HARNESS, claudePid, clearIdentity, client, readIdentity, readPidState, writeIdentity, writeWake, type Identity } from "./session.ts";

type Json = Record<string, unknown>;
interface Tool { name: string; description: string; inputSchema: Json; run: (args: Json) => Promise<string> }

const S = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const obj = (properties: Json, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

export class ClaudeTeamServer {
	paths: StatePaths;
	cpid: number;
	cwd: string;
	identity: Identity | undefined;
	api: TeamClient;
	private timer: ReturnType<typeof setInterval> | undefined;
	private beating = false;

	constructor(o: { paths?: StatePaths; cpid?: number; cwd?: string } = {}) {
		this.paths = o.paths ?? statePaths();
		this.cpid = o.cpid ?? claudePid();
		this.cwd = o.cwd ?? process.cwd();
		this.api = client(() => this.identity?.token, this.paths);
	}

	/** Claude Code session id from the hooks; without hooks, a per-process key (no resume persistence). */
	sessionKey(): string {
		return readPidState(this.cpid, this.paths).session_id ?? `pid-${this.cpid}`;
	}
	loadIdentity(): Identity | undefined {
		this.identity = readIdentity(this.sessionKey(), this.paths);
		return this.identity;
	}
	private adopt(r: { run_id: string; agent_id: string; session_id: string; token: string }, role?: string): void {
		const id = { run_id: r.run_id, agent_id: r.agent_id, session_id: r.session_id, token: r.token, role, cwd: this.cwd };
		writeIdentity(this.sessionKey(), id, this.paths);
		this.identity = { ...id, updated_at: new Date().toISOString() };
		this.start();
	}
	private requireIdentity(): Identity {
		const id = this.identity ?? this.loadIdentity();
		if (!id) throw new Error("This Claude Code session is not in a team. Use team_join (new_team, leader, member or agent) first.");
		return id;
	}
	private async operator(): Promise<string> {
		await ensureController(this.paths);
		return readOperatorToken(this.paths);
	}
	private async agentRef(ref: string): Promise<string> {
		return this.api.resolveAgent(ref, this.identity?.run_id);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
		this.timer.unref?.();
		void this.heartbeat();
	}
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Liveness only. Wakes are written for the Stop hook / waiter; nothing reaches the model from here. */
	async heartbeat(): Promise<void> {
		if (this.beating) return;
		const id = this.identity ?? this.loadIdentity();
		if (!id) return;
		this.beating = true;
		try {
			const busy = !!readPidState(this.cpid, this.paths).busy;
			const r = await this.api.heartbeat({ busy }, { idempotencyKey: `hb:${id.session_id}:${randomUUID()}`, timeoutMs: 5_000 });
			if (r.wake) writeWake(this.sessionKey(), { wake: r.wake, at: new Date().toISOString(), inbox_pending: r.inbox_pending }, this.paths);
		} catch (e) {
			// Superseded (another session attached to this agent) or left: forget the credential.
			if (e instanceof TeamApiError && (e.status === 401 || e.code === "STALE_SESSION")) { this.identity = undefined; this.stop(); }
		} finally { this.beating = false; }
	}

	tools(): Tool[] {
		const t: Tool[] = [
			{
				name: "team_join",
				description: "Put this Claude Code session into a pi-aatwad team (same controller as Pi teams). mode=new_team: found a new team with you as leader. mode=member (alias join): join under an existing team's leader, or under manager: you lead your own (initially empty) team linked under that agent, which can assign you work and dismiss you. mode=leader: take over an existing team's leader session (run_id). mode=agent: resume an existing agent identity (agent). Use team_list_teams to find run IDs. Only when the human asks.",
				inputSchema: obj({ mode: S("new_team | member | join | leader | agent", { enum: ["new_team", "member", "join", "leader", "agent"] }), run_id: S("Team run ID (member, leader, agent)"), manager: S("member: the agent to join under (name or agent ID); default the team's leader"), agent: S("agent: agent name or ID to resume"), name: S("member: your member name"), responsibility: S("member: what you will do"), model: S("Your model as provider/model, e.g. anthropic/claude-opus-5-5"), unlimited: { type: "boolean", description: "new_team: operator-authorized unlimited policy" } }, ["mode"]),
				run: async (a) => {
					if (this.identity) throw new Error(`already in team ${this.identity.run_id} as ${this.identity.agent_id}; team_leave first`);
					const op = await this.operator();
					const [provider, ...rest] = String(a.model ?? process.env.PI_TEAM_CLAUDE_MODEL ?? "anthropic/claude").split("/");
					const model = rest.join("/") || provider;
					const key = `claude-join:${this.sessionKey()}:${randomUUID()}`;
					if (a.mode === "new_team") {
						const r = await this.api.createRun({ config: a.unlimited ? { operator_unlimited: true } : undefined, root: { role: "root", cwd: this.cwd, provider, model, harness: HARNESS } }, { token: op, idempotencyKey: key });
						this.adopt({ run_id: r.run_id, agent_id: r.root_agent_id, session_id: r.session_id, token: r.token }, "root");
						return `Team ${r.run_id} created; you lead it as ${r.root_agent_id}. Create members with team_create_member (they run as Pi workers).`;
					}
					const runId = String(a.run_id ?? "");
					if (!runId) throw new Error("run_id is required");
					if (a.mode === "member" || a.mode === "join") {
						// Joining is linking: this session leads its own team, linked under the target agent.
						const manager = a.manager ? await this.api.resolveAgent(String(a.manager), runId, { token: op }) : undefined;
						const r = await this.api.createRun({ root: { role: String(a.name ?? "Claude Code"), cwd: this.cwd, provider, model, harness: HARNESS } }, { token: op, idempotencyKey: key });
						await this.api.setReporting(r.run_id, { action: "connect", parent_run_id: runId, ...(manager ? { parent_agent_id: manager } : {}) }, { token: r.token, idempotencyKey: `${key}:link` });
						this.adopt({ run_id: r.run_id, agent_id: r.root_agent_id, session_id: r.session_id, token: r.token }, "member");
						return `Joined under ${manager ?? `team ${runId}'s leader`} as ${r.root_agent_id}, leading your own team ${r.run_id}. Your lead assigns work; it arrives as team messages. You can recruit your own members with team_create_member.`;
					}
					const agentId = a.mode === "agent" ? await this.api.resolveAgent(String(a.agent ?? ""), runId, { token: op }) : undefined;
					// The agent may lead a team linked under run_id; attach to its own team.
					const home = agentId ? await this.api.tree(runId, { token: op }, false, true).then((t) => {
						const find = (n: { agent_id: string; run_id?: string; children: any[] }): string | undefined => n.agent_id === agentId ? (n.run_id ?? runId) : n.children.map(find).find(Boolean);
						return find(t.root as never) ?? runId;
					}).catch(() => runId) : runId;
					const r = await this.api.attach(home, { agent_id: agentId, harness: HARNESS }, { token: op, idempotencyKey: key });
					this.adopt(r, agentId ? "agent" : "root");
					return `Attached to team ${runId} as ${r.agent_id}${agentId ? "" : " (leader)"}. Any previous session for this agent is superseded.`;
				},
			},
			{
				name: "team_leave",
				description: "Leave the team: end this session's membership credential. Your agent identity and tasks remain (resumable with team_join mode=agent), and your manager is notified. Teams keep running. Only when the human asks.",
				inputSchema: obj({ reason: S("Why you are leaving") }),
				run: async (a) => {
					const id = this.requireIdentity();
					const r = await this.api.leave({ reason: a.reason as string | undefined });
					clearIdentity(this.sessionKey(), this.paths);
					this.identity = undefined;
					this.stop();
					return `Left team ${id.run_id}; agent ${r.agent_id} remains${r.notified ? ` and ${r.notified} was notified` : ""}.`;
				},
			},
			{
				name: "team_list_teams",
				description: "List teams on this machine's controller (run IDs, leaders, members).",
				inputSchema: obj({ all: { type: "boolean", description: "Include historical teams" } }),
				run: async (a) => {
					const runs = (await this.api.listRuns({ token: await this.operator() })).runs;
					const shown = a.all ? runs : runs.filter((r) => r.status === "RUNNING" && !r.stopped);
					return shown.length ? JSON.stringify(shown, null, 2) : "No active teams.";
				},
			},
			{
				name: "team_status",
				description: "Your place in the team: manager, reports, tasks, budget, reporting links, attention policy.",
				inputSchema: obj({}),
				run: async () => { this.requireIdentity(); return formatOrgContext(await this.api.me()); },
			},
			{
				name: "team_get_tree",
				description: "The live team hierarchy.",
				inputSchema: obj({ include_closed: { type: "boolean" } }),
				run: async (a) => { const id = this.requireIdentity(); return formatTree(await this.api.tree(id.run_id, undefined, !a.include_closed), id.agent_id); },
			},
			{
				name: "team_get_inbox",
				description: "Fetch and acknowledge pending team messages (they also arrive automatically on your next prompt or when you stop).",
				inputSchema: obj({}),
				run: async () => {
					this.requireIdentity();
					const r = await this.api.inbox(20);
					for (const m of r.messages) await this.api.ack(m.message_id);
					return r.messages.length ? r.messages.map((m) => formatEnvelope(m)).join("\n\n---\n\n") : "inbox empty";
				},
			},
			{
				name: "team_send_message",
				description: "Send a durable message to your manager, a peer, someone in your subtree, or a linked team leader. Returns immediately; replies arrive as team messages.",
				inputSchema: obj({ to: S("Recipient name or agent ID"), type: S("Message type", { enum: ["question", "answer", "task.progress", "system.notice"] }), text: S("Message body"), causation_id: S("Message this replies to") }, ["to", "text"]),
				run: async (a) => {
					this.requireIdentity();
					const r = await this.api.sendMessage({ to: await this.agentRef(String(a.to)), type: (a.type ?? "question") as MessageType, payload: { text: a.text }, causation_id: a.causation_id as string | undefined });
					return `sent to ${a.to} (message ${r.message_id}). Do not wait for a reply.`;
				},
			},
			{
				name: "team_delegate_task",
				description: "Assign a task to one of your direct reports. This is a handoff: it returns once the controller has stored it.",
				inputSchema: obj({ owner: S("Direct report name or agent ID"), title: S("Task title"), spec: S("Goals, acceptance criteria, paths") }, ["owner", "title"]),
				run: async (a) => {
					this.requireIdentity();
					const owner = await this.agentRef(String(a.owner));
					const r = await this.api.delegateTask({ owner_id: owner, title: String(a.title), spec: a.spec ? { text: a.spec } : undefined });
					return handoffText(`task ${r.task_id}`, String(a.owner), r.handoff);
				},
			},
			{
				name: "team_create_member",
				description: "Leader only: recruit a new member. Members run as Pi workers (in tmux panes when enabled). Omit model to use your model; give provider/model otherwise. Returns once provisioned; do not wait for it to start.",
				inputSchema: obj({ name: S("Member name"), responsibility: S("Concrete task, context and acceptance criteria"), model: S("provider/model for the Pi worker") }, ["responsibility"]),
				run: async (a) => {
					this.requireIdentity();
					const body: Json = { name: a.name, responsibility: a.responsibility };
					if (a.model) {
						const [provider, ...rest] = String(a.model).split("/");
						if (!rest.length) throw new Error("model must be provider/model");
						body.model = { id: String(a.model), provider, model: rest.join("/"), capability_tags: ["general", "reasoning", "coding", "tools"], tool_support: true };
					}
					const r = await this.api.post<{ spawned_agent_ids?: string[] }>("/members", body, { idempotencyKey: `claude-member:${randomUUID()}` });
					return `Member provisioned: ${(r.spawned_agent_ids ?? []).join(", ")}. It starts asynchronously with its responsibility as its first task. Return control to the human; reports arrive as team messages.`;
				},
			},
			{
				name: "team_report_progress",
				description: "Report progress on a task you own to your manager.",
				inputSchema: obj({ task_id: S("Task ID"), note: S("Progress note") }, ["task_id", "note"]),
				run: async (a) => { this.requireIdentity(); await this.api.reportProgress(String(a.task_id), String(a.note)); return "progress reported"; },
			},
			{
				name: "team_complete_task",
				description: "Complete (DONE), fail or block a task you own; your manager is notified. Completing a task does not end your membership.",
				inputSchema: obj({ task_id: S("Task ID"), summary: S("Result summary"), status: S("DONE | FAILED | BLOCKED", { enum: ["DONE", "FAILED", "BLOCKED"] }) }, ["task_id", "summary"]),
				run: async (a) => { this.requireIdentity(); const status = (a.status ?? "DONE") as "DONE" | "FAILED" | "BLOCKED"; await this.api.completeTask(String(a.task_id), { summary: String(a.summary), status }); return `task ${a.task_id} ${status}`; },
			},
			{
				name: "team_reassign",
				description: "Move an agent you manage under a different manager in your subtree (dynamic reassignment). Its tasks and identity are retained.",
				inputSchema: obj({ agent: S("Agent to move"), new_manager: S("New manager"), reason: S("Why") }, ["agent", "new_manager"]),
				run: async (a) => {
					const id = this.requireIdentity();
					const tree = await this.api.tree(id.run_id);
					const r = await this.api.post(`/agents/${encodeURIComponent(await this.agentRef(String(a.agent)))}/reparent`, { new_parent_id: await this.agentRef(String(a.new_manager)), expected_topology_version: tree.topology_version, reason: a.reason ?? "reassigned", pending_work_policy: "retain" }, { idempotencyKey: `claude-reparent:${randomUUID()}` });
					return JSON.stringify(r, null, 2);
				},
			},
			{
				name: "team_roster",
				description: "Everyone ever linked under you. action=list; recall brings a former member or dismissed team back with its context (same identity for a linked team); rehire fills its position with a fresh agent. Only when the human asks.",
				inputSchema: obj({ action: S("list | recall | rehire", { enum: ["list", "recall", "rehire"] }), agent: S("recall/rehire: roster name or agent ID") }, ["action"]),
				run: async (a) => {
					const id = this.requireIdentity();
					if (a.action === "list") return JSON.stringify(await this.api.get(`/agents/${encodeURIComponent(id.agent_id)}/roster`), null, 2);
					if (!a.agent) throw new Error("agent is required for recall and rehire");
					return JSON.stringify(await this.api.post(`/roster/${a.action === "recall" ? "recall" : "rehire"}`, { agent: String(a.agent) }, { idempotencyKey: `claude-roster:${randomUUID()}` }), null, 2);
				},
			},
			{
				name: "team_report_to",
				description: "Leader only: make your team a sub-team reporting to another team's leader (run_id), or 'none' to disconnect. No merge or takeover; each team keeps its own authority.",
				inputSchema: obj({ run_id: S("Receiving team's run ID, or none") }, ["run_id"]),
				run: async (a) => {
					const id = this.requireIdentity();
					const r = await this.api.setReporting(id.run_id, a.run_id === "none" ? { action: "disconnect" } : { action: "connect", parent_run_id: String(a.run_id) }, { idempotencyKey: `claude-report:${randomUUID()}` });
					return JSON.stringify(r, null, 2);
				},
			},
			{
				name: "team_close_member",
				description: "Actually terminate a member in your subtree (cancels its tasks, stops its process). For a team linked under you it dismisses that team instead: it detaches, or stops resumably if the human made its link terminatable. Only when requested.",
				inputSchema: obj({ agent: S("Member to close"), reason: S("Why") }, ["agent"]),
				run: async (a) => {
					this.requireIdentity();
					const target = await this.agentRef(String(a.agent));
					const reason = String(a.reason ?? "manager requested member close");
					if ((await this.api.me()).children.some((c) => c.agent_id === target && c.run_id)) {
						const d = await this.api.post<{ stopped: boolean; stopped_run_ids: string[] }>(`/agents/${encodeURIComponent(target)}/dismiss`, { reason }, { idempotencyKey: `claude-dismiss:${randomUUID()}` });
						return d.stopped ? `Dismissed and stopped ${d.stopped_run_ids.join(", ")} (resumable).` : "Dismissed: the linked team detached and keeps running on its own.";
					}
					const r = await this.api.lifecycle(target, { action: "cancel", reason, children_policy: "cascade" }, { idempotencyKey: `claude-close:${randomUUID()}` });
					return `closed: ${r.affected_agent_ids.join(", ") || "already closed"}`;
				},
			},
			{
				name: "team_set_attention",
				description: "View or change when idle agents get automatic turns: scope=team (leader) or agent. Fields: on_message wake|next_turn, batch_seconds, stall_seconds, tick_seconds, max_wakes_per_hour, reset. Omit fields to view. Change only when the human asks.",
				inputSchema: obj({ scope: S("team | agent", { enum: ["team", "agent"] }), agent: S("Agent (default: you)"), on_message: S("wake | next_turn", { enum: ["wake", "next_turn"] }), batch_seconds: { type: "integer", minimum: 0 }, stall_seconds: { type: "integer", minimum: 0 }, tick_seconds: { type: "integer", minimum: 0 }, max_wakes_per_hour: { type: "integer", minimum: 0 }, reset: { type: "boolean" } }),
				run: async (a) => {
					const id = this.requireIdentity();
					const target = a.scope === "team" ? { run_id: id.run_id } : { agent_id: a.agent ? await this.agentRef(String(a.agent)) : id.agent_id };
					const { scope: _s, agent: _a, ...patch } = a;
					const view = Object.keys(patch).length ? await this.api.setAttention(target, patch, { idempotencyKey: `claude-attention:${randomUUID()}` }) : await this.api.attention(target);
					return formatAttention(view);
				},
			},
		];
		return t;
	}

	instructions(): string {
		return "pi-aatwad team tools. This Claude Code session can found, lead, join or leave Pi agent teams that share one local controller with Pi sessions. " +
			"Dispatching is a handoff: after team_create_member, team_delegate_task or team_send_message succeeds, summarize and end your turn; do not poll. " +
			"Team messages arrive automatically when you next get a prompt or try to stop; while idle, keep the team waiter running in the background if the session-start context asks you to.";
	}

	/** One JSON-RPC request -> response (undefined for notifications). */
	async handle(msg: { id?: number | string; method?: string; params?: Json }): Promise<Json | undefined> {
		const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
		const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
		if (msg.id === undefined) return undefined;
		switch (msg.method) {
			case "initialize":
				return reply({ protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-team", version: LOADED_VERSION }, instructions: this.instructions() });
			case "ping":
				return reply({});
			case "tools/list":
				return reply({ tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
			case "tools/call": {
				const tool = this.tools().find((x) => x.name === msg.params?.name);
				if (!tool) return error(-32602, `unknown tool ${String(msg.params?.name)}`);
				try {
					return reply({ content: [{ type: "text", text: await tool.run((msg.params?.arguments as Json) ?? {}) }] });
				} catch (e) {
					return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
				}
			}
			default:
				return error(-32601, `method not found: ${msg.method}`);
		}
	}
}

export function serveStdio(server = new ClaudeTeamServer()): void {
	if (server.loadIdentity()) server.start();
	const rl = createInterface({ input: process.stdin });
	rl.on("line", (line) => {
		if (!line.trim()) return;
		let msg: Json;
		try { msg = JSON.parse(line); } catch { return; }
		void server.handle(msg).then((r) => { if (r) process.stdout.write(`${JSON.stringify(r)}\n`); });
	});
	rl.on("close", () => { server.stop(); process.exit(0); });
}
