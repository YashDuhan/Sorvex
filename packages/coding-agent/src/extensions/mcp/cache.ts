import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Prompt as McpPrompt, Tool as McpTool } from "@sorvex/mcp";
import type { McpServerConfig } from "../../core/mcp-servers.ts";
import { stripBom } from "../../utils/text.ts";

// Entries gained `prompts` without a version change: an entry written before has no prompts, which
// are listed at the next connect, and its tools still let a lazy server stay idle until used.
const CACHE_VERSION = 1;

export interface McpCacheEntry {
	configHash: string;
	fetchedAt: number;
	tools: McpTool[];
	instructions?: string;
	hasResources?: boolean;
	prompts?: McpPrompt[];
}

export type McpCacheEntries = ReadonlyMap<string, McpCacheEntry>;

const NON_IDENTITY_KEYS: ReadonlySet<string> = new Set([
	"enabled",
	"exposure",
	"toolExposure",
	"description",
	"timeout",
	"lifecycle",
	"idleTimeoutMinutes",
	"approve",
]);

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function mcpConfigHash(config: McpServerConfig, projectDir?: string): string {
	const identity = Object.fromEntries(Object.entries(config).filter(([key]) => !NON_IDENTITY_KEYS.has(key)));
	return createHash("sha256")
		.update(stableJson({ ...identity, projectDir }))
		.digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptional(value: unknown, check: (value: unknown) => boolean): boolean {
	return value === undefined || value === null || check(value);
}

const isString = (value: unknown): value is string => typeof value === "string";

function isTool(value: unknown): value is McpTool {
	return (
		isRecord(value) &&
		isString(value.name) &&
		isRecord(value.inputSchema) &&
		isOptional(value.outputSchema, isRecord) &&
		isOptional(value.description, isString) &&
		isOptional(value.title, isString) &&
		isOptional(value.annotations, (annotations) => isRecord(annotations) && isOptional(annotations.title, isString))
	);
}

function isPrompt(value: unknown): value is McpPrompt {
	return (
		isRecord(value) &&
		isString(value.name) &&
		isOptional(
			value.arguments,
			(args) => Array.isArray(args) && args.every((arg) => isRecord(arg) && isString(arg.name)),
		)
	);
}

function parseEntry(value: unknown): McpCacheEntry | undefined {
	if (!isRecord(value)) return undefined;
	const { configHash, fetchedAt, tools, instructions, hasResources, prompts } = value;
	if (typeof configHash !== "string" || typeof fetchedAt !== "number" || !Array.isArray(tools)) return undefined;
	if (!tools.every(isTool)) return undefined;
	if (instructions !== undefined && typeof instructions !== "string") return undefined;
	if (hasResources !== undefined && typeof hasResources !== "boolean") return undefined;
	if (prompts !== undefined && !(Array.isArray(prompts) && prompts.every(isPrompt))) return undefined;
	return {
		configHash,
		fetchedAt,
		tools: tools as McpTool[],
		...(instructions === undefined ? {} : { instructions }),
		...(hasResources === undefined ? {} : { hasResources }),
		...(prompts === undefined ? {} : { prompts: prompts as McpPrompt[] }),
	};
}

function readServers(path: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
		if (isRecord(parsed) && parsed.version === CACHE_VERSION && isRecord(parsed.servers)) return parsed.servers;
	} catch {}
	return {};
}

export function readMcpCache(path: string): McpCacheEntries {
	const entries = new Map<string, McpCacheEntry>();
	for (const [name, value] of Object.entries(readServers(path))) {
		const entry = parseEntry(value);
		if (entry) entries.set(name, entry);
	}
	return entries;
}

export function validMcpCacheEntry(
	entries: McpCacheEntries,
	name: string,
	configHash: string,
): McpCacheEntry | undefined {
	const entry = entries.get(name);
	return entry?.configHash === configHash ? entry : undefined;
}

export function writeMcpCacheEntry(path: string, name: string, entry: McpCacheEntry): void {
	const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		const servers = { ...readServers(path), [name]: entry };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(temp, `${JSON.stringify({ version: CACHE_VERSION, servers })}\n`);
		renameSync(temp, path);
	} catch {
		try {
			rmSync(temp, { force: true });
		} catch {}
	}
}
