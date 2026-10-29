// Tiny stand-in for src/controller/main.ts used by the ensureController spawn tests.
// Singleton via O_EXCL lock (exits quietly if another instance owns it), slow-ish startup,
// answers GET /health, writes operator.token, exits after FAKE_CONTROLLER_TTL_MS or SIGTERM.
import { createServer } from "node:http";
import { openSync, writeSync, closeSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { statePaths } from "../../../src/shared/paths.ts";
import { PROTOCOL_VERSION, SCHEMA_VERSION } from "../../../src/shared/protocol.ts";

const p = statePaths();
let fd: number;
try {
	fd = openSync(p.lock, "wx", 0o600);
} catch {
	appendFileSync(p.dir + "/fake-starts.log", `lost-lock ${process.pid}\n`);
	process.exit(0);
}
writeSync(fd, JSON.stringify({ pid: process.pid }));
closeSync(fd);
appendFileSync(p.dir + "/fake-starts.log", `owner ${process.pid}\n`);

const startedAt = new Date().toISOString();
const server = createServer((req, res) => {
	if (req.url === "/health") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				ok: true,
				protocol: PROTOCOL_VERSION,
				schema: Number(process.env.FAKE_SCHEMA ?? SCHEMA_VERSION),
				controller_id: "fake",
				fencing_epoch: 1,
				pid: process.pid,
				started_at: startedAt,
				state_dir: p.dir,
				live_workers: 0,
			}),
		);
		return;
	}
	res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "NOT_FOUND", message: "fake" } }));
});

const cleanup = () => {
	try {
		unlinkSync(p.lock);
	} catch {}
	try {
		unlinkSync(p.socket);
	} catch {}
	process.exit(0);
};
process.on("SIGTERM", cleanup);
setTimeout(cleanup, Number(process.env.FAKE_CONTROLLER_TTL_MS ?? 20_000)).unref();

// Simulate startup work so concurrent clients really overlap with the spawn.
setTimeout(() => {
	try {
		unlinkSync(p.socket);
	} catch {}
	server.listen(p.socket, () => {
		writeFileSync(p.operatorToken, "op-token-fake\n", { mode: 0o600 });
	});
}, Number(process.env.FAKE_CONTROLLER_DELAY_MS ?? 300));
