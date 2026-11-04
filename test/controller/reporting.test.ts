import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, newRun, ownTask, recruit, sql, type Harness } from "./helpers.ts";

type Team = Awaited<ReturnType<typeof newRun>>;
const change = (h: Harness, t: Team, body: unknown, key?: string) => h.call("POST", `/runs/${t.run_id}/reporting`, { token: t.token, body, key });
const send = (h: Harness, from: Team, to: Team, type = "question", text = "Status?") => h.call("POST", "/messages", { token: from.token, body: { to: to.root, type, payload: { text } } });
const inbox = async (h: Harness, t: Team) => (await h.call("GET", "/inbox", { token: t.token })).body.messages;
const ok = (r: any) => assert.equal(r.status, 200, JSON.stringify(r.body));

test("five independent projects connect without identity or budget changes; roots coordinate durably across restart", async () => {
 const h = await harness();
 try {
  const parent = await newRun(h);
  ok(await change(h, parent, { action: "wake", wake_on_message: true }));
  const projects: Team[] = [];
  for (let i = 0; i < 5; i++) {
   const t = await newRun(h); projects.push(t);
   await ownTask(h, t.token, t.root, `Project ${i}`);
   const before = sql(h, "SELECT * FROM allocations WHERE agent_id = ?", t.root);
   const session = sql(h, "SELECT current_session_id FROM agents WHERE id = ?", t.root);
   ok(await change(h, t, { action: "connect", parent_run_id: parent.run_id }, `connect-${i}`));
   ok(await change(h, t, { action: "connect", parent_run_id: parent.run_id }, `connect-${i}`));
   assert.deepEqual(sql(h, "SELECT * FROM allocations WHERE agent_id = ?", t.root), before);
   assert.deepEqual(sql(h, "SELECT current_session_id FROM agents WHERE id = ?", t.root), session);
   ok(await send(h, t, parent, "task.progress", `Project ${i} ready`));
   assert.equal((await h.call("GET", "/me", { token: t.token })).body.reporting.links[0].parent_agent_id, parent.root);
  }
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL").length, 5);
  assert.equal(sql(h, "SELECT * FROM reporting_edges").length, 0);
  await h.restart({ crash: true });
  const messages = await inbox(h, parent);
  assert.equal(messages.length, 10);
  assert.equal(messages.filter((m: any) => m.type === "task.progress").length, 5);
  assert.equal(messages.filter((m: any) => m.payload.kind === "reporting.connected").length, 5);
  assert.ok(messages.every((m: any) => m.run_id === parent.run_id));
  assert.equal((await h.call("GET", "/me", { token: parent.token })).body.reporting.links.length, 5);
  const heartbeat = await h.call("POST", "/sessions/heartbeat", { token: parent.token, body: {} });
  assert.equal(heartbeat.body.reporting_wake, true);
  assert.equal((await h.call("POST", "/sessions/heartbeat", { token: projects[0].token, body: {} })).body.reporting_wake, false);
  ok(await send(h, parent, projects[0]));
  const reply = (await inbox(h, projects[0])).find((m: any) => m.from === parent.root && m.type === "question");
  assert.equal(reply.payload.text, "Status?");
  assert.equal((await send(h, projects[0], projects[1])).status, 403, "sibling projects cannot communicate directly");
  assert.equal((await send(h, parent, projects[0], "task.assigned")).status, 403);
  assert.equal((await h.call("POST", "/tasks", { token: parent.token, body: { owner_id: projects[0].root, title: "Cross-team assignment" } })).status, 403);
  assert.equal((await h.call("GET", `/budgets/${projects[0].root}`, { token: parent.token })).status, 403);
 } finally { await h.cleanup(); }
});

