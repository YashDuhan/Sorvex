import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@sorvex/coding-agent";
import { validateMcpServerConfig } from "@sorvex/coding-agent/core/mcp-servers.js";
import { ProjectTrustStore } from "@sorvex/coding-agent/core/trust-manager.js";
import { runMcpCommand } from "@sorvex/coding-agent/extensions/mcp/cli.js";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "@sorvex/coding-agent/extensions/mcp/config.js";

/**
 * MCP server management on top of Sorvex's own MCP config code, so the GUI reads and writes the same files as
 * `sorvex mcp` and the built-in MCP extension:
 *   global:  ~/.sorvex/agent/mcp.json        project: <cwd>/.sorvex/mcp.json (only read when the folder is trusted)
 * Status and tool lists come from `sorvex mcp list --json`, which connects to each enabled server.
 */

const agentDir = getAgentDir();
const globalPath = join(agentDir, "mcp.json");
export const mcpGlobalPath = globalPath;
const projectPath = (cwd: string) => join(cwd, ".sorvex", "mcp.json");

function projectTrusted(cwd: string): boolean {
	return (
		new ProjectTrustStore(agentDir).get(cwd) ??
		SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust() === "always"
	);
}

export interface McpServerReport {
	name: string;
	scope: string;
	source: string;
	enabled: boolean;
	exposure?: string;
	transport: string;
	state: string;
	tools: string[];
	error?: string;
	/** From the config file: command line or URL, for display. */
	target?: string;
	kind?: "stdio" | "http";
}

/** Live status of every configured server. Connecting can take a few seconds per server. */
export async function listMcpServers(cwd: string) {
	const lines: string[] = [];
	const errors: string[] = [];
	await runMcpCommand(["list", "--json"], { cwd, agentDir, log: (line) => lines.push(line), error: (line) => errors.push(line) });
	const report = JSON.parse(lines.join("\n") || "{}") as { servers?: McpServerReport[]; errors?: string[]; notices?: string[]; note?: string };

	// Add each server's command or URL from config, which the list report leaves out.
	const loaded = loadMcpConfig({ agentDir, cwd, projectTrusted: projectTrusted(cwd) });
	const kinds = new Map(loaded.servers.map((entry) => [entry.name, "url" in entry.config ? ("http" as const) : ("stdio" as const)]));
	return {
		// `transport` in the report is the command line or URL; `kind` is the transport type.
		servers: (report.servers ?? []).map((server) => ({ ...server, target: server.transport, kind: kinds.get(server.name) })),
		errors: [...(report.errors ?? []), ...errors],
		notices: report.notices ?? [],
		note: report.note,
		globalPath,
		projectPath: projectPath(cwd),
		projectTrusted: projectTrusted(cwd),
	};
}

export function addMcpServer(cwd: string, scope: "global" | "project", name: string, raw: unknown): { replaced: boolean } {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Server names may only use letters, digits, - and _");
	const config = validateMcpServerConfig(name, raw);
	if (typeof config === "string") throw new Error(config);
	return { replaced: addMcpServerConfig(scope === "project" ? projectPath(cwd) : globalPath, name, config) };
}

export function removeMcpServer(cwd: string, scope: "global" | "project", name: string): { removed: boolean } {
	return { removed: removeMcpServerConfig(scope === "project" ? projectPath(cwd) : globalPath, name) };
}

/**
 * Turns a server on or off. Servers defined in another file (a shared ~/.config/mcp/mcp.json or the project's
 * .mcp.json) get an override entry in the global file, which is what Sorvex's own /mcp menu does.
 */
export function setMcpServerEnabled(source: string, name: string, enabled: boolean): void {
	const writable = source === globalPath || source.endsWith(join(".sorvex", "mcp.json"));
	updateMcpServerConfig(writable ? source : globalPath, name, { enabled }, { override: !writable });
}

/** Changes how a server's tools reach the model: codemode, deferred (tool search), direct, or hidden. */
export function setMcpServerExposure(source: string, name: string, exposure: "codemode" | "deferred" | "direct" | "hidden"): void {
	const writable = source === globalPath || source.endsWith(join(".sorvex", "mcp.json"));
	updateMcpServerConfig(writable ? source : globalPath, name, { exposure }, { override: !writable });
}
