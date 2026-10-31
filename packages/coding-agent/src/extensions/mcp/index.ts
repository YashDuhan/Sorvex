/**
 * Built-in MCP integration.
 *
 * Serves the servers from `mcp.json` and the servers extensions register with
 * `pi.registerMcpServer()`. A server in `mcp.json` takes precedence over a registered server of the
 * same name. A `lazy` server (the default) with an entry in the metadata cache (cache.ts) registers
 * its tools from the entry when the session starts and connects on the first call that needs it; it
 * disconnects again after `idleTimeoutMinutes` without a call. Other servers connect in the
 * background when the session starts, or right away when registered later, and refresh the cache:
 * the first prompt waits only for servers with `direct` tools, and codemode scripts, `tool_search`,
 * and the resource tools wait for the servers they need when they run. Tools are
 * registered as `mcp__<server>__<tool>`. By default (`"exposure": "codemode"`) the tools are only
 * callable from codemode scripts, which keeps MCP tools out of the model's tool declarations and
 * the codemode description: scripts find the tools with `searchTools()` and the server instructions
 * with `describeNamespace()`. The codemode tool is activated for that unless `autoEnableCodemode` is
 * false. `"deferred"` declares the tools to the model once the `tool_search` tool loads them, and
 * activates `tool_search` instead of codemode.
 * `"exposure": "direct"` declares them to the model right away, and `"hidden"` makes them
 * unreachable. `toolExposure` overrides the exposure of single tools. Servers with resources are
 * reached through Codex's `list_mcp_resources`, `list_mcp_resource_templates`, and
 * `read_mcp_resource` tools (resources.ts).
 *
 * Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission
 * extensions apply to MCP tools the same way they do to built-in tools. The extension's own
 * `tool_call` hook asks the user before calls the server's `approve` setting gates (approval.ts),
 * for calls from the model and from codemode scripts alike.
 *
 * Problems found at startup (config errors, failed connections, servers that need a sign-in) are
 * reported once. `/mcp` opens a manager to sign in, reconnect, enable or disable servers, and change
 * their exposure; the last two are saved to the `mcp.json` that defines the server, as an override
 * in pi's own `mcp.json` of the same scope when other clients read that file, or apply to the
 * current session for registered servers.
 */

import { join, resolve } from "node:path";
import type { SelectItem } from "@sorvex/tui";
import type { TSchema } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEventResult,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import { getMcpIdleTimeoutMs, getMcpRequestTimeoutMs, mcpNamespace } from "../../core/mcp-servers.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { CODEMODE_TOOL_NAME } from "../codemode/tool.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import {
	approvalKey,
	MCP_APPROVAL_CHOICES,
	MCP_APPROVAL_ENTRY_TYPE,
	type McpApprovalEntryData,
	needsApproval,
	readAlwaysAllowedServers,
	readSessionApprovals,
	saveAlwaysAllowedServer,
} from "./approval.ts";
import { type McpCacheEntry, mcpConfigHash, readMcpCache, validMcpCacheEntry, writeMcpCacheEntry } from "./cache.ts";
import {
	getMcpToolExposure,
	type LoadedMcpConfig,
	loadMcpConfig,
	type McpApproval,
	type McpExposure,
	type McpServerConfigPatch,
	type McpServerEntry,
	updateMcpServerConfig,
} from "./config.ts";
import { createMcpElicitationHandler } from "./elicitation.ts";
import type { McpOAuthCredentialStore, McpSignInPrompt } from "./oauth.ts";
import { createMcpPromptCommands } from "./prompts.ts";
import {
	createMcpResourceToolDefinitions,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	LIST_MCP_RESOURCES_TOOL,
	READ_MCP_RESOURCE_TOOL,
} from "./resources.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import type * as McpRuntime from "./runtime.ts";
import type { McpServerConnection, McpServerLog, McpServerOffer, McpTransportFactory } from "./runtime.ts";
import { createMcpToolDefinition, createMcpToolName, createMcpToolRenderers, type McpToolDetails } from "./tools.ts";
import { type McpMenu, type McpUi, showMcpManager } from "./ui.ts";

export type { McpTransportFactory } from "./runtime.ts";

export interface McpExtensionOptions {
	/** Defaults to reading `mcp.json` from the agent directory and the trusted project. */
	loadConfig?: (ctx: ExtensionContext) => LoadedMcpConfig;
	/** Defaults to stdio and streamable HTTP transports built from the server config. */
	createTransport?: McpTransportFactory;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** File server log messages are appended to. Defaults to `mcp.log` in the agent directory. */
	logPath?: string;
	/** Metadata cache that lazy servers register their tools from. Defaults to `mcp-cache.json` in the agent directory. */
	cachePath?: string;
	/** Servers the user always allows, per project. Defaults to `mcp-approvals.json` in the agent directory. */
	approvalsPath?: string;
	/** Opens the OAuth authorization URL. Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/**
	 * Saves `/mcp` changes to the server's config file: its `override` when set, else its `source`.
	 * Defaults to editing that `mcp.json`.
	 */
	updateConfig?: (entry: McpServerEntry, patch: McpServerConfigPatch) => void;
	/**
	 * How long the first prompt waits for servers with `direct` tools that are still connecting at
	 * startup, in milliseconds. Their tools become available when they connect. Other servers are
	 * waited for when a script or search needs them. Default: 10000.
	 */
	startupWaitMs?: number;
}

const DEFAULT_STARTUP_WAIT_MS = 10_000;

const RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
	LIST_MCP_RESOURCES_TOOL,
	LIST_MCP_RESOURCE_TEMPLATES_TOOL,
	READ_MCP_RESOURCE_TOOL,
]);

interface McpServer {
	entry: McpServerEntry;
	connection?: McpServerConnection;
	cached?: McpCacheEntry;
	/** For servers extensions registered: the config as registered, to detect re-registrations. */
	registeredConfig?: string;
	/** Result of the last `/mcp` action that failed, shown in the manager. */
	message?: string;
	/** Identifies the current connection attempt; disabling or replacing it invalidates earlier work. */
	attempt?: symbol;
	/** Settles when the connection started for the server connected or failed. */
	ready?: Promise<void>;
	/** Cleanup of a detached connection; a replacement waits for it before opening a transport. */
	closing?: Promise<void>;
}

const EXPOSURE_DESCRIPTIONS: Record<Exclude<McpExposure, "hidden">, string> = {
	codemode: "called from codemode scripts, which find them with searchTools()",
	deferred: "not declared until tool_search loads them, then called directly; no codemode needed",
	direct: "declared to the model like built-in tools",
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
	return text.split("\n", 1)[0] ?? "";
}

function isEnabled(server: Pick<McpServer, "entry">): boolean {
	return server.entry.config.enabled !== false;
}

function exposureOf(entry: McpServerEntry): McpExposure {
	return entry.config.exposure ?? "codemode";
}

function connectsAtStart(server: Pick<McpServer, "entry" | "cached">): boolean {
	return server.entry.config.lifecycle === "eager" || server.cached === undefined;
}

function stateOf(server: McpServer): McpServerConnection["state"] {
	return server.connection?.state ?? (connectsAtStart(server) ? "connecting" : "idle");
}

/** Exposures the server's tools can have, known from its config before it connects. */
function configuredExposures(entry: McpServerEntry): Set<McpExposure> {
	return new Set([exposureOf(entry), ...Object.values(entry.config.toolExposure ?? {})]);
}

/** Whether some of the server's tools are declared to the model, so the first prompt waits for them. */
function hasDirectTools(entry: McpServerEntry): boolean {
	return configuredExposures(entry).has("direct");
}

/** Whether some of the server's tools are reached through codemode or tool_search. */
function hasIndirectTools(entry: McpServerEntry): boolean {
	const exposures = configuredExposures(entry);
	return exposures.has("codemode") || exposures.has("deferred");
}

