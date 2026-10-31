import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@sorvex/ai";
import type { SystemMessage, ToolResultMessage } from "@sorvex/ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@sorvex/mcp";
import { createInMemoryTransportPair } from "@sorvex/mcp/testing";
import type { AutocompleteProvider } from "@sorvex/tui";
import { Type } from "typebox";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { MCP_APPROVAL_ENTRY_TYPE } from "../../src/extensions/mcp/approval.ts";
import { type McpCacheEntry, mcpConfigHash, readMcpCache, writeMcpCacheEntry } from "../../src/extensions/mcp/cache.ts";
import {
	loadMcpConfig,
	type McpExposure,
	type McpServerConfig,
	type McpServerEntry,
} from "../../src/extensions/mcp/config.ts";
import { createMcpExtension, MCP_SERVERS_SECTION } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import { TOOL_SEARCH_DESCRIPTION } from "../../src/extensions/tool-search/tool.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import {
	createHarness,
	createTestUiContext,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
	getToolResult as toolResult,
} from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{
		name: "fail",
		description: "Always fails.",
		inputSchema: { type: "object", properties: {} },
		annotations: { title: "Fail", destructiveHint: true, readOnlyHint: false, idempotentHint: "yes" },
	},
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/**
 * Minimal MCP server over an in-memory transport. Records the tool calls it receives.
 * `initializeDelayMs` delays the answer to `initialize`; `Infinity` never answers.
 */
function createFakeServer(
	calls: string[],
	options: {
		listTools?: () => unknown[];
		resources?: boolean;
		instructions?: string;
		initializeDelayMs?: number;
		callDelayMs?: number;
	} = {},
) {
	const {
		listTools = () => SERVER_TOOLS,
		resources = false,
		instructions,
		initializeDelayMs = 0,
		callDelayMs = 0,
	} = options;
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {}, ...(resources ? { resources: {} } : {}) },
					serverInfo: { name: "docs", version: "1.0.0" },
					...(instructions ? { instructions } : {}),
				};
			case "tools/list":
				return { tools: listTools() };
			case "resources/list":
				return {
					resources: [
						{ uri: "docs://intro", name: "intro", mimeType: "text/markdown", _meta: { x: 1 } },
						// MCP App user interfaces are left out.
						{ uri: "ui://docs/viewer", name: "viewer", mimeType: "text/html;profile=mcp-app" },
					],
				};
			case "resources/templates/list":
				return {
					resourceTemplates: [
						{ uriTemplate: "docs://pages/{slug}", name: "page", icons: [{ src: "data:image/png;base64,AAAA" }] },
					],
				};
			case "resources/read": {
				const { uri } = request.params as { uri: string };
				calls.push(`read:${uri}`);
				return { contents: [{ uri, mimeType: "text/markdown", text: `# ${uri}` }] };
			}
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const send = () => void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		const delayMs =
			request.method === "initialize" ? initializeDelayMs : request.method === "tools/call" ? callDelayMs : 0;
		if (delayMs === 0) queueMicrotask(send);
		else if (Number.isFinite(delayMs)) setTimeout(send, delayMs);
	});
	return pair;
}

const cacheDirs: string[] = [];

function tempCachePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-mcp-cache-"));
	cacheDirs.push(dir);
	return join(dir, "mcp-cache.json");
}

