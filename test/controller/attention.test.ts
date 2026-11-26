import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, waitFor, type Harness } from "./helpers.ts";

const ok = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const beat = (h: Harness, token: string, busy = false) => h.call("POST", "/sessions/heartbeat", { token, body: { busy } }).then(ok);
const setRun = (h: Harness, token: string, runId: string, body: unknown) => h.call("POST", `/runs/${runId}/attention`, { token, body });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function team(h: Harness) {
	const t = await newRun(h);
	const task = await ownTask(h, t.token, t.root);
	const [worker] = await recruit(h, t.token, t.token, task, [{}]);
	const workerToken = await waitFor(() => h.ex.tokens.get(worker), "worker token");
	return { ...t, worker, workerToken };
}

test("an empty heartbeat never wakes; messages wake an idle leader once the batch window passes, never a busy one", async () => {
	const h = await harness();
	try {
		const t = await team(h);
		const quiet = await beat(h, t.token);
		assert.equal(quiet.wake, undefined, "nothing new -> nothing for the model");
		assert.deepEqual(quiet.attention, { on_message: "wake" }, "wake is the default");
		ok(await setRun(h, t.token, t.run_id, { batch_seconds: 0, stall_seconds: 0 }));
		ok(await h.call("POST", "/messages", { token: t.workerToken, body: { to: t.root, type: "question", payload: { text: "Which branch?" } } }));
		assert.equal((await beat(h, t.token, true)).wake, undefined, "busy sessions are never woken");
		assert.deepEqual((await beat(h, t.token)).wake, { reason: "message" });
		ok(await h.call("GET", "/inbox", { token: t.token }));
		assert.equal((await beat(h, t.token)).wake, undefined, "claimed messages do not wake again");

		ok(await setRun(h, t.token, t.run_id, { batch_seconds: 3600 }));
		ok(await h.call("POST", "/messages", { token: t.workerToken, body: { to: t.root, type: "question", payload: { text: "Again?" } } }));
		assert.equal((await beat(h, t.token)).wake, undefined, "batch window holds the wake");

		ok(await setRun(h, t.token, t.run_id, { batch_seconds: 0, on_message: "next_turn" }));
		const passive = await beat(h, t.token);
		assert.equal(passive.wake, undefined);
		assert.deepEqual(passive.attention, { on_message: "next_turn" });
		assert.equal(passive.reporting_wake, false);
	} finally { await h.cleanup(); }
});

test("progress reports alone do not wake an idle lead; they ride along with the next turn", async () => {
	const h = await harness();
	try {
		const t = await team(h);
		ok(await setRun(h, t.token, t.run_id, { batch_seconds: 0, stall_seconds: 0 }));
		const task = ok(await h.call("POST", "/tasks", { token: t.token, body: { owner_id: t.worker, title: "Scan pages" } }));
		ok(await h.call("GET", "/inbox", { token: t.token })); // clear the recruitment notices
		ok(await h.call("POST", `/tasks/${task.task_id}/progress`, { token: t.workerToken, body: { note: "page 10 of 93" } }));
		const quiet = await beat(h, t.token);
		assert.equal(quiet.wake, undefined, "progress alone is no reason for a turn");
		assert.ok(quiet.inbox_pending >= 1, "but it is waiting for the next one");
		ok(await h.call("POST", "/messages", { token: t.workerToken, body: { to: t.root, type: "question", payload: { text: "Skip blank pages?" } } }));
		assert.deepEqual((await beat(h, t.token)).wake, { reason: "message" }, "a question wakes it, and the progress comes along");
	} finally { await h.cleanup(); }
});

