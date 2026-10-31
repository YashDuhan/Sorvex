import { execFile } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getAgentDir, SessionManager, SettingsManager } from "@sorvex/coding-agent";
import { ProjectTrustStore } from "@sorvex/coding-agent/core/trust-manager.js";
import { BUILTIN_AGENTS } from "@sorvex/coding-agent/extensions/subagent/agents.js";
import { repoRoot } from "./paths.ts";

/**
 * Server side of the TUI features the RPC protocol does not cover: Sorvex's own settings, project trust,
 * session listing across folders, deleting and exporting sessions, the changelog, built-in agents, and the
 * file list behind `@` completion.
 */

const run = promisify(execFile);
const agentDir = getAgentDir();

const settingsFor = (cwd: string) => SettingsManager.create(cwd, agentDir);

/** The `/settings` items that change agent behavior (TUI-only display settings are left out). */
export function readSorvexSettings(cwd: string) {
	const settings = settingsFor(cwd);
	return {
		steeringMode: settings.getSteeringMode(),
		followUpMode: settings.getFollowUpMode(),
		transport: settings.getTransport(),
		cacheWarming: settings.getCacheWarmingMode(),
		hideThinking: settings.getHideThinkingBlock(),
		defaultProjectTrust: settings.getDefaultProjectTrust(),
		doubleEscapeAction: settings.getDoubleEscapeAction(),
		compactionEnabled: settings.getCompactionEnabled(),
		enabledModels: settings.getEnabledModels() ?? [],
		defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? null,
		defaultModel: settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : null,
		projectTrust: new ProjectTrustStore(agentDir).get(cwd),
	};
}

export async function writeSorvexSetting(cwd: string, key: string, value: unknown): Promise<void> {
	const settings = settingsFor(cwd);
	switch (key) {
		case "steeringMode":
			settings.setSteeringMode(value as "all" | "one-at-a-time");
			break;
		case "followUpMode":
			settings.setFollowUpMode(value as "all" | "one-at-a-time");
			break;
		case "transport":
			settings.setTransport(value as Parameters<SettingsManager["setTransport"]>[0]);
			break;
		case "cacheWarming":
			settings.setCacheWarmingMode(value as Parameters<SettingsManager["setCacheWarmingMode"]>[0]);
			break;
		case "hideThinking":
			settings.setHideThinkingBlock(Boolean(value));
			break;
		case "defaultProjectTrust":
			settings.setDefaultProjectTrust(value as Parameters<SettingsManager["setDefaultProjectTrust"]>[0]);
			break;
		case "doubleEscapeAction":
			settings.setDoubleEscapeAction(value as "fork" | "tree" | "none");
			break;
		case "compactionEnabled":
			settings.setCompactionEnabled(Boolean(value));
			break;
		case "enabledModels":
			settings.setEnabledModels(Array.isArray(value) && value.length > 0 ? (value as string[]) : undefined);
			break;
		case "defaultThinkingLevel":
			settings.setDefaultThinkingLevel(value as Parameters<SettingsManager["setDefaultThinkingLevel"]>[0]);
			break;
		// "provider/modelId", the model new sessions start on (what the TUI's Ctrl+S in the model selector saves).
		case "defaultModel": {
			const [provider = "", ...rest] = String(value).split("/");
			settings.setDefaultModelAndProvider(provider, rest.join("/"));
			break;
		}
		case "projectTrust":
			new ProjectTrustStore(agentDir).set(cwd, value === null ? null : Boolean(value));
			return;
		default:
			throw new Error(`Unknown setting ${key}`);
	}
	await settings.flush();
}

/** Sessions for one folder, or for every folder like the TUI resume picker's "All" scope. */
export async function listSessions(cwd: string, all: boolean) {
	const sessions = all ? await SessionManager.listAll() : await SessionManager.list(cwd);
	return sessions
		.map((session) => ({
			path: session.path,
			id: session.id,
			cwd: session.cwd,
			name: session.name ?? null,
			firstMessage: session.firstMessage || null,
			modified: session.modified.getTime(),
			messageCount: session.messageCount,
		}))
		.sort((a, b) => b.modified - a.modified);
}

/** Moves a session file to the trash when a trash tool exists, like the TUI's resume picker; deletes otherwise. */
export async function deleteSession(path: string): Promise<{ trashed: boolean }> {
	if (!path.startsWith(join(agentDir, "sessions")) || !path.endsWith(".jsonl")) throw new Error("Not a session file");
	for (const [command, args] of [
		["gio", ["trash", path]],
		["trash", [path]],
	] as const) {
		try {
			await run(command, [...args]);
			return { trashed: true };
		} catch {
			// Try the next tool.
		}
	}
	unlinkSync(path);
	return { trashed: false };
}

export function exportJsonl(sessionFile: string, target: string): { path: string } {
	if (!existsSync(sessionFile)) throw new Error("This session has not been saved yet");
	copyFileSync(sessionFile, target);
	return { path: target };
}

export function changelog(): string {
	const path = join(repoRoot, "packages/coding-agent/CHANGELOG.md");
	return existsSync(path) ? readFileSync(path, "utf8") : "No changelog found.";
}

export function builtinAgents() {
	return BUILTIN_AGENTS.map((agent) => ({ name: agent.name, description: agent.description, tools: agent.tools ?? null, model: agent.model ?? null }));
}

/** Tracked and untracked (not ignored) files for `@` completion; falls back to an empty list outside git. */
export async function listFiles(cwd: string): Promise<string[]> {
	try {
		const { stdout } = await run("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, maxBuffer: 64 * 1024 * 1024 });
		return stdout.split("\n").filter(Boolean).slice(0, 50000);
	} catch {
		return [];
	}
}
