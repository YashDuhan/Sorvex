/**
 * Read the MCP servers of other clients for `mcp import`. Each client keeps them in one config file
 * per platform, under `mcpServers`, or `servers` for VS Code. Entries convert to the `mcpServers`
 * shape by keeping `command`, `args`, `env`, `cwd`, `url`, and `headers`, with `env` and `headers`
 * values rewritten so they mean in pi what they meant in the other client. `disabled: true`
 * imports the server disabled.
 */

import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { APP_NAME } from "../../config.ts";
import { type McpServerConfig, validateMcpServerConfig } from "../../core/mcp-servers.ts";
import { stripBom } from "../../utils/text.ts";

export type McpImportClient = "claude-code" | "claude-desktop" | "cursor" | "vscode";

/** What locates a client's config file. */
export interface McpImportEnv {
	platform: NodeJS.Platform;
	home: string;
	/** `%APPDATA%` on Windows. Default (also when empty): `<home>/AppData/Roaming`. */
	appData?: string;
	/** `$XDG_CONFIG_HOME` on Linux. Default (also when empty): `<home>/.config`. */
	xdgConfigHome?: string;
}

interface McpClientFormat {
	label: string;
	serversKey: "mcpServers" | "servers";
	path(env: McpImportEnv): string;
}

function joinFor(env: McpImportEnv, ...parts: string[]): string {
	return (env.platform === "win32" ? win32 : posix).join(...parts);
}

function appConfigDir(env: McpImportEnv, app: string): string {
	if (env.platform === "win32") return joinFor(env, env.appData || joinFor(env, env.home, "AppData", "Roaming"), app);
	if (env.platform === "darwin") return joinFor(env, env.home, "Library", "Application Support", app);
	return joinFor(env, env.xdgConfigHome || joinFor(env, env.home, ".config"), app);
}

export const MCP_IMPORT_CLIENTS: Readonly<Record<McpImportClient, McpClientFormat>> = {
	"claude-code": {
		label: "Claude Code",
		serversKey: "mcpServers",
		path: (env) => joinFor(env, env.home, ".claude.json"),
	},
	"claude-desktop": {
		label: "Claude Desktop",
		serversKey: "mcpServers",
		path: (env) => joinFor(env, appConfigDir(env, "Claude"), "claude_desktop_config.json"),
	},
	cursor: {
		label: "Cursor",
		serversKey: "mcpServers",
		path: (env) => joinFor(env, env.home, ".cursor", "mcp.json"),
	},
	vscode: {
		label: "VS Code",
		serversKey: "servers",
		path: (env) => joinFor(env, appConfigDir(env, "Code"), "User", "mcp.json"),
	},
};

export function isMcpImportClient(value: string): value is McpImportClient {
	return Object.hasOwn(MCP_IMPORT_CLIENTS, value);
}

