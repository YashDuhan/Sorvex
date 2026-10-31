/**
 * MCP server configuration.
 *
 * Servers are read from the files of {@link mcpConfigSources}, in order: `~/.config/mcp/mcp.json`,
 * which other MCP clients share, `mcp.json` in the agent directory, and for trusted projects the
 * project's `.mcp.json` (as Claude Code writes it) and `<project>/<CONFIG_DIR_NAME>/mcp.json`. All use
 * the `mcpServers` shape shared by other MCP clients. A later file's entry replaces an earlier entry
 * with the same name. Pi never writes the files other clients read.
 *
 * An entry without `command`, `url`, or `type` overrides only `enabled`, `exposure`,
 * `toolExposure`, and `approve` of the server with the same name from an earlier file, for example to
 * turn it off in one project: `{ "mcpServers": { "internal-tools": { "enabled": false } } }`. The rest
 * of the earlier entry is kept, including credentials the project could not set itself.
 *
 * Project files can make `approve` stricter than the user's setting for a server but not looser, and
 * servers from `.mcp.json` are at least `writes`.
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } },
 *     "sentry": { "url": "https://mcp.sentry.dev/mcp" }
 *   }
 * }
 * ```
 *
 * HTTP servers without an `Authorization` header use OAuth when they answer 401 (sign in with `/mcp`).
 * `"auth": { "provider": "<provider>" }` sends the token of a `/login` provider instead. Project files
 * cannot use it, so a repository cannot pick where the credential goes.
 *
 * The top-level `autoEnableCodemode` (default true) activates the codemode tool when a server
 * with `codemode` exposure connects. A project value overrides the global one.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import {
	type McpApproval,
	type McpExposure,
	type McpServerConfig,
	mcpNamespace,
	PROJECT_MCP_JSON,
	strictestMcpApproval,
	validateMcpServerConfig,
} from "../../core/mcp-servers.ts";
import { stripBom } from "../../utils/text.ts";

export type {
	McpApproval,
	McpExposure,
	McpHttpServerConfig,
	McpOAuthConfig,
	McpServerConfig,
	McpStdioServerConfig,
} from "../../core/mcp-servers.ts";
export { getMcpToolExposure } from "../../core/mcp-servers.ts";

export interface McpServerEntry {
	name: string;
	config: McpServerConfig;
	/** Config file that defined the entry, or the path of the extension that registered it. */
	source: string;
	/**
	 * Whether a user-level or a project config file defines the server, or `extension` for servers
	 * registered with `pi.registerMcpServer()`. Changes to extension servers are not saved.
	 */
	scope?: "global" | "project" | "extension";
	/** Whether other MCP clients read `source`, so `/mcp` saves changes as an override in pi's own file. */
	sharedSource?: boolean;
	/** Later file with an override of this server's `enabled`, `exposure`, `toolExposure`, or `approve`. */
	override?: string;
}

export interface LoadedMcpConfig {
	servers: McpServerEntry[];
	/** Activate the codemode tool when `codemode` servers connect. Default: true. */
	autoEnableCodemode?: boolean;
	errors: string[];
	/** Project servers that replace a user server of the same name, one line each. */
	notices?: string[];
	/** The agent directory's `mcp.json`, where `/mcp` saves overrides of servers from `~/.config/mcp/mcp.json`. */
	globalConfig?: string;
	/** The project `mcp.json` when the project is trusted, where `/mcp` saves project overrides. */
	projectConfig?: string;
}

const OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure", "approve"];

/** A config file servers are read from. */
export interface McpConfigSource {
	path: string;
	scope: "global" | "project";
	/** Whether other MCP clients read the file too. Pi never writes it. */
	shared?: boolean;
	/** The loosest `approve` the file's servers get. */
	minApprove?: McpApproval;
}

/**
 * The config files in merge order: a later file's server replaces an earlier one of the same name.
 * Project files are included only when the project is trusted.
 */
