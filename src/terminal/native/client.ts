// Client for ptyd: request/reply over the per-user socket, starting the daemon on demand.
import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdirSync, openSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { packageRoot } from "../../shared/paths.ts";
import { nodeArgsFor, resolveNode } from "../../shared/client.ts";
import { FRAME_JSON, FrameReader, jsonFrame, ptydLog, ptydSocket, type PtyInfo, type Request } from "./protocol.ts";

const require = createRequire(import.meta.url);

/** Whether this platform has a prebuilt PTY binary; checked without loading it. */
export function nativeHostSupport(): string | undefined {
	if (process.platform === "win32") return "the built-in session host does not support Windows yet";
	try { require.resolve(`@lydell/node-pty-${process.platform}-${process.arch}/package.json`); return undefined; }
	catch { return `no prebuilt terminal support for ${process.platform}-${process.arch}; reinstall pi-recursive-team with optional dependencies enabled`; }
}

export class PtydClient {
	readonly socketPath: string;
	readonly stateDir: string;
	constructor(stateDir: string) { this.stateDir = stateDir; this.socketPath = ptydSocket(stateDir); }

	private open(timeoutMs = 2000): Promise<Socket> {
		return new Promise((resolve, reject) => {
			const socket = connect(this.socketPath);
			const timer = setTimeout(() => { socket.destroy(); reject(new Error("ptyd connection timed out")); }, timeoutMs);
			socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
			socket.once("error", (e) => { clearTimeout(timer); reject(e); });
		});
	}

	async running(): Promise<boolean> {
		try { const s = await this.open(1000); s.destroy(); return true; } catch { return false; }
	}

	/** Start the daemon if needed and wait until it answers. */
	async ensure(timeoutMs = 8000): Promise<void> {
		if (await this.running()) return;
		const unsupported = nativeHostSupport();
		if (unsupported) throw new Error(unsupported);
		mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
		const log = openSync(ptydLog(this.stateDir), "a", 0o600);
		try {
			const child = spawn(resolveNode(), nodeArgsFor(join(packageRoot(), "src/terminal/native/daemon.ts")).concat(this.stateDir), { detached: true, stdio: ["ignore", log, log], env: process.env });
			child.unref();
		} finally { closeSync(log); }
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			if (await this.running()) return;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(`the built-in session host did not start; see ${ptydLog(this.stateDir)}`);
	}

	async request<T>(req: Request, timeoutMs = 5000): Promise<T> {
		const socket = await this.open();
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => { socket.destroy(); reject(new Error(`ptyd ${req.op} timed out`)); }, timeoutMs);
			const reader = new FrameReader((type, payload) => {
				if (type !== FRAME_JSON) return;
				const reply = JSON.parse(payload.toString("utf8")) as { ok: boolean; result?: T; error?: string };
				clearTimeout(timer); socket.end();
				if (reply.ok) resolve(reply.result as T); else reject(new Error(`ptyd: ${reply.error}`));
			});
			socket.on("data", (chunk: Buffer) => reader.push(chunk));
			socket.once("error", (e) => { clearTimeout(timer); reject(e); });
			socket.write(jsonFrame({ id: 1, ...req }));
		});
	}

	list(owner?: string): Promise<PtyInfo[]> { return this.request<{ ptys: PtyInfo[] }>({ op: "list", ...(owner ? { owner } : {}) }).then((r) => r.ptys); }
	info(handle: string): Promise<PtyInfo> { return this.request<PtyInfo>({ op: "info", handle }); }

	/** Open an attach stream; resolves once the daemon accepted it. The socket then carries frames. */
	async attach(handle: string, cols: number, rows: number): Promise<{ socket: Socket; info: PtyInfo }> {
		const socket = await this.open();
		return new Promise((resolve, reject) => {
			let settled = false;
			const reader = new FrameReader((type, payload) => {
				if (settled || type !== FRAME_JSON) return;
				const reply = JSON.parse(payload.toString("utf8")) as { ok: boolean; result?: PtyInfo; error?: string };
				settled = true;
				socket.removeAllListeners("data");
				// Frames that arrived with the reply belong to the attached stream.
				const rest = reader.take();
				if (!reply.ok) { socket.destroy(); reject(new Error(reply.error)); return; }
				socket.pause();
				resolve({ socket, info: reply.result! });
				if (rest.length) socket.unshift(rest);
			});
			socket.on("data", (chunk: Buffer) => reader.push(chunk));
			socket.once("error", (e) => { if (!settled) { settled = true; reject(e); } });
			socket.write(jsonFrame({ id: 1, op: "attach", handle, cols, rows }));
		});
	}
}
