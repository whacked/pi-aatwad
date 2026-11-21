// Switch the leader's own terminal into a member hosted by the built-in session host,
// the way Pi hands its terminal to an external editor: stop the TUI, run the attach
// client with inherited stdio, then restart and fully redraw when it returns.
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { nodeArgsFor, resolveNode } from "../shared/client.ts";
import { packageRoot } from "../shared/paths.ts";
import type { NativeView } from "../terminal/native.ts";

export function attachCommand(stateDir: string, target: string): string[] {
	return [resolveNode(), ...nodeArgsFor(join(packageRoot(), "src/terminal/native/attach.ts")), "--state-dir", stateDir, target];
}

/** Resolves when the human is back in the leader; the text says why. */
export async function attachMember(ctx: ExtensionContext, view: NativeView, agent: string): Promise<string> {
	const member = await view.member(agent);
	if (!member) throw new Error(`No running terminal for ${agent} yet; wait for it to start or check /team tree`);
	if (member.dead) throw new Error(`${agent}'s terminal has exited; the controller restarts it if it should be running`);
	const [command, ...args] = attachCommand(view.opts.stateDir, member.id);
	if (ctx.mode !== "tui") return `Attach from a terminal: ${[command, ...args].join(" ")}`;
	const code = await ctx.ui.custom<number>((tui, _theme, _keys, done) => {
		let finished = false;
		const finish = (exit: number) => {
			if (finished) return;
			finished = true;
			tui.start();
			tui.requestRender(true);
			done(exit);
		};
		// Let this placeholder mount first; a stopped TUI renders nothing until restarted.
		setTimeout(() => {
			tui.stop();
			const child = spawn(command, args, { stdio: "inherit", env: process.env });
			child.on("error", () => finish(1));
			child.on("close", (exit) => finish(exit ?? 1));
		}, 0);
		return { render: () => [], invalidate: () => {} };
	});
	return code === 0 ? `Back in the leader from ${agent}.` : code === 3 ? `${agent}'s terminal exited; back in the leader.` : `Could not attach to ${agent} (exit ${code}).`;
}