export function mcpConfigSources(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	homeDir?: string;
}): McpConfigSource[] {
	const sources: McpConfigSource[] = [
		{ path: join(options.homeDir ?? homedir(), ".config", "mcp", "mcp.json"), scope: "global", shared: true },
		{ path: join(options.agentDir, "mcp.json"), scope: "global" },
	];
	if (!options.projectTrusted) return sources;
	return [
		...sources,
		{ path: join(options.cwd, PROJECT_MCP_JSON), scope: "project", shared: true, minApprove: "writes" },
		{ path: join(options.cwd, CONFIG_DIR_NAME, "mcp.json"), scope: "project" },
	];
}

/** Whether an entry overrides a server defined elsewhere instead of defining one. */
function isOverride(value: Record<string, unknown>): boolean {
	return value.command === undefined && value.url === undefined && value.type === undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface McpConfigState {
	servers: Map<string, McpServerEntry>;
	/** Servers as the user's own files define them, whose `approve` project files cannot loosen. */
	userServers: Map<string, McpServerEntry>;
	autoEnableCodemode?: boolean;
	errors: string[];
	notices: string[];
}

function readConfigFile(source: McpConfigSource, state: McpConfigState): void {
	const { path, scope } = source;
	const { servers, errors } = state;
	const set = (entry: McpServerEntry) => {
		servers.set(entry.name, entry);
		if (scope === "global") state.userServers.set(entry.name, entry);
	};
	if (!existsSync(path)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch (error) {
		errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		errors.push(`${path}: expected an object with an "mcpServers" object`);
		return;
	}
	if (typeof parsed.autoEnableCodemode === "boolean") state.autoEnableCodemode = parsed.autoEnableCodemode;
	else if (parsed.autoEnableCodemode !== undefined) errors.push(`${path}: autoEnableCodemode must be a boolean`);
	for (const [name, value] of Object.entries(parsed.mcpServers ?? {})) {
		if (isRecord(value) && isOverride(value) && (scope === "project" || servers.has(name))) {
			const base = servers.get(name);
			const extra = Object.keys(value).filter((key) => !OVERRIDE_KEYS.includes(key));
			if (!base) {
				errors.push(
					`${path}: server "${name}" needs "command" or "url", or a server in an earlier file to override`,
				);
			} else if (extra.length > 0) {
				errors.push(`${path}: server "${name}": an override can only set ${OVERRIDE_KEYS.join(", ")}`);
			} else {
				const config = validateMcpServerConfig(name, { ...base.config, ...value });
				if (typeof config === "string") {
					errors.push(`${path}: ${config}`);
					continue;
				}
				const approvals = [base.config.approve, config.approve];
				if (scope === "project" && approvals.some(Boolean)) config.approve = strictestMcpApproval(approvals);
				set({ ...base, config, override: path });
			}
			continue;
		}
		const config = validateMcpServerConfig(name, value);
		if (typeof config === "string") {
			errors.push(`${path}: ${config}`);
			continue;
		}
		if (scope === "project") {
			const approvals = [config.approve, state.userServers.get(name)?.config.approve, source.minApprove];
			if (approvals.some(Boolean)) config.approve = strictestMcpApproval(approvals);
		}
		// Names that differ only in `-` and `_` would share a namespace.
		const clash = [...servers.keys()].find((other) => other !== name && mcpNamespace(other) === mcpNamespace(name));
		if (clash) {
			errors.push(`${path}: server "${name}" conflicts with "${clash}"`);
			continue;
		}
		if (scope === "project" && "url" in config && config.auth) {
			errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
			continue;
		}
		const replaced = servers.get(name);
		if (scope === "project" && replaced?.scope === "global") {
			state.notices.push(`${path}: server "${name}" replaces the one in ${replaced.override ?? replaced.source}`);
		}
		set({ name, config, source: path, scope, ...(source.shared ? { sharedSource: true } : {}) });
	}
}

/**
 * Load user-level and (when trusted) project MCP configuration. Disabled servers are included with
 * `enabled: false`, so they can be enabled again.
 */
export function loadMcpConfig(options: {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	homeDir?: string;
}): LoadedMcpConfig {
	const state: McpConfigState = { servers: new Map(), userServers: new Map(), errors: [], notices: [] };
	for (const source of mcpConfigSources(options)) readConfigFile(source, state);
	const projectConfig = options.projectTrusted ? join(options.cwd, CONFIG_DIR_NAME, "mcp.json") : undefined;
	return {
		servers: [...state.servers.values()],
		...(state.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: state.autoEnableCodemode }),
		errors: state.errors,
		notices: state.notices,
		globalConfig: join(options.agentDir, "mcp.json"),
		...(projectConfig ? { projectConfig } : {}),
	};
}

/** Settings `/mcp` changes. `enabled: true` and `exposure: "codemode"` are the defaults and remove the key. */
export interface McpServerConfigPatch {
	enabled?: boolean;
	exposure?: McpExposure;
}

/**
 * Change one server's settings in the `mcp.json` that defines or overrides it. With `override`, a
 * missing entry is added as an override. Overrides keep default values, since they replace the global
 * server's. Other content is kept; the file is rewritten with its indentation.
 */
export function updateMcpServerConfig(
	path: string,
	name: string,
	patch: McpServerConfigPatch,
	options: { override?: boolean } = {},
): void {
	editMcpServers(path, (servers, parsed) => {
		let server = servers && Object.hasOwn(servers, name) ? servers[name] : undefined;
		if (server === undefined && options.override) {
			server = {};
			parsed.mcpServers = { ...servers, [name]: server };
		}
		if (!isRecord(server)) throw new Error(`${path} does not define MCP server "${name}"`);
		const keepDefaults = isOverride(server);
		if (patch.enabled !== undefined) {
			if (patch.enabled && !keepDefaults) delete server.enabled;
			else server.enabled = patch.enabled;
		}
		if (patch.exposure !== undefined) {
			if (patch.exposure === "codemode" && !keepDefaults) delete server.exposure;
			else server.exposure = patch.exposure;
		}
		return true;
	});
}

/**
 * Add a server to an `mcp.json`, creating the file when missing. An existing entry with the same
 * name is replaced. Returns true when an entry was replaced.
 */
export function addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean {
	let replaced = false;
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		replaced = Object.hasOwn(target, name);
		target[name] = config;
		parsed.mcpServers = target;
		return true;
	});
	return replaced;
}

