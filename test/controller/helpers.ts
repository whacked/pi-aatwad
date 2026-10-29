// Test helpers: short state dirs, a stub Executor, and a tiny HTTP-over-unix-socket client.
import { mkdtempSync, readFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { randomBytes } from "node:crypto";
import { HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION, type EnrollmentFile } from "../../src/shared/protocol.ts";
import type { Executor, LaunchSpec, ProcessIdentity, ProbeResult } from "../../src/executor/types.ts";
import { startController, type ControllerHandle, type ControllerOptions } from "../../src/controller/bootstrap.ts";

export function shortStateDir(): string {
	let base = tmpdir();
	if (base.length > 60) base = "/tmp";
	return mkdtempSync(join(base, "ptc-"));
}

export interface ApiResult<T = any> {
	status: number;
	body: T;
}

export function api<T = any>(socket: string, method: string, path: string, o: { token?: string; body?: unknown; key?: string | null; protocol?: string | null } = {}): Promise<ApiResult<T>> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (o.protocol !== null) headers[HDR_PROTOCOL] = o.protocol ?? String(PROTOCOL_VERSION);
		if (o.token) headers.authorization = `Bearer ${o.token}`;
		if (method === "POST" && o.key !== null) headers[HDR_IDEMPOTENCY] = o.key ?? randomBytes(8).toString("hex");
		const data = o.body === undefined ? undefined : JSON.stringify(o.body);
		const req = request({ socketPath: socket, path, method, headers, agent: false }, (res) => {
			let s = "";
			res.on("data", (c) => (s += c));
			res.on("end", () => {
				try {
					resolve({ status: res.statusCode ?? 0, body: s ? JSON.parse(s) : null });
				} catch (e) {
					reject(e);
				}
			});
		});
		req.on("error", reject);
		if (data) req.write(data);
		req.end();
	});
}

export interface StubLaunch {
	spec: LaunchSpec;
	id: ProcessIdentity;
	enrollFile: EnrollmentFile | null;
}

/** In-memory executor. mode: "enroll" (simulate worker enrolling), "silent" (start, never enroll), "hang" (launch never resolves), "fail" (launch rejects). */
export class StubExecutor implements Executor {
	launches: StubLaunch[] = [];
	alive = new Set<number>();
	stopped: number[] = [];
	mode: "enroll" | "silent" | "hang" | "fail" = "enroll";
	/** Tokens obtained by simulated workers, by agent id. */
	tokens = new Map<string, string>();
	private nextPid = 900_000 + Math.floor(Math.random() * 50_000);

	async launch(spec: LaunchSpec): Promise<ProcessIdentity> {
		if (this.mode === "fail") throw new Error("stub launch failure");
		if (this.mode === "hang") return new Promise(() => {});
		const pid = this.nextPid++;
		const id: ProcessIdentity = { pid, process_started_at: `start-${pid}`, launch_token: randomBytes(6).toString("hex") };
		this.alive.add(pid);
		const rec: StubLaunch = { spec, id, enrollFile: null };
		this.launches.push(rec);
		if (this.mode === "enroll") {
			// Like the real worker extension: read + delete the file, then enroll.
			const f = JSON.parse(readFileSync(spec.enroll_file, "utf8")) as EnrollmentFile;
			unlinkSync(spec.enroll_file);
			rec.enrollFile = f;
			setImmediate(async () => {
				try {
					const r = await api(f.socket_path, "POST", "/enroll", { body: { token: f.token, agent_id: f.agent_id, spawn_intent_id: f.spawn_intent_id, pid, process_started_at: id.process_started_at } });
					if (r.status === 200) this.tokens.set(f.agent_id, r.body.token);
				} catch {
					/* controller went away (test teardown / crash simulation) */
				}
			});
		}
		return id;
	}
	async probe(id: Pick<ProcessIdentity, "pid" | "process_started_at">): Promise<ProbeResult> {
		return this.alive.has(id.pid) ? "alive" : "dead";
	}
	async stop(id: Pick<ProcessIdentity, "pid" | "process_started_at">): Promise<void> {
		this.alive.delete(id.pid);
		this.stopped.push(id.pid);
	}
	launchesFor(agentId: string): StubLaunch[] {
		return this.launches.filter((l) => l.spec.agent_id === agentId);
	}
}

export interface Harness {
	dir: string;
	h: ControllerHandle;
	ex: StubExecutor;
	sock: string;
	op: string;
	call: <T = any>(method: string, path: string, o?: { token?: string; body?: unknown; key?: string | null }) => Promise<ApiResult<T>>;
	restart: (o?: { crash?: boolean; ex?: StubExecutor }) => Promise<void>;
	cleanup: () => Promise<void>;
}

