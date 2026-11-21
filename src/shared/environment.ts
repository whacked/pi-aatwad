import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** Resolve before changing cwd to a member worktree; never rely on the host GUI's shell aliases. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const paths = command.includes("/") ? [resolve(command)] : (env.PATH ?? "/usr/bin:/bin").split(delimiter).map((p) => resolve(p, command));
	return paths.find((p) => {
		try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
	});
}

export type TerminalHostKind = "herdr" | "tmux" | "rex" | "plain";

/**
 * Which terminal multiplexer hosts this process, innermost first: tmux running inside Rex
 * is tmux. Terminal hosting is independent of whether Pi has a TTY (SSH and GUI terminals
 * do too). Markers are only claims; callers that act on a pane verify that it contains them.
 */
export function terminalHost(env: NodeJS.ProcessEnv = process.env): TerminalHostKind {
	if (env.HERDR_ENV === "1") return "herdr";
	if (env.TMUX && /^%\d+$/.test(env.TMUX_PANE ?? "")) return "tmux";
	if (env.REX_SERVER && /^block:[0-9a-f-]+$/i.test(env.REX_BLOCK ?? "")) return "rex";
	return "plain";
}

export function currentTmuxPane(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return terminalHost(env) === "tmux" ? env.TMUX_PANE : undefined;
}

export function currentRexBlock(env: NodeJS.ProcessEnv = process.env): { server: string; block: string; session?: string } | undefined {
	return terminalHost(env) === "rex" ? { server: env.REX_SERVER!, block: env.REX_BLOCK!, ...(env.REX_SESSION ? { session: env.REX_SESSION } : {}) } : undefined;
}
