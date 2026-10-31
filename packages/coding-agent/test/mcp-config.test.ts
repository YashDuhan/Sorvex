import { execFile } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { type McpApproval, strictestMcpApproval, validateMcpServerConfig } from "../src/core/mcp-servers.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { readAlwaysAllowedServers, saveAlwaysAllowedServer } from "../src/extensions/mcp/approval.ts";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";
import {
	addMcpServerConfig,
	loadMcpConfig,
	removeMcpServerConfig,
	updateMcpServerConfig,
} from "../src/extensions/mcp/config.ts";

const APPROVAL_MODULE = resolve(import.meta.dirname, "../src/extensions/mcp/approval.ts");

describe("MCP approval and config sources", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function layout() {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-sources-"));
		dirs.push(root);
		const files = {
			shared: join(root, "home", ".config", "mcp", "mcp.json"),
			agent: join(root, "agent", "mcp.json"),
			dotMcp: join(root, "project", ".mcp.json"),
			project: join(root, "project", CONFIG_DIR_NAME, "mcp.json"),
		};
		const write = (file: keyof typeof files, mcpServers: Record<string, unknown>) => {
			mkdirSync(dirname(files[file]), { recursive: true });
			writeFileSync(files[file], JSON.stringify({ mcpServers }));
		};
		const options = { homeDir: join(root, "home"), agentDir: join(root, "agent"), cwd: join(root, "project") };
		const load = () => loadMcpConfig({ ...options, projectTrusted: true });
		const approveOf = (name: string) => load().servers.find((server) => server.name === name)?.config.approve;
		return { root, files, write, options, load, approveOf };
	}

	describe("strictestMcpApproval", () => {
		it.each<[(McpApproval | undefined)[], McpApproval]>([
			[[], "never"],
			[[undefined], "never"],
			[["never"], "never"],
			[[undefined, "writes"], "writes"],
			[["always", "never"], "always"],
			[["never", undefined, "writes"], "writes"],
			[["writes", "always", "never"], "always"],
		])("picks the strictest of %j", (approvals, expected) => {
			expect(strictestMcpApproval(approvals)).toBe(expected);
		});
	});

	describe("project files cannot lower approve", () => {
		it("makes servers from .mcp.json at least writes, even when they set never", () => {
			const { write, approveOf } = layout();
			write("dotMcp", {
				plain: { command: "x" },
				never: { command: "x", approve: "never" },
				strict: { command: "x", approve: "always" },
			});

			expect(approveOf("plain")).toBe("writes");
			expect(approveOf("never")).toBe("writes");
			expect(approveOf("strict")).toBe("always");
		});

		it("keeps the user's stricter approve when .mcp.json redefines the server", () => {
			const { write, approveOf } = layout();
			write("agent", { api: { command: "user", approve: "always" } });
			write("dotMcp", { api: { command: "repo", approve: "never" } });

			expect(approveOf("api")).toBe("always");
		});

		it("keeps the user's stricter approve when .pi/mcp.json redefines the server", () => {
			const { write, approveOf } = layout();
			write("shared", { api: { command: "user", approve: "writes" } });
			write("project", { api: { command: "repo", approve: "never" } });

			expect(approveOf("api")).toBe("writes");
		});

		it("lets project overrides only make approve stricter", () => {
			const { write, approveOf } = layout();
			write("agent", { strict: { command: "x", approve: "always" }, loose: { command: "x" } });
			write("project", { strict: { approve: "never" }, loose: { approve: "always" } });

			expect(approveOf("strict")).toBe("always");
			expect(approveOf("loose")).toBe("always");
		});

		it("keeps the writes floor of .mcp.json servers under a .pi/mcp.json override", () => {
			const { write, approveOf } = layout();
			write("dotMcp", { api: { command: "x" } });
			write("project", { api: { approve: "never" } });

			expect(approveOf("api")).toBe("writes");
		});

		it("lets the user's own files set approve freely", () => {
			const { write, approveOf } = layout();
			write("shared", { api: { command: "x", approve: "always" } });
			write("agent", { api: { approve: "never" } });

			expect(approveOf("api")).toBe("never");
		});

		it("keeps approve unset on user servers", () => {
			const { write, approveOf } = layout();
			write("agent", { api: { command: "x" } });

			expect(approveOf("api")).toBeUndefined();
		});
	});

	describe("overrides in the agent dir", () => {
		it("override a server from ~/.config/mcp/mcp.json and record the file", () => {
			const { files, write, load } = layout();
			write("shared", { api: { command: "x" } });
			write("agent", { api: { enabled: false } });

			const { servers, errors } = load();

			expect(errors).toEqual([]);
			expect(servers).toHaveLength(1);
			expect(servers[0]).toMatchObject({
				name: "api",
				source: files.shared,
				override: files.agent,
				scope: "global",
				sharedSource: true,
				config: { command: "x", enabled: false },
			});
		});

		it("keep the usual error for an entry that has no command and nothing to override", () => {
			const { write, load } = layout();
			write("agent", { bad: { args: ["no command"] } });
			write("project", { missing: { enabled: false } });

			const { servers, errors } = load();

			expect(servers).toEqual([]);
			expect(errors).toEqual([
				expect.stringContaining('server "bad" needs either "command"'),
				expect.stringContaining('server "missing" needs "command" or "url", or a server in an earlier file'),
			]);
		});
	});

	describe("reserved server names", () => {
		it.each(["__proto__", "constructor", "prototype"])("rejects %s", (name) => {
			expect(validateMcpServerConfig(name, { command: "x" })).toBe(`server name "${name}" is reserved`);
		});

		it("rejects them in a config file without creating the server", () => {
			const { files, load } = layout();
			mkdirSync(dirname(files.dotMcp), { recursive: true });
			writeFileSync(
				files.dotMcp,
				'{"mcpServers":{"__proto__":{"command":"x"},"constructor":{"command":"x"},"prototype":{"command":"x"},"ok":{"command":"x"}}}',
			);

			const { servers, errors } = load();

			expect(servers.map((server) => server.name)).toEqual(["ok"]);
			expect(errors).toEqual(
				["__proto__", "constructor", "prototype"].map((name) =>
					expect.stringContaining(`server name "${name}" is reserved`),
				),
			);
		});
	});

	describe("approvals file", () => {
		const setupFile = () => {
			const { root } = layout();
			const path = join(root, "agent", "mcp-approvals.json");
			const project = join(root, "project");
			mkdirSync(project, { recursive: true });
			return { root, path, project };
		};

		it("keeps the saves of concurrent processes", async () => {
			const { path, project } = setupFile();
			const script = `const { saveAlwaysAllowedServer } = await import(process.argv[1]);
for (let i = 0; i < 20; i++) saveAlwaysAllowedServer(process.argv[2], process.argv[3], \`\${process.argv[4]}-\${i}\`, "h");`;
			const run = promisify(execFile);
			await Promise.all(
				["a", "b", "c", "d", "e", "f"].map((prefix) =>
					run(process.execPath, ["--input-type=module", "-e", script, APPROVAL_MODULE, path, project, prefix]),
				),
			);

			const servers = JSON.parse(readFileSync(path, "utf8")).projects[realpathSync(project)];
			expect(Object.keys(servers)).toHaveLength(120);
		}, 30_000);

		it("waits for the lock another process holds", () => {
			const { path, project } = setupFile();
			saveAlwaysAllowedServer(path, project, "a", "h1");
			const release = lockfile.lockSync(path, { realpath: false });
			try {
				expect(() => saveAlwaysAllowedServer(path, project, "b", "h2")).toThrow(/lock/i);
			} finally {
				release();
			}
			saveAlwaysAllowedServer(path, project, "b", "h2");
			expect([...readAlwaysAllowedServers(path, project).servers]).toEqual([
				["a", "h1"],
				["b", "h2"],
			]);
		});

		it.each([
			["a corrupt file", '{"version": 1, "projects": {"/p": {"a": "h"}'],
			["another file version", JSON.stringify({ version: 2, projects: { "/p": { a: "h" } } })],
			["a file of another shape", "[]"],
		])("does not overwrite %s, and reads it as no approvals with the reason", (_, content) => {
			const { path, project } = setupFile();
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);

			expect(() => saveAlwaysAllowedServer(path, project, "b", "h2")).toThrow(/; not overwriting it$/);
			expect(readFileSync(path, "utf8")).toBe(content);
			const read = readAlwaysAllowedServers(path, project);
			expect(read.servers.size).toBe(0);
			expect(read.problem?.startsWith(`${path}: `)).toBe(true);
		});

		it("keeps the entries of other projects and unknown entries", () => {
			const { path, project } = setupFile();
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ version: 1, projects: { "/other": { x: "hx" }, "/odd": 5 } }));

			saveAlwaysAllowedServer(path, project, "b", "h2");

			expect(JSON.parse(readFileSync(path, "utf8")).projects).toEqual({
				"/other": { x: "hx" },
				"/odd": 5,
				[realpathSync(project)]: { b: "h2" },
			});
		});

		it.skipIf(process.platform === "win32")("writes through a symlink instead of replacing it", () => {
			const { root, path, project } = setupFile();
			const target = join(root, "dotfiles", "mcp-approvals.json");
			mkdirSync(dirname(target), { recursive: true });
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(target, JSON.stringify({ version: 1, projects: {} }));
			symlinkSync(target, path);

			saveAlwaysAllowedServer(path, project, "b", "h2");

			expect(lstatSync(path).isSymbolicLink()).toBe(true);
			expect(readAlwaysAllowedServers(target, project).servers.get("b")).toBe("h2");
			expect(readdirSync(dirname(target))).toEqual(["mcp-approvals.json"]);
			expect(readdirSync(dirname(path))).toEqual(["mcp-approvals.json"]);
		});
	});

	describe("Object.prototype names", () => {
		it("does not take them for servers the file defines", () => {
			const { files, write } = layout();
			write("agent", { toString: { command: "x" } });
			const content = readFileSync(files.agent, "utf8");

			expect(removeMcpServerConfig(files.agent, "valueOf")).toBe(false);
			expect(readFileSync(files.agent, "utf8")).toBe(content);
			expect(addMcpServerConfig(files.agent, "valueOf", { command: "y" })).toBe(false);
			updateMcpServerConfig(files.agent, "hasOwnProperty", { enabled: false }, { override: true });
			expect(() => updateMcpServerConfig(files.agent, "isPrototypeOf", { enabled: false })).toThrow(
				'does not define MCP server "isPrototypeOf"',
			);

			expect(JSON.parse(readFileSync(files.agent, "utf8")).mcpServers).toEqual({
				toString: { command: "x" },
				valueOf: { command: "y" },
				hasOwnProperty: { enabled: false },
			});
			expect(removeMcpServerConfig(files.agent, "toString")).toBe(true);
		});
	});

	describe("notices", () => {
		it("report a project server that replaces a user server", () => {
			const { files, write, load } = layout();
			write("agent", { api: { command: "user" }, other: { command: "user" } });
			write("dotMcp", { api: { command: "repo" }, fresh: { command: "repo" } });

			const { notices } = load();

			expect(notices).toEqual([`${files.dotMcp}: server "api" replaces the one in ${files.agent}`]);
		});

		it("do not report project servers replacing project servers or an untrusted project", () => {
			const { write, load, options } = layout();
			write("dotMcp", { api: { command: "repo" } });
			write("project", { api: { command: "repo2" } });
			expect(load().notices).toEqual([]);

			write("agent", { api: { command: "user" } });
			expect(loadMcpConfig({ ...options, projectTrusted: false }).notices).toEqual([]);
		});
	});

	describe("pi mcp list", () => {
		async function list(args: string[], setup: (ctx: ReturnType<typeof layout>) => void) {
			const ctx = layout();
			setup(ctx);
			const output: string[] = [];
			const exitCode = await runMcpCommand(["list", ...args], {
				cwd: ctx.options.cwd,
				agentDir: ctx.options.agentDir,
				log: (line) => output.push(line),
				error: (line) => output.push(line),
			});
			return { ...ctx, exitCode, output: output.join("\n") };
		}

		const defineServers = ({ write }: ReturnType<typeof layout>) => {
			write("agent", { api: { command: "user", enabled: false } });
			write("dotMcp", { api: { command: "repo", enabled: false } });
		};

		it("ignores .mcp.json until the project is trusted", async () => {
			const result = await list([], defineServers);

			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("api: disabled (codemode, global)");
			expect(result.output).not.toContain("replaced:");
			expect(result.output).toContain(`${result.files.dotMcp} is ignored because the project is not trusted`);
		});

		it("reads .mcp.json after the saved decision trusts the project, and prints the replaced notice", async () => {
			const result = await list([], (ctx) => {
				defineServers(ctx);
				new ProjectTrustStore(ctx.options.agentDir).set(ctx.options.cwd, true);
			});

			expect(result.output).toContain("api: disabled (codemode, project)");
			expect(result.output).toContain(
				`replaced: ${result.files.dotMcp}: server "api" replaces the one in ${result.files.agent}`,
			);
		});

		it("trusts the project when defaultProjectTrust is always and no decision is saved", async () => {
			const result = await list(["--json"], (ctx) => {
				defineServers(ctx);
				writeFileSync(
					join(ctx.options.agentDir, "settings.json"),
					JSON.stringify({ defaultProjectTrust: "always" }),
				);
			});

			const parsed = JSON.parse(result.output) as { servers: { name: string; scope: string }[]; notices: string[] };
			expect(parsed.servers.map(({ name, scope }) => [name, scope])).toEqual([["api", "project"]]);
			expect(parsed.notices).toEqual([
				`${result.files.dotMcp}: server "api" replaces the one in ${result.files.agent}`,
			]);
		});

		it("does not trust the project when the saved decision is no, whatever the default", async () => {
			const result = await list([], (ctx) => {
				defineServers(ctx);
				writeFileSync(
					join(ctx.options.agentDir, "settings.json"),
					JSON.stringify({ defaultProjectTrust: "always" }),
				);
				new ProjectTrustStore(ctx.options.agentDir).set(ctx.options.cwd, false);
			});

			expect(result.output).toContain("api: disabled (codemode, global)");
		});
	});

	describe("writing mcp.json", () => {
		it.skipIf(process.platform === "win32")(
			"writes new files readable by the owner only and leaves no temporary files",
			() => {
				const { root } = layout();
				const path = join(root, "agent", "mcp.json");

				addMcpServerConfig(path, "api", { command: "x", env: { TOKEN: "secret" } });

				expect(statSync(path).mode & 0o777).toBe(0o600);
				expect(readdirSync(dirname(path))).toEqual(["mcp.json"]);
			},
		);

		it.skipIf(process.platform === "win32")("tightens the mode of an existing file", () => {
			const { root } = layout();
			const path = join(root, "agent", "mcp.json");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, "{}", { mode: 0o644 });

			addMcpServerConfig(path, "api", { command: "x" });

			expect(statSync(path).mode & 0o777).toBe(0o600);
		});

		it.skipIf(process.platform === "win32")("writes through a symlink instead of replacing it", () => {
			const { root } = layout();
			const dotfiles = join(root, "dotfiles");
			const target = join(dotfiles, "mcp.json");
			const link = join(root, "agent", "mcp.json");
			mkdirSync(dotfiles, { recursive: true });
			mkdirSync(dirname(link), { recursive: true });
			writeFileSync(target, JSON.stringify({ mcpServers: { old: { command: "old" } } }, null, 4));
			symlinkSync(target, link);

			addMcpServerConfig(link, "api", { command: "x" });
			updateMcpServerConfig(link, "old", { enabled: false });

			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(realpathSync(link)).toBe(realpathSync(target));
			expect(JSON.parse(readFileSync(target, "utf8")).mcpServers).toEqual({
				old: { command: "old", enabled: false },
				api: { command: "x" },
			});
			expect(readFileSync(target, "utf8")).toContain('\n    "mcpServers"');
			expect(readdirSync(dotfiles)).toEqual(["mcp.json"]);
			expect(readdirSync(dirname(link))).toEqual(["mcp.json"]);
		});

		it.skipIf(process.platform === "win32")("keeps the old file when the new content cannot be written", () => {
			const { root } = layout();
			const path = join(root, "agent", "mcp.json");
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify({ mcpServers: { old: { command: "old" } } }));
			const before = readFileSync(path, "utf8");

			expect(() => addMcpServerConfig(path, "api", { command: "x", env: { A: 1n as never } })).toThrow();

			expect(readFileSync(path, "utf8")).toBe(before);
			expect(existsSync(path)).toBe(true);
			expect(readdirSync(dirname(path))).toEqual(["mcp.json"]);
		});
	});
});
