import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../../src/extension/tools.ts";
import { TeamClient } from "../../src/shared/client.ts";
import { statePaths } from "../../src/shared/paths.ts";
import { harness, newRun } from "../controller/helpers.ts";

test("conversational reporting tool connects roots, supports durable reports, and keeps identities alive on dismissal", async () => {
 const h = await harness();
 try {
  const project = await newRun(h), parent = await newRun(h);
  const toolsFor = (team: typeof project) => {
   const tools = new Map<string, any>();
   let released = false;
   const rt = { identity: { agent_id: team.root, run_id: team.run_id },
    client: new TeamClient({ paths: statePaths(h.dir), token: () => team.token, noReconnect: true }),
    agentCall: (fn: () => unknown) => fn(), releaseStoppedIdentity: () => { released = true; } };
   registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, rt as any);
   return { invoke: (name: string, params: any, id = name) => tools.get(name).execute(id, params, undefined, undefined, {}), released: () => released };
  };
  const s = toolsFor(parent), p = toolsFor(project);
  const connect = { action: "connect", parent_run_id: parent.run_id };
  const linked = await p.invoke("team_reporting", connect);
  assert.deepEqual((await p.invoke("team_reporting", connect)).details, linked.details);
  assert.equal(linked.details.links.length, 1);
  const sent = await p.invoke("team_send_message", { to: parent.root, type: "task.progress", text: "Initial report: ready, no blockers" });
  assert.ok(sent.details.message_id);
  const state = await s.invoke("team_reporting", { action: "status" });
  assert.equal(state.details.links[0].child_agent_id, project.root);
  await s.invoke("team_reporting", { action: "dismiss" }, "dismiss");
  assert.equal(s.released(), false, "dismissal keeps the receiving leader session alive");
  const history = await p.invoke("team_reporting", { action: "status", history: true });
  assert.ok(history.details.links[0].closed_at);
 } finally { await h.cleanup(); }
});
