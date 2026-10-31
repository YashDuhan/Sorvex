import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { resolveConfigValue } from "../src/core/resolve-config-value.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import { MCP_IMPORT_CLIENTS, type McpImportClient, type McpImportEnv } from "../src/extensions/mcp/import.ts";

describe("mcp import", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-mcp-import-"));
		dirs.push(dir);
		return dir;
	}

	it.each<[McpImportClient, NodeJS.Platform, string]>([
		["claude-code", "win32", "C:\\Users\\me\\.claude.json"],
		["claude-code", "darwin", "/Users/me/.claude.json"],
		["claude-code", "linux", "/home/me/.claude.json"],
		["claude-desktop", "win32", "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json"],
		["claude-desktop", "darwin", "/Users/me/Library/Application Support/Claude/claude_desktop_config.json"],
		["claude-desktop", "linux", "/home/me/.config/Claude/claude_desktop_config.json"],
		["cursor", "win32", "C:\\Users\\me\\.cursor\\mcp.json"],
		["cursor", "darwin", "/Users/me/.cursor/mcp.json"],
		["cursor", "linux", "/home/me/.cursor/mcp.json"],
		["vscode", "win32", "C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json"],
		["vscode", "darwin", "/Users/me/Library/Application Support/Code/User/mcp.json"],
		["vscode", "linux", "/home/me/.config/Code/User/mcp.json"],
	])("reads %s from its %s config path", (client, platform, expected) => {
		const home = platform === "win32" ? "C:\\Users\\me" : platform === "darwin" ? "/Users/me" : "/home/me";
		expect(MCP_IMPORT_CLIENTS[client].path({ platform, home })).toBe(expected);
	});

	it("uses %APPDATA% and $XDG_CONFIG_HOME when set", () => {
		const roaming = { platform: "win32", home: "C:\\Users\\me", appData: "D:\\Roaming" } as const;
		const xdg = { platform: "linux", home: "/home/me", xdgConfigHome: "/cfg" } as const;
		expect(MCP_IMPORT_CLIENTS["claude-desktop"].path(roaming)).toBe(
			"D:\\Roaming\\Claude\\claude_desktop_config.json",
		);
		expect(MCP_IMPORT_CLIENTS.vscode.path(xdg)).toBe("/cfg/Code/User/mcp.json");
	});

	it("treats an empty %APPDATA% or $XDG_CONFIG_HOME as unset", () => {
		const roaming = { platform: "win32", home: "C:\\Users\\me", appData: "" } as const;
		const xdg = { platform: "linux", home: "/home/me", xdgConfigHome: "" } as const;
		expect(MCP_IMPORT_CLIENTS["claude-desktop"].path(roaming)).toBe(
			"C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
		);
		expect(MCP_IMPORT_CLIENTS.vscode.path(xdg)).toBe("/home/me/.config/Code/User/mcp.json");
	});

	async function importFrom(client: string, config: unknown, agentDir = tempDir(), home = tempDir()) {
		const env: McpImportEnv = { platform: process.platform, home, appData: join(home, "AppData", "Roaming") };
		if (config !== undefined && client in MCP_IMPORT_CLIENTS) {
			const path = MCP_IMPORT_CLIENTS[client as McpImportClient].path(env);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(config));
		}
		const output: string[] = [];
		const exitCode = await runMcpCommand(["import", "--from", client], {
			cwd: agentDir,
			agentDir,
			importEnv: env,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		const target = join(agentDir, "mcp.json");
		const servers = () => (JSON.parse(readFileSync(target, "utf8")) as { mcpServers: unknown }).mcpServers;
		return { exitCode, output: output.join("\n"), agentDir, home, target, servers };
	}

	it("converts Claude Code, Claude Desktop, and Cursor mcpServers entries", async () => {
		const claudeCode = await importFrom("claude-code", {
			numStartups: 3,
			mcpServers: {
				files: { type: "stdio", command: "npx", args: ["-y", "server-files"], env: { ROOT: "." } },
				docs: { type: "http", url: "https://example.com/mcp", headers: { Authorization: `Bearer \${TOKEN}` } },
				legacy: { type: "sse", url: "https://example.com/sse" },
			},
		});
		expect(claudeCode.exitCode).toBe(0);
		expect(claudeCode.servers()).toEqual({
			files: { command: "npx", args: ["-y", "server-files"], env: { ROOT: "." } },
			docs: { url: "https://example.com/mcp", headers: { Authorization: `Bearer \${TOKEN}` } },
		});
		expect(claudeCode.output).toContain(`Added 2 MCP servers from Claude Code (`);
		expect(claudeCode.output).toContain("  files: npx -y server-files\n  docs: https://example.com/mcp");
		expect(claudeCode.output).toContain('Skipped "legacy": it uses the SSE transport, which is not supported.');

		for (const client of ["claude-desktop", "cursor"]) {
			const result = await importFrom(client, { mcpServers: { git: { command: "uvx", args: ["mcp-server-git"] } } });
			expect(result.servers()).toEqual({ git: { command: "uvx", args: ["mcp-server-git"] } });
		}
	});

	it("reads VS Code servers from the servers key and skips input prompts", async () => {
		const { exitCode, servers, output } = await importFrom("vscode", {
			inputs: [{ id: "token", type: "promptString" }],
			servers: {
				github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
				secret: { type: "stdio", command: "tool", env: { KEY: `\${input:token}` } },
			},
		});
		expect(exitCode).toBe(0);
		expect(servers()).toEqual({ github: { url: "https://api.githubcopilot.com/mcp/" } });
		expect(output).toContain(`Skipped "secret": it uses \${input:...} prompts`);
	});

	it("imports a disabled server disabled", async () => {
		const result = await importFrom("cursor", {
			mcpServers: { off: { command: "tool", disabled: true }, on: { command: "tool", disabled: false } },
		});

		expect(result.exitCode).toBe(0);
		expect(result.servers()).toEqual({ off: { command: "tool", enabled: false }, on: { command: "tool" } });
	});

	it("never overwrites an existing server, so a rerun adds nothing", async () => {
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { git: { command: "mine" } } }, null, 4));
		const config = { mcpServers: { git: { command: "theirs" }, "web-search": { command: "search" } } };

		const first = await importFrom("cursor", config, agentDir);
		expect(first.servers()).toEqual({ git: { command: "mine" }, "web-search": { command: "search" } });
		expect(first.output).toContain(`Kept existing "git" in ${first.target}.`);

		const second = await importFrom("cursor", config, agentDir, first.home);
		expect(second.output).toContain("No MCP servers to add from Cursor");
		expect(second.servers()).toEqual(first.servers());
		expect(readFileSync(second.target, "utf8")).toContain('\n    "mcpServers"');
	});

	it("reports a missing config file, an unknown client, and a missing --from", async () => {
		const missing = await importFrom("cursor", undefined);
		expect(missing.exitCode).toBe(1);
		expect(missing.output).toMatch(/^No Cursor config at .*mcp\.json\.$/);

		const unknown = await importFrom("zed", undefined);
		expect(unknown).toMatchObject({ exitCode: 1 });
		expect(unknown.output).toContain('Unknown client "zed". Use one of claude-code, claude-desktop, cursor, vscode.');

		const output: string[] = [];
		expect(await runMcpCommand(["import"], { cwd: ".", agentDir: ".", error: (line) => output.push(line) })).toBe(1);
		expect(output[0]).toContain("Usage:");
	});

	describe("env and headers values", () => {
		const convert = async (env: Record<string, string>, headers?: Record<string, string>) => {
			const result = await importFrom("cursor", {
				mcpServers: { tool: headers ? { url: "https://example.com/mcp", headers } : { command: "tool", env } },
			});
			return result.servers() as Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
		};

		it(`turns \${env:NAME} into \${NAME} and keeps \${NAME}`, async () => {
			const servers = await convert({ A: `\${env:HOME_TOKEN}`, B: `x-\${KEY}-y` });

			expect(servers.tool.env).toEqual({ A: `\${HOME_TOKEN}`, B: `x-\${KEY}-y` });
		});

		it("escapes $ and a leading ! so they stay literal in pi", async () => {
			const input = { PRICE: "$5", BARE: "$HOME/bin", PASS: "pa$$word", CMD: "!rm -rf /", MID: "a!b" };
			const servers = await convert(input);

			expect(servers.tool.env).toEqual({
				PRICE: "$$5",
				BARE: "$$HOME/bin",
				PASS: "pa$$$$word",
				CMD: "$!rm -rf /",
				MID: "a!b",
			});
			const resolved = Object.fromEntries(
				Object.entries(servers.tool.env ?? {}).map(([key, value]) => [key, resolveConfigValue(value)]),
			);
			expect(resolved).toEqual(input);
		});

		it("converts header values the same way", async () => {
			const servers = await convert({}, { Authorization: `Bearer \${env:TOKEN}`, "X-Price": "$5" });

			expect(servers.tool.headers).toEqual({ Authorization: `Bearer \${TOKEN}`, "X-Price": "$$5" });
		});

		it("skips servers with a placeholder pi cannot expand, and says which", async () => {
			const result = await importFrom("vscode", {
				servers: {
					a: { command: "tool", env: { ROOT: `\${workspaceFolder}/src` } },
					b: { url: "https://example.com/mcp", headers: { "X-User": `\${userHome}` } },
					c: { command: "tool", env: { OK: `\${env:OK}` } },
				},
			});

			expect(result.servers()).toEqual({ c: { command: "tool", env: { OK: `\${OK}` } } });
			expect(result.output).toContain(
				`Skipped "a": its env "ROOT" uses \${workspaceFolder}, which ${APP_NAME} cannot expand.`,
			);
			expect(result.output).toContain(
				`Skipped "b": its headers "X-User" uses \${userHome}, which ${APP_NAME} cannot expand.`,
			);
		});

		it.each([
			["command", { command: `\${workspaceFolder}/bin/tool` }],
			["args", { command: "tool", args: ["--root", `\${workspaceFolder}`] }],
			["cwd", { command: "tool", cwd: `\${workspaceFolder}` }],
			["url", { url: `https://\${env:HOST}/mcp` }],
		])(`skips servers with \${...} in %s, which ${APP_NAME} does not expand there`, async (key, server) => {
			const result = await importFrom("vscode", { servers: { tool: server } });

			expect(result.output).toContain(`Skipped "tool": its ${key} uses `);
			expect(result.output).toContain(`which ${APP_NAME} does not expand there`);
			expect(result.exitCode).toBe(0);
		});

		it.each([
			"fileWorkspaceFolder",
			"fileDirnameBasename",
			"columnNumber",
			"localWorkspaceFolder",
			"containerWorkspaceFolder",
			"devcontainerId",
		])("skips servers using the editor variable %s", async (variable) => {
			const result = await importFrom("vscode", {
				servers: {
					a: { command: "tool", env: { ROOT: `\${${variable}}` } },
					b: { command: "tool" },
				},
			});

			expect(result.servers()).toEqual({ b: { command: "tool" } });
			expect(result.output).toContain(
				`Skipped "a": its env "ROOT" uses \${${variable}}, which ${APP_NAME} cannot expand.`,
			);
		});

		it("notes a dropped envFile and writes the file readable by the owner only", async () => {
			const result = await importFrom("vscode", {
				servers: { tool: { command: "tool", envFile: `\${workspaceFolder}/.env` } },
			});

			expect(result.servers()).toEqual({ tool: { command: "tool" } });
			expect(result.output).toContain(
				`Note for "tool": its envFile \${workspaceFolder}/.env was not imported; set the variables it needs in "env".`,
			);
			if (process.platform !== "win32") expect(statSync(result.target).mode & 0o777).toBe(0o600);
		});
	});
});