afterAll(() => {
	for (const dir of cacheDirs) rmSync(dir, { recursive: true, force: true });
});

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure,
		listTools?: () => unknown[],
		options: {
			autoEnableCodemode?: boolean;
			builtInTools?: string[];
			/** `--tools` and `--exclude-tools`. */
			allowedToolNames?: string[];
			excludedToolNames?: string[];
			/** Session to continue. */
			sessionManager?: SessionManager;
			/** Whether to wait for `mcp__docs__search` to register. Default: true. */
			waitForTools?: boolean;
			extensionFactories?: ExtensionFactory[];
			toolExposure?: Record<string, McpExposure>;
			resources?: boolean;
			withoutToolSearch?: boolean;
			description?: string;
			instructions?: string;
		} = {},
	) {
		const {
			builtInTools,
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			waitForTools = true,
			extensionFactories = [],
			toolExposure,
			resources,
			withoutToolSearch,
			description,
			instructions,
			...configOptions
		} = options;
		const calls: string[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: {
				url: "http://unused.invalid",
				exposure,
				...(toolExposure ? { toolExposure } : {}),
				...(description ? { description } : {}),
			},
			source: "test",
		};
		// `builtInTools` are the built-in tools active at the start. The MCP extension activates codemode
		// or tool_search.
		const harness = await createHarness({
			initialActiveToolNames: allowedToolNames ?? builtInTools ?? [],
			allowedToolNames,
			excludedToolNames,
			sessionManager,
			extensionFactories: [
				...extensionFactories,
				createCodemodeExtension(),
				...(withoutToolSearch ? [] : [createToolSearchExtension()]),
				createMcpExtension({
					cachePath: tempCachePath(),
					loadConfig: () => ({ servers: [entry], errors: [], ...configOptions }),
					createTransport: () => {
						const pair = createFakeServer(calls, { listTools, resources, instructions });
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		// The first prompt waits only for servers with direct tools; wait for the others here.
		if (waitForTools) {
			await vi.waitFor(() =>
				expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);
		}
		return { harness, calls, servers, notifications };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	/** The `mcp_servers` prompt section as the model currently has it. */
	function serversSection(harness: Harness): string | null | undefined {
		let section: string | null | undefined;
		for (const message of harness.session.messages) {
			if (message.role === "system" && message.sections && MCP_SERVERS_SECTION in message.sections) {
				section = message.sections[MCP_SERVERS_SECTION];
			}
		}
		return section;
	}

	function nestedToolNames(harness: Harness): string[] {
		return harness.session.getCallableToolNames();
	}

	it("keeps MCP tools when --tools names no MCP tool", async () => {
		for (const exposure of ["codemode", "deferred"] as const) {
			const { harness } = await setup(exposure, undefined, {
				allowedToolNames: ["read", "codemode"],
				resources: true,
			});
			expect(harness.session.getActiveToolNames()).toEqual(["read", "codemode"]);
			expect(nestedToolNames(harness)).toEqual(
				expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "list_mcp_resources", "read_mcp_resource"]),
			);
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("bash");
		}

		// A direct MCP tool stays registered but is declared only when --tools names it.
		const { harness } = await setup("codemode", undefined, {
			allowedToolNames: ["codemode"],
			toolExposure: { fail: "direct" },
		});
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__fail"),
		);
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
	});

	it("removes MCP tools with --no-tools", async () => {
		// The first prompt waits for servers with direct tools, so their tools would be registered by then.
		const { harness, servers } = await setup("direct", undefined, { allowedToolNames: [], waitForTools: false });
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");

		expect(servers).toHaveLength(1);
		expect(harness.session.getAllTools()).toEqual([]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("does not declare unnamed MCP tools restored from the transcript", async () => {
		const first = await setup("direct");
		first.harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("second");
		expect(declaredToolNames(first.harness)).toContain("mcp__docs__search");

		// Like `pi --tools read,codemode -c` followed by /tree.
		const second = await setup("direct", undefined, {
			allowedToolNames: ["read", "codemode"],
			sessionManager: first.harness.sessionManager,
		});
		const firstAssistant = second.harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await second.harness.session.navigateTree(firstAssistant.id);

		// The transcript's loadout is restored without the MCP tools it declared.
		expect(second.harness.session.getActiveToolNames()).toEqual([]);
		expect(second.harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search");
	});

	it("lets tool_search declare unnamed MCP tools when --tools names it", async () => {
		const { harness } = await setup("deferred", undefined, { allowedToolNames: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__search"]);
	});

	it("filters MCP tools by the mcp__ entries of --tools", async () => {
		const { harness } = await setup("codemode", undefined, {
			allowedToolNames: ["codemode", "mcp__docs__s*"],
			resources: true,
			toolExposure: { shot: "direct" },
		});
		await vi.waitFor(() => expect(harness.session.getActiveToolNames()).toEqual(["codemode", "mcp__docs__shot"]));
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toEqual(expect.arrayContaining(["mcp__docs__search", "mcp__docs__shot"]));
		expect(registered).not.toContain("mcp__docs__fail");
		expect(registered).not.toContain("list_mcp_resources");
	});

	it("removes MCP tools matching --exclude-tools patterns", async () => {
		const { harness } = await setup("codemode", undefined, {
			allowedToolNames: ["codemode"],
			excludedToolNames: ["mcp__docs__f*"],
		});
		const registered = harness.session.getAllTools().map((tool) => tool.name);
		expect(registered).toContain("mcp__docs__search");
		expect(registered).not.toContain("mcp__docs__fail");
	});

	it("exposes codemode-only MCP tools through codemode and hides them from the model", async () => {
		const { harness, calls } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		// MCP tools resolve to their CallToolResult, errors included.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [a, b] = await Promise.allSettled([
								tools.${searchName}({ query: "mcp" }),
								tools.${searchName}({ query: "pi" }),
							]);
							const failure = await tools.mcp__docs__fail({});
							const shot = await tools.mcp__docs__shot({});
							image(shot.content[0]);
							text(JSON.stringify({
								hits: [...a.value.structuredContent.hits, ...b.value.structuredContent.hits],
								failed: failure.isError,
								failure: failure.content[0].text,
								found: ALL_TOOLS.filter((tool) => tool.name.includes("search")).map((tool) => tool.name),
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search the docs");

		// Exec was activated for the codemode-exposed server; MCP tools are never declared.
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(declaredToolNames(harness)).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toEqual([searchName, "mcp__docs__fail", "mcp__docs__shot"]);
		// The description lists neither the server nor its tools; scripts search for them.
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("mcp__docs");
		expect(codemode?.description).not.toContain("Shared MCP Types:");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		// Output items keep the order the script produced them in; each image follows the path it was saved to.
		const savedPath = /^\[Image saved to (\S+\.png) \(image\/png, \d+B\)\]$/.exec(
			(result.content[1] as { text: string }).text,
		)?.[1];
		expect(savedPath).toBeDefined();
		try {
			expect(readFileSync(savedPath!).toString("base64")).toBe(TINY_PNG_BASE64);
		} finally {
			if (savedPath) rmSync(savedPath, { force: true });
		}
		expect(result.content[2]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		expect(JSON.parse((result.content[3] as { text: string }).text)).toEqual({
			hits: ["mcp guide", "mcp faq", "pi guide", "pi faq"],
			failed: true,
			failure: "server exploded",
			found: [searchName],
		});
		expect(result.content).toHaveLength(4);
		expect(calls).toEqual(['search:{"query":"mcp"}', 'search:{"query":"pi"}', "fail:{}", "shot:{}"]);
	});

	it("keeps codemode-only MCP tools callable across tree navigation", async () => {
		const { harness } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain(searchName);

		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await harness.session.navigateTree(firstAssistant.id);

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain(searchName);
	});

	// Regression: #10239.
	it.each([false, true])("routes tools whose names differ only in - and _ (reverse: %s)", async (reverse) => {
		const tools = [
			{ name: "read-file", description: "dashed", inputSchema: { type: "object", properties: {} } },
			{ name: "read_file", description: "underscored", inputSchema: { type: "object", properties: {} } },
		];
		if (reverse) tools.reverse();
		const { harness, calls } = await setup("codemode", () => [...tools, ...SERVER_TOOLS]);
		const code = `for (const query of ["dashed", "underscored"]) await tools[(await searchTools(query))[0].name]({});`;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(calls).toEqual(["read-file:{}", "read_file:{}"]);
	});

	it("rejects direct model calls to codemode-only MCP tools", async () => {
		const { harness, calls } = await setup("codemode");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Tool mcp__docs__search not found");
		expect(calls).toEqual([]);
	});

	it("declares directly exposed MCP tools to the model", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(declaredToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(harness.session.getActiveToolNames()).not.toContain("codemode");
		// Boolean annotation hints are passed on for permission extensions.
		const annotations = new Map(harness.session.getAllTools().map((tool) => [tool.name, tool.annotations]));
		expect(annotations.get("mcp__docs__fail")).toEqual({ destructiveHint: true, readOnlyHint: false });
		expect(annotations.get("mcp__docs__search")).toBeUndefined();
		const result = toolResult(harness, "mcp__docs__search");
		expect(getMessageText(result)).toBe("direct guide\ndirect faq");
	});

	it.each(["direct", "codemode"] as const)(
		"withdraws and restores %s MCP tools the server changes",
		async (exposure) => {
			let tools = SERVER_TOOLS;
			const { harness, servers } = await setup(exposure, () => tools);
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("start");
			// Direct tools are declared to the model, codemode tools are only callable from codemode.
			const reachable = () =>
				exposure === "direct" ? harness.session.getActiveToolNames() : nestedToolNames(harness);
			const listChanged = async () => {
				await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
				await new Promise((resolve) => setTimeout(resolve, 10));
			};
			expect(reachable()).toContain("mcp__docs__fail");

			tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
			await listChanged();
			expect(reachable()).not.toContain("mcp__docs__fail");
			expect(reachable()).toContain("mcp__docs__search");
			const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
			expect(codemode?.description ?? "").not.toContain("mcp__docs__fail");

			tools = SERVER_TOOLS;
			await listChanged();
			expect(reachable()).toContain("mcp__docs__fail");
		},
	);

	it("lists and reads resources with Codex's resource tools", async () => {
		const { harness, calls } = await setup("direct", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("list_mcp_resources", {}),
					fauxToolCall("list_mcp_resource_templates", { server: "docs" }),
					fauxToolCall("read_mcp_resource", { server: "docs", uri: "docs://pages/setup" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("read_mcp_resource", { server: "nope", uri: "docs://x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		// The resource tools take the exposure of the servers they reach.
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]),
		);
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resources")))).toEqual({
			resources: [{ server: "docs", uri: "docs://intro", name: "intro", mimeType: "text/markdown" }],
		});
		expect(JSON.parse(getMessageText(toolResult(harness, "list_mcp_resource_templates")))).toEqual({
			server: "docs",
			resourceTemplates: [{ server: "docs", uriTemplate: "docs://pages/{slug}", name: "page" }],
		});
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage =>
				message.role === "toolResult" && message.toolName === "read_mcp_resource",
		);
		expect(getMessageText(results[0])).toBe("# docs://pages/setup");
		expect(results[1].isError).toBe(true);
		expect(getMessageText(results[1])).toBe('MCP server "nope" has no resources. Servers with resources: docs');
		expect(calls).toEqual(["read:docs://pages/setup"]);
		const annotations = harness.session.getAllTools().find((tool) => tool.name === "read_mcp_resource");
		expect(annotations?.annotations).toEqual({ readOnlyHint: true });
	});

	it("makes the resource tools callable from codemode for codemode servers", async () => {
		const { harness, calls } = await setup("codemode", undefined, { resources: true });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `const listed = await tools.list_mcp_resources({ server: "docs" });
const read = await tools.read_mcp_resource({ server: "docs", uri: listed.resources[0].uri });
return { uris: listed.resources.map((r) => r.uri), text: read.contents[0].text };`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read");

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(JSON.parse(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1) ?? "")).toEqual({
			uris: ["docs://intro"],
			text: "# docs://intro",
		});
		expect(calls).toEqual(["read:docs://intro"]);
	});

	it("applies per-tool exposure overrides", async () => {
		const { harness } = await setup("hidden", undefined, { toolExposure: { search: "direct", "s*": "codemode" } });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		// `search` is declared, `shot` is only callable from codemode, `fail` keeps the server's `hidden`.
		expect(declaredToolNames(harness)).toEqual(["codemode", "mcp__docs__search"]);
		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__shot"]);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "codemode");
		expect(codemode?.description).not.toContain("mcp__docs__shot");
		expect(codemode?.description).not.toContain("mcp__docs__fail");
	});

	it("describes the server with its configured description and returns its instructions to scripts", async () => {
		const { harness } = await setup("codemode", undefined, {
			description: "Search the product docs",
			instructions: "Always search before reading.",
			builtInTools: ["tool_search"],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `const docs = await describeNamespace("mcp__docs");
const aliases = await Promise.all(["docs", "mcp__docs"].map((name) => describeNamespace(name)));
return { docs, sameForAliases: aliases.every((alias) => JSON.stringify(alias) === JSON.stringify(docs)), none: await describeNamespace("mcp__nope") };`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// The instructions stay out of every tool description.
		const description = (name: string) =>
			harness.session.agent.state.tools.find((tool) => tool.name === name)?.description ?? "";
		expect(description("codemode")).not.toContain("mcp__docs");
		expect(description("tool_search")).toBe(TOOL_SEARCH_DESCRIPTION);
		for (const name of ["codemode", "tool_search"]) expect(description(name)).not.toContain("Always search");
		expect(JSON.parse(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1) ?? "")).toEqual({
			docs: {
				name: "mcp__docs",
				description: "Search the product docs",
				instructions: "Always search before reading.",
				tools: ["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"],
			},
			sameForAliases: true,
		});
		// The system prompt lists the server with its configured description rather than its instructions.
		expect(serversSection(harness)).toContain("- mcp__docs (codemode): Search the product docs");
	});

	it("lists servers by the first line of their instructions without a configured description", async () => {
		const { harness } = await setup("deferred", undefined, { instructions: "Docs search.\nLong guidance." });
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		const section = serversSection(harness);
		expect(section).toContain("- mcp__docs (tool_search): Docs search.\n");
		expect(section).not.toContain("Long guidance");
	});

	it("does not activate codemode when autoEnableCodemode is false", async () => {
		const { harness, notifications } = await setup("codemode", undefined, { autoEnableCodemode: false });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
		expect(notifications).toEqual([
			"MCP tools are only reachable from the codemode or tool_search tool, but neither is active (autoEnableCodemode is false); they cannot be called.",
		]);
	});

	it("treats codemode MCP tools as reachable through an active tool_search", async () => {
		const { harness, notifications } = await setup("codemode", undefined, {
			autoEnableCodemode: false,
			builtInTools: ["tool_search"],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", "mcp__docs__search"]);
		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("loaded guide\nloaded faq");
		expect(notifications).toEqual([]);
	});

	it("reaches deferred MCP tools through codemode when tool_search is not available", async () => {
		const { harness, notifications } = await setup("deferred", undefined, {
			builtInTools: ["codemode"],
			withoutToolSearch: true,
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
		expect(notifications).toEqual([]);
	});

	it("warns when deferred MCP tools have neither tool_search nor codemode", async () => {
		const { harness, notifications } = await setup("deferred", undefined, { withoutToolSearch: true });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual([
			"MCP tools are only reachable from the codemode or tool_search tool, but neither is active; they cannot be called.",
		]);
	});

	it("tells scripts what directly exposed MCP tools resolve to", async () => {
		const { harness } = await setup("direct");
		harness.session.setActiveToolsByName([...harness.session.getActiveToolNames(), "codemode"]);
		const search = harness.session.agent.state.tools.find((tool) => tool.name === "mcp__docs__search");
		const fail = harness.session.agent.state.tools.find((tool) => tool.name === "mcp__docs__fail");
		expect(search?.description).toContain(
			"Codemode: `tools.mcp__docs__search(args)` resolves to `{ content, structuredContent?: { hits }, isError? }`.",
		);
		expect(fail?.description).toContain(
			"Codemode: `tools.mcp__docs__fail(args)` resolves to `{ content, structuredContent?, isError? }`.",
		);
	});

	it("activates another extension's codemode tool when it reaches other tools", async () => {
		const otherExec: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "codemode",
				label: "codemode",
				description: "Another extension's codemode tool.",
				parameters: Type.Object({}),
				defaultActive: false,
				reachesTools: () => "all",
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const { harness } = await setup("codemode", undefined, { extensionFactories: [otherExec] });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["codemode"]);
	});

	it("does not activate another extension's tool named codemode", async () => {
		// Registered first, so it wins over the codemode extension's codemode.
		const otherExec: ExtensionFactory = (pi) => {
			pi.registerTool({
				name: "codemode",
				label: "codemode",
				description: "Another extension's codemode tool.",
				parameters: Type.Object({}),
				defaultActive: false,
				execute: async () => ({ content: [], details: undefined }),
			});
		};
		const { harness } = await setup("codemode", undefined, { extensionFactories: [otherExec] });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	/** A server named `slow` whose answer to `initialize` takes `initializeDelayMs`, without waiting for it. */
	async function setupSlow(
		config: {
			exposure?: McpExposure;
			toolExposure?: Record<string, McpExposure>;
			name?: string;
			instructions?: string;
		},
		initializeDelayMs: number,
		startupWaitMs?: number,
	) {
		const calls: string[] = [];
		const notifications: string[] = [];
		const { name = "slow", instructions, ...serverConfig } = config;
		const entry: McpServerEntry = { name, config: { url: "http://unused.invalid", ...serverConfig }, source: "test" };
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createCodemodeExtension(),
				createToolSearchExtension(),
				createMcpExtension({
					cachePath: tempCachePath(),
					loadConfig: () => ({ servers: [entry], errors: [] }),
					createTransport: () => {
						const pair = createFakeServer(calls, { initializeDelayMs, instructions });
						void pair.server.start();
						return pair.client;
					},
					...(startupWaitMs === undefined ? {} : { startupWaitMs }),
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		return { harness, calls, notifications };
	}

	it("does not hold the first prompt for codemode servers that are still connecting", async () => {
		// The server never answers `initialize`.
		const { harness } = await setupSlow({}, Number.POSITIVE_INFINITY);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		// Codemode is activated from the config, before the server connects.
		expect(declaredToolNames(harness)).toEqual(["codemode"]);
	});

	it("keeps the codemode description unchanged when the server connects", async () => {
		const { harness } = await setupSlow({}, 20);
		const description = () => harness.session.agent.state.tools.find((tool) => tool.name === "codemode")?.description;
		const before = description();
		expect(before).toBeDefined();
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		expect(description()).toBe(before);
	});

	it("lists a server before it connects and appends its summary with the next prompt", async () => {
		const { harness } = await setupSlow({ instructions: "Slow docs.\nMore." }, 30);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

		await harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__slow__search"));
		await harness.session.prompt("second");

		const systemMessages = harness.session.messages.filter(
			(message): message is SystemMessage => message.role === "system",
		);
		// The first request lists the server by name; its summary follows as an appended patch.
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[0].sections?.[MCP_SERVERS_SECTION]).toContain("- mcp__slow (codemode)\n");
		expect(systemMessages[1].sections).toEqual({
			[MCP_SERVERS_SECTION]: expect.stringContaining("- mcp__slow (codemode): Slow docs."),
		});
		expect(harness.session.messages.indexOf(systemMessages[1])).toBeGreaterThan(
			harness.session.messages.findIndex((message) => message.role === "assistant"),
		);
	});

	it("waits for servers with direct tools before listing the servers", async () => {
		const { harness } = await setupSlow(
			{ exposure: "direct", toolExposure: { shot: "codemode" }, instructions: "Slow docs." },
			30,
		);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toContain("- mcp__slow (codemode): Slow docs.");
	});

	it("leaves servers with only direct tools out of the servers section", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 0);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(serversSection(harness)).toBeUndefined();
	});

	it("waits for the servers a codemode script names", async () => {
		const { harness, calls } = await setupSlow({}, 30);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `return (await tools.mcp__slow__search({ query: "q" })).structuredContent;`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(JSON.parse(getMessageText(result).split("\n").at(-1) ?? "")).toEqual({ hits: ["q guide", "q faq"] });
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("waits for servers whose script identifiers differ from their names", async () => {
		const { harness, calls } = await setupSlow({ name: "slow-docs" }, 30);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `await tools.mcp__slow_docs__search({ query: "q" });
const names = ["slow-docs", "slow_docs", "mcp__slow-docs", "mcp__slow_docs"];
return [...new Set(await Promise.all(names.map(async (name) => (await describeNamespace(name))?.name)))];`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(toolResult(harness, "codemode").isError).toBe(false);
		expect(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1)).toBe('["mcp__slow_docs"]');
		expect(calls).toEqual(['search:{"query":"q"}']);
	});

	it("does not wait for servers a codemode script does not name", async () => {
		const { harness } = await setupSlow({}, Number.POSITIVE_INFINITY);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("codemode", { code: "return 1 + 1;" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1)).toBe("2");
	});

	it("waits for servers before tool_search searches", async () => {
		const { harness } = await setupSlow({ exposure: "deferred" }, 30);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall("mcp__slow__search", { query: "late" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "mcp__slow__search"))).toBe("late guide\nlate faq");
	});

	it("holds the first prompt for servers with direct tools", async () => {
		const { harness } = await setupSlow({ exposure: "direct" }, 30);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(declaredToolNames(harness)).toContain("mcp__slow__search");
	});

	it("holds the first prompt for servers with direct tools only up to startupWaitMs", async () => {
		const { harness, notifications } = await setupSlow({ exposure: "direct" }, Number.POSITIVE_INFINITY, 20);
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(getAssistantTexts(harness)).toEqual(["ready"]);
		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(notifications).toEqual(["MCP servers are still connecting; their tools become available once connected."]);
	});

	it("does not let codemode call itself or inactive direct tools", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		harness.session.setActiveToolsByName(["codemode", "mcp__docs__search"]);

		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search"]);
	});

	it("finds tools from scripts with searchTools() and describeTool()", async () => {
		const { harness, calls } = await setup("codemode");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `
							const [match] = await searchTools("search the docs", { limit: 1 });
							const none = await searchTools("docs", { namespace: "mcp__other" });
							const declaration = await describeTool(match.name);
							const result = await tools[match.name]({ query: "found" });
							text(JSON.stringify({
								name: match.name,
								sameAsAllTools: ALL_TOOLS.find((tool) => tool.name === match.name).description === match.description,
								none: none.length,
								declared: declaration.includes("codemode tool declaration:"),
								missing: (await describeTool("nope")) === undefined,
								hits: result.structuredContent.hits,
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "codemode");
		expect(result.isError).toBe(false);
		expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({
			name: "mcp__docs__search",
			sameAsAllTools: true,
			none: 0,
			declared: true,
			missing: true,
			hits: ["found guide", "found faq"],
		});
		expect(calls).toEqual(['search:{"query":"found"}']);
	});

	it("activates tool_search for deferred MCP tools and keeps loaded tools declared on the branch", async () => {
		// No built-in tools are active; the MCP extension activates tool_search, not codemode.
		const { harness, calls } = await setup("deferred");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall(searchName, { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find a docs tool");

		expect(harness.session.getActiveToolNames()).toEqual(["tool_search", searchName]);
		// The description does not depend on the connected servers.
		const toolSearch = harness.session.agent.state.tools.find((tool) => tool.name === "tool_search");
		expect(toolSearch?.description).toBe(TOOL_SEARCH_DESCRIPTION);

		const search = toolResult(harness, "tool_search");
		expect(getMessageText(search)).toBe(
			`Loaded 1 tool. They are available from your next call:\n- ${searchName}: Search the docs.`,
		);
		// Only the loaded tool is added; earlier declarations are not repeated.
		const loadMessages = harness.session.messages.filter(
			(message): message is SystemMessage =>
				message.role === "system" && (message.toolsAdded ?? []).some((tool) => tool.name === searchName),
		);
		expect(loadMessages).toHaveLength(1);
		expect(loadMessages[0].toolsAdded?.map((tool) => tool.name)).toEqual([searchName]);
		expect(getMessageText(toolResult(harness, searchName))).toBe("loaded guide\nloaded faq");
		expect(calls).toEqual(['search:{"query":"loaded"}']);

		// Loads are recorded in the transcript: navigating back before the load drops the tool,
		// navigating to a later entry restores it.
		const branch = harness.sessionManager.getBranch();
		const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const last = branch.at(-1);
		if (!firstUser || !last) throw new Error("Missing entries");
		await harness.session.navigateTree(firstUser.id);
		expect(harness.session.getActiveToolNames()).not.toContain(searchName);
		await harness.session.navigateTree(last.id);
		expect(harness.session.getActiveToolNames()).toContain(searchName);
	});

	it("finds nothing to load when every matching tool is already declared", async () => {
		const { harness } = await setup("direct", undefined, { builtInTools: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(toolResult(harness, "tool_search"))).toBe("No matching tools found.");
	});
});

describe("AgentSession MCP servers registered by extensions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** `configured` are the mcp.json servers; `plugins` register servers through the extension API. */
	async function setup(plugins: ExtensionFactory | ExtensionFactory[], configured: McpServerEntry[] = []) {
		const connected: McpServerEntry[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				...(Array.isArray(plugins) ? plugins : [plugins]),
				createCodemodeExtension(),
				createMcpExtension({
					cachePath: tempCachePath(),
					loadConfig: () => ({ servers: configured, errors: [] }),
					createTransport: (entry) => {
						connected.push(entry);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	it("connects servers registered while extensions load", async () => {
		const { harness, connected } = await setup((pi) => {
			pi.registerMcpServer("plugin", { url: "http://plugin.invalid", exposure: "direct" });
		});
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(connected.map((entry) => [entry.name, entry.scope])).toEqual([["plugin", "extension"]]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__plugin__search");
	});

	it("connects and disconnects servers registered during the session", async () => {
		let api: ExtensionAPI | undefined;
		const { harness, connected } = await setup((pi) => {
			api = pi;
		});
		if (!api) throw new Error("No extension API");
		const pi = api;

		pi.registerMcpServer("late", { url: "http://late.invalid" });
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).toContain("mcp__late__search"));
		expect(connected.map((entry) => entry.name)).toEqual(["late"]);
		// Codemode-exposed tools need the codemode tool, which is activated for them.
		expect(harness.session.getActiveToolNames()).toContain("codemode");

		pi.unregisterMcpServer("late");
		await vi.waitFor(() => expect(harness.session.getCallableToolNames()).not.toContain("mcp__late__search"));
	});

	// "my_docs" shares the namespace of "my-docs" (#10239).
	it.each(["my-docs", "my_docs"])("prefers the mcp.json server over a registered %s", async (name) => {
		const configured: McpServerEntry = {
			name: "my-docs",
			config: { url: "http://config.invalid" },
			source: "mcp.json",
		};
		const { connected } = await setup(
			(pi) => {
				pi.registerMcpServer(name, { url: "http://plugin.invalid" });
			},
			[configured],
		);
		await vi.waitFor(() => expect(connected).toEqual([configured]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(connected).toEqual([configured]);
	});

	it("rejects names another extension registered", async () => {
		const errors: string[] = [];
		await setup([
			(pi) => {
				pi.registerMcpServer("taken", { url: "http://x.invalid" });
				// Registering again replaces the extension's own registration.
				pi.registerMcpServer("taken", { url: "http://y.invalid" });
				pi.registerMcpServer("my-server", { url: "http://x.invalid" });
			},
			(pi) => {
				for (const name of ["taken", "my_server"]) {
					try {
						pi.registerMcpServer(name, { url: "http://z.invalid" });
					} catch (caught) {
						errors.push(String(caught));
					}
				}
			},
		]);
		expect(errors).toEqual([
			expect.stringMatching(/MCP server "taken" is already registered by extension/),
			// Names that differ only in - and _ share a namespace (#10239).
			'Error: MCP server "my_server" conflicts with registered server "my-server"',
		]);
	});

	it("reports registered servers when no extension connects them", async () => {
		const harness = await createHarness({
			extensionFactories: [(pi) => pi.registerMcpServer("orphan", { url: "http://orphan.invalid" })],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });

		expect(errors).toEqual([expect.stringContaining('MCP server "orphan" is registered, but no loaded extension')]);
	});
});

describe("AgentSession MCP tools after resume and reload", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/**
	 * A deferred `docs` server that answers `initialize` after `initializeDelayMs`; `connected` counts
	 * its connections. `/reload` loads the extensions again.
	 */
	async function setup(
		sessionManager?: SessionManager,
		extensionFactories: ExtensionFactory[] = [],
		initializeDelayMs = 0,
	) {
		const connected: string[] = [];
		const servers: McpServerEntry[] = [
			{ name: "docs", config: { url: "http://unused.invalid", exposure: "deferred" }, source: "test" },
		];
		const factories = [
			...extensionFactories,
			createToolSearchExtension(),
			createMcpExtension({
				cachePath: tempCachePath(),
				loadConfig: () => ({ servers, errors: [] }),
				createTransport: (entry) => {
					connected.push(entry.name);
					const pair = createFakeServer([], { initializeDelayMs });
					void pair.server.start();
					return pair.client;
				},
			}),
		];
		let extensions = await createTestExtensionsResult(factories);
		const resourceLoader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult(factories);
			},
		};
		const harness = await createHarness({ resourceLoader, sessionManager });
		harnesses.push(harness);
		// `/reload` emits session_start only to bound extensions.
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return { harness, connected };
	}

	async function loadDocsSearch(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("loaded"),
		]);
		await harness.session.prompt("load");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
	}

	it("declares tools tool_search loaded again on resume once their server connects", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		// The session restores its tools before the server connects again.
		const second = await setup(first.harness.sessionManager);
		await vi.waitFor(() => expect(second.harness.session.getActiveToolNames()).toContain("mcp__docs__search"));
		second.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "again" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await second.harness.session.prompt("use it");

		expect(getMessageText(toolResult(second.harness, "mcp__docs__search"))).toBe("again guide\nagain faq");
		const removals = second.harness.session.messages.filter(
			(message) => message.role === "system" && (message.toolsRemoved ?? []).length > 0,
		);
		expect(removals).toEqual([]);
	});

	it.each([
		["drops", ["read"], undefined, false],
		["keeps", undefined, undefined, true],
		["keeps with keepPendingTools", ["read"], { keepPendingTools: true }, true],
	] as const)(
		"%s restored tools when an extension sets the loadout before they register",
		async (_, loadout, options, kept) => {
			const first = await setup();
			await loadDocsSearch(first.harness);

			// Like plan mode restoring its tools, or an extension adding one to the current loadout.
			const setLoadout: ExtensionFactory = (pi) => {
				pi.on("session_start", () =>
					pi.setActiveTools(loadout ? [...loadout] : [...pi.getActiveTools(), "read"], options),
				);
			};
			const second = await setup(first.harness.sessionManager, [setLoadout]);
			await vi.waitFor(() =>
				expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
			);

			expect(second.harness.session.getActiveToolNames().includes("mcp__docs__search")).toBe(kept);
		},
	);

	it("does not activate restored tools that register after the next prompt starts", async () => {
		const first = await setup();
		await loadDocsSearch(first.harness);

		// The first prompt does not wait for servers without direct tools.
		const second = await setup(first.harness.sessionManager, [], 200);
		second.harness.setResponses([fauxAssistantMessage("done")]);
		await second.harness.session.prompt("go");
		await vi.waitFor(() =>
			expect(second.harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__search")).toBe(true),
		);

		expect(second.harness.session.getActiveToolNames()).not.toContain("mcp__docs__search");
	});

	it("declares tools tool_search loaded again after /reload from the cache, without connecting", async () => {
		const { harness, connected } = await setup();
		await loadDocsSearch(harness);

		await harness.session.reload();

		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(connected).toEqual(["docs"]);
	});
});

describe("AgentSession lazy MCP servers", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: {
			config?: Partial<McpServerConfig>;
			cache?: "current" | "day-old" | "other-config" | "none";
			scope?: McpServerEntry["scope"];
			listTools?: () => unknown[];
			callDelayMs?: number;
			cachedTools?: unknown[];
		} = {},
	) {
		const { cache = "current", scope, listTools, callDelayMs, cachedTools = SERVER_TOOLS } = options;
		const config = { url: "http://unused.invalid", exposure: "direct", ...options.config } as McpServerConfig;
		const cachePath = tempCachePath();
		if (cache !== "none") {
			const hashed = cache === "other-config" ? { ...config, url: "http://other.invalid" } : config;
			writeMcpCacheEntry(cachePath, "docs", {
				configHash: mcpConfigHash(hashed),
				fetchedAt: cache === "day-old" ? Date.now() - 2 * 24 * 60 * 60 * 1000 : Date.now(),
				tools: cachedTools as McpCacheEntry["tools"],
			});
		}
		const calls: string[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		let spawned = 0;
		let closed = 0;
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createCodemodeExtension(),
				createToolSearchExtension(),
				createMcpExtension({
					cachePath,
					loadConfig: () => ({ servers: [{ name: "docs", config, source: "test", scope }], errors: [] }),
					createTransport: () => {
						spawned++;
						const pair = createFakeServer(calls, { listTools, callDelayMs });
						pair.client.onClose(() => closed++);
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
		});
		const status = async () => {
			notifications.length = 0;
			await harness.session.prompt("/mcp");
			return notifications.join("\n");
		};
		return {
			harness,
			calls,
			servers,
			config,
			cachePath,
			spawned: () => spawned,
			open: () => spawned - closed,
			status,
		};
	}

	function callSearch(harness: Harness, query: string) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		return harness.session.prompt(`search ${query}`);
	}

	it("registers a lazy server's tools from the cache without connecting", async () => {
		const { harness, spawned, status } = await setup();
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(await status()).toBe("docs: idle, connects on next call, 3 tools (direct) from test");
		expect(spawned()).toBe(0);
	});

	it("registers a lazy server from cached tools whose optional fields are null", async () => {
		const nulled = SERVER_TOOLS.map((tool) => ({
			...tool,
			description: null,
			title: null,
			outputSchema: null,
			annotations: null,
		}));
		const { harness, spawned } = await setup({ cachedTools: nulled });
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(spawned()).toBe(0);
	});

	it("connects a lazy server on its first call, once for calls that race", async () => {
		const { harness, calls, spawned, status } = await setup({ config: { exposure: "codemode" } });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: `const results = await Promise.all(["a", "b"].map((query) => tools.mcp__docs__search({ query })));
return results.map((result) => result.structuredContent.hits[0]);`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(getMessageText(toolResult(harness, "codemode")).split("\n").at(-1)).toBe('["a guide","b guide"]');
		expect(calls).toEqual(['search:{"query":"a"}', 'search:{"query":"b"}']);
		expect(spawned()).toBe(1);
		expect(await status()).toBe("docs: connected, 3 tools (codemode) from test");
	});

	it("rewrites the cache entry when the server's tool list changes", async () => {
		let tools = SERVER_TOOLS;
		const { harness, servers, cachePath, config } = await setup({ listTools: () => tools });
		await callSearch(harness, "first");
		const cachedTools = () =>
			readMcpCache(cachePath)
				.get("docs")
				?.tools.map((tool) => tool.name);
		expect(readMcpCache(cachePath).get("docs")?.configHash).toBe(mcpConfigHash(config));

		tools = [
			...SERVER_TOOLS,
			{ name: "extra", description: "New.", inputSchema: { type: "object", properties: {} } },
		];
		await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

		await vi.waitFor(() => expect(cachedTools()).toEqual(["search", "fail", "shot", "extra"]));
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__extra");
	});

	it("closes a lazy server after idleTimeoutMinutes and reconnects on the next call", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
		const { harness, spawned, open, status } = await setup({ config: { idleTimeoutMinutes: 1 } });
		await callSearch(harness, "first");
		expect(open()).toBe(1);

		await vi.advanceTimersByTimeAsync(59_000);
		expect(open()).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(open()).toBe(0);
		expect(await status()).toBe("docs: idle, connects on next call, 3 tools (direct) from test");

		await callSearch(harness, "again");
		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("again guide\nagain faq");
		expect(spawned()).toBe(2);
	});

	it("keeps a lazy server connected while a call runs past the idle timeout", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
		const { harness, open } = await setup({ config: { idleTimeoutMinutes: 1, timeout: 120 }, callDelayMs: 90_000 });

		const call = callSearch(harness, "slow");
		await vi.waitFor(() => expect(open()).toBe(1));
		await vi.advanceTimersByTimeAsync(90_000);
		await call;

		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("slow guide\nslow faq");
		expect(open()).toBe(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(open()).toBe(0);
	});

	it("connects at startup when the cache entry belongs to another config", async () => {
		const { cachePath, config, spawned } = await setup({ cache: "other-config" });

		await vi.waitFor(() => expect(readMcpCache(cachePath).get("docs")?.configHash).toBe(mcpConfigHash(config)));
		expect(spawned()).toBe(1);
	});

	it("refreshes a day-old cache entry on the next call, not at startup", async () => {
		const { harness, cachePath, spawned } = await setup({ cache: "day-old" });
		harness.setResponses([fauxAssistantMessage("ready")]);

		await harness.session.prompt("start");
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(harness.session.getActiveToolNames()).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(spawned()).toBe(0);
		await callSearch(harness, "q");
		expect(readMcpCache(cachePath).get("docs")?.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
		expect(spawned()).toBe(1);
	});

	it("connects a server whose cache entry is corrupt and still starts later servers from the cache", async () => {
		const cachePath = tempCachePath();
		const docs = { url: "http://docs.invalid", exposure: "direct" } as McpServerConfig;
		const notes = { url: "http://notes.invalid", exposure: "direct" } as McpServerConfig;
		const fetchedAt = Date.now();
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 1,
				servers: {
					docs: { configHash: mcpConfigHash(docs), fetchedAt, tools: [{ ...SERVER_TOOLS[0], description: 5 }] },
					notes: { configHash: mcpConfigHash(notes), fetchedAt, tools: SERVER_TOOLS },
				},
			}),
		);
		const connected: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					cachePath,
					loadConfig: () => ({
						servers: [
							{ name: "docs", config: docs, source: "test" },
							{ name: "notes", config: notes, source: "test" },
						],
						errors: [],
					}),
					createTransport: (entry) => {
						connected.push(entry.name);
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });

		await vi.waitFor(() =>
			expect(readMcpCache(cachePath).get("docs")?.tools[0]?.description).toBe("Search the docs."),
		);
		expect(connected).toEqual(["docs"]);
		expect(harness.session.getActiveToolNames()).toContain("mcp__notes__search");
	});

	it.each([
		["eager servers with a cache entry", { config: { lifecycle: "eager" as const } }],
		["lazy servers without a cache entry", { cache: "none" as const }],
		["project servers with the entry of another project", { scope: "project" as const }],
	])("connects %s at startup", async (_, options) => {
		const { harness, spawned, open } = await setup(options);
		await vi.waitFor(() => expect(open()).toBe(1));

		await callSearch(harness, "q");

		expect(getMessageText(toolResult(harness, "mcp__docs__search"))).toBe("q guide\nq faq");
		expect(spawned()).toBe(1);
	});

	it.each([
		["never", 1],
		["writes", 0],
		["always", 0],
	] as const)(
		"warms up a deferred server loaded by tool_search only when approve is never (%s)",
		async (approve, expected) => {
			const { harness, spawned } = await setup({ config: { exposure: "deferred", approve } });
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("find the docs tool");

			expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(spawned()).toBe(expected);
		},
	);

	it("closes every connection on session shutdown, also when shut down twice", async () => {
		const { harness, open } = await setup();
		await callSearch(harness, "q");
		expect(open()).toBe(1);

		const shutdown = () =>
			emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		await shutdown();
		await shutdown();

		expect(open()).toBe(0);
	});
});

describe("AgentSession MCP config sources", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function writeJson(path: string, value: unknown) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(value));
	}

	function writeSources() {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-sources-"));
		dirs.push(root);
		const homeDir = join(root, "home");
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const files = {
			shared: join(homeDir, ".config", "mcp", "mcp.json"),
			agent: join(agentDir, "mcp.json"),
			dotMcp: join(cwd, ".mcp.json"),
			project: join(cwd, CONFIG_DIR_NAME, "mcp.json"),
		};
		const server = (file: string) => ({ command: "node", args: [file] });
		writeJson(files.shared, { mcpServers: { all: server("shared"), "shared-only": server("shared") } });
		writeJson(files.agent, { mcpServers: { all: server("agent"), "agent-only": server("agent") } });
		writeJson(files.dotMcp, {
			mcpServers: {
				all: server("dot-mcp"),
				"dot-mcp-only": server("dot-mcp"),
				"dot-mcp-never": { ...server("dot-mcp"), approve: "never" },
			},
		});
		writeJson(files.project, { mcpServers: { all: server("project"), "agent-only": { approve: "always" } } });
		return { homeDir, agentDir, cwd, files };
	}

	it("merges ~/.config/mcp, the agent dir, .mcp.json, and the project file, later files winning", () => {
		const { files, ...options } = writeSources();
		const loaded = loadMcpConfig({ ...options, projectTrusted: true });

		expect(loaded.errors).toEqual([]);
		const byName = new Map(loaded.servers.map((entry) => [entry.name, entry]));
		expect(byName.get("all")).toMatchObject({ source: files.project, config: { args: ["project"] } });
		expect(byName.get("shared-only")).toMatchObject({ source: files.shared, scope: "global" });
		expect(byName.get("agent-only")).toMatchObject({ source: files.agent, override: files.project });
		expect(byName.get("agent-only")?.config.approve).toBe("always");
		expect(byName.get("dot-mcp-only")).toMatchObject({ source: files.dotMcp, scope: "project" });
		expect(byName.get("dot-mcp-only")?.config.approve).toBe("writes");
		expect(byName.get("dot-mcp-never")?.config.approve).toBe("writes");
		expect(byName.get("shared-only")?.config.approve).toBeUndefined();
	});

	it("ignores .mcp.json and the project file in an untrusted project", () => {
		const { files, ...options } = writeSources();
		const loaded = loadMcpConfig({ ...options, projectTrusted: false });

		expect(loaded.servers.map((entry) => entry.name).sort()).toEqual(["agent-only", "all", "shared-only"]);
		expect(loaded.servers.find((entry) => entry.name === "all")?.source).toBe(files.agent);
	});

	it("lists a trusted project's .mcp.json servers in /mcp with their source and approval", async () => {
		const { files, ...options } = writeSources();
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({
					cachePath: tempCachePath(),
					loadConfig: () => loadMcpConfig({ ...options, projectTrusted: true }),
					createTransport: () => {
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
			});
			await harness.session.prompt("/mcp");

			expect(notifications.at(-1)).toContain(
				`dot-mcp-only: connected, 3 tools (codemode, approve writes) from ${files.dotMcp}`,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("reports project servers that replace user servers at session start, in /mcp, and in its status", async () => {
		const { files, ...options } = writeSources();
		writeJson(files.agent, { mcpServers: { all: { command: "node", args: ["agent"] } } });
		writeJson(files.dotMcp, { mcpServers: { all: { command: "node", args: ["dot-mcp"] } } });
		writeJson(files.project, { mcpServers: {} });
		writeJson(files.shared, { mcpServers: {} });
		const notifications: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({
					cachePath: tempCachePath(),
					loadConfig: () => loadMcpConfig({ ...options, projectTrusted: true }),
					createTransport: () => {
						const pair = createFakeServer([]);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notifications.push(message) }),
			});
			const notice = `${files.dotMcp}: server "all" replaces the one in ${files.agent}`;
			expect(notifications).toContain(`MCP: ${notice}`);

			notifications.length = 0;
			await harness.session.prompt("/mcp");
			expect(notifications.join("\n")).toContain(`replaced: ${notice}`);
		} finally {
			harness.cleanup();
		}
	});
});

describe("AgentSession MCP approval", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	const APPROVAL_TOOLS = SERVER_TOOLS.filter((tool) => tool.name === "search" || tool.name === "shot").map((tool) =>
		tool.name === "search" ? { ...tool, annotations: { readOnlyHint: true } } : tool,
	);

	async function setup(
		options: {
			approve?: string;
			exposure?: McpExposure;
			answers?: string[];
			printMode?: boolean;
			sessionManager?: SessionManager;
			agentDir?: string;
			/** Define the server in the session's `.mcp.json` instead of the agent dir, in a trusted project. */
			dotMcp?: { approve?: string };
			/** Runs with the session's directory after the harness exists and before the session starts. */
			prepare?: (cwd: string, agentDir: string) => void;
		} = {},
	) {
		const { approve = "writes", exposure = "direct", answers = [], printMode = false, sessionManager } = options;
		const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "pi-mcp-approval-"));
		if (!options.agentDir) {
			dirs.push(agentDir);
			if (!options.dotMcp) {
				writeFileSync(
					join(agentDir, "mcp.json"),
					JSON.stringify({ mcpServers: { docs: { command: "unused", exposure, approve } } }),
				);
			}
		}
		const calls: string[] = [];
		const prompts: { title: string; options: string[] }[] = [];
		const notices: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: [],
			sessionManager,
			extensionFactories: [
				createCodemodeExtension(),
				createMcpExtension({
					cachePath: tempCachePath(),
					approvalsPath: join(agentDir, "mcp-approvals.json"),
					loadConfig: (ctx) =>
						loadMcpConfig({
							agentDir,
							cwd: ctx.cwd,
							projectTrusted: options.dotMcp !== undefined,
							homeDir: agentDir,
						}),
					createTransport: () => {
						const pair = createFakeServer(calls, { listTools: () => APPROVAL_TOOLS });
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		if (options.dotMcp) {
			writeFileSync(
				join(harness.tempDir, ".mcp.json"),
				JSON.stringify({
					mcpServers: { docs: { command: "unused", exposure, ...options.dotMcp } },
				}),
			);
		}
		options.prepare?.(harness.tempDir, agentDir);
		const unused = async (): Promise<never> => {
			throw new Error("not used");
		};
		await harness.session.bindExtensions(
			printMode
				? {
						mode: "print",
						// As print mode binds them: commands that wait for idle wait for the run they started.
						commandContextActions: {
							waitForIdle: () => harness.session.waitForIdle(),
							newSession: unused,
							fork: unused,
							navigateTree: unused,
							switchSession: unused,
							reload: unused,
						},
					}
				: {
						uiContext: createTestUiContext({
							select: async (title, choices) => {
								prompts.push({ title, options: choices });
								return answers.shift();
							},
							notify: (message) => notices.push(message),
						}),
					},
		);
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().some((tool) => tool.name === "mcp__docs__shot")).toBe(true),
		);
		return { harness, calls, prompts, notices, agentDir, cwd: harness.tempDir };
	}

	const approvalsFile = (agentDir: string) => join(agentDir, "mcp-approvals.json");
	const readApprovals = (agentDir: string) => JSON.parse(readFileSync(approvalsFile(agentDir), "utf8"));
	const DOCS_HASH = mcpConfigHash({ command: "unused" });

	function call(harness: Harness, tool: string) {
		const args: Record<string, string> = tool === "mcp__docs__search" ? { query: "q" } : {};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		return harness.session.prompt(`call ${tool}`);
	}

	const lastResult = (harness: Harness, tool: string) => {
		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === tool,
		);
		return results.at(-1);
	};

	it("asks before write tools of a writes server, not before read-only tools", async () => {
		const { harness, calls, prompts } = await setup({ answers: ["Allow once"] });

		await call(harness, "mcp__docs__search");
		expect(prompts).toEqual([]);

		await call(harness, "mcp__docs__shot");
		expect(prompts).toEqual([
			{
				title: 'Allow MCP server "docs" to run "shot"?\n{}',
				options: ["Allow once", "Allow for this session", "Always allow this server", "Deny"],
			},
		]);
		expect(calls).toEqual(['search:{"query":"q"}', "shot:{}"]);
	});

	it("asks for every call with approve always and for none with approve never", async () => {
		const always = await setup({ approve: "always", answers: ["Allow once"] });
		await call(always.harness, "mcp__docs__search");
		expect(always.prompts).toHaveLength(1);

		const never = await setup({ approve: "never" });
		await call(never.harness, "mcp__docs__shot");
		expect(never.prompts).toEqual([]);
		expect(never.calls).toEqual(["shot:{}"]);
	});

	it("asks again after Allow once", async () => {
		const { harness, calls, prompts } = await setup({ answers: ["Allow once", "Allow once"] });

		await call(harness, "mcp__docs__shot");
		await call(harness, "mcp__docs__shot");

		expect(prompts).toHaveLength(2);
		expect(calls).toEqual(["shot:{}", "shot:{}"]);
	});

	it("allows the tool for the session with Allow for this session, also after a resume", async () => {
		const first = await setup({ answers: ["Allow for this session"] });
		await call(first.harness, "mcp__docs__shot");
		await call(first.harness, "mcp__docs__shot");
		expect(first.prompts).toHaveLength(1);
		expect(first.calls).toEqual(["shot:{}", "shot:{}"]);
		expect(
			first.harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === MCP_APPROVAL_ENTRY_TYPE)
				.map((entry) => (entry.type === "custom" ? entry.data : undefined)),
		).toEqual([{ server: "docs", tool: "shot", configHash: DOCS_HASH }]);

		const resumed = await setup({ sessionManager: first.harness.sessionManager, agentDir: first.agentDir });
		await call(resumed.harness, "mcp__docs__shot");
		expect(resumed.prompts).toEqual([]);
		expect(resumed.calls).toEqual(["shot:{}"]);
	});

	it("asks again after a resume when the server's config changed since Allow for this session", async () => {
		const first = await setup({ answers: ["Allow for this session"] });
		await call(first.harness, "mcp__docs__shot");
		writeFileSync(
			join(first.agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { docs: { command: "unused", args: ["--changed"], exposure: "direct", approve: "writes" } },
			}),
		);

		const resumed = await setup({
			sessionManager: first.harness.sessionManager,
			agentDir: first.agentDir,
			answers: ["Deny"],
		});
		await call(resumed.harness, "mcp__docs__shot");

		expect(resumed.prompts).toHaveLength(1);
		expect(resumed.calls).toEqual([]);
	});

	it("does not apply Allow for this session from a branch the user left", async () => {
		const { harness, prompts, agentDir } = await setup({ answers: ["Allow for this session", "Allow once"] });
		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");
		await call(harness, "mcp__docs__shot");
		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");

		await harness.session.navigateTree(firstAssistant.id);
		await call(harness, "mcp__docs__shot");
		expect(prompts).toHaveLength(2);

		const resumed = await setup({ sessionManager: harness.sessionManager, agentDir, answers: ["Allow once"] });
		await call(resumed.harness, "mcp__docs__shot");
		expect(resumed.prompts).toHaveLength(1);
	});

	it("records Always allow this server in the approvals file and leaves the config alone", async () => {
		const { harness, calls, prompts, agentDir, cwd } = await setup({ answers: ["Always allow this server"] });
		const config = readFileSync(join(agentDir, "mcp.json"), "utf8");

		await call(harness, "mcp__docs__shot");
		await call(harness, "mcp__docs__shot");

		expect(prompts).toHaveLength(1);
		expect(calls).toEqual(["shot:{}", "shot:{}"]);
		expect(readFileSync(join(agentDir, "mcp.json"), "utf8")).toBe(config);
		expect(readApprovals(agentDir)).toEqual({
			version: 1,
			projects: { [realpathSync(cwd)]: { docs: DOCS_HASH } },
		});
		if (process.platform !== "win32") expect(statSync(approvalsFile(agentDir)).mode & 0o777).toBe(0o600);
	});

	it("keeps an always-allowed server allowed in the next session of the project", async () => {
		const first = await setup({ answers: ["Always allow this server"] });
		await call(first.harness, "mcp__docs__shot");

		const next = await setup({
			agentDir: first.agentDir,
			prepare: (cwd) => {
				const approvals = readApprovals(first.agentDir);
				approvals.projects[realpathSync(cwd)] = approvals.projects[realpathSync(first.cwd)];
				writeFileSync(approvalsFile(first.agentDir), JSON.stringify(approvals));
			},
		});
		await call(next.harness, "mcp__docs__shot");

		expect(next.prompts).toEqual([]);
		expect(next.calls).toEqual(["shot:{}"]);
	});

	it.each<[string, (cwd: string) => string]>([
		["another project", () => JSON.stringify({ version: 1, projects: { "/elsewhere": { docs: DOCS_HASH } } })],
		[
			"a config that changed since",
			(cwd) =>
				JSON.stringify({
					version: 1,
					projects: { [realpathSync(cwd)]: { docs: mcpConfigHash({ command: "old" }) } },
				}),
		],
		[
			"another file version",
			(cwd) => JSON.stringify({ version: 2, projects: { [realpathSync(cwd)]: { docs: DOCS_HASH } } }),
		],
		["a corrupt file", () => "{not json"],
	])("asks again for %s in the approvals file", async (_, content) => {
		const { harness, prompts } = await setup({
			answers: ["Allow once"],
			prepare: (cwd, agentDir) => writeFileSync(approvalsFile(agentDir), content(cwd)),
		});

		await call(harness, "mcp__docs__shot");

		expect(prompts).toHaveLength(1);
	});

	it("leaves an approvals file it cannot read as it is, and says so", async () => {
		const { harness, calls, prompts, notices, agentDir } = await setup({
			answers: ["Always allow this server", "Allow once"],
			prepare: (_, agentDir) => writeFileSync(approvalsFile(agentDir), "{not json"),
		});
		expect(notices).toContainEqual(
			expect.stringMatching(/^MCP: .*mcp-approvals\.json: .*servers always allowed in it ask again$/),
		);

		await call(harness, "mcp__docs__shot");
		await call(harness, "mcp__docs__shot");

		expect(readFileSync(approvalsFile(agentDir), "utf8")).toBe("{not json");
		expect(notices).toContainEqual(expect.stringMatching(/^Could not update .*not overwriting it$/));
		expect(prompts).toHaveLength(1);
		expect(calls).toEqual(["shot:{}", "shot:{}"]);
	});

	it("does not let Always allow lower what a shared .mcp.json asks for, but allows the server for this user", async () => {
		const { harness, calls, prompts, agentDir, cwd } = await setup({
			dotMcp: { approve: "never" },
			answers: ["Always allow this server"],
		});
		const dotMcp = readFileSync(join(cwd, ".mcp.json"), "utf8");

		await call(harness, "mcp__docs__search");
		expect(prompts).toEqual([]);
		await call(harness, "mcp__docs__shot");
		await call(harness, "mcp__docs__shot");

		expect(prompts).toHaveLength(1);
		expect(calls).toEqual(['search:{"query":"q"}', "shot:{}", "shot:{}"]);
		expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(dotMcp);
		expect(readApprovals(agentDir).projects[realpathSync(cwd)].docs).toBe(mcpConfigHash({ command: "unused" }, cwd));
	});

	it("asks for write tools of a .mcp.json server that sets approve never", async () => {
		const { harness, prompts, calls } = await setup({ dotMcp: { approve: "never" }, answers: ["Deny"] });

		await call(harness, "mcp__docs__shot");

		expect(prompts).toHaveLength(1);
		expect(calls).toEqual([]);
	});

	it.each([["Deny"], [undefined]])("blocks the call when the user answers %s", async (answer) => {
		const { harness, calls } = await setup({ answers: answer ? [answer] : [] });

		await call(harness, "mcp__docs__shot");

		const result = lastResult(harness, "mcp__docs__shot");
		expect(result?.isError).toBe(true);
		expect(getMessageText(result)).toBe("The user denied the call to MCP tool docs/shot.");
		expect(calls).toEqual([]);
	});

	it("denies gated calls in print mode with a message naming the setting", async () => {
		const { harness, calls, agentDir } = await setup({ printMode: true });

		await call(harness, "mcp__docs__shot");

		expect(getMessageText(lastResult(harness, "mcp__docs__shot"))).toBe(
			`MCP tool docs/shot needs approval ("approve": "writes" for server "docs" in ${join(agentDir, "mcp.json")}), and print mode cannot ask. Set "approve": "never" for the server in your own mcp.json to run its tools without asking.`,
		);
		expect(calls).toEqual([]);
	});

	it("names the interactive choice when a project server is denied in print mode", async () => {
		const { harness, calls, cwd } = await setup({ printMode: true, dotMcp: {} });

		await call(harness, "mcp__docs__shot");

		expect(getMessageText(lastResult(harness, "mcp__docs__shot"))).toBe(
			`MCP tool docs/shot needs approval ("approve": "writes" for server "docs" in ${join(cwd, ".mcp.json")}), and print mode cannot ask. Choose "Always allow this server" in an interactive session to run its tools without asking; a project file cannot lower "approve".`,
		);
		expect(calls).toEqual([]);
	});

	it("asks for calls from codemode scripts, one prompt at a time", async () => {
		const { harness, calls, prompts } = await setup({
			exposure: "codemode",
			answers: ["Allow for this session"],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("codemode", {
						code: "await Promise.all([tools.mcp__docs__shot({}), tools.mcp__docs__shot({})]); return 'ok';",
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("script");

		expect(prompts).toHaveLength(1);
		expect(calls).toEqual(["shot:{}", "shot:{}"]);
	});
});

describe("AgentSession MCP prompts and elicitation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const REVIEW_PROMPT = {
		name: "review",
		description: "Review a file",
		arguments: [{ name: "file", description: "Path", required: true }, { name: "focus" }],
	};
	const SIGNUP_FORM = {
		message: "Sign up",
		requestedSchema: {
			type: "object",
			properties: { name: { type: "string", title: "Name" }, newsletter: { type: "boolean", default: false } },
			required: ["name"],
		},
	};

	function createPromptServer(log: string[], prompts: () => unknown[], form: unknown = SIGNUP_FORM) {
		const pair = createInMemoryTransportPair();
		const answers = new Map<string, (result: unknown) => void>();
		let elicitations = 0;
		const respond = async (request: JsonRpcRequest): Promise<unknown> => {
			const params = request.params as Record<string, unknown> | undefined;
			switch (request.method) {
				case "initialize":
					log.push(`capabilities:${JSON.stringify(params?.capabilities)}`);
					return {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {}, prompts: { listChanged: true } },
						serverInfo: { name: "docs", version: "1.0.0" },
					};
				case "tools/list":
					return { tools: [{ name: "signup", inputSchema: { type: "object", properties: {} } }] };
				case "prompts/list":
					return { prompts: prompts() };
				case "prompts/get": {
					const args = (params?.arguments ?? {}) as Record<string, string>;
					log.push(`get:${params?.name}:${JSON.stringify(args)}`);
					const focus = args.focus ? ` for ${args.focus}` : "";
					const text = args.file === "huge" ? "x".repeat(150_000) : `Review ${args.file}${focus}`;
					return { messages: [{ role: "user", content: { type: "text", text } }] };
				}
				case "tools/call": {
					const id = `elicit-${++elicitations}`;
					const answer = await new Promise((resolve) => {
						answers.set(id, resolve);
						void pair.server.send({ jsonrpc: "2.0", id, method: "elicitation/create", params: form });
					});
					log.push(`elicit:${JSON.stringify(answer)}`);
					return { content: [{ type: "text", text: `answer ${JSON.stringify(answer)}` }] };
				}
				default:
					return {};
			}
		};
		pair.server.onMessage((message) => {
			if ("id" in message && !("method" in message)) {
				answers.get(String(message.id))?.("result" in message ? message.result : message);
				return;
			}
			if (!("id" in message) || !("method" in message)) return;
			const request = message as JsonRpcRequest;
			void respond(request).then((result) => pair.server.send({ jsonrpc: "2.0", id: request.id, result }));
		});
		return pair;
	}

	async function setup(
		options: {
			selects?: string[];
			inputs?: string[];
			printMode?: boolean;
			tui?: boolean;
			prompts?: () => unknown[];
			cachedPrompts?: unknown[];
			approve?: McpServerConfig["approve"];
			form?: unknown;
			/** Text fields stay open until their dialog is aborted. */
			holdInputs?: boolean;
			harness?: Pick<HarnessOptions, "settings" | "withConfiguredAuth">;
			extensions?: ExtensionFactory[];
		} = {},
	) {
		const { selects = [], inputs = [], printMode = false, tui = false, prompts = () => [REVIEW_PROMPT] } = options;
		const config = {
			url: "http://unused.invalid",
			exposure: "direct",
			...(options.approve ? { approve: options.approve } : {}),
		} as McpServerConfig;
		const cachePath = tempCachePath();
		if (options.cachedPrompts) {
			writeMcpCacheEntry(cachePath, "docs", {
				configHash: mcpConfigHash(config),
				fetchedAt: Date.now(),
				tools: [],
				prompts: options.cachedPrompts as McpCacheEntry["prompts"],
			});
		}
		const log: string[] = [];
		const dialogs: unknown[] = [];
		const notifications: string[] = [];
		const servers: ReturnType<typeof createPromptServer>["server"][] = [];
		const autocomplete: ((current: AutocompleteProvider) => AutocompleteProvider)[] = [];
		const harness = await createHarness({
			...options.harness,
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					cachePath,
					loadConfig: () => ({ servers: [{ name: "docs", config, source: "test" }], errors: [] }),
					createTransport: () => {
						const pair = createPromptServer(log, prompts, options.form);
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
				...(options.extensions ?? []),
			],
		});
		harnesses.push(harness);
		const unused = async (): Promise<never> => {
			throw new Error("not used");
		};
		await harness.session.bindExtensions(
			printMode
				? {
						mode: "print",
						// As print mode binds them: commands that wait for idle wait for the run they started.
						commandContextActions: {
							waitForIdle: () => harness.session.waitForIdle(),
							newSession: unused,
							fork: unused,
							navigateTree: unused,
							switchSession: unused,
							reload: unused,
						},
					}
				: {
						mode: tui ? "tui" : "rpc",
						uiContext: createTestUiContext({
							select: async (title, choices) => {
								dialogs.push({ select: title, choices });
								return selects.shift();
							},
							input: async (title, placeholder, dialogOptions) => {
								dialogs.push({ input: title, placeholder });
								if (!options.holdInputs) return inputs.shift();
								return new Promise<undefined>((resolve) =>
									dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined)),
								);
							},
							notify: (message) => notifications.push(message),
							addAutocompleteProvider: (factory) => autocomplete.push(factory),
						}),
					},
		);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const hasCommand = (name: string) =>
			harness.session.extensionRunner.getRegisteredCommands().some((command) => command.name === name);
		await vi.waitFor(() => expect(hasCommand("mcp__docs__review")).toBe(true));
		return { harness, log, dialogs, notifications, errors, servers, autocomplete, hasCommand };
	}

	async function runCommand(harness: Harness, command: string) {
		harness.setResponses([fauxAssistantMessage("reviewed")]);
		await harness.session.prompt(command);
	}

	function signup(harness: Harness) {
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__signup", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		return harness.session.prompt("sign me up");
	}

	it("runs a prompt with inline arguments and sends its messages as the user's message", async () => {
		const { harness, log, dialogs } = await setup();

		await runCommand(harness, '/mcp__docs__review file=a.ts focus="error handling"');

		expect(log).toContain('get:review:{"file":"a.ts","focus":"error handling"}');
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["Review a.ts for error handling"]));
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toEqual(["reviewed"]));
		expect(dialogs).toEqual([]);
	});

	it("asks for a missing required argument", async () => {
		const { harness, log, dialogs } = await setup({ inputs: ["b.ts"] });

		await runCommand(harness, "/mcp__docs__review");

		expect(dialogs).toEqual([{ input: "/mcp__docs__review: file (Path)", placeholder: undefined }]);
		expect(log).toContain('get:review:{"file":"b.ts"}');
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["Review b.ts"]));
	});

	it("reports arguments that are not key=value pairs", async () => {
		const { harness, log, notifications } = await setup();

		await runCommand(harness, "/mcp__docs__review a.ts");

		expect(notifications).toContain("Arguments are key=value pairs. Usage: /mcp__docs__review file=… [focus=…]");
		expect(log.filter((line) => line.startsWith("get:"))).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("does not run a prompt with a missing argument in print mode, and fails the command with the reason", async () => {
		const { harness, log, errors } = await setup({ printMode: true });

		await runCommand(harness, "/mcp__docs__review");

		expect(errors).toEqual(['Missing argument "file". Usage: /mcp__docs__review file=… [focus=…]']);
		expect(log.filter((line) => line.startsWith("get:"))).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("runs the prompt's message as the turn in print mode before the command returns", async () => {
		const { harness, errors } = await setup({ printMode: true });

		await runCommand(harness, "/mcp__docs__review file=a.ts");

		expect(errors).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["Review a.ts"]);
		expect(getAssistantTexts(harness)).toEqual(["reviewed"]);
	});

	/** Fails instead of hanging when a print-mode command never settles. */
	async function settles(run: Promise<void>, ms = 5000) {
		let timer: NodeJS.Timeout | undefined;
		const watchdog = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`command did not settle within ${ms}ms`)), ms);
		});
		try {
			await Promise.race([run, watchdog]);
		} finally {
			clearTimeout(timer);
		}
	}

	it("fails a print-mode prompt command without credentials instead of waiting for a turn", async () => {
		const { harness, errors } = await setup({ printMode: true, harness: { withConfiguredAuth: false } });

		await settles(runCommand(harness, "/mcp__docs__review file=a.ts"));

		expect(errors).toEqual([expect.stringContaining(`No API key found for ${harness.getModel().provider}`)]);
		expect(getAssistantTexts(harness)).toEqual([]);
	});

	it("fails a print-mode prompt command without a model instead of waiting for a turn", async () => {
		const { harness, errors } = await setup({ printMode: true });
		harness.session.agent.state.model = undefined as never;

		await settles(runCommand(harness, "/mcp__docs__review file=a.ts"));

		expect(errors).toEqual([expect.stringContaining("No model selected")]);
		expect(getAssistantTexts(harness)).toEqual([]);
	});

	it("fails a print-mode prompt command whose message an input handler consumes", async () => {
		const handleExtensionInput: ExtensionFactory = (pi) => {
			pi.on("input", (event) => (event.source === "extension" ? { action: "handled" } : undefined));
		};
		const { harness, errors } = await setup({ printMode: true, extensions: [handleExtensionInput] });

		await settles(runCommand(harness, "/mcp__docs__review file=a.ts"));

		expect(errors).toEqual(["An extension handled the prompt's message, so no turn ran."]);
		expect(getAssistantTexts(harness)).toEqual([]);
	});

	it("fails a print-mode prompt command whose turn cannot be prepared", async () => {
		const { harness, errors } = await setup({ printMode: true });
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("hello");
		const model = harness.getModel();
		harness.settingsManager.applyOverrides({
			compaction: { modelOverrides: { [`${model.provider}/${model.id}`]: 5 as never } },
		});

		await settles(runCommand(harness, "/mcp__docs__review file=a.ts"));

		expect(errors).toEqual([expect.stringContaining("Invalid compaction.modelOverrides")]);
		expect(getUserTexts(harness)).toEqual(["hello"]);
	});

	it("cuts a prompt message longer than the limit with a note", async () => {
		const { harness } = await setup();

		await runCommand(harness, "/mcp__docs__review file=huge");

		await vi.waitFor(() => expect(getUserTexts(harness)).toHaveLength(1));
		const [text] = getUserTexts(harness);
		expect(text).toBe(`${"x".repeat(100_000)}\n\n[MCP prompt cut: 50000 more characters left out]`);
	});

	it("registers cached prompts of a lazy server before it connects, and connects to run one", async () => {
		const { harness, log, servers } = await setup({ cachedPrompts: [REVIEW_PROMPT] });
		expect(servers).toHaveLength(0);

		await runCommand(harness, "/mcp__docs__review file=c.ts");

		expect(servers).toHaveLength(1);
		expect(log).toContain('get:review:{"file":"c.ts"}');
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["Review c.ts"]));
	});

	it("reads the cache entry of a prompt whose optional fields are null, and a cache written before prompts", async () => {
		const config = { url: "http://unused.invalid", exposure: "direct" } as McpServerConfig;
		const cachePath = tempCachePath();
		const entry = { configHash: mcpConfigHash(config), fetchedAt: Date.now(), tools: [] };
		writeFileSync(
			cachePath,
			JSON.stringify({
				version: 1,
				servers: {
					docs: { ...entry, prompts: [{ name: "review", description: null, arguments: null }] },
				},
			}),
		);
		expect(readMcpCache(cachePath).get("docs")?.prompts).toHaveLength(1);

		// Written before prompts were cached: its tools still keep a lazy server idle until used.
		writeFileSync(cachePath, JSON.stringify({ version: 1, servers: { docs: { ...entry, tools: SERVER_TOOLS } } }));
		expect(readMcpCache(cachePath).get("docs")).toEqual({ ...entry, tools: SERVER_TOOLS });
	});

	it("asks before a prompt command starts an idle server whose calls ask, and starts nothing when denied", async () => {
		const { harness, log, servers, dialogs, notifications } = await setup({
			cachedPrompts: [REVIEW_PROMPT],
			approve: "always",
			selects: ["Deny"],
		});

		await runCommand(harness, "/mcp__docs__review file=a.ts");

		expect(dialogs).toEqual([
			{
				select: 'Allow MCP server "docs" to start and run its prompt "review"?',
				choices: ["Allow once", "Allow for this session", "Always allow this server", "Deny"],
			},
		]);
		expect(notifications).toContain('MCP prompt docs/review failed: The user denied starting MCP server "docs".');
		expect(servers).toHaveLength(0);
		expect(log.filter((line) => line.startsWith("get:"))).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("starts an idle server whose calls ask once the user allows the prompt for the session", async () => {
		const { harness, log, servers, dialogs } = await setup({
			cachedPrompts: [REVIEW_PROMPT],
			approve: "writes",
			selects: ["Allow for this session"],
		});

		await runCommand(harness, "/mcp__docs__review file=a.ts");
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["Review a.ts"]));
		await runCommand(harness, "/mcp__docs__review file=b.ts");

		expect(dialogs).toHaveLength(1);
		expect(servers).toHaveLength(1);
		expect(log).toContain('get:review:{"file":"b.ts"}');
	});

	it("asks again before a prompt command reconnects a server whose calls ask after it disconnected", async () => {
		const { harness, log, servers, dialogs } = await setup({
			cachedPrompts: [REVIEW_PROMPT],
			approve: "always",
			selects: ["Allow once", "Deny"],
		});
		await runCommand(harness, "/mcp__docs__review file=a.ts");
		await vi.waitFor(() => expect(getUserTexts(harness)).toEqual(["Review a.ts"]));

		await servers[0]?.close();
		await runCommand(harness, "/mcp__docs__review file=b.ts");

		expect(dialogs).toHaveLength(2);
		expect(servers).toHaveLength(1);
		expect(log).not.toContain('get:review:{"file":"b.ts"}');
	});

	it("does not start an idle server whose calls ask from a mode that cannot ask", async () => {
		const { harness, log, servers, errors } = await setup({
			cachedPrompts: [REVIEW_PROMPT],
			approve: "always",
			printMode: true,
		});

		await runCommand(harness, "/mcp__docs__review file=a.ts");

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('Starting MCP server "docs" for the prompt needs approval');
		expect(servers).toHaveLength(0);
		expect(log.filter((line) => line.startsWith("get:"))).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("registers prompts the server lists after prompts/list_changed", async () => {
		let prompts = [REVIEW_PROMPT];
		const { harness, servers, hasCommand, notifications } = await setup({ prompts: () => prompts });
		prompts = [{ ...REVIEW_PROMPT, name: "audit" }];

		await servers[0]?.send({ jsonrpc: "2.0", method: "notifications/prompts/list_changed" });
		await vi.waitFor(() => expect(hasCommand("mcp__docs__audit")).toBe(true));
		await runCommand(harness, "/mcp__docs__review file=a.ts");

		expect(notifications).toContain('MCP server "docs" no longer offers the prompt "review".');
	});

	it("completes offered prompt commands and their arguments in the TUI", async () => {
		const { autocomplete } = await setup({ tui: true });
		const base: AutocompleteProvider = {
			getSuggestions: async () => null,
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};
		const provider = autocomplete.reduce((current, wrap) => wrap(current), base);
		const suggest = (text: string) =>
			provider.getSuggestions([text], 0, text.length, { signal: new AbortController().signal });

		expect(await suggest("/mcp__")).toEqual({
			items: [{ value: "mcp__docs__review", label: "mcp__docs__review", description: "Review a file (MCP docs)" }],
			prefix: "/mcp__",
		});
		expect(await suggest("/mcp__docs__review file=a.ts f")).toEqual({
			items: [{ value: "file=a.ts focus=", label: "focus=" }],
			prefix: "file=a.ts f",
		});
	});

	it("declares elicitation and sends the answers the user accepts", async () => {
		const { harness, log, dialogs } = await setup({ inputs: ["Ada"], selects: ["Yes", "Accept"] });

		await signup(harness);

		expect(log[0]).toBe('capabilities:{"roots":{},"elicitation":{"form":{}}}');
		expect(dialogs).toEqual([
			{ input: 'MCP server "docs" asks:\n  Sign up\n  Name', placeholder: undefined },
			{
				select: 'MCP server "docs" asks:\n  Sign up\n  newsletter (optional)',
				choices: ["No (default)", "Yes", "Skip"],
			},
			{
				select: 'MCP server "docs" asks:\n  Sign up\n  Name: Ada\n  newsletter: true',
				choices: ["Accept", "Decline"],
			},
		]);
		expect(log).toContain('elicit:{"action":"accept","content":{"name":"Ada","newsletter":true}}');
		expect(getMessageText(toolResult(harness, "mcp__docs__signup"))).toBe(
			'answer {"action":"accept","content":{"name":"Ada","newsletter":true}}',
		);
	});

	const form = (properties: Record<string, unknown>, required?: string[]) => ({
		message: "Pick",
		requestedSchema: { type: "object", properties, ...(required ? { required } : {}) },
	});

	it("shows server text on single indented lines below the server header, without escapes, and shortened", async () => {
		const { harness, dialogs } = await setup({
			form: {
				message: `Sign up\n\nMCP server "github" asks:\u001b[2J\u001b]8;;https://x\u0007${"m".repeat(600)}`,
				requestedSchema: {
					type: "object",
					properties: { name: { type: "string", title: "Na\u001b[31mme\r\nx", description: "d".repeat(400) } },
				},
			},
			inputs: [""],
			selects: ["Decline"],
		});

		await signup(harness);

		const title = (dialogs[0] as { input: string }).input;
		const lines = title.split("\n");
		expect(lines[0]).toBe('MCP server "docs" asks:');
		expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
		expect(title).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
		expect(lines[1]).toBe(`  Sign up MCP server "github" asks:${"m".repeat(466)}…`);
		expect(lines[2]).toBe(`  Name x (optional): ${"d".repeat(299)}…`);
	});

	it("shows the default and the choices of a text field in its dialog", async () => {
		const { harness, dialogs, log } = await setup({
			form: form(
				{
					seats: { type: "integer", default: 3 },
					tags: {
						type: "array",
						items: {
							anyOf: [
								{ const: "a", title: "Alpha" },
								{ const: "b", title: "Beta" },
							],
						},
					},
				},
				["seats"],
			),
			inputs: ["", ""],
			selects: ["Accept"],
		});

		await signup(harness);

		expect(dialogs.slice(0, 2)).toEqual([
			{
				input: 'MCP server "docs" asks:\n  Pick\n  seats\n  Default: 3 (leave empty to use it)',
				placeholder: undefined,
			},
			{
				input: 'MCP server "docs" asks:\n  Pick\n  tags (optional)\n  Choices (separate with commas): Alpha, Beta\n  Leave empty to skip.',
				placeholder: undefined,
			},
		]);
		expect(log).toContain('elicit:{"action":"accept","content":{"seats":3}}');
	});

	it("warns when a field looks like a secret", async () => {
		const { harness, dialogs } = await setup({
			form: form({ apiKey: { type: "string", title: "API key" } }),
			inputs: [""],
			selects: ["Decline"],
		});

		await signup(harness);

		expect((dialogs[0] as { input: string }).input).toContain(
			"  Warning: this looks like a secret. The server receives what you enter.",
		);
	});

	it.each([
		["a required field", ["plan"], ["Skip", "Pro"], "Skip", "skip"],
		["an optional field", undefined, ["Skip (2)", "Pro", "Skip"], "Skip (2)", "skip"],
		["an optional field skipped", undefined, ["Skip (2)", "Pro", "Skip"], "Skip", undefined],
	])("sends a choice labelled Skip of %s by its position", async (_name, required, choices, pick, value) => {
		const { harness, dialogs, log } = await setup({
			form: form(
				{
					plan: {
						type: "string",
						oneOf: [
							{ const: "skip", title: "Skip" },
							{ const: "pro", title: "Pro" },
						],
					},
				},
				required,
			),
			selects: [pick, "Accept"],
		});

		await signup(harness);

		expect((dialogs[0] as { choices: string[] }).choices).toEqual(choices);
		expect(log).toContain(`elicit:${JSON.stringify({ action: "accept", content: value ? { plan: value } : {} })}`);
	});

	it("closes an elicitation dialog when the agent turn that caused it is aborted", async () => {
		const { harness, dialogs, log } = await setup({ holdInputs: true });

		const turn = signup(harness);
		await vi.waitFor(() => expect(dialogs).toHaveLength(1));
		await harness.session.abort();
		await turn;

		await vi.waitFor(() => expect(log).toContain('elicit:{"action":"cancel"}'));
	});

	it.each([
		["declines when the user declines", { inputs: ["Ada"], selects: ["No (default)", "Decline"] }, "decline"],
		["cancels when the user dismisses a field", { inputs: [] }, "cancel"],
		["declines in print mode", { printMode: true }, "decline"],
	])("%s", async (_name, options, action) => {
		const { harness, log } = await setup(options);

		await signup(harness);

		expect(log).toContain(`elicit:${JSON.stringify({ action })}`);
	});
});
