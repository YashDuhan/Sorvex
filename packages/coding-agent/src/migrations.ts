/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative } from "path";
import { APP_TITLE, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { stripBom } from "./utils/text.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md";

const LEGACY_CONFIG_DIR_NAME = ".pi";
const LEGACY_IMPORT_RECORD = ".pi-import.json";
const LEGACY_IMPORT_ENTRIES = [
	"auth.json",
	"models.json",
	"settings.json",
	"keybindings.json",
	"mcp.json",
	"mcp-auth.json",
	"AGENTS.override.md",
	"AGENTS.md",
	"AGENTS.MD",
	"CLAUDE.md",
	"CLAUDE.MD",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	"prompts",
	"themes",
	"agents",
	"skills",
	"extensions",
] as const;

export interface LegacyImport {
	from: string;
	to: string;
	copied: string[];
}

function readSettledEntries(recordPath: string): Set<string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(recordPath, "utf-8"));
		return new Set(Array.isArray(parsed) ? parsed.filter((name) => typeof name === "string") : []);
	} catch {
		return new Set();
	}
}

function holdsNoData(path: string): boolean {
	if (!existsSync(path)) return true;
	if (statSync(path).isDirectory()) return readdirSync(path).length === 0;
	const content = stripBom(readFileSync(path, "utf-8")).trim();
	return content === "" || content === "{}";
}

// With a filter, cpSync with dereference throws ENOENT on a link whose target is gone, and follows a link back to one of its own ancestors forever, which crashes the process on Windows.
function classifyLink(entry: string, root: string): "copy" | "dangling" | "cycle" {
	if (entry === root || !lstatSync(entry).isSymbolicLink()) return "copy";
	let target: string;
	try {
		target = realpathSync(entry);
	} catch {
		return "dangling";
	}
	for (let dir = dirname(entry); ; dir = dirname(dir)) {
		if (realpathSync(dir) === target) return "cycle";
		if (dir === root || dir === dirname(dir)) return "copy";
	}
}

export function importLegacyConfigDir(home: string = homedir()): LegacyImport | undefined {
	if (process.env[ENV_AGENT_DIR]) return undefined;
	const to = join(home, CONFIG_DIR_NAME, "agent");
	const from = join(home, LEGACY_CONFIG_DIR_NAME, "agent");
	if (to === from || !existsSync(from)) return undefined;
	const recordPath = join(to, LEGACY_IMPORT_RECORD);
	const settled = readSettledEntries(recordPath);
	const pending = LEGACY_IMPORT_ENTRIES.filter((name) => !settled.has(name) && existsSync(join(from, name)));
	if (pending.length === 0) return undefined;

	const copied: string[] = [];
	const danglingLinks: string[] = [];
	const failed: string[] = [];
	for (const name of pending) {
		const target = join(to, name);
		const staging = `${target}.importing`;
		try {
			mkdirSync(to, { recursive: true, mode: 0o700 });
			if (!holdsNoData(target)) {
				settled.add(name);
				continue;
			}
			rmSync(staging, { recursive: true, force: true });
			const source = join(from, name);
			const skipped: string[] = [];
			cpSync(source, staging, {
				recursive: true,
				dereference: true,
				filter: (entry) => {
					const link = classifyLink(entry, source);
					if (link === "dangling") skipped.push(relative(from, entry));
					return link === "copy";
				},
			});
			rmSync(target, { recursive: true, force: true });
			renameSync(staging, target);
			copied.push(name);
			danglingLinks.push(...skipped);
			settled.add(name);
		} catch (err) {
			rmSync(staging, { recursive: true, force: true });
			failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	if (failed.length < pending.length) {
		writeFileSync(`${recordPath}.tmp`, JSON.stringify([...settled]));
		renameSync(`${recordPath}.tmp`, recordPath);
	}

	if (copied.length > 0) {
		const skippedNote =
			danglingLinks.length > 0 ? ` Skipped links whose target does not exist: ${danglingLinks.join(", ")}.` : "";
		console.error(
			chalk.green(`Imported ${copied.join(", ")} from ${from} to ${to}. ${from} was left unchanged.${skippedNote}`),
		);
	}
	if (failed.length > 0) {
		console.error(
			chalk.yellow(
				`Warning: Could not import ${failed.join("; ")} from ${from}. ${APP_TITLE} will retry on the next start.`,
			),
		);
	}
	return copied.length > 0 ? { from, to, copied } : undefined;
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// Migrate oauth.json
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// Skip on error
		}
	}

	// Migrate settings.json apiKeys
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// Skip on error
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to proper session directories.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/<encoded-cwd>/. This migration moves them
 * to the correct location based on the cwd in their session header.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