test("delegation returns a handoff ack; a stalled team wakes its manager once per distinct state, within the hourly cap", async () => {
	const h = await harness();
	try {
		const t = await team(h);
		await beat(h, t.workerToken, false);
		const d = ok(await h.call("POST", "/tasks", { token: t.token, body: { owner_id: t.worker, title: "Write the parser" } }));
		assert.deepEqual(d.handoff, { owner_id: t.worker, owner_live: true, owner_busy: false, desired_state: "RUNNING" });

		ok(await setRun(h, t.token, t.run_id, { stall_seconds: 1, batch_seconds: 3600 }));
		assert.equal((await beat(h, t.token)).wake, undefined, "not stalled yet");
		await sleep(1100);
		const w = (await beat(h, t.token)).wake;
		assert.equal(w?.reason, "stall");
		assert.match(w.text, /Write the parser" ASSIGNED \(not yet picked up\)/);
		assert.equal((await beat(h, t.token)).wake, undefined, "same stalled state does not wake again");

		// The worker picks the task up: the state changes, so a later stall wakes once more.
		for (const m of ok(await h.call("GET", "/inbox", { token: t.workerToken })).messages) ok(await h.call("POST", `/messages/${m.message_id}/ack`, { token: t.workerToken, body: {} }));
		await beat(h, t.workerToken, true);
		assert.equal((await beat(h, t.token)).wake, undefined, "a working member is not a stall");
		await beat(h, t.workerToken, false);
		await sleep(1100);
		const again = (await beat(h, t.token)).wake;
		assert.equal(again?.reason, "stall");
		assert.doesNotMatch(again.text, /not yet picked up/);

		ok(await setRun(h, t.token, t.run_id, { max_wakes_per_hour: 0 }));
		ok(await h.call("POST", "/messages", { token: t.workerToken, body: { to: t.root, type: "question", payload: { text: "?" } } }));
		ok(await setRun(h, t.token, t.run_id, { batch_seconds: 0 }));
		assert.equal((await beat(h, t.token)).wake, undefined, "cap 0 disables automatic turns");
	} finally { await h.cleanup(); }
});

test("attention authority: root sets team defaults; managers set reports; members cannot change the team", async () => {
	const h = await harness();
	try {
		const t = await team(h);
		assert.equal((await setRun(h, t.workerToken, t.run_id, { stall_seconds: 0 })).status, 403);
		const own = ok(await h.call("POST", `/agents/${t.worker}/attention`, { token: t.workerToken, body: { on_message: "next_turn" } }));
		assert.equal(own.effective.on_message, "next_turn");
		assert.equal((await h.call("POST", `/agents/${t.root}/attention`, { token: t.workerToken, body: { cap: 1 } })).status, 403);
		const byRoot = ok(await h.call("POST", `/agents/${t.worker}/attention`, { token: t.token, body: { reset: true, tick_seconds: 600 } }));
		assert.deepEqual(byRoot.configured, { tick_seconds: 600 });
		assert.equal(byRoot.effective.on_message, "wake", "reset re-inherits");
		assert.equal((await h.call("POST", `/agents/${t.worker}/attention`, { token: t.token, body: { batch_seconds: -1 } })).status, 400);
		const view = ok(await h.call("GET", `/runs/${t.run_id}/attention`, { token: t.workerToken }));
		assert.equal(view.effective.stall_seconds, 180);
	} finally { await h.cleanup(); }
});

test("scheduled check-ins wake a lead on a fixed interval, even unchanged, and see teams linked under it", async () => {
	const h = await harness();
	try {
		const lead = await newRun(h), sub = await newRun(h);
		ok(await h.call("POST", `/runs/${sub.run_id}/reporting`, { token: sub.token, body: { action: "connect", parent_run_id: lead.run_id } }));
		const task = ok(await h.call("POST", "/tasks", { token: lead.token, body: { owner_id: sub.root, title: "Port the parser" } }));
		for (const m of ok(await h.call("GET", "/inbox", { token: lead.token })).messages) ok(await h.call("POST", `/messages/${m.message_id}/ack`, { token: lead.token, body: {} }));
		await beat(h, sub.token, true);
		ok(await setRun(h, lead.token, lead.run_id, { checkin_seconds: 1, stall_seconds: 0, batch_seconds: 3600 }));
		assert.equal((await beat(h, lead.token)).wake, undefined, "the first check-in comes one interval after it starts");
		await sleep(1100);
		const first = (await beat(h, lead.token)).wake;
		assert.equal(first?.reason, "checkin");
		assert.match(first.text, new RegExp(`\\[${sub.root}\\]: working, RUNNING; "Port the parser" ASSIGNED`), "the linked sub-leader and its task from this lead are in the digest");
		assert.equal((await beat(h, lead.token)).wake, undefined, "not before the next interval");
		await sleep(1100);
		assert.equal((await beat(h, lead.token)).wake?.reason, "checkin", "fires again although nothing changed");
		assert.equal((await beat(h, lead.token, true)).wake, undefined, "never while the lead is busy");
		void task;
	} finally { await h.cleanup(); }
});
