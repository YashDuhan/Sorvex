import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cliArguments, createSandbox, ScenarioError, SCRIPT_ENV } from "./drive-live.mjs";
import { keyBytes, validateSteps } from "./drive-tui.mjs";

const driver = join(dirname(fileURLToPath(import.meta.url)), "drive-live.mjs");
const RUN_TIMEOUT_MS = 90_000;

function temporaryDirectory(t) {
	const directory = mkdtempSync(join(tmpdir(), "pi-drive-live-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function drive(t, scenario, { driverArgs = [], env = process.env } = {}) {
	const directory = temporaryDirectory(t);
	const scenarioPath = join(directory, "scenario.json");
	writeFileSync(scenarioPath, JSON.stringify(scenario));
	const result = spawnSync(process.execPath, [driver, scenarioPath, ...driverArgs], { encoding: "utf8", timeout: RUN_TIMEOUT_MS, env });
	return { status: result.status, transcript: result.stdout, stderr: result.stderr };
}

function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function lineIndex(transcript, pattern) {
	return transcript.split("\n").findIndex((line) => pattern.test(line));
}

test("a text-only scenario ends with the scripted reply and exit code 0", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		prompts: ["hi"],
		turns: [{ text: "Hello from the script." }],
	});
	assert.equal(status, 0, transcript);
	assert.match(transcript, /assistant: "Hello from the script\." \[stop\]/);
	assert.match(transcript, /# result: PASS/);
});

test("a tool-call scenario records the real tool result before the final text", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		args: ["--tools", "ls"],
		files: { "alpha.txt": "a", "beta.txt": "b" },
		prompts: ["list"],
		turns: [{ toolCalls: [{ name: "ls", args: { path: "." } }] }, { text: "Listed." }],
	});
	assert.equal(status, 0, transcript);
	const toolEnd = lineIndex(transcript, /tool_execution_end\s+ls isError=false .*alpha\.txt.*beta\.txt/);
	const finalText = lineIndex(transcript, /assistant: "Listed\."/);
	assert.ok(toolEnd >= 0, transcript);
	assert.ok(finalText > toolEnd, transcript);
});

test("a script that runs out of turns fails the run", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		args: ["--tools", "ls"],
		prompts: ["list"],
		turns: [{ toolCalls: [{ name: "ls", args: { path: "." } }] }],
	});
	assert.notEqual(status, 0);
	assert.match(transcript, /# result: FAIL script exhausted/);
});

test("a scripted turn the model never requested fails the run", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		prompts: ["hi"],
		turns: [{ text: "used" }, { text: "unused" }],
	});
	assert.notEqual(status, 0);
	assert.match(transcript, /1 scripted turn\(s\) were never requested/);
});

test("a scripted provider error fails the run and reaches the transcript", (t) => {
	const { status, transcript } = drive(t, { mode: "json", prompts: ["hi"], turns: [{ error: "scripted failure" }] });
	assert.notEqual(status, 0);
	assert.match(transcript, /\[error\] error="scripted failure"/);
});

test("rpc mode answers each prompt in order and ends on its own", (t) => {
	const { status, transcript } = drive(t, {
		mode: "rpc",
		prompts: ["one", "two"],
		turns: [{ text: "reply one" }, { text: "reply two" }],
	});
	assert.equal(status, 0, transcript);
	const first = lineIndex(transcript, /assistant: "reply one"/);
	const second = lineIndex(transcript, /assistant: "reply two"/);
	assert.ok(first >= 0 && second > first, transcript);
});

test("rpc mode answers extension UI requests from uiAnswers", (t) => {
	const directory = temporaryDirectory(t);
	const extensionPath = join(directory, "ask.ts");
	writeFileSync(
		extensionPath,
		`export default function (pi) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: "Asks a question",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute(_id, _params, _signal, _update, ctx) {
			const choice = await ctx.ui.select("Pick one", ["first", "second"]);
			return { content: [{ type: "text", text: "picked " + choice }], details: {} };
		},
	});
}
`,
	);
	const { status, transcript } = drive(t, {
		mode: "rpc",
		args: ["-e", extensionPath, "--tools", "ask"],
		prompts: ["ask me"],
		uiAnswers: [{ method: "select", value: "second" }],
		turns: [{ toolCalls: [{ name: "ask", args: {} }] }, { text: "Done." }],
	});
	assert.equal(status, 0, transcript);
	assert.match(transcript, /tool_execution_end\s+ask isError=false \["picked second"\]/);
});

test("expectFiles fails the run when the file lacks the text", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		prompts: ["hi"],
		files: { "kept.txt": "original" },
		expectFiles: { "kept.txt": "replacement" },
		turns: [{ text: "ok" }],
	});
	assert.notEqual(status, 0);
	assert.match(transcript, /kept\.txt does not contain "replacement"/);
});

test("a tool that errors fails the run", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		args: ["--tools", "read"],
		prompts: ["list"],
		turns: [{ toolCalls: [{ name: "ls", args: { path: "." } }] }, { text: "Listed." }],
	});
	assert.notEqual(status, 0, transcript);
	assert.match(transcript, /# result: FAIL .*tool ls failed/);
});

