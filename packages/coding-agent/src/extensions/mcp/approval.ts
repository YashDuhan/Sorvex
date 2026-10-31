/**
 * Which MCP tool calls ask the user first, per the server's `approve` setting, and the choices
 * they get. Tools the user allows for the session are recorded as session entries with the server's
 * config hash, so they stay allowed after a resume while the server's config is unchanged. Servers
 * the user always allows are recorded in pi's own approvals file, never in a config file another
 * client or a teammate reads.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import type { ToolAnnotations } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { stripBom } from "../../utils/text.ts";
import type { McpApproval } from "./config.ts";

export const MCP_APPROVAL_ENTRY_TYPE = "mcp-approval";

/** A tool the user allowed for the rest of the session, for the server as configured then. */
export interface McpApprovalEntryData {
	server: string;
	tool: string;
	/** `mcpConfigHash` of the server when the user allowed the tool. */
	configHash: string;
}

export type McpApprovalChoice = "once" | "session" | "server" | "deny";

/** The prompt's choices, in the order shown. */
export const MCP_APPROVAL_CHOICES: readonly { choice: McpApprovalChoice; label: string }[] = [
	{ choice: "once", label: "Allow once" },
	{ choice: "session", label: "Allow for this session" },
	{ choice: "server", label: "Always allow this server" },
	{ choice: "deny", label: "Deny" },
];

export function needsApproval(approve: McpApproval, annotations: ToolAnnotations | undefined): boolean {
	return approve === "always" || (approve === "writes" && annotations?.readOnlyHint !== true);
}

/** Key of a tool, for the server as configured, in the set of tools allowed for the session. */
export function approvalKey({ server, tool, configHash }: McpApprovalEntryData): string {
	return `${server}\0${tool}\0${configHash}`;
}

/** Tools the entries of the session's current branch allow, as {@link approvalKey} keys. */
export function readSessionApprovals(branch: readonly SessionEntry[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== MCP_APPROVAL_ENTRY_TYPE) continue;
		const data = entry.data as Partial<McpApprovalEntryData> | undefined;
		if (typeof data?.server === "string" && typeof data.tool === "string" && typeof data.configHash === "string")
			keys.add(approvalKey({ server: data.server, tool: data.tool, configHash: data.configHash }));
	}
	return keys;
}

const APPROVALS_VERSION = 1;
const LOCK_ATTEMPTS = 50;
const LOCK_RETRY_MS = 20;

/**
 * The approvals file: per project directory, the servers the user chose "Always allow this server"
 * for, each with the config hash (cache.ts `mcpConfigHash`) it had then, so changing the server's
 * command, arguments, URL, or credentials revokes the choice.
 *
 * `{ "version": 1, "projects": { "<project dir>": { "<server>": "<config hash>" } } }`
 */
interface McpApprovalsFile {
	version: typeof APPROVALS_VERSION;
	projects: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The file's content, an empty one when it is missing, or why it is not a file this version reads. */
function readApprovalsFile(path: string): McpApprovalsFile | string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
			return { version: APPROVALS_VERSION, projects: {} };
		return error instanceof Error ? error.message : String(error);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(text));
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (!isRecord(parsed) || parsed.version !== APPROVALS_VERSION || !isRecord(parsed.projects))
		return `expected {"version": ${APPROVALS_VERSION}, "projects": {...}}`;
	return { version: APPROVALS_VERSION, projects: parsed.projects };
}

function projectKey(projectDir: string): string {
	return canonicalizePath(resolvePath(projectDir));
}

export interface McpAlwaysAllowedServers {
	/** Servers always allowed in the project, mapped to the config hash they were allowed with. */
	servers: ReadonlyMap<string, string>;
	/** Why the file could not be read, in which case no server is always allowed. */
	problem?: string;
}

export function readAlwaysAllowedServers(path: string, projectDir: string): McpAlwaysAllowedServers {
	const file = readApprovalsFile(path);
	if (typeof file === "string") return { servers: new Map(), problem: `${path}: ${file}` };
	const servers = file.projects[projectKey(projectDir)];
	if (!isRecord(servers)) return { servers: new Map() };
	return {
		servers: new Map(
			Object.entries(servers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		),
	};
}

/** Lock the approvals file (by a `.lock` directory next to it), retrying while another process holds it. */
function lockApprovalsFile(path: string): () => void {
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(path, { realpath: false });
		} catch (error) {
			const locked = typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
			if (!locked || attempt === LOCK_ATTEMPTS) throw error;
			const start = Date.now();
			while (Date.now() - start < LOCK_RETRY_MS) {
				// Wait synchronously, so the prompt's choice is saved before the call runs.
			}
		}
	}
}

/**
 * Record that the user always allows the server, as configured now, in the project. Other processes
 * write the file too, so it is read and written while locked. A file this version cannot read is left
 * as it is, and the error says why. A symlinked file is written through to its target.
 */
export function saveAlwaysAllowedServer(path: string, projectDir: string, server: string, configHash: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const target = existsSync(path) ? realpathSync(path) : path;
	const release = lockApprovalsFile(target);
	try {
		const file = readApprovalsFile(target);
		if (typeof file === "string") throw new Error(`${file}; not overwriting it`);
		const key = projectKey(projectDir);
		const servers = file.projects[key];
		file.projects[key] = { ...(isRecord(servers) ? servers : {}), [server]: configHash };
		const temp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
			renameSync(temp, target);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	} finally {
		release();
	}
}
