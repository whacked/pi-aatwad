import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

/** Resolve before changing cwd to a member worktree; never rely on the host GUI's shell aliases. */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const paths = command.includes("/") ? [resolve(command)] : (env.PATH ?? "/usr/bin:/bin").split(delimiter).map((p) => resolve(p, command));
	return paths.find((p) => {
		try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
	});
}

