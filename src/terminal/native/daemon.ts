#!/usr/bin/env node
// ptyd: the built-in session host for terminals without a multiplexer. One per controller
// state directory. It owns member PTYs so they outlive the leader Pi and the controller,
// keeps a headless screen per member for re-attach, and relays bytes to attached clients.
// Usage: node daemon.ts <stateDir>
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { IPty } from "@lydell/node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize";
import { isEntryPoint, DETACH_SEQUENCE, ENV_PTY_HANDLE, ENV_PTYD_SOCKET, FRAME_DATA, FRAME_JSON, FrameReader, PTYD_PROTOCOL, encodeFrame, jsonFrame, ptydLock, ptydSocket, type PtyInfo, type Request } from "./protocol.ts";

const require = createRequire(import.meta.url);
const IDLE_EXIT_MS = Number(process.env.PI_TEAM_PTYD_IDLE_MS ?? 60_000);
const SCROLLBACK = 5_000;
const PASS_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"];

interface Entry extends PtyInfo {
	proc: IPty;
	term: HeadlessTerminal;
	serializer: Serializer;
	clients: Set<Socket>;
	carry: string;
}

function log(message: string): void { process.stderr.write(`${new Date().toISOString()} ptyd[${process.pid}] ${message}\n`); }

function acquireLock(path: string): boolean {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(path, "wx", 0o600);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			const pid = Number(readFileSync(path, "utf8").trim());
			try { if (pid > 0) { process.kill(pid, 0); return false; } } catch {}
			try { unlinkSync(path); } catch {}
		}
	}
	return false;
}