test("disconnect withdraws pending deliveries, retains history, denies messages; dismissal ends links while every team keeps running", async () => {
 const h = await harness();
 try {
  const s = await newRun(h), a = await newRun(h), b = await newRun(h);
  const task = await ownTask(h, a.token, a.root);
  const [worker] = await recruit(h, a.token, a.token, task, [{ max_cost_usd: 1 }]);
  for (const p of [a, b]) ok(await change(h, p, { action: "connect", parent_run_id: s.run_id }));
  const question = await send(h, s, a);
  ok(question);
  const memberToken = h.ex.tokens.get(worker)!;
  assert.equal((await h.call("POST", `/runs/${a.run_id}/reporting`, { token: memberToken, body: { action: "disconnect" } })).status, 403);
  assert.equal((await h.call("POST", "/messages", { token: memberToken, body: { to: s.root, type: "question", payload: { text: "x" } } })).status, 403);
  assert.equal((await h.call("POST", `/runs/${a.run_id}/reporting`, { token: s.token, body: { action: "disconnect" } })).status, 403);
  ok(await change(h, a, { action: "disconnect" }));
  ok(await change(h, a, { action: "disconnect" }));
  const after = await inbox(h, a);
  assert.ok(!after.some((m: any) => m.message_id === question.body.message_id));
  assert.ok(after.some((m: any) => m.payload.kind === "reporting.disconnected"));
  assert.ok(sql(h, "SELECT withdrawn_at FROM team_reporting_messages WHERE message_id = ?", question.body.message_id)[0].withdrawn_at);
  assert.equal((await send(h, s, a)).status, 403);
  const hist = await h.call("GET", `/runs/${a.run_id}/reporting?history=1`, { token: a.token });
  assert.equal(hist.body.links.length, 1); assert.ok(hist.body.links[0].closed_at);
  ok(await change(h, s, { action: "dismiss" }, "dismiss"));
  ok(await change(h, s, { action: "dismiss" }, "dismiss"));
  ok(await h.call("POST", `/runs/${s.run_id}/reporting`, { token: h.op, body: { action: "dismiss" } }));
  assert.equal(sql(h, "SELECT status FROM agents WHERE id = ?", s.root)[0].status, "RUNNING");
  ok(await h.call("GET", "/me", { token: s.token }));
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL").length, 0);
  for (const t of [a, b]) ok(await h.call("GET", "/me", { token: t.token }));
  ok(await h.call("GET", "/me", { token: memberToken }));
  assert.equal(h.ex.stopped.length, 0);
  assert.equal(sql(h, "SELECT status FROM tasks WHERE id = ?", task)[0].status, "ASSIGNED");
 } finally { await h.cleanup(); }
});

test("transfer moves links and history atomically; validation and cycles roll back; ordinary stop disconnects", async () => {
 const h = await harness();
 try {
  const old = await newRun(h), next = await newRun(h), a = await newRun(h), b = await newRun(h);
  for (const t of [a, b]) ok(await change(h, t, { action: "connect", parent_run_id: old.run_id }));
  assert.equal((await change(h, old, { action: "connect", parent_run_id: a.run_id })).status, 409);
  assert.equal((await change(h, old, { action: "transfer", parent_run_id: a.run_id })).status, 409);
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL AND parent_run_id = ?", old.run_id).length, 2, "failed transfer restores every original link");
  ok(await send(h, a, old, "answer", "Ready; need a decision"));
  const existing = sql(h, "SELECT id, current_session_id FROM agents ORDER BY id");
  ok(await change(h, old, { action: "transfer", parent_run_id: next.run_id }));
  assert.deepEqual(sql(h, "SELECT id, current_session_id FROM agents ORDER BY id"), existing);
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL AND parent_run_id = ?", next.run_id).length, 2);
  const handoffs = (await inbox(h, next)).filter((m: any) => m.payload.kind === "reporting.handoff");
  assert.equal(handoffs.length, 2);
  assert.ok(handoffs.some((m: any) => m.payload.recent_messages.some((r: any) => r.payload_json.includes("need a decision"))));
  assert.equal((await send(h, old, a)).status, 403);
  ok(await send(h, next, a));
  ok(await h.call("POST", `/agents/${next.root}/lifecycle`, { token: h.op, body: { action: "cancel", children_policy: "cascade", reason: "operator stopped parent" } }));
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL").length, 0);
  for (const t of [a,b]) ok(await h.call("GET", "/me", { token: t.token }));
 } finally { await h.cleanup(); }
});