export async function harness(opts: Partial<ControllerOptions> = {}, dir = shortStateDir()): Promise<Harness> {
	const ex = (opts.executor as StubExecutor) ?? new StubExecutor();
	const mk = (e: StubExecutor) => startController({ stateDir: dir, idleMs: 0, ...opts, executor: e, tunables: { tickMs: 50, ...(opts.tunables ?? {}) } });
	const hs: Harness = {
		dir,
		h: await mk(ex),
		ex,
		sock: join(dir, "c.sock"),
		op: "",
		call: (method, path, o = {}) => api(hs.sock, method, path, o),
		restart: async (o = {}) => {
			await hs.h.close({ crash: o.crash });
			if (o.ex) hs.ex = o.ex;
			hs.h = await mk(hs.ex);
			hs.op = hs.h.operatorToken;
		},
		cleanup: async () => {
			await hs.h.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
	hs.op = hs.h.operatorToken;
	return hs;
}

export async function waitFor<T>(fn: () => T | Promise<T>, what = "condition", timeoutMs = 5000): Promise<NonNullable<T>> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v as NonNullable<T>;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 20));
	}
}

export const MODELS = [
	{ id: "reasoning-primary", provider: "anthropic", model: "claude-x", capability_tags: ["reasoning", "coding", "tools"], tool_support: true, cost_per_m_input_usd: 3, cost_per_m_output_usd: 15, availability: "available" },
	{ id: "economy-coder", provider: "openrouter", model: "cheap-coder", capability_tags: ["coding", "tools"], tool_support: true, cost_per_m_input_usd: 0.2, cost_per_m_output_usd: 0.6, availability: "available" },
	{ id: "offline", provider: "local", model: "llama", capability_tags: ["coding", "tools"], tool_support: true, cost_per_m_input_usd: 0, cost_per_m_output_usd: 0, availability: "unavailable" },
];

export async function newRun(hs: Harness, config: Record<string, unknown> = {}): Promise<{ run_id: string; root: string; token: string }> {
	const r = await hs.call("POST", "/runs", { token: hs.op, body: { root: { role: "root", cwd: hs.dir, provider: "anthropic", model: "claude-x" }, config: { models: MODELS, ...config } } });
	if (r.status !== 200) throw new Error(`createRun failed: ${JSON.stringify(r.body)}`);
	return { run_id: r.body.run_id, root: r.body.root_agent_id, token: r.body.token };
}

export async function ownTask(hs: Harness, token: string, ownerId: string, title = "objective"): Promise<string> {
	const r = await hs.call("POST", "/tasks", { token, body: { owner_id: ownerId, title } });
	if (r.status !== 200) throw new Error(`task failed: ${JSON.stringify(r.body)}`);
	return r.body.task_id;
}

export function proposal(taskId: string, roles: { title?: string; count?: number; max_cost_usd?: number; preferred_model_id?: string; capabilities?: string[]; max_runtime_seconds?: number }[]) {
	return {
		version: 1,
		task_id: taskId,
		reason: "Work is larger than one agent can finish before the deadline.",
		alternatives: "Do it serially.",
		estimated_cost_usd: roles.reduce((s, r) => s + (r.max_cost_usd ?? 1) * (r.count ?? 1), 0),
		roles: roles.map((r) => ({ title: r.title ?? "worker", responsibility: "do the work", count: r.count ?? 1, capabilities: r.capabilities ?? ["coding"], max_cost_usd: r.max_cost_usd ?? 1, ...(r.preferred_model_id ? { preferred_model_id: r.preferred_model_id } : {}), ...(r.max_runtime_seconds ? { max_runtime_seconds: r.max_runtime_seconds } : {}) })),
	};
}

/** Propose as `token` and approve as `reviewerToken`; waits for spawned agents to enroll (stub). Returns agent ids. */
export async function recruit(hs: Harness, token: string, reviewerToken: string, taskId: string, roles: Parameters<typeof proposal>[1]): Promise<string[]> {
	const p = await hs.call("POST", "/expansions", { token, body: proposal(taskId, roles) });
	if (p.status !== 200) throw new Error(`propose failed: ${JSON.stringify(p.body)}`);
	const d = await hs.call("POST", `/expansions/${p.body.proposal_id}/decision`, { token: reviewerToken, body: { decision: "APPROVE", reason: "ok" } });
	if (d.status !== 200) throw new Error(`approve failed: ${JSON.stringify(d.body)}`);
	const ids: string[] = d.body.spawned_agent_ids;
	await waitFor(() => ids.every((id) => hs.ex.tokens.has(id)), "enrollment of " + ids.join(","));
	return ids;
}

export function sql<T = any>(hs: Harness, q: string, ...params: unknown[]): T[] {
	return hs.h.db.prepare(q).all(...(params as never[])) as T[];
}
