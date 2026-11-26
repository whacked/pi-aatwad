// Team summaries: a small model condenses a team's event log into readable windows, opt-in per
// project. Each summary covers the events after the previous one; it states what happened in that
// window and keeps a rolling overview of the whole team. Summaries are derived data: they are made
// on demand (when someone reads the brief and enough happened), charged to the team's budget, and
// never fed back into the summarizer except the previous overview.
import { spawn } from "node:child_process";
import type { Ctx, Principal } from "./context.ts";
import type { ProjectSettings, SummarizerSetting, SummaryView } from "../shared/protocol.ts";
import { type DB, all, emit, get, newId, nowIso, parseJson, run, tx } from "./db.ts";
import { fail } from "./errors.ts";
import { obj, onlyKeys, str } from "./validate.ts";
import { getAgent, getRun, runConfig } from "./queries.ts";
import { headSeq, scanEvents, type EventRow } from "./history.ts";
import { findExecutable } from "../shared/environment.ts";
import { budgetPool, ownBudgetUsd } from "./budgets.ts";
import { chargeUsage } from "./runs.ts";

// ------------------------------------------------------------------ project settings
function norm(path: string): string {
	return path.replace(/\/+$/, "") || "/";
}

export function readProjectSettings(db: DB, project: string): ProjectSettings {
	const row = get(db, "SELECT settings_json FROM project_settings WHERE project = ?", norm(project));
	return parseJson<ProjectSettings>(row?.settings_json, {});
}

/** The settings of the innermost configured project containing dir. */
export function settingsFor(db: DB, dir: string | null | undefined): { project: string; settings: ProjectSettings } | undefined {
	if (!dir) return undefined;
	const d = norm(dir);
	const rows = all(db, "SELECT project, settings_json FROM project_settings");
	const match = rows.filter((r) => d === r.project || d.startsWith(`${r.project}/`)).sort((a, b) => String(b.project).length - String(a.project).length)[0];
	return match ? { project: String(match.project), settings: parseJson<ProjectSettings>(match.settings_json, {}) } : undefined;
}

function runSettings(db: DB, runId: string): SummarizerSetting | undefined {
	const root = getAgent(db, getRun(db, runId).root_agent_id);
	return settingsFor(db, root.cwd)?.settings.summarizer;
}

export function getProjectSettingsRoute(ctx: Ctx, p: Principal, q: URLSearchParams): { project: string; settings: ProjectSettings; configured_at: string | null } {
	if (p.kind !== "operator") fail("FORBIDDEN", "operator token required");
	const project = q.get("project");
	if (!project) fail("INVALID", "project is required");
	const found = settingsFor(ctx.db, project);
	return { project: found?.project ?? norm(project), settings: found?.settings ?? {}, configured_at: found ? String(get(ctx.db, "SELECT updated_at FROM project_settings WHERE project = ?", found.project)?.updated_at) : null };
}

export function setProjectSettingsRoute(ctx: Ctx, p: Principal, body: unknown): { project: string; settings: ProjectSettings } {
	if (p.kind !== "operator") fail("FORBIDDEN", "operator token required");
	const b = obj(body);
	onlyKeys(b, ["project", "summarizer"]);
	const project = norm(str(b, "project"));
	const s = obj(b.summarizer);
	onlyKeys(s, ["state", "model"]);
	const state = str(s, "state");
	let summarizer: SummarizerSetting;
	if (state === "enabled") {
		const model = str(s, "model");
		if (!/^[^/\s]+\/\S+$/.test(model)) fail("INVALID", "model must be provider/id");
		summarizer = { state: "enabled", model };
	} else if (state === "declined") summarizer = { state: "declined" };
	else return fail("INVALID", "summarizer.state must be enabled or declined");
	const settings = { ...readProjectSettings(ctx.db, project), summarizer };
	tx(ctx.db, () => {
		run(ctx.db, "INSERT INTO project_settings(project, settings_json, updated_at) VALUES (?,?,?) ON CONFLICT(project) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at", project, JSON.stringify(settings), nowIso());
	});
	ctx.log("info", "project settings changed", { project, summarizer: summarizer.state, model: summarizer.state === "enabled" ? summarizer.model : undefined });
	return { project, settings };
}

