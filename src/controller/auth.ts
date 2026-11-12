// Bearer tokens: operator token (file) and agent session tokens (hash stored, generation-fenced).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { type DB, get, run, nowIso } from "./db.ts";
import { fail } from "./errors.ts";
import type { Principal } from "./context.ts";

export function hashToken(t: string): string {
	return createHash("sha256").update(t).digest("hex");
}
export function mintSecret(prefix: string): string {
	return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/** Creates <stateDir>/operator.token (0600) if missing; returns its contents. */
export function ensureOperatorToken(path: string): string {
	if (!existsSync(path)) {
		try {
			writeFileSync(path, mintSecret("pto") + "\n", { mode: 0o600, flag: "wx" });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
	chmodSync(path, 0o600);
	return readFileSync(path, "utf8").trim();
}

export function issueSessionToken(db: DB, s: { run_id: string; agent_id: string; session_id: string; generation: number }): string {
	const token = mintSecret("pts");
	run(db, "INSERT INTO auth_tokens(token_hash, run_id, agent_id, session_id, generation, created_at) VALUES (?,?,?,?,?,?)", hashToken(token), s.run_id, s.agent_id, s.session_id, s.generation, nowIso());
	return token;
}

/** Revoke tokens of an agent (optionally all but one session) and its unused enrollment credentials. */
export function revokeAgentCredentials(db: DB, agentId: string, reason: string, keepSessionId: string | null = null): void {
	const ts = nowIso();
	run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = ? WHERE agent_id = ? AND revoked_at IS NULL AND session_id IS NOT ?", ts, reason, agentId, keepSessionId);
	run(db, "UPDATE enrollment_credentials SET revoked_at = ? WHERE agent_id = ? AND used_at IS NULL AND revoked_at IS NULL AND session_id IS NOT ?", ts, agentId, keepSessionId);
}

export function revokeSessionTokens(db: DB, sessionId: string, reason: string): void {
	run(db, "UPDATE auth_tokens SET revoked_at = ?, revoke_reason = ? WHERE session_id = ? AND revoked_at IS NULL", nowIso(), reason, sessionId);
}

function safeEq(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function resolvePrincipal(db: DB, operatorToken: string, authorization: string | undefined): Principal {
	const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? "");
	if (!m) fail("UNAUTHENTICATED", "missing bearer token");
	const token = m[1];
	if (safeEq(token, operatorToken)) return { kind: "operator", actor_id: "operator" };
	const row = get(db, "SELECT t.*, a.current_session_id, a.status AS agent_status FROM auth_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.token_hash = ?", hashToken(token));
	if (!row) fail("UNAUTHENTICATED", "unknown token");
	if (["COMPLETED", "FAILED", "CANCELLED", "RETIRED"].includes(row.agent_status))
		fail("STALE_SESSION", `agent is ${row.agent_status}`, { reason: "agent_terminal", agent_status: row.agent_status });
	if (row.current_session_id !== row.session_id || row.revoke_reason === "superseded")
		fail("STALE_SESSION", "session attempt has been superseded", { reason: "superseded" });
	if (row.revoke_reason === "team_stopped") fail("STALE_SESSION", "team is stopped; resume it to continue", { reason: "team_stopped" });
	if (row.revoked_at) fail("STALE_SESSION", `session token revoked (${row.revoke_reason ?? "revoked"})`, { reason: "credential_revoked", revoke_reason: row.revoke_reason });
	return { kind: "agent", actor_id: row.agent_id, run_id: row.run_id, session_id: row.session_id, generation: row.generation };
}
