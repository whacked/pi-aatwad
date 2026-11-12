import { test, mock } from "node:test";
import assert from "node:assert/strict";
import extension, { CONTEXT_SECTION } from "../../src/extension/index.ts";
import { TeamRuntime } from "../../src/extension/runtime.ts";
import type { Identity } from "../../src/extension/runtime.ts";
import { TeamApiError } from "../../src/shared/client.ts";
import type { OrgContext } from "../../src/shared/protocol.ts";
import { makeState } from "./helpers.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

for (const phase of ["context-result", "context-error", "inbox-result"] as const) {
	test(`before_agent_start discards stale ${phase} after identity replacement`, async () => {
		const { paths, cleanup } = makeState();
		const handlers = new Map<string, (...args: any[]) => any>();
		let rt!: TeamRuntime;
		const a: Identity = { run_id: "run-A", agent_id: "A", session_id: "session-A", token: "token-A", managed: false, pi_session_id: "pi" };
		const b: Identity = { ...a, run_id: "run-B", agent_id: "B", session_id: "session-B", token: "token-B" };
		const start = mock.method(TeamRuntime.prototype, "start", function (this: TeamRuntime) {
			rt = this;
			this.opts.paths = paths;
			this.identity = a;
			return Promise.resolve();
		});
		const pending = deferred<any>();
		const inboxStarted = deferred<void>();
		const inbox = mock.method(TeamRuntime.prototype, "inboxForRunStart", () => { inboxStarted.resolve(); return pending.promise; });
		const pi = {
			on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
			registerCommand: () => {}, registerTool: () => {},
			appendEntry: () => {}, sendMessage: () => {},
		};
		try {
			extension(pi as any);
			await handlers.get("session_start")!({}, { mode: "rpc" });
			const me = { run_id: "run-A", agent_id: "A", session_id: "session-A", role: "old-role", is_root: false, parent: null, children: [], tasks: [], inbox_pending: 0, pending_proposals_to_review: 0 } as unknown as OrgContext;
			const request = mock.method(rt.client, "me", () => phase === "inbox-result" ? Promise.resolve(me) : pending.promise);
			try {
				const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
				const work = handlers.get("before_agent_start")!(event);
				if (phase === "inbox-result") await inboxStarted.promise;
				else {
					// Let the ready barrier settle so the context request has started.
					await Promise.resolve();
					await Promise.resolve();
					assert.equal(request.mock.callCount(), 1);
				}
				rt.releaseStoppedIdentity("CANCELLED");
				rt.identity = b;
				if (phase === "context-error") pending.reject(new TeamApiError("STALE_SESSION", "superseded", 409, { reason: "superseded" }));
				else pending.resolve(phase === "context-result" ? me : { customType: "old-inbox", content: "old", display: true, details: { message_ids: [] } });
				assert.equal(await work, undefined);
				assert.equal(event.systemPromptOptions.sections[CONTEXT_SECTION], undefined);
				assert.equal(rt.identity, b);
				assert.equal(rt.fenced, false);
			} finally { request.mock.restore(); }
		} finally {
			handlers.get("session_shutdown")?.();
			start.mock.restore();
			inbox.mock.restore();
			cleanup();
		}
	});
}
