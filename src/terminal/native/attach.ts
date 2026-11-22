#!/usr/bin/env node
// Attach this terminal to a member hosted by ptyd, like `tmux attach`.
// Leaves when the member asks (/team back), when it exits, or on an opt-in detach key.
// Usage: attach.ts [--state-dir DIR] [--detach-key ctrl-X] [name|agent_id|pty:handle]
// Exit codes: 0 detached by request, 3 member exited or was closed, 1 error, 2 usage.
import type { Socket } from "node:net";
import { stateDir as defaultStateDir } from "../../shared/paths.ts";
import { PtydClient } from "./client.ts";
import { FRAME_DATA, FRAME_JSON, FrameReader, encodeFrame, isEntryPoint, jsonFrame, type PtyInfo } from "./protocol.ts";

// Undo terminal modes a member may have enabled inside the alternate screen.
const RESTORE = "\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[>4;0m\x1b[?25h\x1b[0m\x1b[?1049l";

/** "ctrl-]" or "ctrl-q" style keys; returns the control byte. */
export function parseDetachKey(spec: string | undefined): string | undefined {
	if (!spec) return undefined;
	const m = /^ctrl-(.)$/i.exec(spec.trim());
	if (!m) throw new Error(`unsupported detach key ${spec}; use ctrl-<key>, for example ctrl-]`);
	const code = m[1].toUpperCase().charCodeAt(0) - 64;
	if (code < 0 || code > 31) throw new Error(`unsupported detach key ${spec}`);
	return String.fromCharCode(code);
}

export function pickMember(ptys: PtyInfo[], target: string | undefined): PtyInfo | string {
	const live = ptys.filter((p) => p.alive);
	if (!target) return live.length === 1 ? live[0] : `choose a member: ${live.map((p) => p.label || p.agent).join(", ") || "none running"}`;
	const t = target.toLowerCase();
	const exact = live.filter((p) => p.handle === target || p.agent === target || p.label.toLowerCase() === t || p.label.toLowerCase().startsWith(`${t} [`));
	if (exact.length === 1) return exact[0];
	const partial = live.filter((p) => p.agent.includes(t) || p.label.toLowerCase().includes(t));
	if (partial.length === 1) return partial[0];
	return `${partial.length ? "ambiguous" : "no running member matches"} "${target}"${partial.length ? `: ${partial.map((p) => p.label || p.agent).join(", ")}` : ""}`;
}

export async function attachTerminal(client: PtydClient, handle: string, options: { detachKey?: string } = {}): Promise<"member" | "key" | "exited" | "closed"> {
	const stdin = process.stdin, stdout = process.stdout;
	if (!stdin.isTTY || !stdout.isTTY) throw new Error("attaching needs an interactive terminal");
	const { socket } = await client.attach(handle, stdout.columns || 80, stdout.rows || 24);
	return new Promise((resolve) => {
		let done = false;
		const finish = (reason: "member" | "key" | "exited" | "closed") => {
			if (done) return;
			done = true;
			stdin.off("data", onInput);
			stdout.off("resize", onResize);
			try { stdin.setRawMode(false); } catch {}
			stdin.pause();
			stdout.write(RESTORE);
			socket.destroy();
			resolve(reason);
		};
		const onInput = (data: Buffer) => {
			const text = data.toString("utf8");
			if (options.detachKey && text.includes(options.detachKey)) { finish("key"); return; }
			socket.write(encodeFrame(FRAME_DATA, data));
		};
		const onResize = () => socket.write(jsonFrame({ op: "resize", cols: stdout.columns, rows: stdout.rows }));
		const reader = new FrameReader((type, payload) => {
			if (type === FRAME_DATA) { stdout.write(payload); return; }
			if (type !== FRAME_JSON) return;
			const event = JSON.parse(payload.toString("utf8")) as { event?: string; reason?: string };
			if (event.event === "detach") finish(event.reason === "member" ? "member" : event.reason === "exited" ? "exited" : "closed");
		});
		stdout.write("\x1b[?1049h");
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onInput);
		stdout.on("resize", onResize);
		(socket as Socket).on("data", (chunk: Buffer) => reader.push(chunk));
		socket.on("close", () => finish("closed"));
		socket.resume();
	});
}

async function main(argv: string[]): Promise<number> {
	let stateDir = defaultStateDir(), detachKey: string | undefined, target: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--state-dir") stateDir = argv[++i];
		else if (argv[i] === "--detach-key") detachKey = argv[++i];
		else if (argv[i] === "-h" || argv[i] === "--help") { process.stdout.write("usage: pi-team-attach [--state-dir DIR] [--detach-key ctrl-X] [name|agent_id]\nType /team back in the member to return.\n"); return 0; }
		else target = argv[i];
	}
	const client = new PtydClient(stateDir);
	if (!await client.running()) { process.stderr.write("No team members are hosted in this terminal environment.\n"); return 1; }
	const picked = target?.startsWith("pty:") ? await client.info(target) : pickMember(await client.list(), target);
	if (typeof picked === "string") { process.stderr.write(`${picked}\n`); return 2; }
	const reason = await attachTerminal(client, picked.handle, { detachKey: parseDetachKey(detachKey ?? process.env.PI_TEAM_DETACH_KEY) });
	if (reason === "exited" || reason === "closed") { process.stderr.write(`${picked.label || picked.agent}: member terminal ${reason}.\n`); return 3; }
	return 0;
}

if (isEntryPoint(import.meta.url)) {
	main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { process.stderr.write(`pi-team-attach: ${(e as Error).message}\n`); process.exit(1); });
}
