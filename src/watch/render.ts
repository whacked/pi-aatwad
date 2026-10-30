// Bounded terminal rendering. Never replay terminal control sequences from worker output.
import { openSync, closeSync, fstatSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function clean(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function content(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value.map((c) => c?.type === "text" ? c.text : c?.type === "toolCall" ? `[tool ${c.name}]` : "").filter(Boolean).join("\n");
}
export function renderLog(raw: string): string {
	const lines: string[] = [];
	let pending = "";
	const flush = () => { if (pending) lines.push(pending); pending = ""; };
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "message_start") flush();
			if (e.type === "message_update") pending = content(e.message?.content);
			if (e.type === "message_end") {
				pending = content(e.message?.content);
				flush();
			}
			if (e.type === "tool_execution_start") { flush(); lines.push(`[tool started: ${e.toolName}]`); }
			if (e.type === "tool_execution_end") { flush(); lines.push(`[tool ${e.isError ? "failed" : "finished"}: ${e.toolName}]`, content(e.result?.content)); }
			if (e.type === "agent_end") { flush(); lines.push("[turn finished; waiting for new work]"); }
		} catch {
			if (!line.startsWith("[pi-team-executor]")) { flush(); lines.push(line.slice(0, 1000)); }
		}
	}
	flush();
	return clean(lines.filter(Boolean).join("\n"));
}

/** Follow the highest log generation, including across controller/worker restarts. */
export function recentOutput(dir: string, agent: string): string {
	if (!/^[A-Za-z0-9_.:-]+$/.test(agent)) throw new Error("invalid agent ID");
	let files: string[];
	try { files = readdirSync(dir); } catch { return "Waiting for worker log…"; }
	const generations = files.filter((f) => f.startsWith(`${agent}.`) && /^\d+\.log$/.test(f.slice(agent.length + 1)))
		.sort((a, b) => Number(b.slice(agent.length + 1, -4)) - Number(a.slice(agent.length + 1, -4)));
	if (!generations.length) return "Waiting for worker log…";
	let fd: number | undefined;
	try {
		fd = openSync(join(dir, generations[0]), "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - 128 * 1024);
		const buffer = Buffer.alloc(size - start);
		readSync(fd, buffer, 0, buffer.length, start);
		let text = buffer.toString("utf8");
		if (start) text = text.slice(text.indexOf("\n") + 1);
		return `Log: ${generations[0]}\n${renderLog(text) || "Waiting for output…"}`;
	} catch { return "Worker log temporarily unavailable"; }
	finally { if (fd !== undefined) closeSync(fd); }
}

export function screen(text: string, rows = 40, columns = 120): string {
	const lines = clean(text).split("\n");
	// Keep status header and newest output when the pane is small.
	const visible = lines.length > rows ? [...lines.slice(0, Math.min(6, rows)), ...lines.slice(-(Math.max(0, rows - 6)))].slice(0, rows) : lines;
	return "\x1b[H\x1b[2J" + visible.map((line) => line.slice(0, Math.max(10, columns - 1))).join("\n");
}
