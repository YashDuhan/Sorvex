import type * as Fs from "node:fs";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";
import { importLegacyConfigDir } from "../src/migrations.ts";

const copyFault = vi.hoisted(() => ({ entry: undefined as string | undefined }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof Fs>();
	return {
		...actual,
		cpSync: (...args: Parameters<typeof actual.cpSync>) => {
			if (copyFault.entry && String(args[0]).endsWith(copyFault.entry)) {
				throw new Error(`EIO: i/o error, copy '${String(args[0])}'`);
			}
			actual.cpSync(...args);
		},
	};
});

describe("importLegacyConfigDir", () => {
	const originalAgentDir = process.env[ENV_AGENT_DIR];
	let home: string;
	let legacyAgentDir: string;
	let agentDir: string;
	let notices: string[];

	function seed(dir: string, files: Record<string, string>): void {
		for (const [name, content] of Object.entries(files)) {
			mkdirSync(join(dir, name, ".."), { recursive: true });
			writeFileSync(join(dir, name), content);
		}
	}

	function visibleEntries(dir: string): string[] {
		return readdirSync(dir)
			.filter((name) => !name.startsWith("."))
			.sort();
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "sorvex-legacy-import-"));
		legacyAgentDir = join(home, ".pi", "agent");
		agentDir = join(home, CONFIG_DIR_NAME, "agent");
		mkdirSync(legacyAgentDir, { recursive: true });
		delete process.env[ENV_AGENT_DIR];
		copyFault.entry = undefined;
		notices = [];
		vi.spyOn(console, "error").mockImplementation((message: unknown) => {
			notices.push(String(message));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		copyFault.entry = undefined;
		rmSync(home, { recursive: true, force: true });
		if (originalAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = originalAgentDir;
		}
	});

	it("copies the user config into the agent dir and leaves ~/.pi untouched", () => {
		seed(legacyAgentDir, {
			"auth.json": '{"anthropic":{"type":"api_key","key":"k"}}',
			"settings.json": '{"theme":"dark"}',
			"mcp.json": "{}",
			"prompts/review.md": "review",
			"themes/mine.json": "{}",
			"agents/scout.md": "scout",
			"sessions/--proj--/old.jsonl": "history",
			"bin/fd": "binary",
		});

		const result = importLegacyConfigDir(home);

		expect(result).toEqual({
			from: legacyAgentDir,
			to: agentDir,
			copied: ["auth.json", "settings.json", "mcp.json", "prompts", "themes", "agents"],
		});
		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe('{"anthropic":{"type":"api_key","key":"k"}}');
		expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf-8")).toBe("review");
		expect(readFileSync(join(agentDir, "agents", "scout.md"), "utf-8")).toBe("scout");
		expect(visibleEntries(agentDir)).toEqual([
			"agents",
			"auth.json",
			"mcp.json",
			"prompts",
			"settings.json",
			"themes",
		]);
		expect(readFileSync(join(legacyAgentDir, "auth.json"), "utf-8")).toBe(
			'{"anthropic":{"type":"api_key","key":"k"}}',
		);
		expect(existsSync(join(legacyAgentDir, "sessions", "--proj--", "old.jsonl"))).toBe(true);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("auth.json");
		expect(notices[0]).toContain(legacyAgentDir);
	});

	it("copies skills and extensions, including nested node_modules and symlinked files", () => {
		seed(legacyAgentDir, {
			"skills/review/SKILL.md": "# review",
			"skills/review/scripts/run.sh": "echo run",
			"extensions/hello/index.ts": "export default () => {};",
			"extensions/hello/node_modules/dep/package.json": '{"name":"dep"}',
			"extensions/hello/node_modules/dep/index.js": "module.exports = 1;",
			"extensions/hello/real.txt": "target",
		});
		let linked = true;
		try {
			symlinkSync("real.txt", join(legacyAgentDir, "extensions", "hello", "link.txt"));
		} catch {
			linked = false;
		}

		expect(importLegacyConfigDir(home)?.copied).toEqual(["skills", "extensions"]);

		expect(readFileSync(join(agentDir, "skills", "review", "SKILL.md"), "utf-8")).toBe("# review");
		expect(readFileSync(join(agentDir, "skills", "review", "scripts", "run.sh"), "utf-8")).toBe("echo run");
		expect(readFileSync(join(agentDir, "extensions", "hello", "index.ts"), "utf-8")).toBe("export default () => {};");
		expect(readFileSync(join(agentDir, "extensions", "hello", "node_modules", "dep", "index.js"), "utf-8")).toBe(
			"module.exports = 1;",
		);
		if (linked) {
			expect(readFileSync(join(agentDir, "extensions", "hello", "link.txt"), "utf-8")).toBe("target");
		}
		expect(existsSync(join(legacyAgentDir, "skills", "review", "SKILL.md"))).toBe(true);
	});

	it("copies an extension whose node_modules links back to the extension itself", () => {
		const extension = join(legacyAgentDir, "extensions", "self");
		seed(legacyAgentDir, { "extensions/self/index.ts": "export default () => {};" });
		mkdirSync(join(extension, "node_modules"));
		try {
			symlinkSync(extension, join(extension, "node_modules", "self"), "junction");
		} catch {
			return;
		}

		expect(importLegacyConfigDir(home)?.copied).toEqual(["extensions"]);

		expect(readFileSync(join(agentDir, "extensions", "self", "index.ts"), "utf-8")).toBe("export default () => {};");
		expect(existsSync(join(agentDir, "extensions", "self", "node_modules", "self"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("creates the agent dir private to the user", () => {
		seed(legacyAgentDir, { "auth.json": "{}" });

		importLegacyConfigDir(home);

		expect(statSync(agentDir).mode & 0o777).toBe(0o700);
	});

	it("does nothing on the second run and keeps edits and deletions made after the first import", () => {
		seed(legacyAgentDir, { "settings.json": '{"theme":"dark"}', "mcp.json": '{"mcpServers":{}}' });
		importLegacyConfigDir(home);
		writeFileSync(join(agentDir, "settings.json"), '{"theme":"light"}');
		rmSync(join(agentDir, "mcp.json"));
		notices.length = 0;

		expect(importLegacyConfigDir(home)).toBeUndefined();

		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe('{"theme":"light"}');
		expect(existsSync(join(agentDir, "mcp.json"))).toBe(false);
		expect(notices).toEqual([]);
	});

	it("keeps a logout made after the import instead of importing the old credentials again", () => {
		seed(legacyAgentDir, { "auth.json": '{"anthropic":{"type":"api_key","key":"k"}}' });
		importLegacyConfigDir(home);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({}, null, 2));
		notices.length = 0;

		expect(importLegacyConfigDir(home)).toBeUndefined();

		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe("{}");
		expect(notices).toEqual([]);
	});

	it("imports the rest of skills when a link inside it points at a deleted directory, and does not retry", () => {
		seed(legacyAgentDir, { "auth.json": '{"legacy":true}', "skills/good/SKILL.md": "# good" });
		try {
			symlinkSync(join(home, "deleted-repo"), join(legacyAgentDir, "skills", "linked"), "junction");
		} catch {
			return;
		}

		expect(importLegacyConfigDir(home)?.copied).toEqual(["auth.json", "skills"]);

		expect(readFileSync(join(agentDir, "skills", "good", "SKILL.md"), "utf-8")).toBe("# good");
		expect(existsSync(join(agentDir, "skills", "linked"))).toBe(false);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain(`Skipped links whose target does not exist: ${join("skills", "linked")}.`);

		writeFileSync(join(agentDir, "auth.json"), "{}");
		notices.length = 0;
		expect(importLegacyConfigDir(home)).toBeUndefined();
		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe("{}");
		expect(notices).toEqual([]);
	});

	it("retries only the entry that failed, without overwriting files changed in between", () => {
		seed(legacyAgentDir, {
			"auth.json": '{"legacy":true}',
			"settings.json": '{"theme":"dark"}',
			"prompts/review.md": "review",
		});
		copyFault.entry = "prompts";

		expect(importLegacyConfigDir(home)?.copied).toEqual(["auth.json", "settings.json"]);
		expect(existsSync(join(agentDir, "prompts"))).toBe(false);
		expect(notices).toHaveLength(2);
		expect(notices[1]).toContain("Could not import prompts");
		expect(notices[1]).toContain("retry on the next start");

		copyFault.entry = undefined;
		writeFileSync(join(agentDir, "settings.json"), '{"theme":"light"}');
		writeFileSync(join(agentDir, "auth.json"), "{}");
		seed(agentDir, { "sessions/--proj--/new.jsonl": "history" });
		notices.length = 0;

		expect(importLegacyConfigDir(home)?.copied).toEqual(["prompts"]);
		expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf-8")).toBe("review");
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe('{"theme":"light"}');
		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe("{}");
		expect(notices).toHaveLength(1);

		notices.length = 0;
		expect(importLegacyConfigDir(home)).toBeUndefined();
		expect(notices).toEqual([]);
	});

	it("imports the global context and system prompt files", () => {
		seed(legacyAgentDir, {
			"AGENTS.md": "agents",
			"SYSTEM.md": "system",
			"APPEND_SYSTEM.md": "append",
		});

		expect(importLegacyConfigDir(home)?.copied).toEqual(["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]);

		expect(readFileSync(join(agentDir, "AGENTS.md"), "utf-8")).toBe("agents");
		expect(readFileSync(join(agentDir, "SYSTEM.md"), "utf-8")).toBe("system");
		expect(readFileSync(join(agentDir, "APPEND_SYSTEM.md"), "utf-8")).toBe("append");
	});

	it("replaces entries that hold no data, such as the empty auth.json a failed run leaves behind", () => {
		seed(legacyAgentDir, { "auth.json": '{"legacy":true}', "prompts/review.md": "review" });
		seed(agentDir, { "auth.json": "{}" });
		mkdirSync(join(agentDir, "prompts"));

		expect(importLegacyConfigDir(home)?.copied).toEqual(["auth.json", "prompts"]);

		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe('{"legacy":true}');
		expect(readFileSync(join(agentDir, "prompts", "review.md"), "utf-8")).toBe("review");
	});

	it("keeps entries the agent dir already holds and imports the rest", () => {
		seed(legacyAgentDir, { "auth.json": '{"legacy":true}', "settings.json": '{"theme":"dark"}' });
		seed(agentDir, { "auth.json": '{"current":true}' });

		expect(importLegacyConfigDir(home)?.copied).toEqual(["settings.json"]);

		expect(readFileSync(join(agentDir, "auth.json"), "utf-8")).toBe('{"current":true}');
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe('{"theme":"dark"}');
	});

	it("does nothing when the agent dir env var is set", () => {
		process.env[ENV_AGENT_DIR] = join(home, "custom-agent");
		seed(legacyAgentDir, { "auth.json": "{}" });

		expect(importLegacyConfigDir(home)).toBeUndefined();

		expect(existsSync(join(home, CONFIG_DIR_NAME))).toBe(false);
		expect(notices).toEqual([]);
	});

	it("does nothing when ~/.pi/agent does not exist", () => {
		rmSync(join(home, ".pi"), { recursive: true });

		expect(importLegacyConfigDir(home)).toBeUndefined();

		expect(existsSync(join(home, CONFIG_DIR_NAME))).toBe(false);
		expect(notices).toEqual([]);
	});

	it("does nothing when ~/.pi/agent holds none of the importable entries", () => {
		seed(legacyAgentDir, { "sessions/--proj--/old.jsonl": "history" });

		expect(importLegacyConfigDir(home)).toBeUndefined();

		expect(existsSync(join(home, CONFIG_DIR_NAME))).toBe(false);
	});

	it("finishes an entry after a crash left its staging copy behind", () => {
		seed(legacyAgentDir, { "prompts/review.md": "review" });
		seed(agentDir, { "prompts.importing/half.md": "half-copied" });

		expect(importLegacyConfigDir(home)?.copied).toEqual(["prompts"]);

		expect(readdirSync(join(agentDir, "prompts"))).toEqual(["review.md"]);
		expect(visibleEntries(agentDir)).toEqual(["prompts"]);
	});
});
