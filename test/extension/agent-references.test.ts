import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAgentWords } from "../../src/shared/agent-reference.ts";
import { TeamClient } from "../../src/shared/client.ts";
import { statePaths } from "../../src/shared/paths.ts";

function fixture() {
	const client = new TeamClient({ paths: statePaths("/tmp/prt-reference-tests"), noReconnect: true });
	const node = (id: string, role: string, status = "RUNNING"): any => ({ agent_id: id, role, status, children: [] });
	const root = node("agent-0123456789abcdef", "root");
	root.children = [node("agent-A-B-C", "First"), node("agent-A-D-E", "Second"), node("agent-F-G-H", "Third")];
	let calls = 0;
	client.tree = async (runId) => { assert.equal(runId, "run-test"); calls++; return { root } as any; };
	return { client, root, calls: () => calls, node };
}

test("short references resolve unique words anywhere, optional agent prefix, spaces and hyphens", async () => {
	const { client } = fixture();
	for (const ref of ["B", "agent B", "agent-b", "a b", "A-B", " B C "]) assert.equal(await client.resolveAgent(ref, "run-test"), "agent-A-B-C");
	for (const ref of ["D", "agent D", "a d", "D E"]) assert.equal(await client.resolveAgent(ref, "run-test"), "agent-A-D-E");
	for (const ref of ["F", "agent F", "G H"]) assert.equal(await client.resolveAgent(ref, "run-test"), "agent-F-G-H");
	await assert.rejects(client.resolveAgent("agent A", "run-test"), /Ambiguous.*agent-A-B-C.*agent-A-D-E/);
	assert.equal(await client.resolveAgent("Second", "run-test"), "agent-A-D-E");
});

test("six-word production IDs accept internal words but never partial characters or out-of-order words", async () => {
	const { client, root, node } = fixture();
	const maple = "agent-river-maple-orbit-silver-garden-cloud";
	const egg = "agent-river-egg-forest-sunset-lake-tree";
	root.children = [node(maple, "Reviewer"), node(egg, "Writer")];
	for (const ref of ["maple", "agent maple", "river maple", "river-maple", "garden cloud"]) assert.equal(await client.resolveAgent(ref, "run-test"), maple);
	assert.equal(await client.resolveAgent("egg", "run-test"), egg);
	await assert.rejects(client.resolveAgent("river", "run-test"), /Ambiguous.*more ID words/);
	for (const ref of ["map", "ple", "maple river", "river cloud", "agent", "", "*", "maple/", "[maple]"]) {
		await assert.rejects(client.resolveAgent(ref, "run-test"), /No agent/);
	}
});

test("full IDs bypass team lookups; short references require and remain scoped to attached team", async () => {
	const { client, calls } = fixture();
	for (const id of ["agent-0123456789abcdef", "agent-river-maple-orbit-silver-garden-cloud", "controller"]) {
		assert.equal(await client.resolveAgent(id), id);
		assert.equal(await client.resolveAgent(id, "run-test"), id);
	}
	assert.equal(calls(), 0);
	await assert.rejects(client.resolveAgent("maple"), /attached team/);
	await assert.rejects(client.resolveAgent("maple", "run-test"), /No agent/);
});

test("exact names retain priority and active-replacement semantics; ambiguous ID aliases never silently retarget", async () => {
	const { client, root, node } = fixture();
	root.children.push(node("agent-river-maple-orbit-silver-garden-cloud", "B"));
	assert.equal(await client.resolveAgent("B", "run-test"), "agent-river-maple-orbit-silver-garden-cloud");
	root.children = [node("agent-A-B-C", "Reviewer", "RETIRED"), node("agent-A-D-E", "Reviewer")];
	assert.equal(await client.resolveAgent("Reviewer", "run-test"), "agent-A-D-E");
	await assert.rejects(client.resolveAgent("A", "run-test"), /Ambiguous.*agent-A-B-C.*agent-A-D-E/);
	assert.equal(await client.resolveAgent("B", "run-test"), "agent-A-B-C");
});

test("word matching cannot cross word boundaries or accidentally match legacy hex IDs", () => {
	assert.equal(matchesAgentWords("agent-river-maple-orbit", "maple"), true);
	assert.equal(matchesAgentWords("agent-river-agent-cloud", "agent"), true, "the literal vocabulary word agent is not swallowed as a bare type prefix");
	assert.equal(matchesAgentWords("agent-river-agent-cloud", "agent agent"), true);
	assert.equal(matchesAgentWords("agent-river-maple-orbit", "river maple"), true);
	assert.equal(matchesAgentWords("agent-river-maple-orbit", "vermap"), false);
	assert.equal(matchesAgentWords("agent-abcdefabcdefabcd", "abcdef"), false);
});
