// Dismissal and link policy (docs/design/unified-team-links.md).
// Dismissing an agent linked under you severs the link; on a terminatable link it also stops
// the agent's team, resumably, cascading through terminatable links and severing the rest.
import type { Ctx, Principal, ReqScope } from "./context.ts";
import type { DismissResponse, ReportingLink } from "../shared/protocol.ts";
import { all, emit, get, run } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getAgent, isTerminal } from "./queries.ts";
import { closeLink, LINK_COLUMNS, linkOfChild } from "./reporting.ts";
import { cascadeStop, suspendTeam } from "./team-lifecycle.ts";

export function dismiss(ctx: Ctx, p: Principal, scope: ReqScope, agentId: string, body: unknown): DismissResponse {
	const db = ctx.db;
	const b = obj(body ?? {});
	onlyKeys(b, ["reason", "stop"]);
	const reason = str(b, "reason", { optional: true }) ?? "dismissed by its lead";
	if (b.stop !== undefined && typeof b.stop !== "boolean") fail("INVALID", "stop must be boolean");
	getAgent(db, agentId);
	const link = linkOfChild(db, agentId);
	if (!link) fail("NOT_FOUND", "agent is not linked under another team; close your own team's members with team_close_member");
	if (p.kind === "agent" && p.actor_id !== link.parent_agent_id) fail("FORBIDDEN", "only the agent's lead or the human operator may dismiss it");
	if (b.stop !== undefined && p.kind !== "operator") fail("FORBIDDEN", "only the human operator may override whether dismissal stops the team");
	const stop = (b.stop as boolean | undefined) ?? !!link.terminatable;
	const stopped: string[] = [], severedBelow: string[] = [];
	if (stop && !isTerminal(getAgent(db, agentId).status)) {
		suspendTeam(ctx, scope, link.child_run_id, p.actor_id, link.parent_run_id);
		stopped.push(link.child_run_id);
		cascadeStop(ctx, scope, link.child_run_id, p.actor_id, new Set([link.child_run_id, link.parent_run_id]), { stopped });
		// The dismissed teams are gone until recalled; joined teams below them carry on independently.
		for (const runId of stopped) {
			for (const below of all(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e WHERE e.parent_run_id = ? AND e.valid_to IS NULL AND e.terminatable = 0`, runId)) {
				closeLink(db, below, p.actor_id, `its lead's team was dismissed: ${reason}`);
				severedBelow.push(below.child_run_id);
			}
		}
	}
	closeLink(db, link, p.actor_id, stop ? `dismissed and stopped: ${reason}` : `dismissed: ${reason}`);
	emit(db, { run_id: link.parent_run_id, actor_id: p.actor_id, type: "link.dismissed", entity_id: link.id, payload: { agent_id: agentId, stopped, severed_below: severedBelow, reason } });
	ctx.kick();
	return { agent_id: agentId, run_id: link.child_run_id, severed: true, stopped: stopped.length > 0, stopped_run_ids: stopped, severed_below: severedBelow };
}

/** Operator-only: whether dismissing this agent may stop its team. */
export function setLinkPolicy(ctx: Ctx, p: Principal, agentId: string, body: unknown): ReportingLink {
	if (p.kind !== "operator") fail("FORBIDDEN", "only the human operator may change whether a link is terminatable");
	const db = ctx.db;
	const b = obj(body);
	onlyKeys(b, ["terminatable"]);
	if (typeof b.terminatable !== "boolean") fail("INVALID", "terminatable must be boolean");
	const edge = get(db, "SELECT id FROM reporting_edges WHERE child_id = ? AND valid_to IS NULL", agentId);
	if (!edge) fail("NOT_FOUND", "agent has no active link");
	run(db, "UPDATE reporting_edges SET terminatable = ? WHERE id = ?", b.terminatable ? 1 : 0, edge.id);
	const row = get(db, `SELECT ${LINK_COLUMNS} FROM reporting_edges e WHERE e.id = ?`, edge.id)!;
	emit(db, { run_id: getAgent(db, agentId).run_id, actor_id: p.actor_id, type: "link.policy", entity_id: edge.id, payload: { agent_id: agentId, terminatable: b.terminatable } });
	return { ...row, child_run_id: row.child_run_id, parent_run_id: row.parent_run_id ?? row.child_run_id, terminatable: !!row.terminatable } as ReportingLink;
}