/** Name of the system prompt section that lists the servers whose tools are not declared. */
export const MCP_SERVERS_SECTION = "mcp_servers";
/** Characters of a server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/**
 * Characters of the whole section. Descriptions shrink to fit; when the server lines alone do not
 * fit, the last servers are left out and counted in a closing line.
 */
export const MAX_SERVERS_SECTION_CHARS = 4096;

/** The section's first line. It explains only the ways of reaching tools that the listed servers use. */
function serversSectionIntro(reaches: ReadonlySet<string>): string {
	let intro = "MCP servers whose tools are not declared to you.";
	if (reaches.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	if (reaches.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";
	return intro;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** What the `mcp_servers` section needs of a server. */
export interface McpServerListing {
	entry: McpServerEntry;
	connection?: { instructions?: string };
}

/** First line of the configured description, or of the server instructions once connected. */
function serverSummary(server: McpServerListing): string {
	const text = server.entry.config.description?.trim() || server.connection?.instructions || "";
	return (text.split("\n", 1)[0] ?? "").trim();
}

/**
 * The `mcp_servers` section: every enabled server with codemode or deferred tools, with how its
 * tools are reached and a one-line summary. The model learns of the servers from it, since neither
 * codemode nor tool_search lists them. Undefined when there are no such servers.
 */
export function renderServersSection(servers: readonly McpServerListing[]): string | undefined {
	const listed = servers
		.filter((server) => isEnabled(server) && hasIndirectTools(server.entry))
		.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
	if (listed.length === 0) return undefined;
	const reaches = listed.map((server) =>
		configuredExposures(server.entry).has("codemode") ? "codemode" : "tool_search",
	);
	const intro = serversSectionIntro(new Set(reaches));
	const heads = listed.map((server, index) => `- ${mcpNamespace(server.entry.name)} (${reaches[index]})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	// Characters of the intro, the first `kept` server lines without descriptions, and the omission line.
	const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	// Each description also takes a ": " separator.
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
	const lines = listed.slice(0, kept).map((server, index) => {
		const summary = perServer > 0 ? truncate(serverSummary(server), perServer) : "";
		return summary ? `${heads[index]}: ${summary}` : heads[index];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/**
 * Whether a call that reaches `reach` (see `ToolDefinition.reachesTools`) needs the server: it
 * reaches every tool, or one of its words contains the server's namespace.
 */
function reachesServer(reach: "all" | readonly string[], server: string): boolean {
	if (reach === "all") return true;
	const namespace = mcpNamespace(server);
	return reach.some((word) => word.includes(namespace));
}

/** Short state for lists and the startup report. `withError` appends the first line of a failure. */
function describeState(server: McpServer, withError = true): string {
	if (!isEnabled(server)) return "disabled";
	const offer = server.connection ?? server.cached;
	const count = offer?.tools.length ?? 0;
	const tools = `${count} tool${count === 1 ? "" : "s"}${offer?.hasResources ? " · resources" : ""}`;
	const state = stateOf(server);
	switch (state) {
		case "needs-auth":
			return "needs sign-in";
		case "failed":
			return withError ? `failed: ${firstLine(server.connection?.error ?? "unknown error")}` : "failed";
		case "connected":
		case "idle":
			return `${state} · ${tools}`;
		case "connecting":
			return "connecting…";
		default:
			return state;
	}
}

/** Servers that need the user first. */
const ATTENTION_RANKS: Record<McpServerConnection["state"], number> = {
	"needs-auth": 0,
	failed: 1,
	disconnected: 2,
	connecting: 3,
	closed: 3,
	connected: 4,
	idle: 4,
};

function attentionRank(server: McpServer): number {
	return isEnabled(server) ? ATTENTION_RANKS[stateOf(server)] : 5;
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	if ("url" in config) return config.url;
	return [config.command, ...(config.args ?? [])].join(" ");
}

function noServersMessage(): string {
	return `No MCP servers configured. Add them to ${resolve(getAgentDir(), "mcp.json")} or ${CONFIG_DIR_NAME}/mcp.json.`;
}

const MCP_USAGE = "Usage: /mcp, /mcp login [server], /mcp logout [server], /mcp reconnect [server]";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let servers: McpServer[] = [];
		/** Servers from `mcp.json`, which take precedence over registered servers of the same name. */
		let configuredEntries: McpServerEntry[] = [];
		let configErrors: string[] = [];
		/** Project servers that replace a user server of the same name. */
		let configNotices: string[] = [];
		/** The agent directory's `mcp.json`, where `/mcp` saves overrides of servers from `~/.config/mcp/mcp.json`. */
		let globalConfig = join(getAgentDir(), "mcp.json");
		/** The trusted project's `mcp.json`, where `/mcp` saves project overrides of global servers. */
		let projectConfig: string | undefined;
		/** Registered servers that `mcp.json` overrides, shown in `/mcp`. */
		let overridden: string[] = [];
		let autoEnableCodemode = true;
		/** Whether the "codemode tools unreachable" warning was shown since the session started. */
		let warnedUnreachable = false;
		let pending: Promise<unknown> | undefined;
		/** Whether a prompt already waited for the startup connections since the session started. */
		let waitedForStartup = false;
		const startupWaitMs = options.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
		/** Working directory of the session, for stdio servers. */
		let sessionCwd = process.cwd();
		let credentials = options.credentials;
		/** The session's model registry, which resolves `auth.provider` tokens. */
		let modelRegistry: ModelRegistry | undefined;
		let serverLog: McpServerLog | undefined;
		const openUrl = options.openUrl ?? openBrowser;
		const cachePath = options.cachePath ?? join(getAgentDir(), "mcp-cache.json");
		const approvalsPath = options.approvalsPath ?? join(getAgentDir(), "mcp-approvals.json");
		/** Servers the user always allows in the session's project, with the config hash they were allowed for. */
		let alwaysAllowed: ReadonlyMap<string, string> = new Map();
		const updateConfig =
			options.updateConfig ??
			((entry, patch) =>
				updateMcpServerConfig(entry.override ?? entry.source, entry.name, patch, {
					override: entry.override !== undefined,
				}));

		/**
		 * Lifetime of the current session: aborted on session_shutdown, and before the first session_start
		 * (registrations before that are read on session_start). Work captures `session.signal` when it
		 * starts and drops late results once it aborted, for example a runtime load that resolves after
		 * shutdown. Work that outlives the command that started it also stops on the signal and is
		 * registered with `track`, so shutdown can wait for its cleanup.
		 */
		let session = new AbortController();
		session.abort();
		let sessionContext: ExtensionContext | undefined;
		const elicit = createMcpElicitationHandler(() => (session.signal.aborted ? undefined : sessionContext));
		const promptCommands = createMcpPromptCommands(pi, async (name, prompt, args, ctx) => {
			const server = findServer(name);
			if (server && !server.connection) await server.ready;
			const connection = server && isEnabled(server) ? server.connection : undefined;
			if (!server || !connection) throw new Error(`MCP server "${name}" is disabled.`);
			await approvePromptStart(server, prompt, ctx);
			return (server.connection ?? connection).getPrompt(prompt, args, { signal: ctx.signal });
		});
		/** Work registered with `track`: manager actions opening or closing connections, and sign-ins. */
		const backgroundActions = new Set<Promise<void>>();
		const track = <T>(work: Promise<T>): Promise<T> => {
			const task = work.then(
				() => undefined,
				() => undefined,
			);
			backgroundActions.add(task);
			void task.finally(() => backgroundActions.delete(task));
			return work;
		};
		const listeners = new Set<() => void>();
		const emitChange = () => {
			for (const listener of listeners) listener();
		};
		const subscribe = (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};

		const connections = () => servers.flatMap((server) => (server.connection ? [server.connection] : []));
		const findServer = (name: string) => servers.find((server) => server.entry.name === name);

		/** Servers extensions registered, except names `mcp.json` defines, which take precedence. */
		const registeredServers = (): { servers: McpServer[]; overridden: string[] } => {
			const registered: McpServer[] = [];
			const overriddenNames: string[] = [];
			for (const { name, config, extensionPath } of pi.getMcpServers()) {
				const configured = configuredEntries.find((entry) => mcpNamespace(entry.name) === mcpNamespace(name));
				if (configured) {
					overriddenNames.push(
						`"${name}" registered by ${extensionPath} is overridden by "${configured.name}" in ${configured.source}`,
					);
					continue;
				}
				registered.push({
					entry: { name, config, source: extensionPath, scope: "extension" },
					registeredConfig: JSON.stringify(config),
				});
			}
			return { servers: registered, overridden: overriddenNames };
		};

		const getCredentials = (runtime: typeof McpRuntime): McpOAuthCredentialStore => {
			credentials ??= new runtime.McpOAuthCredentialStore();
			return credentials;
		};

		const getServerLog = (runtime: typeof McpRuntime): McpServerLog => {
			serverLog ??= new runtime.McpServerLog(options.logPath ?? join(getAgentDir(), "mcp.log"));
			return serverLog;
		};

		/** pi tool name to the `<server>\0<tool>` it was assigned to, so names stay unique and stable. */
		const toolOwners = new Map<string, string>();
		/** Tool names currently offered by each server. */
		const serverTools = new Map<string, Set<string>>();
		const ownerOf = (toolName: string) => toolOwners.get(toolName)?.split("\0", 1)[0];
		/** Last definition registered under each tool name, to re-register withdrawn tools as hidden. */
		const definitions = new Map<string, ToolDefinition<TSchema, McpToolDetails>>();
		let sessionApprovals = new Set<string>();
		let previousPromptAnswered: Promise<unknown> = Promise.resolve();

		// A resumed session renders calls to MCP tools before their server connected, if it ever does.
		pi.registerToolRenderer((toolName, next) => {
			const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
			return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
		});

		const registerTools = (entry: McpServerEntry, offer: McpServerOffer) => {
			const server = entry.name;
			const description = entry.config.description?.trim();
			const namespace = {
				name: mcpNamespace(server),
				// `describeNamespace("docs")` finds `mcp__docs`.
				aliases: [server],
				...(description ? { description } : {}),
				...(offer.instructions ? { instructions: offer.instructions } : {}),
			};
			const previous = serverTools.get(server) ?? new Set<string>();
			const current = new Set<string>();
			// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
			// one would keep the plain name does not depend on the order of the list.
			const plain = [...new Set(offer.tools.map((tool) => tool.name))].map((tool) =>
				createMcpToolName(server, tool),
			);
			const assignName = (tool: string, owner: string) => {
				const name = createMcpToolName(server, tool, (candidate) => {
					const existing = toolOwners.get(candidate);
					return (
						(existing !== undefined && existing !== owner) ||
						current.has(candidate) ||
						plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
					);
				});
				toolOwners.set(name, owner);
				current.add(name);
				return name;
			};
			for (const tool of offer.tools) {
				const definition = createMcpToolDefinition({
					server,
					tool,
					name: assignName(tool.name, `${server}\0${tool.name}`),
					exposure: getMcpToolExposure(entry.config, tool.name),
					namespace,
					timeoutMs: getMcpRequestTimeoutMs(entry.config),
					getClient: async () => {
						// A prepared call can outlive this definition's connection while the readiness
						// hook waits for a disable/re-enable. Resolve the replacement at execution time.
						const current = findServer(server);
						if (current && !current.connection) await current.ready;
						if (!current || !isEnabled(current) || !servers.includes(current)) {
							throw new Error(`MCP server "${server}" is disabled.`);
						}
						const client = current.connection;
						if (!client) throw new Error(`MCP server "${server}" is still starting.`);
						if (
							getMcpToolExposure(current.entry.config, tool.name) === "hidden" ||
							(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
						) {
							throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
						}
						return client;
					},
					readableResources: () => resourceServers().some((current) => current.name === server),
				});
				definitions.set(definition.name, definition);
				pi.registerTool(definition);
			}
			serverTools.set(server, current);
			// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
			// the server offers them again they are registered with their configured exposure above.
			for (const name of previous) {
				const definition = definitions.get(name);
				if (!current.has(name) && definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			syncResourceTools();
			promptCommands.offer(server, offer.prompts ?? []);
		};

		/** Make a disabled server's tools unreachable. */
		const hideTools = (server: string) => {
			for (const name of serverTools.get(server) ?? []) {
				const definition = definitions.get(name);
				if (definition) pi.registerTool({ ...definition, exposure: "hidden" });
			}
			serverTools.set(server, new Set());
			syncResourceTools();
			promptCommands.withdraw(server);
		};

		/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
		const serversWithResources = (): McpServer[] =>
			servers.filter(
				(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
			);
		const resourceServers = (): McpServerConnection[] =>
			serversWithResources().flatMap((server) => (server.connection ? [server.connection] : []));

		/** Exposure the resource tools were last registered with; undefined until a server has resources. */
		let resourceToolsExposure: McpExposure | undefined;
		/**
		 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
		 * one of them is direct, and so on. They are hidden when no server has resources.
		 */
		const syncResourceTools = () => {
			const exposures = new Set(serversWithResources().map((server) => exposureOf(server.entry)));
			const exposure = (["direct", "codemode", "deferred"] as const).find((candidate) => exposures.has(candidate));
			const next = exposure ?? "hidden";
			if (next === resourceToolsExposure || (resourceToolsExposure === undefined && next === "hidden")) return;
			const wasDirect = resourceToolsExposure === "direct";
			resourceToolsExposure = next;
			const resourceDefinitions = createMcpResourceToolDefinitions({ exposure: next, servers: resourceServers });
			for (const definition of resourceDefinitions) pi.registerTool(definition);
			if (wasDirect) {
				const names = new Set(resourceDefinitions.map((definition) => definition.name));
				pi.setActiveTools(pi.getActiveTools().filter((name) => !names.has(name)));
			}
		};

		/**
		 * Tools that are not declared to the model are reached through the codemode tool (scripts call
		 * them) or the tool_search tool (it declares them). Either reaches every such tool. Activate the
		 * one the tools' exposure asks for: codemode for `codemode` unless `autoEnableCodemode` is false,
		 * tool_search for `deferred`.
		 */
		const ensureDiscoveryActive = (ctx: ExtensionContext) => {
			// From the config, so the tool is active before the servers connect. Resource tools share
			// their server's exposure.
			const exposures = new Set<McpExposure>();
			for (const server of servers) {
				if (isEnabled(server)) for (const exposure of configuredExposures(server.entry)) exposures.add(exposure);
			}
			const needsCodemode = exposures.has("codemode");
			const needsToolSearch = exposures.has("deferred");
			if (!needsCodemode && !needsToolSearch) return;
			// Only a tool of these names that declares `reachesTools` can reach MCP tools; another
			// extension's tool of the same name without it is never activated.
			const tools = pi.getAllTools();
			const hasReachingTool = (name: string) => tools.some((tool) => tool.name === name && tool.reachesTools);
			const hasCodemode = hasReachingTool(CODEMODE_TOOL_NAME);
			const hasToolSearch = hasReachingTool(TOOL_SEARCH_TOOL_NAME);
			const active = pi.getActiveTools();
			const activate: string[] = [];
			if (needsCodemode && hasCodemode && autoEnableCodemode && !active.includes(CODEMODE_TOOL_NAME)) {
				activate.push(CODEMODE_TOOL_NAME);
			}
			if (needsToolSearch && hasToolSearch && !active.includes(TOOL_SEARCH_TOOL_NAME)) {
				activate.push(TOOL_SEARCH_TOOL_NAME);
			}
			if (activate.length > 0) pi.setActiveTools([...active, ...activate]);
			const reachable = [...active, ...activate];
			if (hasCodemode && reachable.includes(CODEMODE_TOOL_NAME)) return;
			if (hasToolSearch && reachable.includes(TOOL_SEARCH_TOOL_NAME)) return;
			if (warnedUnreachable) return;
			warnedUnreachable = true;
			const reason = needsCodemode && hasCodemode && !autoEnableCodemode ? " (autoEnableCodemode is false)" : "";
			ctx.ui.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		};

		/**
		 * Stored tokens of servers waiting for a sign-in, as they were when the sign-in was needed.
		 * `pi mcp login` in another process (for example run by the agent) changes them.
		 */
		const tokensAtSignIn = new Map<McpServerConnection, string>();
		const storedTokens = (connection: McpServerConnection): string => {
			const url = connection.oauthUrl;
			return url && credentials ? JSON.stringify(credentials.tokens(connection.name, url) ?? null) : "null";
		};
		const onConnectionChange = (connection: McpServerConnection) => {
			if (connection.state !== "needs-auth") tokensAtSignIn.delete(connection);
			else if (!tokensAtSignIn.has(connection)) tokensAtSignIn.set(connection, storedTokens(connection));
			emitChange();
		};
		/** Reconnect servers that need a sign-in when their credentials were stored since. */
		const reconnectSignedIn = async (ctx: ExtensionContext) => {
			const signedIn = [...tokensAtSignIn].filter(([connection, tokens]) => storedTokens(connection) !== tokens);
			if (signedIn.length === 0) return;
			for (const [connection] of signedIn) tokensAtSignIn.delete(connection);
			await Promise.allSettled(signedIn.map(([connection]) => connection.reconnect()));
			ensureDiscoveryActive(ctx);
		};

		const configHash = (entry: McpServerEntry) =>
			mcpConfigHash(entry.config, entry.scope === "project" ? sessionCwd : undefined);

		/** The server's `approve`, or `never` when the user always allows it as currently configured. */
		const approvalOf = (entry: McpServerEntry): McpApproval =>
			alwaysAllowed.get(entry.name) === configHash(entry) ? "never" : (entry.config.approve ?? "never");

		/** Create the server's connection, loading the MCP runtime on first use. */
		const createConnection = async (
			server: McpServer,
			isCurrent: () => boolean,
		): Promise<McpServerConnection | undefined> => {
			const runtime = await loadMcpRuntime();
			if (!isCurrent()) return undefined;
			const connection = new runtime.McpServerConnection({
				entry: server.entry,
				cwd: sessionCwd,
				createTransport: options.createTransport ?? runtime.createDefaultTransport,
				credentials: getCredentials(runtime),
				providerToken: async (provider) => modelRegistry?.getApiKeyForProvider(provider),
				log: getServerLog(runtime),
				offer: server.cached,
				idleTimeoutMs: getMcpIdleTimeoutMs(server.entry.config),
				elicitation: (params, { signal }) => elicit(server.entry.name, params, signal),
				onTools: (connection) => {
					if (!isCurrent()) return;
					registerTools(server.entry, connection);
					const { tools, instructions, hasResources, prompts } = connection;
					server.cached = {
						configHash: configHash(connection.entry),
						fetchedAt: Date.now(),
						tools,
						...(instructions ? { instructions } : {}),
						...(hasResources ? { hasResources } : {}),
						...(prompts.length > 0 ? { prompts } : {}),
					};
					writeMcpCacheEntry(cachePath, connection.name, server.cached);
				},
				onChange: (connection) => {
					if (isCurrent()) onConnectionChange(connection);
					else tokensAtSignIn.delete(connection);
				},
			});
			server.connection = connection;
			syncResourceTools();
			emitChange();
			return connection;
		};

		const startConnection = (server: McpServer, after?: Promise<unknown>): Promise<void> => {
			const { signal } = session;
			const attempt = Symbol();
			server.attempt = attempt;
			const isCurrent = () =>
				!signal.aborted && server.attempt === attempt && isEnabled(server) && servers.includes(server);
			if (server.cached) registerTools(server.entry, server.cached);
			const ready = (async () => {
				await after;
				if (!isCurrent()) return;
				const connection = await createConnection(server, isCurrent);
				if (!connection || !isCurrent()) return;
				if (connectsAtStart(server)) await connection.getClient().catch(() => undefined);
			})();
			server.ready = ready.catch(() => undefined);
			return ready;
		};

		const startConnections = async (starting: readonly McpServer[], after?: Promise<unknown>): Promise<void> => {
			const entries = readMcpCache(cachePath);
			await Promise.all(
				starting.map((server) => {
					server.cached =
						server.entry.config.lifecycle === "eager"
							? undefined
							: validMcpCacheEntry(entries, server.entry.name, configHash(server.entry));
					return startConnection(server, after);
				}),
			);
		};

		/**
		 * Connect an idle server ahead of the calls that will need it. Servers whose calls may ask first
		 * connect on their first allowed call instead, so a denied call starts nothing.
		 */
		const warmUp = (server: McpServer) => {
			if (isEnabled(server) && approvalOf(server.entry) === "never" && server.connection?.state === "idle") {
				void server.connection.getClient().catch(() => undefined);
			}
		};

		/** Wait for the latest connection attempts, including ones queued while waiting, or an abort. */
		const waitForServers = async (waiting: readonly McpServer[], signal: AbortSignal | undefined) => {
			for (;;) {
				const ready = waiting.flatMap((server) =>
					isEnabled(server) && servers.includes(server) && server.ready ? [{ server, ready: server.ready }] : [],
				);
				if (ready.length === 0 || signal?.aborted) return;
				let onAbort: (() => void) | undefined;
				await Promise.race([
					Promise.all(ready.map((attempt) => attempt.ready)),
					new Promise<void>((resolve) => {
						onAbort = () => resolve();
						signal?.addEventListener("abort", onAbort, { once: true });
					}),
				]);
				if (onAbort) signal?.removeEventListener("abort", onAbort);
				if (
					signal?.aborted ||
					ready.every(
						(attempt) =>
							!isEnabled(attempt.server) ||
							!servers.includes(attempt.server) ||
							attempt.ready === attempt.server.ready,
					)
				)
					return;
			}
		};

		/**
		 * One message for everything that needs the user after startup, or only for `only`, servers
		 * that connected later.
		 */
		const reportProblems = (ctx: ExtensionContext, only?: readonly McpServer[]) => {
			const lines = only ? [] : configErrors.map((error) => `config: ${error}`);
			for (const server of only ?? servers) {
				const state = server.connection?.state;
				if (state === "needs-auth" || state === "failed")
					lines.push(`${server.entry.name}: ${describeState(server)}`);
			}
			if (lines.length === 0) return;
			ctx.ui.notify(
				`MCP servers need attention:\n${lines.map((line) => `  ${line}`).join("\n")}\nRun /mcp to fix.`,
				"warning",
			);
		};

		/** Pi's own file a change to the server is saved to as an override, instead of a file other clients read. */
		const ownOverrideFile = (entry: McpServerEntry): string | undefined =>
			entry.sharedSource ? (entry.scope === "project" ? projectConfig : globalConfig) : undefined;

		/**
		 * Save a config change; returns an error message when the file could not be updated. Changes to
		 * registered servers only apply to the current session. `inProject` adds a project override.
		 */
		const saveConfig = (server: McpServer, patch: McpServerConfigPatch, inProject = false): string | undefined => {
			const override = inProject ? projectConfig : (server.entry.override ?? ownOverrideFile(server.entry));
			const entry = override ? { ...server.entry, override } : server.entry;
			if (entry.scope !== "extension") {
				try {
					updateConfig(entry, patch);
				} catch (error) {
					return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
				}
			}
			server.entry = { ...entry, config: { ...entry.config, ...patch } };
			return undefined;
		};

		/** Sign in, then reconnect. Returns an error message on failure. `cancel` or the session's end stops the sign-in. */
		const signIn = async (
			server: McpServer,
			prompt: McpSignInPrompt,
			cancel?: AbortSignal,
		): Promise<string | undefined> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return `MCP server "${server.entry.name}" does not use OAuth.`;
			const runtime = await loadMcpRuntime();
			const signal = cancel ? AbortSignal.any([session.signal, cancel]) : session.signal;
			try {
				await track(
					runtime.signInMcpServer({
						serverUrl: url,
						store: getCredentials(runtime).forServer(server.entry.name, url),
						settings: connection.oauthSettings(),
						challenge: connection.challenge,
						prompt,
						signal,
					}),
				);
			} catch (error) {
				if (error instanceof runtime.McpSignInCancelledError) return "Sign-in cancelled.";
				return `Sign-in failed: ${errorMessage(error)}`;
			}
			// The challenge that asked for this sign-in (for example for more scope) is answered.
			connection.challenge = undefined;
			try {
				await connection.reconnect();
			} catch (error) {
				return `Signed in, but ${errorMessage(error)}`;
			}
			return undefined;
		};

		const signOut = async (server: McpServer): Promise<boolean> => {
			const connection = server.connection;
			const url = connection?.oauthUrl;
			if (!connection || !url) return false;
			const removed = getCredentials(await loadMcpRuntime()).remove(server.entry.name, url);
			await connection.signOut();
			return removed;
		};

		const reconnect = async (server: McpServer): Promise<string | undefined> => {
			const connection = server.connection;
			if (!connection) return `MCP server "${server.entry.name}" is disabled.`;
			const previous = server.ready;
			const ready = (async () => {
				await previous;
				await connection.reconnect();
			})();
			server.ready = ready.catch(() => undefined);
			try {
				await ready;
				return undefined;
			} catch (error) {
				return errorMessage(error);
			}
		};

		/** Returns an error message when the config could not be saved; connection errors show in the state. */
		const setEnabled = async (
			server: McpServer,
			enabled: boolean,
			inProject = false,
		): Promise<string | undefined> => {
			const failed = saveConfig(server, { enabled }, inProject);
			if (failed) return failed;
			if (!enabled) {
				const connection = server.connection;
				server.attempt = undefined;
				server.connection = undefined;
				if (connection) {
					// A reconnect may already have detached its old client while awaiting transport
					// shutdown. Closing the connection alone does not wait for that reconnect.
					server.closing = Promise.all([connection.close(), server.ready]).then(() => undefined);
				}
				const closing = server.closing;
				hideTools(server.entry.name);
				emitChange();
				try {
					await closing;
				} finally {
					if (server.closing === closing) server.closing = undefined;
				}
				return undefined;
			}
			await startConnections([server], server.closing);
			return undefined;
		};

		const setExposure = (server: McpServer, exposure: McpExposure): string | undefined => {
			const failed = saveConfig(server, { exposure });
			if (failed) return failed;
			if (isEnabled(server) && server.cached) registerTools(server.entry, server.cached);
			syncResourceTools();
			// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
			const indirect = new Set(
				pi
					.getAllTools()
					.filter((tool) => tool.exposure !== "direct")
					.map((tool) => tool.name),
			);
			const tools = serverTools.get(server.entry.name) ?? new Set<string>();
			pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
			emitChange();
			return undefined;
		};

		// ---------------------------------------------------------------------------------------
		// Manager (`/mcp` in the TUI)
		// ---------------------------------------------------------------------------------------

		const notices = () => [
			...configErrors.map((error) => `config: ${error}`),
			...configNotices.map((line) => `replaced: ${line}`),
			...overridden.map((line) => `overridden: ${line}`),
		];

		const serversMenu = (): McpMenu => ({
			title: "MCP servers",
			error: notices().join("\n") || undefined,
			items: [...servers]
				.sort((a, b) => attentionRank(a) - attentionRank(b) || a.entry.name.localeCompare(b.entry.name))
				.map((server) => ({
					value: server.entry.name,
					label: server.entry.name,
					description: [
						describeState(server),
						exposureOf(server.entry),
						...(approvalOf(server.entry) === "never" ? [] : [`approve ${approvalOf(server.entry)}`]),
						server.entry.override
							? `${server.entry.scope}, override`
							: (server.entry.scope ?? server.entry.source),
					].join(" · "),
				})),
			empty: noServersMessage(),
			confirmLabel: "manage",
			cancelLabel: "close",
		});

		const serverMenu = (name: string): McpMenu => {
			const server = findServer(name);
			if (!server) {
				return {
					title: name,
					items: [],
					empty: "This server is no longer configured.",
					confirmLabel: "",
					cancelLabel: "back",
				};
			}
			const { entry, connection } = server;
			const savedTo = entry.override ?? ownOverrideFile(entry) ?? entry.source;
			const saved = entry.scope === "extension" ? "for this session" : `saved to ${savedTo}`;
			// Global servers without a project override can be turned on or off for the trusted project alone.
			const inProject = entry.scope === "global" && projectConfig !== undefined && entry.override !== projectConfig;
			const inProjectSaved = "saved to the project mcp.json";
			const items: SelectItem[] = [];
			if (!isEnabled(server)) {
				items.push({ value: "enable", label: "Enable", description: saved });
				if (inProject) {
					items.push({ value: "enable-project", label: "Enable in this project", description: inProjectSaved });
				}
			} else {
				const state = connection?.state;
				if (state === "needs-auth")
					items.push({ value: "signin", label: "Sign in", description: "opens the browser" });
				if ((state === "connected" || state === "idle") && connection) {
					items.push({ value: "tools", label: "Tools", description: `${connection.tools.length} offered` });
				}
				if (state === "idle") items.push({ value: "reconnect", label: "Connect" });
				if (state === "failed" || state === "disconnected" || state === "connected" || state === "needs-auth") {
					items.push({ value: "reconnect", label: "Reconnect" });
				}
				if ((state === "connected" || state === "idle") && connection?.oauthUrl) {
					items.push({ value: "signout", label: "Sign out", description: "deletes the stored credentials" });
				}
				items.push({ value: "exposure", label: "Exposure", description: exposureOf(entry) });
				items.push({ value: "disable", label: "Disable", description: saved });
				if (inProject) {
					items.push({ value: "disable-project", label: "Disable in this project", description: inProjectSaved });
				}
			}
			const details = [
				describeTransport(entry),
				`${entry.scope ?? "config"}: ${entry.source}`,
				...(entry.override ? [`override: ${entry.override}`] : []),
				`State: ${describeState(server, false)}`,
				`Approval: ${approvalOf(entry)}`,
			];
			const error = [server.message, connection?.state === "connected" ? undefined : connection?.error]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			return {
				title: `MCP server ${name}`,
				details: details.join("\n"),
				error: error || undefined,
				items,
				selected: items[0]?.value,
				confirmLabel: "select",
				cancelLabel: "back",
			};
		};

		const showTools = async (ui: McpUi, server: McpServer) => {
			const exposure = exposureOf(server.entry);
			const overridden = Object.keys(server.entry.config.toolExposure ?? {}).length > 0;
			await ui.menu(() => ({
				title: `Tools of ${server.entry.name}`,
				details: `Exposure ${exposure}: ${exposure === "hidden" ? "unreachable" : EXPOSURE_DESCRIPTIONS[exposure]}${overridden ? "\nSome tools override it with toolExposure." : ""}`,
				items: ((server.connection ?? server.cached)?.tools ?? []).map((tool) => {
					const toolExposure = getMcpToolExposure(server.entry.config, tool.name);
					const description = firstLine(tool.description ?? "");
					return {
						value: tool.name,
						label: tool.name,
						description: toolExposure === exposure ? description : `[${toolExposure}] ${description}`,
					};
				}),
				empty: "The server offers no tools.",
				confirmLabel: "back",
				cancelLabel: "back",
			}));
		};

		const chooseExposure = async (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const current = exposureOf(server.entry);
			const choice = await ui.menu(() => ({
				title: `Exposure of ${server.entry.name}`,
				details:
					server.entry.scope === "extension"
						? `Applies to this session; the server is registered by ${server.entry.source}.`
						: `Saved to ${server.entry.override ?? ownOverrideFile(server.entry) ?? server.entry.source}.`,
				items: (Object.keys(EXPOSURE_DESCRIPTIONS) as (keyof typeof EXPOSURE_DESCRIPTIONS)[]).map((exposure) => ({
					value: exposure,
					label: `${exposure === current ? "✓ " : "  "}${exposure}`,
					description: EXPOSURE_DESCRIPTIONS[exposure],
				})),
				selected: current,
				confirmLabel: "save",
				cancelLabel: "back",
			}));
			if (!choice || choice === current) return undefined;
			return setExposure(server, choice as McpExposure);
		};

		/** Sign in with the manager view's sign-in screen, which shows the URL with a copy key and cancels with Esc. */
		const signInWithUi = (ui: McpUi, server: McpServer): Promise<string | undefined> => {
			const title = `Sign in to ${server.entry.name}`;
			const cancel = new AbortController();
			const status = (message: string) => ui.status(title, message, () => cancel.abort());
			let authorizationUrl = "";
			status("Contacting the authorization server…");
			return signIn(
				server,
				{
					showAuthorizationUrl: (url) => {
						authorizationUrl = url.href;
						openUrl(url.href);
					},
					promptForRedirectUrl: async (signal) => {
						const value = await ui.redirectUrl(title, authorizationUrl, signal);
						status("Connecting…");
						return value;
					},
				},
				cancel.signal,
			);
		};

		/** Keep the subscribed menu usable while a connection opens or closes. */
		const runInBackground = (
			ctx: ExtensionContext,
			server: McpServer,
			operation: () => Promise<string | undefined>,
		) => {
			const ready = operation();
			const attempt = server.attempt;
			const { signal } = session;
			const finish = (message: string | undefined) => {
				if (signal.aborted || server.attempt !== attempt || !servers.includes(server)) return;
				server.message = message;
				ensureDiscoveryActive(ctx);
				emitChange();
			};
			void track(ready.then(finish, (error: unknown) => finish(errorMessage(error))));
		};

		const runAction = async (ui: McpUi, ctx: ExtensionContext, server: McpServer, action: string) => {
			const { signal } = session;
			let message: string | undefined;
			switch (action) {
				case "signin":
					message = await signInWithUi(ui, server);
					break;
				case "reconnect":
					// Connection state and error already report failures, including required sign-ins.
					runInBackground(ctx, server, async () => {
						await reconnect(server);
						return undefined;
					});
					break;
				case "signout":
					await signOut(server);
					break;
				case "tools":
					await showTools(ui, server);
					break;
				case "exposure":
					message = await chooseExposure(ui, server);
					break;
				case "enable":
				case "disable":
				case "enable-project":
				case "disable-project": {
					const enable = action.startsWith("enable");
					runInBackground(ctx, server, () => setEnabled(server, enable, action.endsWith("-project")));
					break;
				}
			}
			// The session ended meanwhile (for example during a sign-in), which made ctx stale.
			if (signal.aborted) return;
			server.message = message;
			ensureDiscoveryActive(ctx);
			emitChange();
		};
		const manage = async (ui: McpUi, ctx: ExtensionContext) => {
			for (;;) {
				const name = await ui.menu(serversMenu, subscribe);
				if (!name) return;
				for (;;) {
					const action = await ui.menu(() => serverMenu(name), subscribe);
					const server = findServer(name);
					if (!action || !server) break;
					await runAction(ui, ctx, server, action);
				}
			}
		};

		// ---------------------------------------------------------------------------------------
		// Subcommands and plain status (no TUI)
		// ---------------------------------------------------------------------------------------

		const formatStatus = (): string => {
			if (
				servers.length === 0 &&
				configErrors.length === 0 &&
				configNotices.length === 0 &&
				overridden.length === 0
			) {
				return noServersMessage();
			}
			const lines = servers.map((server) => {
				const { name } = server.entry;
				const approve = approvalOf(server.entry);
				const settings = `(${exposureOf(server.entry)}${approve === "never" ? "" : `, approve ${approve}`}) from ${server.entry.source}`;
				const connection = server.connection;
				if (!isEnabled(server)) return `${name}: disabled ${settings}`;
				const current = stateOf(server);
				if (current === "needs-auth") return `${name}: needs sign-in, run /mcp login ${name} ${settings}`;
				const offer = connection ?? server.cached;
				const tools =
					(current === "connected" || current === "idle") && offer ? `, ${offer.tools.length} tools` : "";
				const state =
					current === "disconnected"
						? "disconnected, reconnects on next call"
						: current === "idle"
							? "idle, connects on next call"
							: current;
				const error =
					connection?.error && connection.state !== "connected"
						? `\n    ${connection.error.split("\n").join("\n    ")}`
						: "";
				return `${name}: ${state}${tools} ${settings}${error}`;
			});
			for (const error of configErrors) lines.push(`config error: ${error}`);
			for (const line of configNotices) lines.push(`replaced: ${line}`);
			for (const line of overridden) lines.push(`overridden: ${line}`);
			return lines.join("\n");
		};

		/** Resolve the server for a subcommand, asking when the name is omitted and ambiguous. */
		const pickServer = async (
			name: string | undefined,
			ctx: ExtensionCommandContext,
			options: { eligible: (server: McpServer) => boolean; preferred: (server: McpServer) => boolean; none: string },
		): Promise<McpServer | undefined> => {
			if (name) {
				const server = findServer(name);
				if (!server) ctx.ui.notify(`No MCP server named "${name}".`, "error");
				else if (!options.eligible(server)) ctx.ui.notify(options.none, "error");
				return server && options.eligible(server) ? server : undefined;
			}
			const candidates = servers.filter(options.eligible);
			if (candidates.length === 0) {
				ctx.ui.notify(options.none, "info");
				return undefined;
			}
			const preferred = candidates.filter(options.preferred);
			if (candidates.length === 1) return candidates[0];
			if (preferred.length === 1) return preferred[0];
			const choice = await ctx.ui.select(
				"MCP server",
				candidates.map((server) => server.entry.name),
			);
			return candidates.find((server) => server.entry.name === choice);
		};

		const usesOAuth = (server: McpServer) => server.connection?.oauthUrl !== undefined;
		const oauthPick = {
			eligible: usesOAuth,
			preferred: (server: McpServer) => server.connection?.state === "needs-auth",
			none: "No enabled MCP server uses OAuth. Only HTTP servers without an Authorization header do.",
		};

		const loginCommand = async (server: McpServer, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			if (!ctx.hasUI) {
				ctx.ui.notify(`Signing in to MCP server "${name}" requires interactive mode.`, "error");
				return;
			}
			const { signal } = session;
			let failure: string | undefined;
			if (ctx.mode === "tui") {
				await showMcpManager(ctx, async (ui) => {
					failure = await signInWithUi(ui, server);
				});
			} else {
				failure = await signIn(server, {
					showAuthorizationUrl: (url) => {
						ctx.ui.notify(`Sign in to MCP server "${name}" in your browser:\n${url.href}`, "info");
						openUrl(url.href);
					},
					promptForRedirectUrl: (signal) =>
						ctx.ui.input(
							`Waiting for sign-in to "${name}". If the browser cannot reach this machine, paste the URL it was redirected to.`,
							"http://127.0.0.1:.../callback?code=...",
							{ signal },
						),
				});
			}
			// The session ended meanwhile, which cancelled the sign-in and made ctx stale.
			if (signal.aborted) return;
			if (failure) {
				ctx.ui.notify(failure, failure === "Sign-in cancelled." ? "info" : "error");
				return;
			}
			ensureDiscoveryActive(ctx);
			ctx.ui.notify(`Signed in to MCP server "${name}" (${server.connection?.tools.length ?? 0} tools).`, "info");
		};

		pi.on("session_start", (_event, ctx) => {
			const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx);
			configErrors = loaded.errors;
			configNotices = loaded.notices ?? [];
			globalConfig = loaded.globalConfig ?? join(getAgentDir(), "mcp.json");
			projectConfig = loaded.projectConfig;
			autoEnableCodemode = loaded.autoEnableCodemode ?? true;
			warnedUnreachable = false;
			waitedForStartup = false;
			sessionCwd = ctx.cwd;
			modelRegistry = ctx.modelRegistry;
			sessionApprovals = readSessionApprovals(ctx.sessionManager.getBranch());
			const allowed = readAlwaysAllowedServers(approvalsPath, ctx.cwd);
			alwaysAllowed = allowed.servers;
			if (allowed.problem)
				configNotices = [...configNotices, `${allowed.problem}; servers always allowed in it ask again`];
			previousPromptAnswered = Promise.resolve();
			session = new AbortController();
			sessionContext = ctx;
			promptCommands.withdrawAll();
			// Other modes run a prompt command by its name, so only the TUI completes them.
			if (ctx.mode === "tui") ctx.ui.addAutocompleteProvider((current) => promptCommands.autocomplete(current));
			const { signal } = session;
			configuredEntries = loaded.servers;
			const registered = registeredServers();
			overridden = registered.overridden;
			servers = [...loaded.servers.map((entry) => ({ entry })), ...registered.servers];
			emitChange();
			for (const notice of configNotices) ctx.ui.notify(`MCP: ${notice}`, "info");
			// Codemode or tool_search is activated from the config: the first prompt does not wait for
			// servers whose tools are not declared to the model, and scripts or searches wait for them.
			ensureDiscoveryActive(ctx);
			const enabled = servers.filter(isEnabled);
			if (enabled.length === 0) {
				reportProblems(ctx);
				return;
			}
			// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
			// event loop turn lets the first render happen before loading and connecting.
			const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
			pending = startConnections(enabled, runtime)
				.then(() => {
					if (!signal.aborted) reportProblems(ctx);
				})
				.catch((error: unknown) => {
					// The session may have been disposed meanwhile, which makes ctx stale.
					try {
						ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
					} catch {}
				});
		});

		// The first prompt waits for servers whose tools are declared to the model, so they are declared
		// in its first request, but not indefinitely: a slow or hanging server must not hold up the
		// prompt. Other servers are waited for when a script or search needs them (below).
		const waitForDirectServers = async (ctx: ExtensionContext) => {
			if (waitedForStartup) return;
			waitedForStartup = true;
			const ready = servers.flatMap((server) =>
				isEnabled(server) && hasDirectTools(server.entry) && server.ready ? [server.ready] : [],
			);
			if (ready.length === 0) return;
			let timer: NodeJS.Timeout | undefined;
			const finished = await Promise.race([
				Promise.all(ready).then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), startupWaitMs);
				}),
			]);
			clearTimeout(timer);
			if (!finished) {
				ctx.ui.notify("MCP servers are still connecting; their tools become available once connected.", "info");
			}
		};

		// Every prompt lists the servers in the `mcp_servers` section as they are when it starts. Pi
		// appends the section to the conversation when it changed, for example after a server connected.
		pi.on("before_agent_start", async (event, ctx) => {
			await waitForDirectServers(ctx);
			const { sections } = event.systemPromptOptions;
			const section = renderServersSection(
				servers.map((server) => ({ entry: server.entry, connection: server.connection ?? server.cached })),
			);
			if (section) sections[MCP_SERVERS_SECTION] = section;
			else delete sections[MCP_SERVERS_SECTION];
		});

		const gatedCall = (toolName: string) => {
			const owner = toolOwners.get(toolName);
			const [name, tool] = owner?.split("\0") ?? [];
			const server = name === undefined ? undefined : findServer(name);
			if (!server || tool === undefined) return undefined;
			if (sessionApprovals.has(approvalKey({ server: name, tool, configHash: configHash(server.entry) })))
				return undefined;
			const approve = approvalOf(server.entry);
			return needsApproval(approve, definitions.get(toolName)?.annotations) ? { server, tool, approve } : undefined;
		};

		/** Asks `question` and applies the answer. `tool` is the key "Allow for this session" records. */
		const askApproval = async (
			server: McpServer,
			tool: string,
			question: string,
			denied: string,
			ctx: ExtensionContext,
		): Promise<ToolCallEventResult | undefined> => {
			const name = server.entry.name;
			const answer = await ctx.ui.select(
				question,
				MCP_APPROVAL_CHOICES.map((choice) => choice.label),
				{ signal: ctx.signal },
			);
			switch (MCP_APPROVAL_CHOICES.find((choice) => choice.label === answer)?.choice) {
				case "once":
					return undefined;
				case "session": {
					const approval = { server: name, tool, configHash: configHash(server.entry) };
					sessionApprovals.add(approvalKey(approval));
					pi.appendEntry<McpApprovalEntryData>(MCP_APPROVAL_ENTRY_TYPE, approval);
					return undefined;
				}
				case "server": {
					const hash = configHash(server.entry);
					alwaysAllowed = new Map([...alwaysAllowed, [name, hash]]);
					try {
						saveAlwaysAllowedServer(approvalsPath, sessionCwd, name, hash);
					} catch (error) {
						ctx.ui.notify(`Could not update ${approvalsPath}: ${errorMessage(error)}`, "error");
					}
					emitChange();
					return undefined;
				}
				default:
					return { block: true, reason: denied };
			}
		};

		/** Why a call that needs approval fails when nothing can ask. */
		const cannotAskReason = (server: McpServer, approve: McpApproval, subject: string, ctx: ExtensionContext) => {
			const { name, override, source, scope } = server.entry;
			const allow =
				scope === "project"
					? `Choose "Always allow this server" in an interactive session to run its tools without asking; a project file cannot lower "approve".`
					: `Set "approve": "never" for the server in your own mcp.json to run its tools without asking.`;
			return `${subject} needs approval ("approve": "${approve}" for server "${name}" in ${override ?? source}), and ${ctx.mode} mode cannot ask. ${allow}`;
		};

		const approveCall = (
			toolName: string,
			input: Record<string, unknown>,
			ctx: ExtensionContext,
		): ToolCallEventResult | Promise<ToolCallEventResult | undefined> | undefined => {
			const gated = gatedCall(toolName);
			if (!gated) return undefined;
			if (!ctx.hasUI) {
				const { server, tool, approve } = gated;
				return {
					block: true,
					reason: cannotAskReason(server, approve, `MCP tool ${server.entry.name}/${tool}`, ctx),
				};
			}
			const prompt = previousPromptAnswered.then(() => {
				const stillGated = gatedCall(toolName);
				if (!stillGated) return undefined;
				const { server, tool } = stillGated;
				return askApproval(
					server,
					tool,
					`Allow MCP server "${server.entry.name}" to run ${JSON.stringify(tool)}?\n${truncate(JSON.stringify(input, null, 2), 500)}`,
					`The user denied the call to MCP tool ${server.entry.name}/${tool}.`,
					ctx,
				);
			});
			previousPromptAnswered = prompt.catch(() => undefined);
			return prompt;
		};

		/**
		 * A prompt command does not need approval to run, but it may not start a server whose calls ask
		 * first: such a server stays idle until a call is allowed, so asking here keeps a denied prompt
		 * from starting it. That holds for any server without a live client (idle, disconnected,
		 * failed, signed out), since getting the prompt connects it. A server that is connected or
		 * connecting, or whose calls never ask, runs the prompt.
		 */
		const approvePromptStart = async (server: McpServer, prompt: string, ctx: ExtensionCommandContext) => {
			const { name } = server.entry;
			const key = `\0prompt\0${prompt}`;
			const gated = () =>
				isEnabled(server) &&
				server.connection?.state !== "connected" &&
				server.connection?.state !== "connecting" &&
				approvalOf(server.entry) !== "never" &&
				!sessionApprovals.has(approvalKey({ server: name, tool: key, configHash: configHash(server.entry) }));
			if (!gated()) return;
			if (!ctx.hasUI) {
				throw new Error(
					cannotAskReason(server, approvalOf(server.entry), `Starting MCP server "${name}" for the prompt`, ctx),
				);
			}
			const answered = previousPromptAnswered.then(async () => {
				if (!gated()) return;
				const denied = await askApproval(
					server,
					key,
					`Allow MCP server "${name}" to start and run its prompt ${JSON.stringify(prompt)}?`,
					`The user denied starting MCP server "${name}".`,
					ctx,
				);
				if (denied?.reason) throw new Error(denied.reason);
			});
			previousPromptAnswered = answered.catch(() => undefined);
			await answered;
		};

		// A tool that reaches other tools (`reachesTools`) waits for the servers it may reach, so their
		// tools are registered before it runs: a codemode script for the servers it names, or for every
		// server when it searches or enumerates tools, and tool_search for every server. The resource
		// tools reach every server, so they wait for all of them. Direct MCP calls wait only for their
		// own server, including a reconnect still closing its old transport.
		pi.on("tool_call", async (event, ctx) => {
			const blocked = await approveCall(event.toolName, event.input, ctx);
			if (blocked) return blocked;
			const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
			if (!tool) return;
			// Readiness can be pending while the display state is still connected: reconnect first
			// closes the old transport, then opens a new one. Settled promises return immediately.
			const readyServers = servers.filter((server) => isEnabled(server) && server.ready);
			if (readyServers.length === 0) return;
			let waiting: McpServer[] = [];
			const reach = tool.reachesTools?.(event.input);
			if (reach !== undefined) {
				waiting = readyServers.filter((server) => reachesServer(reach, server.entry.name));
			} else if (RESOURCE_TOOL_NAMES.has(tool.name)) {
				waiting = readyServers;
			} else {
				const owner = ownerOf(event.toolName);
				waiting = readyServers.filter((server) => server.entry.name === owner);
			}
			await waitForServers(waiting, ctx.signal);
			if (reach !== undefined && reach !== "all") for (const server of waiting) warmUp(server);
		});

		pi.on("tool_result", (event) => {
			if (event.toolName !== TOOL_SEARCH_TOOL_NAME || event.isError || !("details" in event)) return;
			const loaded = (event.details as { loaded?: unknown } | undefined)?.loaded;
			if (!Array.isArray(loaded)) return;
			const owners = new Set(loaded.map((name) => (typeof name === "string" ? ownerOf(name) : undefined)));
			for (const server of servers) if (owners.has(server.entry.name)) warmUp(server);
		});

		// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
		pi.on("turn_start", async (_event, ctx) => {
			if (tokensAtSignIn.size > 0) await reconnectSignedIn(ctx);
		});

		// Servers registered or unregistered during the session connect or disconnect right away.
		pi.on("mcp_servers_change", async (_event, ctx) => {
			const { signal } = session;
			if (signal.aborted) return;
			const registered = registeredServers();
			overridden = registered.overridden;
			const next = new Map(registered.servers.map((server) => [server.entry.name, server]));
			// Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
			const removed = servers.filter(
				(server) =>
					server.entry.scope === "extension" &&
					next.get(server.entry.name)?.registeredConfig !== server.registeredConfig,
			);
			servers = servers.filter((server) => !removed.includes(server));
			for (const server of removed) hideTools(server.entry.name);
			const added = registered.servers.filter((server) => !findServer(server.entry.name));
			servers.push(...added);
			emitChange();
			ensureDiscoveryActive(ctx);
			await Promise.all(removed.map((server) => server.connection?.close()));
			const connecting = added.filter(isEnabled);
			if (signal.aborted || connecting.length === 0) return;
			try {
				await startConnections(connecting);
				if (signal.aborted) {
					await Promise.all(connecting.map((server) => server.connection?.close()));
					return;
				}
			} catch (error) {
				ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				return;
			}
			if (signal.aborted) return;
			reportProblems(ctx, connecting);
		});

		// Approvals recorded on the branch the user left do not apply on the one navigated to.
		pi.on("session_tree", (_event, ctx) => {
			sessionApprovals = readSessionApprovals(ctx.sessionManager.getBranch());
		});

		pi.on("session_shutdown", async () => {
			session.abort();
			const closing = connections();
			servers = [];
			emitChange();
			await Promise.all([...backgroundActions, ...closing.map((connection) => connection.close())]);
		});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: sign in, reconnect, enable or disable, and change exposure",
			getArgumentCompletions: (prefix) => {
				const [action, server, ...rest] = prefix.trimStart().split(/\s+/);
				if (rest.length > 0) return null;
				if (server === undefined) {
					return ["login", "logout", "reconnect"]
						.filter((item) => item.startsWith(action ?? ""))
						.map((item) => ({ value: `${item} `, label: item }));
				}
				if (action !== "login" && action !== "logout" && action !== "reconnect") return null;
				const items = servers
					.filter((candidate) =>
						action === "reconnect" ? candidate.connection !== undefined : usesOAuth(candidate),
					)
					.filter((candidate) => candidate.entry.name.startsWith(server))
					.map((candidate) => ({
						value: `${action} ${candidate.entry.name}`,
						label: candidate.entry.name,
						description: describeState(candidate),
					}));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const [action, name, ...extra] = args.trim().split(/\s+/).filter(Boolean);
				if (action === undefined) {
					if (ctx.mode === "tui") await showMcpManager(ctx, (ui) => manage(ui, ctx));
					else {
						await pending;
						ctx.ui.notify(formatStatus(), "info");
					}
					return;
				}
				if (extra.length > 0) {
					ctx.ui.notify(MCP_USAGE, "warning");
					return;
				}
				await pending;
				switch (action) {
					case "login": {
						const server = await pickServer(name, ctx, oauthPick);
						if (server) await loginCommand(server, ctx);
						return;
					}
					case "logout": {
						const server = await pickServer(name, ctx, oauthPick);
						if (!server) return;
						const removed = await signOut(server);
						ctx.ui.notify(
							removed
								? `Signed out of MCP server "${server.entry.name}".`
								: `No stored credentials for MCP server "${server.entry.name}".`,
							"info",
						);
						return;
					}
					case "reconnect": {
						const server = await pickServer(name, ctx, {
							eligible: (candidate) => candidate.connection !== undefined,
							preferred: (candidate) =>
								candidate.connection?.state === "failed" || candidate.connection?.state === "disconnected",
							none: "No enabled MCP server to reconnect.",
						});
						if (!server) return;
						const failure = await reconnect(server);
						if (failure) ctx.ui.notify(failure, "error");
						else {
							ensureDiscoveryActive(ctx);
							ctx.ui.notify(
								`Reconnected to MCP server "${server.entry.name}" (${describeState(server)}).`,
								"info",
							);
						}
						return;
					}
					default:
						ctx.ui.notify(MCP_USAGE, "warning");
				}
			},
		});
	};
}

function defaultLoadConfig(ctx: ExtensionContext): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
}

export default createMcpExtension();
