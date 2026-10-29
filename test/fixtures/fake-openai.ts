// Tiny OpenAI-compatible streaming chat-completions server for offline Pi tests.
// Default reply is the text "ACK". A `respond` hook can script tool calls per request.
// Records every request (messages incl. tool calls, offered tool names) for assertions.
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeToolCall {
	id: string;
	name: string;
	arguments: string; // JSON text
}

export interface FakeMessage {
	role: string;
	text: string;
	tool_calls?: FakeToolCall[];
	tool_call_id?: string;
}

export interface FakeRequest {
	messages: FakeMessage[];
	tools: string[];
	model: string;
}

/** What the fake model answers: plain text, or tool calls (finish_reason "tool_calls"). */
export type FakeReply = { text: string } | { tool_calls: { name: string; arguments: Record<string, unknown> }[] };

export interface FakeOpenAI {
	server: Server;
	port: number;
	/** Every request: messages (incl. tool calls / tool results) and offered tool names. */
	requests: FakeRequest[];
	close(): Promise<void>;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
	return "";
}

export async function startFakeOpenAI(respond?: (req: FakeRequest, index: number) => FakeReply | Promise<FakeReply>): Promise<FakeOpenAI> {
	const requests: FakeRequest[] = [];
	let callSeq = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", async () => {
			let j: any = {};
			try {
				j = JSON.parse(body);
			} catch {}
			const r: FakeRequest = {
				model: j.model ?? "",
				tools: (j.tools ?? []).map((t: any) => t?.function?.name).filter(Boolean),
				messages: (j.messages ?? []).map((m: any) => ({
					role: m.role,
					text: text(m.content),
					...(m.tool_calls ? { tool_calls: m.tool_calls.map((t: any) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments ?? "" })) } : {}),
					...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
				})),
			};
			requests.push(r);
			let reply: FakeReply = { text: "ACK" };
			try {
				if (respond) reply = await respond(r, requests.length - 1); // may hold the request open
			} catch (e) {
				reply = { text: `fake responder error: ${(e as Error).message}` };
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
				res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: r.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
			if ("tool_calls" in reply) {
				chunk(
					{
						role: "assistant",
						content: null,
						tool_calls: reply.tool_calls.map((t, i) => ({ index: i, id: `call_${++callSeq}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })),
					},
					null,
				);
				chunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
			} else {
				chunk({ role: "assistant", content: reply.text }, null);
				chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
			}
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	return { server, port, requests, close: () => new Promise((r) => server.close(() => r())) };
}