// ------------------------------------------------------------------ the model call
export interface SummarizeRequest { model: string; system: string; input: string }
export interface SummarizeResult { text: string; cost_usd: number }
export type Summarize = (req: SummarizeRequest) => Promise<SummarizeResult>;

/** One tool-free Pi call in JSON mode: no session file, no extensions, no project context. */
export function piSummarize(piBin = process.env.PI_TEAM_PI_BIN ?? "pi", timeoutMs = 180_000): Summarize {
	return (req) => new Promise((resolve, reject) => {
		const bin = findExecutable(piBin);
		if (!bin) return reject(new Error(`Pi executable '${piBin}' is unavailable to the controller`));
		const args = ["--mode", "json", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--no-themes",
			"--model", req.model, "--system-prompt", req.system, "Summarize the team records above as instructed."];
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_TEAM_STATE_DIR: undefined } });
		let out = "", err = "";
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`summarizer timed out after ${timeoutMs} ms`)); }, timeoutMs);
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("error", (e) => { clearTimeout(timer); reject(e); });
		child.on("close", (code) => {
			clearTimeout(timer);
			let final: { content?: unknown; usage?: { cost?: { total?: number } }; stopReason?: string; errorMessage?: string } | undefined;
			for (const line of out.split("\n")) {
				if (!line.trim()) continue;
				try {
					const r = JSON.parse(line) as { type?: string; message?: typeof final & { role?: string } };
					if (r.type === "message_end" && r.message?.role === "assistant") final = r.message;
				} catch { /* not a record */ }
			}
			if (!final) return reject(new Error(`summarizer produced no answer (exit ${code}): ${err.trim().slice(-300)}`));
			if (final.stopReason === "error") return reject(new Error(`summarizer model error: ${final.errorMessage ?? "unknown"}`));
			const text = Array.isArray(final.content) ? final.content.filter((b: { type?: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("") : String(final.content ?? "");
			resolve({ text: text.trim(), cost_usd: Number(final.usage?.cost?.total ?? 0) || 0 });
		});
		child.stdin.end(req.input);
	});
}

// ------------------------------------------------------------------ making summaries
/** How many new records make a new summary worthwhile (reviewed with field data later). */
export const SUMMARY_MIN_EVENTS = 8;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const MAX_INPUT_CHARS = 24_000;
/** The summarizer's own traces never count as activity worth summarizing. */
const SKIP = new Set(["usage.reported", "summary.created", "summary.failed", "agent.reconnected", "agent.lost", "spawn.launching", "spawn.launched", "session.enrolled", "agent.host_detected", "attention.agent_changed", "attention.run_changed"]);

export const SUMMARY_SYSTEM = [
	"You summarize the activity of an AI agent team for its human operator and its team leader.",
	"Use only the records given. Be concrete: name members, tasks, results, blockers and open questions. No speculation, no advice.",
	"Answer with exactly two sections in this format:",
	"## Window",
	"What happened in these records, grouped by member: at most 10 short bullets.",
	"## Overview",
	"The whole team's current picture: goal, who is doing what, progress, blockers, open questions for the human. At most 12 short bullets. Start from the previous overview (if given) and update it with the new records.",
].join("\n");

const inFlight = new Set<string>();
const lastFailure = new Map<string, number>();

function latest(db: DB, runId: string): { to_seq: number; overview_text: string } | undefined {
	return get(db, "SELECT to_seq, overview_text FROM summaries WHERE run_id = ? ORDER BY to_seq DESC LIMIT 1", runId) as { to_seq: number; overview_text: string } | undefined;
}

function worthSummarizing(db: DB, runId: string, after: number): EventRow[] {
	return scanEvents(db, { run_id: runId, after_seq: after, limit: 2000 }).filter((e) => !SKIP.has(e.type));
}

