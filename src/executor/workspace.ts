// Worker workspaces: <workspace_root>/.team-worktrees/<run_id>/<agent_id>
// * workspace_root inside a git repo with at least one commit -> detached `git worktree add`
//   (each worker gets its own checkout; never two write-capable workers in one checkout).
// * otherwise -> plain isolated directory.
// Idempotent: an existing worktree / directory is reused (agent restart keeps its files).
// Every returned path is verified (realpath) to be inside workspace_root: no "..",
// absolute-segment or symlink escapes.

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKTREES_DIR = ".team-worktrees";

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSegment(name: string, value: string): void {
	if (!SAFE_SEGMENT.test(value) || value.includes("..")) {
		throw new Error(`unsafe ${name} for workspace path: ${JSON.stringify(value)}`);
	}
}

/** realpath of p, or of its deepest existing ancestor joined with the non-existing remainder. */
function realpathLoose(p: string): string {
	const abs = resolve(p);
	const rest: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			const real = realpathSync(cur);
			return rest.length ? join(real, ...rest.reverse()) : real;
		} catch {
			const parent = dirname(cur);
			if (parent === cur) return abs;
			rest.push(basename(cur));
			cur = parent;
		}
	}
}

/**
 * Throws unless `path` resolves (following symlinks) to `root` or a descendant of it.
 * Returns the canonical path.
 */
export function assertInside(root: string, path: string): string {
	const realRoot = realpathSync(resolve(root));
	const target = isAbsolute(path) ? path : join(realRoot, path);
	const realTarget = realpathLoose(target);
	const rel = relative(realRoot, realTarget);
	if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return realTarget;
	throw new Error(`path escapes workspace root: ${path} -> ${realTarget} (root ${realRoot})`);
}

/** The (unvalidated) worktree path for an agent. */
export function worktreePath(workspace_root: string, run_id: string, agent_id: string): string {
	assertSegment("run_id", run_id);
	assertSegment("agent_id", agent_id);
	return join(resolve(workspace_root), WORKTREES_DIR, run_id, agent_id);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	})
		.toString()
		.trim();
}

function tryGit(cwd: string, args: string[]): string | null {
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
}

/** Keep .team-worktrees/ out of the parent checkout's `git status` (local-only exclude). */
function ensureExcluded(repoTop: string): void {
	const gitDir = tryGit(repoTop, ["rev-parse", "--git-common-dir"]);
	if (!gitDir) return;
	const exclude = join(resolve(repoTop, gitDir), "info", "exclude");
	try {
		const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		if (!cur.split(/\r?\n/).includes(`/${WORKTREES_DIR}/`)) {
			mkdirSync(dirname(exclude), { recursive: true });
			appendFileSync(exclude, `${cur && !cur.endsWith("\n") ? "\n" : ""}/${WORKTREES_DIR}/\n`);
		}
	} catch {
		/* best effort */
	}
}

/**
 * Create (or reuse) the isolated workspace of one agent and return its canonical path.
 * Note: the exclude entry is anchored at the repo top-level; when workspace_root is a
 * subdirectory of the repo the worktree dir may show up as untracked in the parent checkout.
 */
export function prepareWorkspace(workspace_root: string, run_id: string, agent_id: string): string {
	const root = realpathSync(resolve(workspace_root));
	const target = worktreePath(root, run_id, agent_id);
	// Validate before creating anything (catches a pre-planted .team-worktrees symlink).
	assertInside(root, target);

	const repoTop = tryGit(root, ["rev-parse", "--show-toplevel"]);
	const hasCommit = repoTop !== null && tryGit(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]) !== null;

	if (existsSync(target)) {
		const real = assertInside(root, target);
		if (!hasCommit) return real;
		// Reuse only if it is already a working tree rooted exactly at target.
		const top = tryGit(real, ["rev-parse", "--show-toplevel"]);
		if (top !== null && realpathSync(top) === real) return real;
		throw new Error(`workspace exists but is not a git worktree: ${real}`);
	}

	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	assertInside(root, dirname(target));
	if (hasCommit && repoTop) {
		ensureExcluded(repoTop);
		git(root, ["worktree", "add", "--detach", target, "HEAD"]);
	} else {
		mkdirSync(target, { recursive: true, mode: 0o700 });
	}
	return assertInside(root, target);
}
