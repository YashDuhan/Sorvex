// Minimal stdio MCP server (newline-delimited JSON-RPC) with the tools echo_upper and ask, and the
// prompt greet. ask sends an elicitation request and returns the client's answer as JSON.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pendingAsks = new Map();
let nextAsk = 1;
createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === undefined && pendingAsks.has(message.id)) {
		const callId = pendingAsks.get(message.id);
		pendingAsks.delete(message.id);
		send({ id: callId, result: { content: [{ type: "text", text: JSON.stringify(message.result ?? message.error) }] } });
	} else if (message.method === "initialize") {
		send({
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {}, prompts: {} },
				serverInfo: { name: "echo", version: "1" },
			},
		});
	} else if (message.method === "tools/list") {
		send({
			id: message.id,
			result: {
				tools: [
					{
						name: "echo_upper",
						description: "Uppercase the text",
						inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
						annotations: { readOnlyHint: true },
					},
					{
						name: "ask",
						description: "Ask the user for a name",
						inputSchema: { type: "object", properties: {} },
						annotations: { readOnlyHint: true },
					},
				],
			},
		});
	} else if (message.method === "prompts/list") {
		send({ id: message.id, result: { prompts: [{ name: "greet", description: "Greet" }] } });
	} else if (message.method === "prompts/get") {
		send({ id: message.id, result: { messages: [{ role: "user", content: { type: "text", text: "PROMPT RAN" } }] } });
	} else if (message.method === "tools/call" && message.params.name === "ask") {
		const id = `ask-${nextAsk++}`;
		pendingAsks.set(id, message.id);
		send({
			id,
			method: "elicitation/create",
			params: {
				message: "Who are you?",
				requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			},
		});
	} else if (message.method === "tools/call") {
		send({
			id: message.id,
			result: { content: [{ type: "text", text: String(message.params.arguments.text).toUpperCase() }] },
		});
	} else if (message.id !== undefined) {
		send({ id: message.id, result: {} });
	}
});