function recordLines(db: DB, runId: string, events: EventRow[]): string[] {
	const role = new Map<string, string>();
	const who = (id: string | null) => {
		if (!id) return "controller";
		if (!role.has(id)) {
			const a = get(db, "SELECT role, run_id FROM agents WHERE id = ?", id);
			const team = a && a.run_id !== runId ? ` (team ${runConfig(db, String(a.run_id)).name ?? a.run_id})` : "";
			role.set(id, `${String(a?.role ?? id)}${team}`);
		}
		return role.get(id)!;
	};
	const title = (id: string | null) => (id ? String(get(db, "SELECT title FROM tasks WHERE id = ?", id)?.title ?? id) : "");
	const lines: string[] = [];
	for (const e of events) {
		const p = parseJson<Record<string, unknown>>(e.payload_json, {});
		const t = e.created_at.slice(11, 16);
		const detail =
			e.type === "task.assigned" ? `assigned "${title(e.entity_id)}" to ${who(String(p.owner_id ?? p.to ?? ""))}`
			: e.type === "task.progress" ? `progress on "${title(e.entity_id)}": ${p.headline ? `${String(p.headline)}. ` : ""}${String(p.note ?? "")}`
			: e.type === "task.completed" ? `finished "${title(e.entity_id)}" (${String(p.status ?? "DONE")}): ${p.headline ? `${String(p.headline)}. ` : ""}${String(p.summary ?? "")}${p.briefing ? ` Briefing: ${String(p.briefing).replace(/\s+/g, " ").slice(0, 400)}` : ""}`
			: e.type === "agent.created" ? `${who(e.entity_id)} joined the team`
			: e.type === "message.sent" ? messageLine(db, e, who)
			: `${e.type}${e.entity_id ? ` ${who(e.entity_id)}` : ""}`;
		lines.push(`${t} ${who(e.actor_id)}: ${detail}`.slice(0, 800));
	}
	return lines;
}

/** As many records, oldest first, as fit the model input; the rest go into the next summary. Never drops any. */
export function fitWindow(lines: string[], maxChars = MAX_INPUT_CHARS): number {
	let used = 0, n = 0;
	for (const l of lines) {
		if (n > 0 && used + l.length + 1 > maxChars) break;
		used += l.length + 1;
		n++;
	}
	return n;
}

