import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const scriptedProviderPath = resolve(__dirname, "live/scripted-provider.ts");
// --import takes a module specifier, not a filesystem path.
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

async function runCli(args: string[]): Promise<CliResult> {
	const root = mkdtempSync(join(tmpdir(), "sorvex-agent-mode-flag-"));
	tempDirs.push(root);
	const home = join(root, "home");
	const projectDir = join(root, "project");
	mkdirSync(home);
	mkdirSync(projectDir);
	const script = join(root, "script.json");
	writeFileSync(script, JSON.stringify([{ text: "hello back" }]));
	const child = spawn(
		process.execPath,
		[
			"--import",
			sourceResolverUrl,
			cliPath,
			"-e",
			scriptedProviderPath,
			"--provider",
			"scripted",
			"--model",
			"scripted-1",
			"--no-skills",
			"--no-context-files",
			"--no-session",
			...args,
		],
		{
			cwd: projectDir,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				[ENV_AGENT_DIR]: join(home, "agent"),
				SORVEX_OFFLINE: "1",
				SORVEX_SCRIPT: script,
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((resolveCode) => child.on("close", resolveCode));
	return { code, stdout, stderr };
}

describe("--agent-mode", () => {
	it("rejects an unknown mode in print mode before the session starts", async () => {
		const result = await runCli(["-p", "--agent-mode", "bogus", "hi"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Unknown --agent-mode "bogus". Use build, plan, security.');
		expect(result.stdout).not.toContain("hello back");
	}, 60_000);

	it("rejects an unknown mode in JSON mode", async () => {
		const result = await runCli(["--mode", "json", "--agent-mode", "bogus", "hi"]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain('Unknown --agent-mode "bogus"');
		expect(result.stdout).not.toContain("hello back");
	}, 60_000);

	it("accepts a known mode in any case", async () => {
		const result = await runCli(["-p", "--agent-mode", "Security", "hi"]);
		expect(result.stderr).not.toContain("Unknown --agent-mode");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("hello back");
	}, 60_000);
});