const IMPORTED_KEYS = ["command", "args", "env", "cwd", "url", "headers"];
/** Fields pi uses as written, apart from a leading `~`. */
const LITERAL_KEYS = ["command", "args", "cwd", "url"];
/** Fields whose values pi reads as `${NAME}` templates or, with a leading `!`, as shell commands. */
const TEMPLATE_KEYS = ["env", "headers"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Variables of VS Code (its predefined variables, https://code.visualstudio.com/docs/reference/variables-reference),
 * Cursor, and dev containers that look like environment variable names but expand to editor state.
 */
const EDITOR_VARIABLES: ReadonlySet<string> = new Set([
	"userHome",
	"workspaceFolder",
	"workspaceFolderBasename",
	"workspaceRoot",
	"file",
	"fileWorkspaceFolder",
	"relativeFile",
	"relativeFileDirname",
	"fileBasename",
	"fileBasenameNoExtension",
	"fileExtname",
	"fileDirname",
	"fileDirnameBasename",
	"cwd",
	"lineNumber",
	"columnNumber",
	"selectedText",
	"execPath",
	"defaultBuildTask",
	"pathSeparator",
	"localWorkspaceFolder",
	"localWorkspaceFolderBasename",
	"containerWorkspaceFolder",
	"containerWorkspaceFolderBasename",
	"devcontainerId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A value of another client as a pi template value with the same meaning: `${env:NAME}` and `${NAME}`
 * read the environment variable, any other `$` and a leading `!` are escaped so they stay literal.
 * Returns the placeholder pi has no equivalent for, such as `${workspaceFolder}`, as `unsupported`.
 */
function convertTemplateValue(value: string): { value: string } | { unsupported: string } {
	let unsupported: string | undefined;
	const converted = value.replace(/\$\{([^}]*)\}|\$/g, (match, inner: string | undefined) => {
		if (inner === undefined) return "$$";
		const name = inner.startsWith("env:") ? inner.slice(4) : inner;
		if (ENV_NAME.test(name) && !EDITOR_VARIABLES.has(name)) return `\${${name}}`;
		unsupported ??= match;
		return match;
	});
	if (unsupported) return { unsupported };
	return { value: converted.startsWith("!") ? `$${converted}` : converted };
}

interface ConvertedServer {
	config: McpServerConfig;
	notes: string[];
}

function convertServer(name: string, raw: unknown): ConvertedServer | string {
	if (!isRecord(raw)) return "the entry is not an object";
	if (raw.type === "sse") return "it uses the SSE transport, which is not supported";
	if (JSON.stringify(raw).includes(`\${input:`)) {
		return `it uses \${input:...} prompts; add it with \${NAME} environment variables instead`;
	}
	for (const key of LITERAL_KEYS) {
		const placeholder = /\$\{[^}]*\}/.exec(JSON.stringify(raw[key] ?? ""))?.[0];
		if (placeholder) return `its ${key} uses ${placeholder}, which ${APP_NAME} does not expand there`;
	}
	const fields: Record<string, unknown> = Object.fromEntries(
		IMPORTED_KEYS.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]),
	);
	for (const key of TEMPLATE_KEYS) {
		const values = fields[key];
		if (!isRecord(values)) continue;
		const converted: Record<string, unknown> = {};
		for (const [field, value] of Object.entries(values)) {
			if (typeof value !== "string") {
				converted[field] = value;
				continue;
			}
			const result = convertTemplateValue(value);
			if ("unsupported" in result)
				return `its ${key} "${field}" uses ${result.unsupported}, which ${APP_NAME} cannot expand`;
			converted[field] = result.value;
		}
		fields[key] = converted;
	}
	if (raw.disabled === true) fields.enabled = false;
	const config = validateMcpServerConfig(name, fields);
	if (typeof config === "string") return config;
	const notes =
		typeof raw.envFile === "string"
			? [`its envFile ${raw.envFile} was not imported; set the variables it needs in "env"`]
			: [];
	return { config, notes };
}

export interface McpClientServers {
	path: string;
	servers: Map<string, McpServerConfig>;
	/** What changed in the meaning of converted entries, such as a dropped `envFile`. */
	notes: { name: string; message: string }[];
	/** Entries that could not be converted, with the reason. */
	skipped: { name: string; reason: string }[];
}

/** The servers of the client's config file, or an error message when the file is missing or invalid. */
export function readMcpClientServers(client: McpImportClient, env: McpImportEnv): McpClientServers | string {
	const format = MCP_IMPORT_CLIENTS[client];
	const path = format.path(env);
	if (!existsSync(path)) return `No ${format.label} config at ${path}.`;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch (error) {
		return `${path}: ${error instanceof Error ? error.message : String(error)}`;
	}
	const entries = isRecord(parsed) ? parsed[format.serversKey] : undefined;
	if (entries !== undefined && !isRecord(entries)) return `${path}: "${format.serversKey}" is not an object`;
	const servers = new Map<string, McpServerConfig>();
	const notes: McpClientServers["notes"] = [];
	const skipped: McpClientServers["skipped"] = [];
	for (const [name, raw] of Object.entries(entries ?? {})) {
		const converted = convertServer(name, raw);
		if (typeof converted === "string") {
			skipped.push({ name, reason: converted });
			continue;
		}
		servers.set(name, converted.config);
		for (const message of converted.notes) notes.push({ name, message });
	}
	return { path, servers, notes, skipped };
}