function messageLine(db: DB, e: EventRow, who: (id: string | null) => string): string {
	const p = parseJson<{ to?: string; type?: string }>(e.payload_json, {});
	const m = e.entity_id ? get(db, "SELECT payload_json FROM messages WHERE id = ?", e.entity_id) : undefined;
	const body = m ? parseJson<{ text?: string }>(m.payload_json, {}).text : undefined;
	return `${p.type ?? "message"} to ${who(p.to ?? null)}${body ? `: ${String(body).replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
}

/**
 * Teams linked under this one are summarized by their own summarizer; the parent reads their latest
 * overviews, not their raw events. So each level condenses its direct reports plus its own activity,
 * and the cost per summary stays bounded however deep the organization grows.
 */
function linkedOverviews(db: DB, runId: string): string {
	const parts: string[] = [];
	for (const l of all(db, "SELECT DISTINCT run_id FROM reporting_edges WHERE parent_run_id = ? AND valid_to IS NULL", runId)) {
		const s = get(db, "SELECT overview_text, created_at FROM summaries WHERE run_id = ? ORDER BY to_seq DESC LIMIT 1", l.run_id);
		if (!s) continue;
		const name = runConfig(db, String(l.run_id)).name ?? l.run_id;
		parts.push(`Team "${name}" (linked under this team), its own overview as of ${String(s.created_at).slice(11, 16)} UTC:\n${String(s.overview_text).slice(0, 3000)}`);
	}
	return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

export function splitSections(text: string): { window: string; overview: string } {
	const w = text.match(/##\s*Window\s*\n([\s\S]*?)(?=\n##\s*Overview|$)/i)?.[1]?.trim();
	const o = text.match(/##\s*Overview\s*\n([\s\S]*)$/i)?.[1]?.trim();
	return { window: w || text.trim(), overview: o || w || text.trim() };
}

/**
 * Make a new summary for the team if it is enabled for its project, enough happened since the last
 * one, its budget allows, and none is being made. Never throws; failures are recorded and retried later.
 */
export async function summarizeIfDue(ctx: Ctx, runId: string, summarize: Summarize, now = Date.now()): Promise<"made" | "skipped"> {
	const db = ctx.db;
	if (inFlight.has(runId)) return "skipped";
	const setting = runSettings(db, runId);
	if (setting?.state !== "enabled") return "skipped";
	if (now - (lastFailure.get(runId) ?? 0) < RETRY_AFTER_FAILURE_MS) return "skipped";
	const prev = latest(db, runId);
	const after = prev?.to_seq ?? 0;
	const events = worthSummarizing(db, runId, after);
	if (events.length < SUMMARY_MIN_EVENTS) return "skipped";
	const root = getRun(db, runId).root_agent_id;
	// A team out of budget gets no summaries until the human raises or clears its limit.
	const own = ownBudgetUsd(db, root);
	if (own !== null && budgetPool(db, root).consumed >= own - 1e-9) return "skipped";
	// A busy team (many members, long notes) can outgrow one model call: summarize what fits, then the rest.
	const lines = recordLines(db, runId, events);
	const n = fitWindow(lines);
	const toSeq = events[n - 1].seq;
	const more = n < events.length;
	inFlight.add(runId);
	try {
		const input = `${prev ? `Previous overview:\n${prev.overview_text}\n\n` : ""}${linkedOverviews(db, runId)}Team records (time UTC, who: what):\n${lines.slice(0, n).join("\n")}`;
		const r = await summarize({ model: setting.model, system: SUMMARY_SYSTEM, input });
		const { window, overview } = splitSections(r.text);
		tx(db, () => {
			const id = newId("sum");
			run(db, "INSERT INTO summaries(id, run_id, from_seq, to_seq, window_text, overview_text, model, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?)", id, runId, after, toSeq, window, overview, setting.model, r.cost_usd, nowIso());
			// The team pays for its summaries, like any other model use, and its limits apply.
			chargeUsage(db, { actor_id: root, run_id: runId }, r.cost_usd, { source: "summarizer", model: setting.model }, "controller");
			emit(db, { run_id: runId, actor_id: "controller", type: "summary.created", entity_id: id, payload: { from_seq: after, to_seq: toSeq, model: setting.model } });
		});
		lastFailure.delete(runId);
		if (more) setImmediate(() => void summarizeIfDue(ctx, runId, summarize));
		return "made";
	} catch (e) {
		lastFailure.set(runId, now);
		ctx.log("warn", "summary failed", { run_id: runId, model: setting.model, err: String((e as Error)?.message ?? e) });
		try { tx(db, () => emit(db, { run_id: runId, actor_id: "controller", type: "summary.failed", entity_id: runId, payload: { model: setting.model, error: String((e as Error)?.message ?? e).slice(0, 300) } })); } catch { /* best effort */ }
		return "skipped";
	} finally {
		inFlight.delete(runId);
	}
}

// ------------------------------------------------------------------ reading summaries
export function viewOf(r: Record<string, unknown>): SummaryView {
	return { summary_id: String(r.id), run_id: String(r.run_id), from_seq: Number(r.from_seq), to_seq: Number(r.to_seq), window: String(r.window_text), overview: String(r.overview_text), model: String(r.model), cost_usd: Number(r.cost_usd), created_at: String(r.created_at) };
}

export function latestSummary(db: DB, runId: string): SummaryView | undefined {
	const r = get(db, "SELECT * FROM summaries WHERE run_id = ? ORDER BY to_seq DESC LIMIT 1", runId);
	return r ? viewOf(r) : undefined;
}

/** Summaries of a team, newest first; `q` matches words in either text; `before_seq` pages back. */
export function listSummaries(db: DB, runId: string, o: { q?: string; before_seq?: number; limit?: number } = {}): { summaries: SummaryView[]; head_seq: number } {
	const clauses = ["run_id = ?"], params: unknown[] = [runId];
	if (o.before_seq !== undefined) { clauses.push("to_seq < ?"); params.push(o.before_seq); }
	for (const word of (o.q ?? "").split(/\s+/).filter(Boolean).slice(0, 8)) {
		clauses.push("(window_text LIKE ? ESCAPE '\\' OR overview_text LIKE ? ESCAPE '\\')");
		const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
		params.push(like, like);
	}
	const rows = all(db, `SELECT * FROM summaries WHERE ${clauses.join(" AND ")} ORDER BY to_seq DESC LIMIT ?`, ...params, Math.min(Math.max(o.limit ?? 10, 1), 100));
	return { summaries: rows.map(viewOf), head_seq: headSeq(db) };
}