test("disconnect withdraws delivered unanswered questions, while linked answers resolve questions", async () => {
 const h = await harness();
 try {
  const s = await newRun(h), p = await newRun(h);
  ok(await change(h, p, { action: "connect", parent_run_id: s.run_id }));
  const unanswered = await send(h, s, p), answered = await send(h, s, p);
  for (const m of await inbox(h, p)) ok(await h.call("POST", `/messages/${m.message_id}/ack`, { token: p.token, body: {} }));
  ok(await h.call("POST", "/messages", { token: p.token, body: { to: s.root, type: "answer", causation_id: answered.body.message_id, payload: { text: "Resolved" } } }));
  ok(await change(h, p, { action: "disconnect" }));
  const withdrawn = (id: string) => sql(h, "SELECT withdrawn_at FROM team_reporting_messages WHERE message_id = ?", id)[0].withdrawn_at;
  assert.ok(withdrawn(unanswered.body.message_id));
  assert.equal(withdrawn(answered.body.message_id), null);
 } finally { await h.cleanup(); }
});

test("migration from schema 3 preserves existing team identity and tasks", async () => {
 const h = await harness();
 try {
  const p = await newRun(h);
  const task = await ownTask(h, p.token, p.root);
  // Reconstruct the prior schema without touching any existing team records.
  h.h.db.exec("DROP TABLE team_reporting_messages; DROP TABLE team_reporting_links; DROP TABLE team_reporting_settings; DELETE FROM schema_migrations WHERE version = 4;");
  await h.restart({ crash: true });
  const me = await h.call("GET", "/me", { token: p.token });
  ok(me);
  assert.equal(me.body.tasks[0].task_id, task);
  assert.deepEqual(me.body.reporting.links, []);
  assert.equal(sql(h, "SELECT MAX(version) AS v FROM schema_migrations")[0].v, 4);
 } finally { await h.cleanup(); }
});

test("any leader can both receive reports and report upward; transfer preserves its parent and dismissal preserves every team", async () => {
 const h = await harness();
 try {
  const top = await newRun(h), middle = await newRun(h), leaf = await newRun(h), other = await newRun(h);
  const identities = sql(h, "SELECT id, current_session_id, role, status FROM agents ORDER BY id");
  ok(await change(h, middle, { action: "connect", parent_run_id: top.run_id }));
  ok(await change(h, leaf, { action: "connect", parent_run_id: middle.run_id }));
  const context = (await h.call("GET", "/me", { token: middle.token })).body.reporting;
  assert.equal(context.links.length, 2);
  assert.ok(context.links.some((l: any) => l.parent_run_id === top.run_id));
  assert.ok(context.links.some((l: any) => l.child_run_id === leaf.run_id));
  assert.equal((await change(h, top, { action: "connect", parent_run_id: leaf.run_id })).status, 409);
  ok(await change(h, middle, { action: "transfer", parent_run_id: other.run_id }));
  assert.equal(sql(h, "SELECT parent_run_id FROM team_reporting_links WHERE child_run_id = ? AND closed_at IS NULL", middle.run_id)[0].parent_run_id, top.run_id);
  assert.equal(sql(h, "SELECT parent_run_id FROM team_reporting_links WHERE child_run_id = ? AND closed_at IS NULL", leaf.run_id)[0].parent_run_id, other.run_id);
  ok(await change(h, other, { action: "connect", parent_run_id: middle.run_id }));
  ok(await change(h, middle, { action: "dismiss" }));
  assert.equal(sql(h, "SELECT * FROM team_reporting_links WHERE closed_at IS NULL").length, 1, "only middle's incident links end");
  assert.deepEqual(sql(h, "SELECT id, current_session_id, role, status FROM agents ORDER BY id"), identities);
  for (const t of [top, middle, leaf, other]) ok(await h.call("GET", "/me", { token: t.token }));
  ok(await send(h, leaf, other, "task.progress", "Still working"));
 } finally { await h.cleanup(); }
});
