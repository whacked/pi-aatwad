// Wire protocol of the built-in session host (ptyd) over its per-user unix socket.
// Frames: 1 byte type, 4 byte big-endian length, payload. JSON frames carry requests,
// replies and events; data frames carry raw terminal bytes in either direction.
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the process entry point, including through an npm bin symlink. */
export function isEntryPoint(moduleUrl: string): boolean {
	try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
}

export const PTYD_PROTOCOL = 1;
export const FRAME_JSON = 1;
export const FRAME_DATA = 2;
/** Private OSC a member writes to ask attached clients to return to the leader. */
export const DETACH_SEQUENCE = "\x1b]7726;pi-team;detach\x07";
/** Environment markers ptyd gives each member terminal. */
export const ENV_PTYD_SOCKET = "PI_TEAM_PTYD";
export const ENV_PTY_HANDLE = "PI_TEAM_PTY";

export function ptydSocket(stateDir: string): string { return join(stateDir, "ptyd.sock"); }
export function ptydLock(stateDir: string): string { return join(stateDir, "ptyd.lock"); }
export function ptydLog(stateDir: string): string { return join(stateDir, "ptyd.log"); }

export interface PtyInfo {
	handle: string;
	owner: string;
	agent: string;
	label: string;
	pid: number;
	alive: boolean;
	exit_code?: number | null;
	cols: number;
	rows: number;
	attached: number;
}

export type Request =
	| { op: "hello" }
	| { op: "spawn"; owner: string; agent: string; label: string; command: string[]; cwd: string; cols?: number; rows?: number }
	| { op: "list"; owner?: string }
	| { op: "info"; handle: string }
	| { op: "tag"; handle: string; owner?: string; agent?: string; label?: string }
	| { op: "kill"; handle: string }
	| { op: "attach"; handle: string; cols: number; rows: number }
	| { op: "resize"; cols: number; rows: number }
	| { op: "shutdown" };

export function encodeFrame(type: number, payload: Buffer | string): Buffer {
	const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
	const head = Buffer.alloc(5);
	head.writeUInt8(type, 0);
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}
export function jsonFrame(value: unknown): Buffer { return encodeFrame(FRAME_JSON, JSON.stringify(value)); }

/** Incremental frame decoder for a stream socket. */
export class FrameReader {
	private buffer: Buffer = Buffer.alloc(0);
	private stopped = false;
	private readonly onFrame: (type: number, payload: Buffer) => void;
	constructor(onFrame: (type: number, payload: Buffer) => void) { this.onFrame = onFrame; }
	/** Stop decoding and return the undecoded bytes, for handing the stream to another reader. */
	take(): Buffer { this.stopped = true; const rest = this.buffer; this.buffer = Buffer.alloc(0); return rest; }
	push(chunk: Buffer): void {
		if (this.stopped) return;
		this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
		while (!this.stopped && this.buffer.length >= 5) {
			const length = this.buffer.readUInt32BE(1);
			if (length > 64 * 1024 * 1024) throw new Error("ptyd frame too large");
			if (this.buffer.length < 5 + length) return;
			const type = this.buffer.readUInt8(0);
			const payload = this.buffer.subarray(5, 5 + length);
			this.buffer = this.buffer.subarray(5 + length);
			this.onFrame(type, payload);
		}
	}
}
