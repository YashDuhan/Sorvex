import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ElicitationHandler,
	type ElicitResult,
	type JsonRpcMessage,
	type JsonRpcRequest,
	LATEST_PROTOCOL_VERSION,
	McpAbortError,
	McpClient,
	McpError,
	McpTimeoutError,
} from "../src/index.ts";
import { createInMemoryTransportPair, type InMemoryTransport } from "../src/testing/index.ts";

interface TestServer {
	transport: InMemoryTransport;
	messages: JsonRpcMessage[];
	setHandler(method: string, handler: (request: JsonRpcRequest) => unknown | Promise<unknown>): void;
}

async function createServer(): Promise<{ clientTransport: InMemoryTransport; server: TestServer }> {
	const pair = createInMemoryTransportPair();
	const handlers = new Map<string, (request: JsonRpcRequest) => unknown | Promise<unknown>>();
	const messages: JsonRpcMessage[] = [];
	pair.server.onMessage((message) => {
		messages.push(message);
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const handler = handlers.get(request.method);
		queueMicrotask(async () => {
			try {
				if (!handler) throw new McpError(-32601, `Method not found: ${request.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: request.id, result: await handler(request) });
			} catch (error) {
				const mcpError = error instanceof McpError ? error : new McpError(-32603, String(error));
				await pair.server.send({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: mcpError.code, message: mcpError.message, data: mcpError.data },
				});
			}
		});
	});
	await pair.server.start();
	const server: TestServer = {
		transport: pair.server,
		messages,
		setHandler(method, handler) {
			handlers.set(method, handler);
		},
	};
	server.setHandler("initialize", () => ({
		protocolVersion: LATEST_PROTOCOL_VERSION,
		capabilities: { tools: { listChanged: true } },
		serverInfo: { name: "test-server", version: "1.0.0" },
		instructions: "Use test tools.",
	}));
	return { clientTransport: pair.client, server };
}

async function connect(): Promise<{ client: McpClient; server: TestServer }> {
	const { clientTransport, server } = await createServer();
	const client = new McpClient({ name: "test-client", version: "2.0.0" });
	await client.connect(clientTransport);
	return { client, server };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("McpClient", () => {
	it("initializes the connection before exposing server information", async () => {
		const { client, server } = await connect();
		expect(client.connectionState).toBe("connected");
		expect(client.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
		expect(client.serverInfo).toEqual({ name: "test-server", version: "1.0.0" });
		expect(client.serverCapabilities).toEqual({ tools: { listChanged: true } });
		expect(client.instructions).toBe("Use test tools.");
		expect(server.messages).toEqual([
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "test-client", version: "2.0.0" },
				},
			},
			{ jsonrpc: "2.0", method: "notifications/initialized" },
		]);
		await client.close();
	});

	it("paginates tools and preserves protocol tool definitions", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/list", (request) => {
			const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
			return cursor === undefined
				? {
						tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
						nextCursor: "page-2",
					}
				: {
						tools: [
							{
								name: "read",
								inputSchema: { type: "object" },
								outputSchema: { type: "object" },
								annotations: { readOnlyHint: true },
							},
						],
						// Some servers end pagination with an empty cursor instead of omitting it.
						nextCursor: "",
					};
		});
		expect(await client.listTools()).toEqual([
			{ name: "search", description: "Search", inputSchema: { type: "object" } },
			{
				name: "read",
				inputSchema: { type: "object" },
				outputSchema: { type: "object" },
				annotations: { readOnlyHint: true },
			},
		]);
		await client.close();
	});

	it("lists and reads resources", async () => {
		const { client, server } = await connect();
		server.setHandler("resources/list", (request) =>
			(request.params as { cursor?: string } | undefined)?.cursor === undefined
				? { resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }], nextCursor: "2" }
				: { resources: [{ uri: "file:///b" }] },
		);
		server.setHandler("resources/templates/list", () => ({
			resourceTemplates: [{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }],
		}));
		server.setHandler("resources/read", (request) => ({
			contents: [{ uri: (request.params as { uri: string }).uri, text: "hello" }],
		}));
		// A missing name falls back to the URI.
		expect(await client.listResources()).toEqual([
			{ uri: "file:///a", name: "a", mimeType: "text/plain" },
			{ uri: "file:///b", name: "file:///b" },
		]);
		expect(await client.listResourceTemplates()).toEqual([{ uriTemplate: "repo://{owner}/{repo}", name: "repo" }]);
		// Single pages pass the cursor through.
		expect(await client.listResourcesPage()).toEqual({
			resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }],
			nextCursor: "2",
		});
		expect(await client.listResourcesPage("2")).toEqual({ resources: [{ uri: "file:///b", name: "file:///b" }] });
		expect(await client.readResource("file:///a")).toEqual({ contents: [{ uri: "file:///a", text: "hello" }] });

		server.setHandler("resources/read", () => ({ contents: [{ uri: "file:///a" }] }));
		await expect(client.readResource("file:///a")).rejects.toThrow("Invalid contents in MCP resources/read result");
		server.setHandler("resources/list", () => ({ resources: [{ name: "no uri" }] }));
		await expect(client.listResources()).rejects.toThrow("Invalid entry in MCP resources/list result");
		await client.close();
	});

	it("returns structured tool content and surfaces JSON-RPC errors", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", (request) => {
			const params = request.params as { name: string; arguments?: Record<string, unknown> };
			if (params.name === "fail") throw new McpError(1234, "tool failed", { retryable: false });
			return {
				content: [{ type: "text", text: "ok" }],
				structuredContent: { count: params.arguments?.count },
			};
		});
		expect(await client.callTool("count", { count: 3 })).toEqual({
			content: [{ type: "text", text: "ok" }],
			structuredContent: { count: 3 },
		});
		await expect(client.callTool("fail")).rejects.toMatchObject({
			name: "McpError",
			code: 1234,
			message: "tool failed",
			data: { retryable: false },
		});
		await client.close();
	});

	it("renews the timeout on progress", async () => {
		vi.useFakeTimers();
		const { client, server } = await connect();
		server.setHandler("tools/call", async (request) => {
			const token = ((request.params as Record<string, unknown>)._meta as Record<string, unknown>)
				.progressToken as number;
			setTimeout(() => {
				void server.transport.send({
					jsonrpc: "2.0",
					method: "notifications/progress",
					params: { progressToken: token, progress: 1, total: 2 },
				});
			}, 40);
			await new Promise((resolve) => setTimeout(resolve, 80));
			return { content: [{ type: "text", text: "done" }] };
		});
		const progress = vi.fn();
		const result = client.callTool("slow", {}, { timeoutMs: 50, onProgress: progress });
		await vi.advanceTimersByTimeAsync(40);
		await vi.advanceTimersByTimeAsync(40);
		expect(await result).toEqual({ content: [{ type: "text", text: "done" }] });
		expect(progress).toHaveBeenCalledWith({ progressToken: 2, progress: 1, total: 2 });
		await client.close();
	});

	it("cancels aborted and timed-out requests", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => new Promise(() => {}));
		const controller = new AbortController();
		const aborted = client.callTool("wait", {}, { signal: controller.signal });
		controller.abort("stop");
		await expect(aborted).rejects.toBeInstanceOf(McpAbortError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 2, reason: "stop" },
		});

		await expect(client.callTool("wait", {}, { timeoutMs: 5 })).rejects.toBeInstanceOf(McpTimeoutError);
		await client.close();
	});

	it("reports transport errors without failing pending requests", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		let respond = () => {};
		server.setHandler(
			"tools/call",
			() =>
				new Promise((resolve) => {
					respond = () => resolve({ content: [] });
				}),
		);
		const call = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		clientTransport.emitError(new Error("stray log line"));
		respond();
		expect(await call).toEqual({ content: [] });
		expect(errors.map((error) => error.message)).toEqual(["stray log line"]);
		await client.close();
	});

	it("accepts servers that answer with an older protocol version", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => ({
			protocolVersion: "2024-11-05",
			capabilities: {},
			serverInfo: { name: "old-server", version: "0.1.0" },
		}));
		const client = new McpClient({ name: "test-client", version: "1.0.0" });
		await client.connect(clientTransport);
		expect(client.protocolVersion).toBe("2024-11-05");
		await client.close();

		const unsupported = await createServer();
		unsupported.server.setHandler("initialize", () => ({
			protocolVersion: "1999-01-01",
			capabilities: {},
			serverInfo: { name: "ancient-server", version: "0.1.0" },
		}));
		const rejected = new McpClient({ name: "test-client", version: "1.0.0" });
		await expect(rejected.connect(unsupported.clientTransport)).rejects.toThrow("unsupported protocol version");
		expect(rejected.connectionState).toBe("closed");
	});

	it("defaults missing tool result content to an empty list", async () => {
		const { client, server } = await connect();
		server.setHandler("tools/call", () => ({ structuredContent: { ok: true } }));
		expect(await client.callTool("structured")).toEqual({ content: [], structuredContent: { ok: true } });
		server.setHandler("tools/call", () => ({ content: "not a list" }));
		await expect(client.callTool("broken")).rejects.toThrow("Invalid MCP tools/call result");
		await client.close();
	});

	// #10416: MCP 2026-07-28 allows any JSON value as structured content.
	it("accepts structured content that is not an object", async () => {
		const { client, server } = await connect();
		for (const structuredContent of [[{ id: 1 }, { id: 2 }], null, "text", 3, false]) {
			server.setHandler("tools/call", () => ({ content: [], structuredContent }));
			expect(await client.callTool("structured")).toEqual({ content: [], structuredContent });
		}
		await client.close();
	});

	it("does not send notifications/cancelled for a timed-out initialize", async () => {
		const { clientTransport, server } = await createServer();
		server.setHandler("initialize", () => new Promise(() => {}));
		const client = new McpClient({ name: "test-client", version: "1.0.0", requestTimeoutMs: 5 });
		await expect(client.connect(clientTransport)).rejects.toBeInstanceOf(McpTimeoutError);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			server.messages.some((message) => "method" in message && message.method === "notifications/cancelled"),
		).toBe(false);
	});

	it("notifies close listeners once when the transport drops", async () => {
		const { client, server } = await connect();
		const closed = vi.fn();
		client.onClose(closed);
		server.setHandler("tools/call", () => new Promise(() => {}));
		const pending = client.callTool("wait");
		await new Promise((resolve) => setTimeout(resolve, 0));
		await server.transport.close();
		await expect(pending).rejects.toThrow("MCP connection closed");
		expect(client.connectionState).toBe("closed");
		await client.close();
		expect(closed).toHaveBeenCalledTimes(1);
	});

	it("answers roots/list and dispatches notifications", async () => {
		const { clientTransport, server } = await createServer();
		const client = new McpClient({
			name: "test-client",
			version: "1.0.0",
			roots: [{ uri: "file:///workspace", name: "workspace" }],
		});
		await client.connect(clientTransport);
		const changed = vi.fn();
		client.onNotification("notifications/tools/list_changed", changed);
		await server.transport.send({ jsonrpc: "2.0", id: "roots", method: "roots/list" });
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(server.messages).toContainEqual({
			jsonrpc: "2.0",
			id: "roots",
			result: { roots: [{ uri: "file:///workspace", name: "workspace" }] },
		});
		expect(changed).toHaveBeenCalledWith(undefined);
		await client.close();
	});
});

function serverRequest(server: TestServer, id: string, method: string, params: unknown): Promise<JsonRpcMessage> {
	return new Promise((resolve) => {
		const stop = server.transport.onMessage((message) => {
			if ("id" in message && message.id === id && !("method" in message)) {
				stop();
				resolve(message);
			}
		});
		void server.transport.send({ jsonrpc: "2.0", id, method, params } as JsonRpcMessage);
	});
}

const form = (properties: Record<string, unknown>) => ({
	message: "x",
	requestedSchema: { type: "object", properties },
});

const SIGNUP_FORM = {
	message: "Sign up",
	requestedSchema: {
		type: "object",
		properties: {
			name: { type: "string", default: "Ada" },
			plan: { type: "string", oneOf: [{ const: "pro", title: "Pro" }] },
			seats: { type: "integer", minimum: 1 },
			tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
			newsletter: { type: "boolean" },
		},
		required: ["name"],
	},
};

describe("McpClient prompts", () => {
	it("lists prompts across pages, again after prompts/list_changed", async () => {
		const { client, server } = await connect();
		let version = 1;
		server.setHandler("prompts/list", (request) => {
			const cursor = (request.params as { cursor?: string } | undefined)?.cursor;
			if (cursor === undefined) {
				return { prompts: [{ name: "review", arguments: [{ name: "file", required: true }] }], nextCursor: "2" };
			}
			return { prompts: version === 1 ? [] : [{ name: "summarize" }] };
		});
		expect(await client.listPrompts()).toEqual([{ name: "review", arguments: [{ name: "file", required: true }] }]);

		const changed = new Promise((resolve) => client.onNotification("notifications/prompts/list_changed", resolve));
		version = 2;
		await server.transport.send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
		await changed;
		expect((await client.listPrompts()).map((prompt) => prompt.name)).toEqual(["review", "summarize"]);
		await client.close();
	});

	it("gets a prompt with its arguments and rejects malformed results", async () => {
		const { client, server } = await connect();
		server.setHandler("prompts/get", (request) => {
			const { name, arguments: args } = request.params as { name: string; arguments?: Record<string, string> };
			if (name === "broken") return { messages: [{ role: "system", content: { type: "text", text: "x" } }] };
			return {
				description: "Review a file",
				messages: [{ role: "user", content: { type: "text", text: `Review ${args?.file}` } }],
			};
		});

		expect(await client.getPrompt("review", { file: "a.ts" })).toEqual({
			description: "Review a file",
			messages: [{ role: "user", content: { type: "text", text: "Review a.ts" } }],
		});
		expect(server.messages).toContainEqual(
			expect.objectContaining({ method: "prompts/get", params: { name: "review", arguments: { file: "a.ts" } } }),
		);
		await expect(client.getPrompt("broken")).rejects.toThrow("Invalid message in MCP prompts/get result");
		await client.close();
	});

	it.each([
		["text without text", { type: "text" }],
		["image without data", { type: "image", mimeType: "image/png" }],
		["image with a non-image type", { type: "image", data: "aGk=", mimeType: "text/html" }],
		["audio without a type", { type: "audio", data: "aGk=" }],
		["resource link without a name", { type: "resource_link", uri: "file:///a" }],
		["resource without contents", { type: "resource" }],
		["resource without text or blob", { type: "resource", resource: { uri: "file:///a" } }],
	])("rejects a prompt message with %s", async (_name, content) => {
		const { client, server } = await connect();
		server.setHandler("prompts/get", () => ({ messages: [{ role: "user", content }] }));

		await expect(client.getPrompt("review")).rejects.toThrow("Invalid message in MCP prompts/get result");
		await client.close();
	});
});

describe("McpClient elicitation", () => {
	async function connectWithElicitation(answer: () => ElicitResult | Promise<ElicitResult>) {
		const { clientTransport, server } = await createServer();
		const elicitation = vi.fn<ElicitationHandler>(async () => answer());
		const client = new McpClient({ name: "test-client", version: "1.0.0", elicitation });
		await client.connect(clientTransport);
		return { client, server, elicitation };
	}

	it("declares the capability and answers elicitation/create with the handler", async () => {
		const { client, server, elicitation } = await connectWithElicitation(() => ({
			action: "accept",
			content: { name: "Ada" },
		}));

		expect(server.messages[0]).toMatchObject({
			method: "initialize",
			params: { capabilities: { elicitation: { form: {} } } },
		});
		const response = await serverRequest(server, "e1", "elicitation/create", SIGNUP_FORM);

		expect(elicitation).toHaveBeenCalledWith(
			SIGNUP_FORM,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(response).toEqual({ jsonrpc: "2.0", id: "e1", result: { action: "accept", content: { name: "Ada" } } });
		await client.close();
	});

	it.each([
		["URL mode", { mode: "url", message: "Open", url: "https://example.com", elicitationId: "1" }],
		["a nested field", { message: "x", requestedSchema: { type: "object", properties: { a: { type: "object" } } } }],
		[
			"a default of the wrong type",
			{ message: "x", requestedSchema: { type: "object", properties: { a: { type: "boolean", default: "yes" } } } },
		],
		["an unknown format", form({ a: { type: "string", format: "hostname" } })],
		["an inherited format name", form({ a: { type: "string", format: "constructor" } })],
		[
			"more than 50 fields",
			form(Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}`, { type: "boolean" }]))),
		],
		["more than 200 options", form({ a: { type: "string", enum: Array.from({ length: 201 }, (_, i) => `o${i}`) } })],
		[
			"more than 200 choices",
			form({
				a: {
					type: "array",
					items: { anyOf: Array.from({ length: 201 }, (_, i) => ({ const: `${i}`, title: `${i}` })) },
				},
			}),
		],
		[
			"a field named __proto__",
			JSON.parse('{"message":"x","requestedSchema":{"type":"object","properties":{"__proto__":{"type":"string"}}}}'),
		],
		["a field named constructor", form({ constructor: { type: "string" } })],
		["a title that is not a string", form({ a: { type: "string", title: 5 } })],
	])("rejects %s with invalid params", async (_name, params) => {
		const { client, server, elicitation } = await connectWithElicitation(() => ({ action: "decline" }));

		const response = await serverRequest(server, "e1", "elicitation/create", params);

		expect(response).toMatchObject({ id: "e1", error: { code: -32602 } });
		expect(elicitation).not.toHaveBeenCalled();
		await client.close();
	});

	it("does not answer an elicitation the server cancelled", async () => {
		let release: () => void = () => {};
		const { client, server, elicitation } = await connectWithElicitation(
			() =>
				new Promise<ElicitResult>((resolve) => {
					release = () => resolve({ action: "accept", content: {} });
				}),
		);
		void serverRequest(server, "e1", "elicitation/create", SIGNUP_FORM);
		await vi.waitFor(() => expect(elicitation).toHaveBeenCalled());
		const signal = elicitation.mock.calls[0]?.[1].signal;

		await server.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "e1" } });
		await vi.waitFor(() => expect(signal?.aborted).toBe(true));
		release();
		await client.listTools().catch(() => undefined);

		expect(server.messages.filter((message) => "id" in message && message.id === "e1")).toEqual([]);
		await client.close();
	});

	it("does not declare elicitation without a handler", async () => {
		const { client, server } = await connect();
		expect(server.messages[0]).toMatchObject({ params: { capabilities: {} } });
		const response = await serverRequest(server, "e1", "elicitation/create", SIGNUP_FORM);
		expect(response).toMatchObject({ error: { code: -32601 } });
		await client.close();
	});

	it("pauses request timeouts while an elicitation is answered", async () => {
		vi.useFakeTimers();
		const { client, server } = await connectWithElicitation(
			() => new Promise<ElicitResult>((resolve) => setTimeout(() => resolve({ action: "cancel" }), 200)),
		);
		server.setHandler("tools/call", async () => {
			const response = await serverRequest(server, "e1", "elicitation/create", SIGNUP_FORM);
			return { content: [{ type: "text", text: JSON.stringify(response) }] };
		});

		const result = client.callTool("signup", {}, { timeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(200);

		expect(await result).toEqual({
			content: [{ type: "text", text: JSON.stringify({ jsonrpc: "2.0", id: "e1", result: { action: "cancel" } }) }],
		});
		await client.close();
	});
});
