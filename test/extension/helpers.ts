// Test helpers: short unix-socket dirs (macOS sun_path limit is 104 bytes) and a scriptable mock controller.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statePaths, ensureStateDir } from "../../src/shared/paths.ts";
import type { StatePaths } from "../../src/shared/paths.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../src/shared/protocol.ts";
import type { HealthResponse } from "../../src/shared/protocol.ts";

export function shortTmp(prefix = "prt-"): string {
	const base = process.platform === "darwin" ? "/tmp" : tmpdir();
	return mkdtempSync(join(base, prefix));
}

export function makeState(): { paths: StatePaths; cleanup: () => void } {
	const dir = shortTmp();
	const paths = ensureStateDir(statePaths(dir));
	return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface Recorded {
	method: string;
	path: string;
	headers: IncomingMessage["headers"];
	body: any;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | { status?: number; body: unknown } | undefined;

export function health(over: Partial<HealthResponse> = {}): HealthResponse {
	return {
		ok: true,
		protocol: PROTOCOL_VERSION,
		schema: SCHEMA_VERSION,
		controller_id: "mock",
		fencing_epoch: 1,
		pid: process.pid,
		started_at: new Date().toISOString(),
		state_dir: "/mock",
		live_workers: 0,
		...over,
	};
}

export interface Mock {
	server: Server;
	requests: Recorded[];
	route: (method: string, path: string | RegExp, h: Handler) => void;
	close: () => Promise<void>;
}

/** Mock controller on paths.socket. Unrouted requests -> 404 NOT_FOUND ApiError. GET /health is pre-routed. */
export async function startMock(paths: StatePaths, opts: { operatorToken?: string } = {}): Promise<Mock> {
	const routes: { method: string; path: string | RegExp; h: Handler }[] = [];
	const requests: Recorded[] = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			const rec: Recorded = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
			requests.push(rec);
			const pathOnly = rec.path.split("?")[0];
			const r = [...routes].reverse().find((x) => x.method === rec.method && (typeof x.path === "string" ? x.path === pathOnly : x.path.test(pathOnly)));
			if (!r) {
				res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: `no route ${rec.method} ${pathOnly}` } }));
				return;
			}
			const out = r.h(rec, res);
			if (out && !res.headersSent) {
				res.writeHead(out.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(out.body));
			}
		});
	});
	const route = (method: string, path: string | RegExp, h: Handler) => routes.push({ method, path, h });
	route("GET", "/health", () => ({ body: health() }));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(paths.socket, () => resolve());
	});
	if (opts.operatorToken) {
		writeFileSync(paths.operatorToken, opts.operatorToken);
		chmodSync(paths.operatorToken, 0o600);
	}
	return {
		server,
		requests,
		route,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 3_000, what = "condition"): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
		await sleep(10);
	}
}
