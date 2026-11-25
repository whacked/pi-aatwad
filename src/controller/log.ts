// Structured JSON-lines logger. Never logs secrets: keys that look like secrets are redacted.
import { appendFileSync, renameSync, statSync } from "node:fs";

export type Level = "debug" | "info" | "warn" | "error";
export interface Logger {
	(level: Level, msg: string, fields?: Record<string, unknown>): void;
}

const SECRET_KEY = /token|secret|authorization|password|api[_-]?key/i;

function redact(v: unknown, depth = 0): unknown {
	if (depth > 4 || v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
	const out: Record<string, unknown> = {};
	for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(x, depth + 1);
	return out;
}

/** Past this size the log moves to `<path>.1` (replacing the previous one) and starts again. */
export const LOG_MAX_BYTES = 20 * 1024 * 1024;

export function createLogger(path: string | null, base: Record<string, unknown> = {}, maxBytes = LOG_MAX_BYTES): Logger {
	let size: number | undefined;
	return (level, msg, fields) => {
		const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...(redact(fields ?? {}) as object) });
		if (!path) return;
		try {
			if (size === undefined) { try { size = statSync(path).size; } catch { size = 0; } }
			if (size > maxBytes) {
				renameSync(path, `${path}.1`);
				size = 0;
			}
			appendFileSync(path, line + "\n", { mode: 0o600 });
			size += Buffer.byteLength(line) + 1;
		} catch {
			/* logging must never crash the controller */
		}
	};
}