test("a scripted tool call marked expectError may fail without failing the run", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		args: ["--tools", "read"],
		prompts: ["read"],
		turns: [{ toolCalls: [{ name: "read", args: { path: "missing.txt" }, expectError: true }] }, { text: "Missing." }],
	});
	assert.equal(status, 0, transcript);
	assert.match(transcript, /tool_execution_end\s+read isError=true/);
});

test("a scripted tool call marked expectError fails the run when the tool succeeds", (t) => {
	const { status, transcript } = drive(t, {
		mode: "json",
		args: ["--tools", "read"],
		files: { "here.txt": "x" },
		prompts: ["read"],
		turns: [{ toolCalls: [{ name: "read", args: { path: "here.txt" }, expectError: true }] }, { text: "Read." }],
	});
	assert.notEqual(status, 0, transcript);
	assert.match(transcript, /expected tool read to fail but it succeeded/);
});

test("a timeout kills the whole process tree and still writes the transcript and cleans up", (t) => {
	const directory = temporaryDirectory(t);
	const pidFile = join(directory, "grandchild.pid");
	const temp = join(directory, "tmp");
	mkdirSync(temp);
	const outFile = join(directory, "out.txt");
	const holder = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const { status, transcript } = drive(
		t,
		{
			mode: "json",
			args: ["--tools", "bash"],
			files: { "hold.cjs": holder },
			prompts: ["hold"],
			turns: [{ toolCalls: [{ name: "bash", args: { command: "node hold.cjs" } }] }, { text: "unreachable" }],
		},
		{ driverArgs: ["--timeout", "15000", "--out", outFile], env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp } },
	);
	assert.ok(existsSync(pidFile), "the grandchild never started");
	const pid = Number(readFileSync(pidFile, "utf8"));
	t.after(() => {
		if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
	});
	assert.notEqual(status, 0, transcript);
	assert.match(transcript, /timed out after 15000 ms/);
	assert.ok(existsSync(outFile), "no transcript was written");
	assert.equal(processIsAlive(pid), false, "the grandchild survived the timeout");
	assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("pi-live-")), []);
});

test("a missing scenario file exits 2 without starting the CLI", () => {
	const result = spawnSync(process.execPath, [driver, join(tmpdir(), "pi-drive-live-no-such-scenario.json")], {
		encoding: "utf8",
	});
	assert.equal(result.status, 2);
	assert.match(result.stderr, /cannot read scenario/);
});

test("an invalid scenario exits 2 and names the bad field", (t) => {
	const { status, stderr } = drive(t, { mode: "json", prompts: [], turns: [] });
	assert.equal(status, 2);
	assert.match(stderr, /"prompts" must be a non-empty array/);
});

test("the scripted provider fails the CLI loudly when its script file is missing", (t) => {
	const sandbox = createSandbox({ turns: [] });
	t.after(() => sandbox.cleanup());
	const env = { ...sandbox.env, [SCRIPT_ENV]: join(sandbox.dir, "no-such-script.json") };
	const result = spawnSync(process.execPath, [...cliArguments({}), "--mode", "json", "-p", "hi"], {
		cwd: sandbox.work,
		env,
		input: "",
		encoding: "utf8",
		timeout: RUN_TIMEOUT_MS,
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /no-such-script\.json/);
});

test("--root runs that checkout's CLI with that checkout's scripted provider", (t) => {
	const root = temporaryDirectory(t);
	const argvFile = join(root, "argv.json");
	mkdirSync(join(root, "packages/coding-agent/src/experimental"), { recursive: true });
	writeFileSync(join(root, "packages/coding-agent/src/experimental/source-resolver.ts"), "");
	writeFileSync(
		join(root, "packages/coding-agent/src/cli.ts"),
		`require("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\n`,
	);
	drive(t, { mode: "json", prompts: ["hi"], turns: [{ text: "hello" }] }, { driverArgs: ["--root", root] });
	const argv = JSON.parse(readFileSync(argvFile, "utf8"));
	assert.equal(argv[argv.indexOf("-e") + 1], join(root, "packages/coding-agent/test/live/scripted-provider.ts"));
});

test("tui keys cover ctrl, alt, and ctrl+alt chords", () => {
	assert.equal(keyBytes("ctrl+p"), "\x10");
	assert.equal(keyBytes("alt+t"), "\x1bt");
	assert.equal(keyBytes("ctrl+alt+p"), "\x1b\x10");
	assert.throws(() => keyBytes("ctrl+alt+shift+p"), ScenarioError);
});

test("tui scenarios accept raw byte steps and reject a raw step without bytes", () => {
	const base = { cols: 80, rows: 24 };
	validateSteps({ ...base, steps: [{ type: "raw", bytes: "\x1b[1;7P" }] });
	assert.throws(() => validateSteps({ ...base, steps: [{ type: "raw" }] }), ScenarioError);
});
