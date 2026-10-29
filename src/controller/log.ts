// Structured JSON-lines logger. Never logs secrets: keys that look like secrets are redacted.
import { appendFileSync } from "node:fs";

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

export function createLogger(path: string | null, base: Record<string, unknown> = {}): Logger {
	return (level, msg, fields) => {
		const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...base, ...(redact(fields ?? {}) as object) });
		if (!path) return;
		try {
			appendFileSync(path, line + "\n", { mode: 0o600 });
		} catch {
			/* logging must never crash the controller */
		}
	};
}
