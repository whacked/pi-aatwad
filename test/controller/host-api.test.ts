import { test } from "node:test";
import assert from "node:assert/strict";
import { api, harness, newRun, waitFor } from "./helpers.ts";
import { ROUTE_SUMMARIES } from "../../src/controller/openapi.ts";
import { HDR_PROTOCOL } from "../../src/shared/protocol.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const report = (host: string) => ({ host, label: host, sessions: host !== "detached", beside: false, verified: true, candidates: [{ host, label: host, detected: true, usable: true }], detected_at: new Date().toISOString() });

test("host detection is reported, readable, and refreshable over the API", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), other = await newRun(h);
		const member = ok(await h.call("POST", "/members", { token: lead.token, body: { name: "Worker", responsibility: "Work" } })).spawned_agent_ids[0];
		await waitFor(() => h.ex.tokens.has(member));
		const mtoken = h.ex.tokens.get(member)!;
		assert.deepEqual(ok(await h.call("GET", `/agents/${member}/host`, { token: lead.token })), { agent_id: member, host: null, reported_at: null, refresh_requested: false });
		ok(await h.call("POST", "/sessions/host", { token: mtoken, body: report("native") }));
		const read = ok(await h.call("GET", `/agents/${member}/host`, { token: h.op }));
		assert.equal(read.host.host, "native");
		assert.ok(read.reported_at);
		assert.equal((await h.call("POST", "/sessions/host", { token: mtoken, body: { host: 1 } })).status, 400);
		assert.equal((await h.call("POST", "/sessions/host", { token: h.op, body: report("tmux") })).status, 403, "only a session reports its own host");
		// Asking for a refresh is relayed on the member's next heartbeat until it reports again.
		assert.equal((await h.call("POST", `/agents/${member}/host/refresh`, { token: other.token, body: {} })).status, 403);
		assert.equal(ok(await h.call("POST", `/agents/${member}/host/refresh`, { token: lead.token, body: {} })).refresh_requested, true);
		assert.equal(ok(await h.call("POST", "/sessions/heartbeat", { token: mtoken, body: {} })).host_refresh, true);
		ok(await h.call("POST", "/sessions/host", { token: mtoken, body: report("tmux") }));
		assert.equal(ok(await h.call("POST", "/sessions/heartbeat", { token: mtoken, body: {} })).host_refresh, undefined);
		const after = ok(await h.call("GET", `/agents/${member}/host`, { token: lead.token }));
		assert.deepEqual([after.host.host, after.refresh_requested], ["tmux", false]);
		const events = ok(await h.call("GET", `/events?run_id=${lead.run_id}`, { token: h.op })).events.map((e: any) => e.type);
		assert.ok(events.includes("agent.host_detected") && events.includes("agent.host_refresh_requested"));
	} finally { await h.cleanup(); }
});

test("GET /openapi.json lists every route, needs no token or protocol header, and every route is documented", async () => {
	const h = await harness();
	try {
		// No protocol header and no token: discovery works for any client.
		const doc = await api(h.sock, "GET", "/openapi.json", { protocol: null });
		assert.equal(doc.status, 200);
		assert.equal(doc.body.openapi, "3.1.0");
		const ops = Object.entries(doc.body.paths as Record<string, Record<string, any>>).flatMap(([path, m]) => Object.entries(m).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path.replace(/\{id\d*\}/g, ":id")}`, op })));
		const undocumented = ops.filter((o) => !ROUTE_SUMMARIES[o.key]).map((o) => o.key);
		assert.deepEqual(undocumented, [], "every route needs a summary in ROUTE_SUMMARIES");
		const byKey = Object.fromEntries(ops.map((o) => [o.key, o.op]));
		assert.equal(byKey["GET /agents/:id/host"]["x-auth"], "any");
		assert.equal(byKey["POST /agents/:id/host/refresh"].parameters[0].name, "id");
		assert.ok(byKey["POST /sessions/host"].parameters.some((p: any) => p.name === HDR_PROTOCOL));
		assert.deepEqual(byKey["GET /health"].security, []);
		assert.ok(ops.length >= 60);
	} finally { await h.cleanup(); }
});