/**
 * Add the servers an `mcp.json` does not define yet, creating the file when missing. A name that
 * shares a tool namespace with an existing one (`a-b` and `a_b`) counts as defined. Returns the
 * names it added.
 */
export function addMissingMcpServers(path: string, configs: ReadonlyMap<string, McpServerConfig>): string[] {
	const added: string[] = [];
	editMcpServers(path, (servers, parsed) => {
		const target = servers ?? {};
		const namespaces = new Set(Object.keys(target).map(mcpNamespace));
		for (const [name, config] of configs) {
			if (namespaces.has(mcpNamespace(name))) continue;
			target[name] = config;
			namespaces.add(mcpNamespace(name));
			added.push(name);
		}
		parsed.mcpServers = target;
		return added.length > 0;
	});
	return added;
}

/** Remove a server from an `mcp.json`. Returns false when the file does not define it. */
export function removeMcpServerConfig(path: string, name: string): boolean {
	if (!existsSync(path)) return false;
	let removed = false;
	editMcpServers(path, (servers) => {
		if (!servers || !Object.hasOwn(servers, name)) return false;
		delete servers[name];
		removed = true;
		return true;
	});
	return removed;
}

/**
 * Read an `mcp.json` (an empty config when missing), let `edit` change its `mcpServers`, and write
 * it back with its indentation when `edit` returns true. Other content is kept. The file can hold
 * credentials, so it is written readable by the owner only, through a temporary file so a reader
 * never sees it half written.
 */
function editMcpServers(
	path: string,
	edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean,
): void {
	const text = existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
	const parsed: unknown = text === undefined ? {} : JSON.parse(text);
	if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
		throw new Error(`${path}: expected an object with an "mcpServers" object`);
	}
	const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
	if (!edit(servers, parsed)) return;
	const indent = (text && /^([ \t]+)\S/m.exec(text)?.[1]) || "  ";
	const target = text === undefined ? path : realpathSync(path);
	const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	mkdirSync(dirname(target), { recursive: true });
	try {
		writeFileSync(temp, `${JSON.stringify(parsed, null, indent)}\n`, { mode: 0o600 });
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