export async function runDaemon(stateDir: string): Promise<Server | undefined> {
	const lock = ptydLock(stateDir), socketPath = ptydSocket(stateDir);
	if (!acquireLock(lock)) { log("another ptyd owns this state directory"); return undefined; }
	const pty = require("@lydell/node-pty") as typeof import("@lydell/node-pty");
	const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
	const { SerializeAddon } = require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");
	const entries = new Map<string, Entry>();
	const connections = new Set<Socket>();
	let lastActive = Date.now();

	const info = (e: Entry): PtyInfo => ({ handle: e.handle, owner: e.owner, agent: e.agent, label: e.label, pid: e.pid, alive: e.alive, exit_code: e.exit_code, cols: e.cols, rows: e.rows, attached: e.clients.size });
	const send = (socket: Socket, value: unknown) => { if (!socket.destroyed) socket.write(jsonFrame(value)); };
	const detachAll = (e: Entry, reason: string) => { for (const c of e.clients) { send(c, { event: "detach", reason }); c.end(); } e.clients.clear(); };
	const resize = (e: Entry, cols: number, rows: number) => {
		cols = Math.max(2, Math.min(1000, Math.floor(cols))); rows = Math.max(2, Math.min(500, Math.floor(rows)));
		if (cols === e.cols && rows === e.rows) return;
		e.cols = cols; e.rows = rows;
		e.term.resize(cols, rows);
		if (e.alive) { try { e.proc.resize(cols, rows); } catch {} }
	};
	const remove = (e: Entry) => {
		detachAll(e, "closed");
		if (e.alive) { try { e.proc.kill("SIGHUP"); } catch {} }
		e.term.dispose();
		entries.delete(e.handle);
		lastActive = Date.now();
	};

	function spawn(r: Extract<Request, { op: "spawn" }>): PtyInfo {
		if (!Array.isArray(r.command) || !r.command.length || r.command.some((a) => typeof a !== "string")) throw new Error("command must be a non-empty string array");
		const handle = `pty:${randomBytes(8).toString("hex")}`;
		const cols = r.cols ?? 120, rows = r.rows ?? 40;
		const env: Record<string, string> = { TERM: "xterm-256color", [ENV_PTYD_SOCKET]: socketPath, [ENV_PTY_HANDLE]: handle };
		for (const key of PASS_ENV) if (process.env[key]) env[key] = process.env[key]!;
		const proc = pty.spawn(r.command[0], r.command.slice(1), { name: "xterm-256color", cols, rows, cwd: r.cwd, env });
		const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
		const serializer = new SerializeAddon();
		term.loadAddon(serializer);
		const e: Entry = { handle, owner: r.owner, agent: r.agent, label: r.label, pid: proc.pid, alive: true, exit_code: null, cols, rows, attached: 0, proc, term, serializer, clients: new Set(), carry: "" };
		proc.onData((data) => {
			term.write(data);
			const scan = e.carry + data;
			e.carry = scan.slice(-DETACH_SEQUENCE.length);
			for (const c of e.clients) if (!c.destroyed) c.write(encodeFrame(FRAME_DATA, data));
			if (scan.includes(DETACH_SEQUENCE)) { e.carry = ""; detachAll(e, "member"); }
		});
		proc.onExit(({ exitCode }) => {
			e.alive = false; e.exit_code = exitCode;
			log(`${handle} (${e.agent}) exited with ${exitCode}`);
			detachAll(e, "exited");
		});
		entries.set(handle, e);
		lastActive = Date.now();
		log(`${handle} spawned for ${r.agent} (pid ${proc.pid})`);
		return info(e);
	}

	function handle(socket: Socket, req: Request & { id?: number }): unknown {
		const need = (h: string) => { const e = entries.get(h); if (!e) throw new Error(`not found: ${h}`); return e; };
		switch (req.op) {
			case "hello": return { protocol: PTYD_PROTOCOL, pid: process.pid };
			case "spawn": return spawn(req);
			case "list": return { ptys: [...entries.values()].filter((e) => !req.owner || e.owner === req.owner).map(info) };
			case "info": return info(need(req.handle));
			case "tag": {
				const e = need(req.handle);
				if (req.owner !== undefined) e.owner = req.owner;
				if (req.agent !== undefined) e.agent = req.agent;
				if (req.label !== undefined) e.label = req.label;
				return info(e);
			}
			case "kill": { const e = entries.get(req.handle); if (e) remove(e); return { removed: !!e }; }
			case "shutdown": setImmediate(() => shutdown("requested")); return { stopping: true };
			default: throw new Error(`unknown op ${(req as { op: string }).op}`);
		}
	}

	function attach(socket: Socket, req: Extract<Request, { op: "attach" }> & { id?: number }): void {
		const e = entries.get(req.handle);
		if (!e) { send(socket, { id: req.id, ok: false, error: `not found: ${req.handle}` }); return; }
		if (!e.alive) { send(socket, { id: req.id, ok: false, error: `member terminal ${req.handle} has exited` }); return; }
		resize(e, req.cols, req.rows);
		e.clients.add(socket);
		send(socket, { id: req.id, ok: true, result: info(e) });
		// Repaint the current screen; live output follows in order on the same socket.
		socket.write(encodeFrame(FRAME_DATA, "\x1b[H\x1b[2J" + e.serializer.serialize({ scrollback: 0 })));
		socket.on("close", () => e.clients.delete(socket));
		const reader = new FrameReader((type, payload) => {
			if (type === FRAME_DATA) { if (e.alive) e.proc.write(payload.toString("utf8")); return; }
			const msg = JSON.parse(payload.toString("utf8")) as Request;
			if (msg.op === "resize") resize(e, msg.cols, msg.rows);
		});
		socket.removeAllListeners("data");
		socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { socket.destroy(); } });
	}

	const server = createServer((socket) => {
		// Short probes and requests do not postpone the idle exit; open connections block it.
		connections.add(socket);
		socket.on("close", () => connections.delete(socket));
		socket.on("error", () => {});
		const reader = new FrameReader((type, payload) => {
			if (type !== FRAME_JSON) return;
			let req: Request & { id?: number };
			try { req = JSON.parse(payload.toString("utf8")); } catch { socket.destroy(); return; }
			if (req.op === "attach") { attach(socket, req); return; }
			try { send(socket, { id: req.id, ok: true, result: handle(socket, req) }); }
			catch (err) { send(socket, { id: req.id, ok: false, error: (err as Error).message }); }
		});
		socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { socket.destroy(); } });
	});

	function shutdown(reason: string): void {
		log(`stopping: ${reason}`);
		for (const e of [...entries.values()]) remove(e);
		for (const c of connections) c.destroy();
		server.close();
		clearInterval(idle);
		try { unlinkSync(socketPath); } catch {}
		try { if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock); } catch {}
	}
	// Exit only when nothing is hosted and nobody is connected; members never die from idling.
	const idle = setInterval(() => {
		if (entries.size === 0 && connections.size === 0 && Date.now() - lastActive > IDLE_EXIT_MS) shutdown("idle");
	}, Math.min(10_000, Math.max(200, IDLE_EXIT_MS / 4)));
	idle.unref?.();

	try { unlinkSync(socketPath); } catch {}
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.off("error", reject); resolve(); }); });
	chmodSync(socketPath, 0o600);
	for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { shutdown(signal); process.exit(0); });
	log(`listening on ${socketPath}`);
	return server;
}

if (isEntryPoint(import.meta.url)) {
	const stateDir = process.argv[2];
	if (!stateDir) { process.stderr.write("usage: daemon.ts <stateDir>\n"); process.exit(2); }
	runDaemon(stateDir).then((server) => { if (!server) process.exit(0); }, (e) => { log(`failed: ${(e as Error).stack ?? e}`); process.exit(1); });
}
