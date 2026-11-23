// Host detection reports: each Pi detects its own host (src/terminal/hosts.ts) at startup and on
// request, and reports it on its heartbeat. The controller keeps the latest report per agent and
// relays refresh requests, so detection is visible and triggerable over the API.
import type { Ctx, Principal } from "./context.ts";
import type { HostReport, HostStatusResponse } from "../shared/protocol.ts";
import { getAgent, inLinkedSubtree, isAncestor } from "./queries.ts";
import { emit, nowIso, parseJson, run } from "./db.ts";
import { fail } from "./errors.ts";

interface HostMeta { host?: HostReport; host_reported_at?: string; host_refresh?: string }

function readable(ctx: Ctx, p: Principal, id: string) {
	const a = getAgent(ctx.db, id);
	if (p.kind === "agent" && p.run_id !== a.run_id && !inLinkedSubtree(ctx.db, p.actor_id, id)) fail("FORBIDDEN", "other run");
	return a;
}

function status(id: string, meta: HostMeta): HostStatusResponse {
	return { agent_id: id, host: meta.host ?? null, reported_at: meta.host_reported_at ?? null, refresh_requested: !!meta.host_refresh };
}

/** GET /agents/:id/host */
export function hostStatus(ctx: Ctx, p: Principal, id: string): HostStatusResponse {
	return status(id, parseJson<HostMeta>(readable(ctx, p, id).metadata_json, {}));
}

/** POST /agents/:id/host/refresh: the agent itself, an ancestor or lead, or the operator. */
export function requestHostRefresh(ctx: Ctx, p: Principal, id: string): HostStatusResponse {
	const a = readable(ctx, p, id);
	if (p.kind === "agent" && p.actor_id !== id && !isAncestor(ctx.db, p.actor_id, id) && !inLinkedSubtree(ctx.db, p.actor_id, id)) fail("FORBIDDEN", "only the agent, its leaders, or the operator may ask it to detect its host");
	const meta = parseJson<Record<string, unknown> & HostMeta>(a.metadata_json, {});
	meta.host_refresh = nowIso();
	run(ctx.db, "UPDATE agents SET metadata_json = ? WHERE id = ?", JSON.stringify(meta), id);
	emit(ctx.db, { run_id: a.run_id, actor_id: p.actor_id, type: "agent.host_refresh_requested", entity_id: id, payload: {} });
	return status(id, meta);
}

/** POST /sessions/host: the calling session's detection result; clears a pending refresh. */
export function reportHost(ctx: Ctx, p: Principal, report: unknown): HostStatusResponse {
	if (p.kind !== "agent") fail("FORBIDDEN", "only an agent session reports its host");
	if (!report || typeof report !== "object" || typeof (report as HostReport).host !== "string" || !Array.isArray((report as HostReport).candidates)) fail("INVALID", "body must be a host detection report");
	if (JSON.stringify(report).length > 16_384) fail("INVALID", "host report too large");
	const a = getAgent(ctx.db, p.actor_id);
	const meta = parseJson<Record<string, unknown> & HostMeta>(a.metadata_json, {});
	const before = meta.host?.host;
	meta.host = report as HostReport;
	meta.host_reported_at = nowIso();
	delete meta.host_refresh;
	run(ctx.db, "UPDATE agents SET metadata_json = ? WHERE id = ?", JSON.stringify(meta), p.actor_id);
	if (before !== meta.host.host) emit(ctx.db, { run_id: a.run_id, actor_id: p.actor_id, type: "agent.host_detected", entity_id: p.actor_id, payload: { host: meta.host.host, backend: meta.host.backend ?? null } });
	return status(p.actor_id, meta);
}

/** Heartbeat side: whether someone asked this agent to detect its host again. */
export function hostRefreshWanted(ctx: Ctx, agentId: string): boolean {
	return !!parseJson<HostMeta>(getAgent(ctx.db, agentId).metadata_json, {}).host_refresh;
}
