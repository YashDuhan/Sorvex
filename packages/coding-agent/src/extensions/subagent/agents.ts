import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@sorvex/agent-core";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { BUILTIN_AGENT_FILES } from "./builtin-agents.ts";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentDefinition {
	name: string;
	description: string;
	/** Tool allowlist. Undefined means `DEFAULT_AGENT_TOOLS`. */
	tools?: string[];
	/** `provider/id` or a bare id, optionally with a `:<thinking>` suffix. Undefined means the parent's model. */
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: AgentSource;
	/** Undefined for built-in agents. */
	filePath?: string;
}

export interface AgentDiscovery {
	/** Later sources replace earlier ones by name: built-in, then user, then project. */
	agents: AgentDefinition[];
	/** Agent files that were skipped. */
	diagnostics: AgentDiagnostic[];
	userAgentsDir: string;
	/** Undefined when the project is not trusted or has no agents directory. */
	projectAgentsDir: string | undefined;
}

/** Both `tools: read, bash` and `tools: [read, bash]` are in use. */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((tool): tool is string => typeof tool === "string")
		.map((tool) => tool.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export type AgentParseResult = { ok: true; agent: AgentDefinition } | { ok: false; error: string };

/** An agent file that was skipped, with the reason. */
export interface AgentDiagnostic {
	path: string;
	message: string;
}

/**
 * Parse an agent file. Uses the pi-subagents field names `name`, `description`, `tools`, `model`, and
 * `thinking`; other fields are ignored. A file that is not a valid agent gives an error, so one bad file
 * does not hide the other agents of its directory.
 */
export function parseAgentFile(content: string, source: AgentSource, filePath?: string): AgentParseResult {
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(content);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `invalid frontmatter: ${message.split("\n")[0]}` };
	}
	const { frontmatter, body } = parsed;
	if (typeof frontmatter !== "object" || frontmatter === null) return { ok: false, error: "no frontmatter" };
	const { name, description, model, thinking } = frontmatter;
	if (typeof name !== "string" || !name.trim()) return { ok: false, error: "frontmatter has no name" };
	if (typeof description !== "string") return { ok: false, error: "frontmatter has no description" };
	return {
		ok: true,
		agent: {
			name: name.trim(),
			description,
			tools: parseToolList(frontmatter.tools),
			model: typeof model === "string" && model.trim() ? model.trim() : undefined,
			thinking: typeof thinking === "string" && isValidThinkingLevel(thinking) ? thinking : undefined,
			systemPrompt: body,
			source,
			filePath,
		},
	};
}

function loadAgentsFromDir(dir: string, source: AgentSource, diagnostics: AgentDiagnostic[]): AgentDefinition[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const agents: AgentDefinition[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (error) {
			diagnostics.push({ path: filePath, message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const result = parseAgentFile(content, source, filePath);
		if (result.ok) agents.push(result.agent);
		else diagnostics.push({ path: filePath, message: result.error });
	}
	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export const BUILTIN_AGENTS: readonly AgentDefinition[] = BUILTIN_AGENT_FILES.map((content) => {
	const result = parseAgentFile(content, "builtin");
	if (!result.ok) throw new Error(`Invalid built-in agent: ${result.error}`);
	return result.agent;
});

/**
 * Agents from the built-ins, then the user agents directory, then the project agents directory. Project
 * agents come from the repository, so an untrusted project's directory is not read at all: none of its
 * names, descriptions, or diagnostics reach the model or the UI.
 */
export function discoverAgents(cwd: string, options: { projectTrusted: boolean }): AgentDiscovery {
	const userAgentsDir = path.join(getAgentDir(), "agents");
	// Like the other project resources, only the working directory's own config directory counts, and
	// the project trust that gates it is resolved for that directory.
	const candidate = path.join(path.resolve(cwd), CONFIG_DIR_NAME, "agents");
	const projectAgentsDir = options.projectTrusted && isDirectory(candidate) ? candidate : undefined;
	const diagnostics: AgentDiagnostic[] = [];
	const byName = new Map<string, AgentDefinition>();
	const layers = [
		BUILTIN_AGENTS,
		loadAgentsFromDir(userAgentsDir, "user", diagnostics),
		projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project", diagnostics) : [],
	];
	for (const agent of layers.flat()) byName.set(agent.name, agent);
	return { agents: [...byName.values()], diagnostics, userAgentsDir, projectAgentsDir };
}
