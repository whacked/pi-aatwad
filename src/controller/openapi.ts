// OpenAPI description of the controller API, generated from the route table so it cannot drift.
// Served at GET /openapi.json (no token, no protocol header). Request and response shapes are
// documented in src/shared/protocol.ts; this lists every route with its auth and purpose.
import { HDR_IDEMPOTENCY, HDR_PROTOCOL, PROTOCOL_VERSION } from "../shared/protocol.ts";

export type Auth = "none" | "any" | "operator" | "agent";
export interface RouteDoc { method: "GET" | "POST"; path: string; auth: Auth }

/** One-line purpose of every route. A route without an entry fails the API test. */
export const ROUTE_SUMMARIES: Record<string, string> = {
	"GET /openapi.json": "This document: every controller route with its auth and purpose",
	"GET /health": "Controller identity, protocol and schema version",
	"POST /runs": "Create a team (run) and its root agent",
	"GET /runs": "List teams with name, state, members, open tasks and last activity",
	"GET /runs/:id/reporting": "Reporting links of a team (who it reports to, who reports to it)",
	"POST /runs/:id/reporting": "Connect, disconnect, transfer or dismiss reporting links",
	"POST /runs/:id/join": "Link a team under another team's leader or agent (join)",
	"POST /sessions/leave": "End the calling session's own reporting link (leave)",
	"POST /runs/:id/attach": "Attach a new leader session to an existing team",
	"POST /runs/:id/stop": "Stop a team resumably (members pause; history kept)",
	"POST /runs/:id/resume": "Resume a stopped team and its interrupted work",
	"POST /runs/:id/remove": "Remove a team permanently",
	"GET /runs/:id/lifecycle": "A team's stop/resume lifecycle state",
	"GET /runs/:id/admin": "A team's resource policy (limits, budgets, providers)",
	"POST /runs/:id/admin": "Change a team's resource policy",
	"GET /runs/:id/terminal": "Where member terminals live (backend, saved location)",
	"POST /runs/:id/terminal": "Enable member terminals at a location, or switch to detached workers",
	"GET /runs/:id/attention": "Team-wide attention policy (message wake, stall, check-ins)",
	"POST /runs/:id/attention": "Change the team-wide attention policy",
	"GET /agents/:id/attention": "An agent's effective attention policy",
	"POST /agents/:id/attention": "Override an agent's attention policy",
	"GET /runs/:id/tree": "The team's agent tree (optionally active only, or with linked teams)",
	"GET /runs/:id/recovery": "Recovery status after a controller restart",
	"POST /enroll": "Exchange a one-time enrollment credential for an agent session token",
	"POST /sessions/heartbeat": "Session liveness; returns wake, model change, host refresh and inbox signals",
	"POST /sessions/usage": "Report token usage and cost for budgets",
	"GET /me": "The calling agent: identity, role, lead, children and organization context",
	"POST /messages": "Send a message to an agent",
	"GET /inbox": "Claim pending messages for the calling agent",
	"POST /messages/:id/ack": "Acknowledge a delivered message",
	"POST /tasks": "Assign a task to a member",
	"POST /tasks/:id/progress": "Report progress on a task",
	"POST /tasks/:id/complete": "Complete a task with a summary",
	"POST /expansions": "Propose recruiting members (expansion) for approval",
	"POST /expansions/:id/decision": "Approve or reject an expansion proposal",
	"GET /proposals": "Expansion proposals to review, or the caller's own",
	"POST /agents/:id/reparent": "Move an agent under another parent",
	"POST /agents/:id/lifecycle": "Pause, resume or cancel an agent (optionally its children)",
	"POST /agents/:id/dismiss": "Dismiss a linked team from under its lead",
	"POST /agents/:id/resume-team": "A lead resumes a stopped team linked directly under it",
	"POST /agents/:id/link": "Set a link's policy (e.g. terminatable)",
	"GET /agents/:id/roster": "Closed members that can be recalled or rehired",
	"POST /roster/recall": "Bring a closed member back on its transcript",
	"POST /roster/rehire": "Hire a new member from a closed member's role",
	"POST /sessions/secede": "Detach the calling member's session into its own team",
	"POST /runs/:id/settings": "Set a team's name and exit policy",
	"GET /runs/:id/activity": "Live and busy members across the linked tree (used by the quit guard)",
	"GET /runs/:id/away": "What happened since the leader's previous session ended",
	"POST /sessions/host": "Report the calling session's host detection result",
	"GET /agents/:id/host": "An agent's latest host detection (bb, Rex, tmux, built-in, detached) and why",
	"POST /agents/:id/host/refresh": "Ask an agent's session to detect its host again (picked up on its next heartbeat)",
	"GET /agents/:id": "Inspect an agent: metadata and sessions",
	"POST /budgets/:id": "Change an agent's budget",
	"POST /agents/:id/model": "Request a model change for an agent",
	"POST /sessions/model": "Report the model the calling session selected",
	"GET /budgets/:id": "An agent's budget and usage",
	"POST /models": "Register a model in the team catalog",
	"POST /members": "Recruit members",
	"GET /models": "The team's model catalog, or models available from Pi",
	"GET /events": "The event log of a team",
	"POST /controller/shutdown": "Stop the controller process",
};

const AUTH_NOTE: Record<Auth, string> = {
	none: "No token.",
	any: "Operator token or an agent session token; agents are limited to their own team and linked teams.",
	operator: "Operator token only.",
	agent: "Agent session token only.",
};

export function openApi(routes: readonly RouteDoc[], version: string): unknown {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const r of routes) {
		let n = 0;
		const params: string[] = [];
		const path = r.path.replace(/:id/g, () => { const name = n++ ? `id${n}` : "id"; params.push(name); return `{${name}}`; });
		const summary = ROUTE_SUMMARIES[`${r.method} ${r.path}`] ?? `${r.method} ${r.path}`;
		(paths[path] ??= {})[r.method.toLowerCase()] = {
			summary,
			description: AUTH_NOTE[r.auth],
			"x-auth": r.auth,
			...(r.auth === "none" ? { security: [] } : {}),
			parameters: [
				...params.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
				...(r.path === "/openapi.json" ? [] : [{ name: HDR_PROTOCOL, in: "header", required: true, schema: { type: "string", enum: [String(PROTOCOL_VERSION)] } }]),
				...(r.method === "POST" ? [{ name: HDR_IDEMPOTENCY, in: "header", required: true, schema: { type: "string" }, description: "Unique per mutation; retries with the same key return the stored result" }] : []),
			],
			...(r.method === "POST" ? { requestBody: { required: false, content: { "application/json": { schema: { type: "object" } } } } } : {}),
			responses: {
				"200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } },
				default: { description: "Error: { error: { code, message } }" },
			},
		};
	}
	return {
		openapi: "3.1.0",
		info: { title: "pi-recursive-team controller", version, description: "HTTP over the controller's unix socket (<state dir>/c.sock). Request and response types: src/shared/protocol.ts." },
		servers: [{ url: "http://controller", description: "unix socket <state dir>/c.sock" }],
		components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
		security: [{ bearer: [] }],
		paths,
	};
}
