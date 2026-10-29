import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertInside, prepareWorkspace, worktreePath } from "../../src/executor/workspace.ts";
import { tmp } from "./helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function repo(): string {
	const d = tmp("pt-ws-");
	git(d, "init", "-q");
	git(d, "config", "user.email", "t@example.com");
	git(d, "config", "user.name", "t");
	writeFileSync(join(d, "README.md"), "hello\n");
	git(d, "add", ".");
	git(d, "commit", "-q", "-m", "init");
	return d;
}

test("two agents get isolated git worktrees; idempotent", () => {
	const root = repo();
	const a = prepareWorkspace(root, "run1", "agentA");
	const b = prepareWorkspace(root, "run1", "agentB");
	assert.equal(a, join(root, ".team-worktrees", "run1", "agentA"));
	assert.notEqual(a, b);
	assert.equal(git(a, "rev-parse", "--show-toplevel"), a);
	assert.equal(git(b, "rev-parse", "--show-toplevel"), b);
	writeFileSync(join(a, "only-in-a.txt"), "x");
	assert.ok(!existsSync(join(b, "only-in-a.txt")));
	assert.ok(!existsSync(join(root, "only-in-a.txt")));
	assert.equal(readFileSync(join(b, "README.md"), "utf8"), "hello\n");
	// parent checkout stays clean (.team-worktrees excluded)
	assert.equal(git(root, "status", "--porcelain"), "");
	// idempotent: reuse keeps files
	assert.equal(prepareWorkspace(root, "run1", "agentA"), a);
	assert.ok(existsSync(join(a, "only-in-a.txt")));
	assert.match(git(root, "worktree", "list"), /agentA[\s\S]*agentB/);
});

test("non-git root gets plain isolated dirs", () => {
	const root = tmp("pt-ws-");
	const a = prepareWorkspace(root, "r", "a");
	const b = prepareWorkspace(root, "r", "b");
	assert.ok(existsSync(a) && existsSync(b) && a !== b);
	assert.equal(prepareWorkspace(root, "r", "a"), a);
});

test("traversal / unsafe ids rejected", () => {
	const root = tmp("pt-ws-");
	for (const bad of ["..", "../x", "a/b", "/etc", "", ".hidden", "a\0b", "x/../../y"]) {
		assert.throws(() => worktreePath(root, "run", bad), /unsafe agent_id/, bad);
		assert.throws(() => prepareWorkspace(root, bad, "a"), /unsafe run_id/, bad);
	}
});

test("assertInside rejects .. and symlink escapes", () => {
	const root = tmp("pt-ws-");
	const outside = tmp("pt-out-");
	mkdirSync(join(root, "sub"));
	assert.equal(assertInside(root, join(root, "sub")), join(root, "sub"));
	assert.equal(assertInside(root, "sub/new/file"), join(root, "sub", "new", "file"));
	assert.equal(assertInside(root, root), root);
	assert.throws(() => assertInside(root, join(root, "..", "x")), /escapes/);
	assert.throws(() => assertInside(root, outside), /escapes/);
	assert.throws(() => assertInside(root, "../../etc/passwd"), /escapes/);
	symlinkSync(outside, join(root, "link"));
	assert.throws(() => assertInside(root, join(root, "link")), /escapes/);
	assert.throws(() => assertInside(root, join(root, "link", "deeper", "x")), /escapes/);
	// sibling with common prefix is not "inside"
	assert.throws(() => assertInside(root, `${root}-evil`), /escapes/);
});

test("prepareWorkspace refuses a planted .team-worktrees symlink", () => {
	const root = tmp("pt-ws-");
	const outside = tmp("pt-out-");
	symlinkSync(outside, join(root, ".team-worktrees"));
	assert.throws(() => prepareWorkspace(root, "r", "a"), /escapes/);
	assert.ok(!existsSync(join(outside, "r")));
});
