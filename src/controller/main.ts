#!/usr/bin/env node
// Controller process entry: `node src/controller/main.ts`. Thin wrapper around startController().
// Exit codes: 0 = stopped normally OR another healthy controller already owns the state dir; 1 = failed.
import { statePaths } from "../shared/paths.ts";
import type { Executor } from "../executor/types.ts";
import { ControllerAlreadyRunning, probeHealth, startController } from "./bootstrap.ts";

async function loadExecutor(): Promise<Executor> {
	try {
		const mod = (await import("../executor/index.ts")) as { createExecutor: () => Executor };
		return mod.createExecutor();
	} catch (e) {
		// Keep the control plane usable (inspection, governance) even if the executor module is broken;
		// launches will fail and be retried/recorded as FAILED.
		const msg = `executor unavailable: ${String((e as Error)?.message ?? e)}`;
		process.stderr.write(msg + "\n");
		return {
			launch: async () => {
				throw new Error(msg);
			},
			probe: async () => "dead",
			stop: async () => {},
		};
	}
}

async function main(): Promise<void> {
	const executor = await loadExecutor();
	try {
		const h = await startController({
			executor,
			onClosed: (reason) => {
				process.exitCode = 0;
				// Give stdio a moment, then exit even if stray handles remain.
				setTimeout(() => process.exit(0), 50).unref();
				void reason;
			},
		});
		const stop = (sig: string) => void h.close({ reason: sig });
		process.on("SIGTERM", () => stop("SIGTERM"));
		process.on("SIGINT", () => stop("SIGINT"));
	} catch (e) {
		if (e instanceof ControllerAlreadyRunning) {
			const socket = statePaths().socket;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				if (await probeHealth(socket)) process.exit(0);
				await new Promise((r) => setTimeout(r, 100));
			}
			process.stderr.write("another controller holds the lock but is not answering /health\n");
			process.exit(1);
		}
		process.stderr.write(`controller failed to start: ${String((e as Error)?.stack ?? e)}\n`);
		process.exit(1);
	}
}

void main();
