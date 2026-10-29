// Tiny OpenAI-compatible streaming chat-completions server for offline Pi tests.
// Every reply is the text "ACK". Records each request's messages for assertions.
import { createServer } from "node:http";
import type { Server } from "node:http";

export interface FakeOpenAI { server: Server; port: number; requests: { role: string; text: string }[][]; close(): Promise<void> }

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("");
	return "";
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
	const requests: { role: string; text: string }[][] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let j: any = {};
			try { j = JSON.parse(body); } catch {}
			requests.push((j.messages ?? []).map((m: any) => ({ role: m.role, text: text(m.content) })));
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
			chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [{ index: 0, delta: { role: "assistant", content: "ACK" }, finish_reason: null }] });
			chunk({ id: "c", object: "chat.completion.chunk", created: 1, model: "fake-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	return { server, port, requests, close: () => new Promise((r) => server.close(() => r())) };
}
