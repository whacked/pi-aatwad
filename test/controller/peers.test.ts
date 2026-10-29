// Peer messaging: agents with the same manager can talk directly; other teams cannot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, type Harness } from "./helpers.ts";

const tok = (hs: Harness, id: string) => hs.ex.tokens.get(id)!;
const firstTask = async (hs: Harness, id: string) => (await hs.call("GET", "/me", { token: tok(hs, id) })).body.tasks[0].task_id as string;
const send = (hs: Harness, from: string, to: string, text = "hi") =>
	hs.call("POST", "/messages", { token: tok(hs, from), body: { to, type: "question", payload: { text } } });

test("teammates (same manager) can message each other; other teams and retired peers cannot", async () => {
	const hs = await harness();
	try {
		const { root, token: rt } = await newRun(hs);
		// root -> L1, L2 ; L1 -> A, B ; L2 -> C
		const [L1, L2] = await recruit(hs, rt, rt, await ownTask(hs, rt, root), [{ count: 2, max_cost_usd: 2 }]);
		const [A, B] = await recruit(hs, tok(hs, L1), hs.op, await firstTask(hs, L1), [{ count: 2, max_cost_usd: 0.5 }]);
		const [C] = await recruit(hs, tok(hs, L2), hs.op, await firstTask(hs, L2), [{ max_cost_usd: 0.5 }]);

		const ab = await send(hs, A, B);
		assert.equal(ab.status, 200, JSON.stringify(ab.body));
		assert.equal((await send(hs, B, A, "answer")).status, 200);
		assert.equal((await send(hs, L1, L2)).status, 200, "leads under the same root are peers too");
		assert.equal(sql(hs, "SELECT sender_id FROM messages WHERE id = ?", ab.body.message_id)[0].sender_id, A, "sender comes from the token");

		const ac = await send(hs, A, C);
		assert.equal(ac.status, 403);
		assert.equal(ac.body.error.code, "FORBIDDEN", "different manager: not a teammate");

		const me = (await hs.call("GET", "/me", { token: tok(hs, A) })).body;
		assert.deepEqual(me.peers.map((p: { agent_id: string }) => p.agent_id), [B]);
		assert.deepEqual((await hs.call("GET", "/me", { token: rt })).body.peers, [], "root has no peers");

		const ret = await hs.call("POST", `/agents/${B}/lifecycle`, { token: tok(hs, L1), body: { action: "retire", reason: "done" } });
		assert.equal(ret.status, 200, JSON.stringify(ret.body));
		assert.equal((await send(hs, A, B)).body.error.code, "CONFLICT", "retired teammate is not messageable");
		assert.deepEqual((await hs.call("GET", "/me", { token: tok(hs, A) })).body.peers, [], "retired teammate drops out of peers");
	} finally {
		await hs.cleanup();
	}
});
