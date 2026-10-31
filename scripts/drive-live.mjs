#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGENT_DIR_ENVS = ["SORVEX_CODING_AGENT_DIR"];
export const SCRIPT_ENV = "SORVEX_SCRIPT";
export const REPORT_ENV = "SORVEX_SCRIPT_REPORT";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESULT_CHARS = 2000;
const TRANSCRIPT_SKIPPED_EVENTS = new Set(["message_start", "message_update", "turn_start", "turn_end", "tool_execution_update"]);

export class ScenarioError extends Error {}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireStringMap(scenario, key) {
	const value = scenario[key];
	if (value === undefined) return;
	if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
		throw new ScenarioError(`"${key}" must map names to strings`);
	}
}

function validateTurn(turn, index) {
	const where = `turns[${index}]`;
	if (!isRecord(turn)) throw new ScenarioError(`${where} must be an object`);
	for (const key of ["text", "thinking", "error"]) {
		if (turn[key] !== undefined && typeof turn[key] !== "string") throw new ScenarioError(`${where}.${key} must be a string`);
	}
	if (turn.toolCalls === undefined) return;
	if (!Array.isArray(turn.toolCalls)) throw new ScenarioError(`${where}.toolCalls must be an array`);
	for (const call of turn.toolCalls) {
		if (!isRecord(call) || typeof call.name !== "string" || !isRecord(call.args)) {
			throw new ScenarioError(`${where}.toolCalls entries need a string "name" and an object "args"`);
		}
		if (call.expectError !== undefined && typeof call.expectError !== "boolean") {
			throw new ScenarioError(`${where}.toolCalls entries need a boolean "expectError"`);
		}
	}
}

export function loadScenarioFile(path, modes) {
	let scenario;
	try {
		scenario = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new ScenarioError(`cannot read scenario ${path}: ${error.message}`);
	}
	if (!isRecord(scenario)) throw new ScenarioError("scenario must be a JSON object");
	if (!modes.includes(scenario.mode)) throw new ScenarioError(`"mode" must be one of ${modes.join(", ")}`);
	if (!Array.isArray(scenario.turns)) throw new ScenarioError('"turns" must be an array');
	scenario.turns.forEach(validateTurn);
	if (scenario.args !== undefined && !(Array.isArray(scenario.args) && scenario.args.every((arg) => typeof arg === "string"))) {
		throw new ScenarioError('"args" must be an array of strings');
	}
	requireStringMap(scenario, "files");
	requireStringMap(scenario, "homeFiles");
	if (scenario.env !== undefined) {
		if (!isRecord(scenario.env) || !Object.values(scenario.env).every((entry) => entry === null || typeof entry === "string")) {
			throw new ScenarioError('"env" must map names to strings or null');
		}
	}
	return scenario;
}

export function loadHeadlessScenario(path) {
	const scenario = loadScenarioFile(path, ["json", "rpc", "print"]);
	if (!Array.isArray(scenario.prompts) || scenario.prompts.length === 0 || !scenario.prompts.every((p) => typeof p === "string")) {
		throw new ScenarioError('"prompts" must be a non-empty array of strings');
	}
	if (scenario.uiAnswers !== undefined && !Array.isArray(scenario.uiAnswers)) throw new ScenarioError('"uiAnswers" must be an array');
	requireStringMap(scenario, "expectFiles");
	return scenario;
}

function writeFiles(directory, files = {}) {
	for (const [name, body] of Object.entries(files)) {
		const target = join(directory, name);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, body);
	}
}

export function createSandbox(scenario, { keep = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-live-"));
	const home = join(dir, "home");
	const agentDir = join(home, ".sorvex", "agent");
	const work = join(dir, "work");
	for (const path of [home, agentDir, work]) mkdirSync(path, { recursive: true });
	writeFiles(work, scenario.files);
	writeFiles(home, scenario.homeFiles);
	const scriptFile = join(dir, "script.json");
	const reportFile = join(dir, "report.json");
	writeFileSync(scriptFile, JSON.stringify(scenario.turns));

	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("SORVEX_")));
	Object.assign(env, {
		HOME: home,
		USERPROFILE: home,
		SORVEX_OFFLINE: "1",
		...Object.fromEntries(AGENT_DIR_ENVS.map((name) => [name, agentDir])),
		[SCRIPT_ENV]: scriptFile,
		[REPORT_ENV]: reportFile,
	});
	for (const [name, value] of Object.entries(scenario.env ?? {})) {
		if (value === null) delete env[name];
		else env[name] = value;
	}
	return {
		dir,
		home,
		agentDir,
		work,
		env,
		reportFile,
		cleanup() {
			if (keep) return undefined;
			try {
				rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
				return undefined;
			} catch (error) {
				return `${dir} (${error.message})`;
			}
		},
	};
}

export function cliArguments(scenario, root = repoRoot) {
	const resolver = pathToFileURL(join(root, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
	return [
		"--import",
		resolver,
		join(root, "packages/coding-agent/src/cli.ts"),
		"-e",
		join(root, "packages/coding-agent/test/live/scripted-provider.ts"),
		"--provider",
		"scripted",
		"--model",
		"scripted-1",
		"--no-skills",
		"--no-context-files",
		...(scenario.args ?? []),
	];
}

function textOf(content) {
	if (typeof content === "string") return content;
	return (content ?? [])
		.map((block) => {
			if (block.type === "text") return JSON.stringify(block.text);
			if (block.type === "thinking") return `thinking(${JSON.stringify(block.thinking)})`;
			if (block.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments)})`;
			return block.type;
		})
		.join(" ");
}

function clip(text) {
	return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}...[${text.length - MAX_RESULT_CHARS} more chars]` : text;
}

function summarize(event) {
	switch (event.type) {
		case "message_end": {
			const message = event.message;
			if (message.role === "system") return "system (elided)";
			const reason = message.stopReason ? ` [${message.stopReason}]` : "";
			const error = message.errorMessage ? ` error=${JSON.stringify(message.errorMessage)}` : "";
			return clip(`${message.role}: ${textOf(message.content)}${reason}${error}`);
		}
		case "tool_execution_start":
			return `${event.toolName} ${JSON.stringify(event.args)}`;
		case "tool_execution_end":
			return clip(`${event.toolName} isError=${event.isError} ${JSON.stringify((event.result?.content ?? []).map((block) => block.text))}`);
		case "agent_end":
			return `messages=${event.messages?.length} willRetry=${event.willRetry}`;
		case "agent_settled":
			return `aborted=${event.aborted}`;
		case "response":
			return `${event.command} success=${event.success}${event.error ? ` error=${event.error}` : ""}`;
		case "session":
			return `id=${event.id}`;
		case "extension_ui_request":
			return clip(JSON.stringify(event));
		default:
			return "";
	}
}

function uiResponse(answer, id) {
	if ("cancelled" in answer) return { type: "extension_ui_response", id, cancelled: true };
	if (answer.method === "confirm") return { type: "extension_ui_response", id, confirmed: answer.confirmed };
	return { type: "extension_ui_response", id, value: answer.value };
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

function killProcessTree(child) {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		child.kill("SIGKILL");
	}
}

function readReport(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export async function runScenario(scenario, { root = repoRoot, keep = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	const sandbox = createSandbox(scenario, { keep });
	const rpc = scenario.mode === "rpc";
	const args = [
		...cliArguments(scenario, root),
		...(rpc ? ["--mode", "rpc"] : scenario.mode === "json" ? ["--mode", "json", "-p", ...scenario.prompts] : ["-p", ...scenario.prompts]),
	];
	const pendingAnswers = [...(scenario.uiAnswers ?? [])];
	const failures = [];
	const expectedToolErrors = scenario.turns.flatMap((turn) => (turn.toolCalls ?? []).filter((call) => call.expectError).map((call) => call.name));
	const events = [];
	const stdoutText = [];
	let stderr = "";
	let buffered = "";
	let promptsSent = 0;
	const marks = {};

	const startedAt = performance.now();
	const child = spawn(process.execPath, args, {
		cwd: sandbox.work,
		env: sandbox.env,
		stdio: [rpc ? "pipe" : "ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
	child.stdin?.on("error", () => {});
	const sendNextPrompt = () => {
		send({ id: `prompt-${promptsSent}`, type: "prompt", message: scenario.prompts[promptsSent] });
		promptsSent++;
	};

	const handleLine = (line) => {
		const at = performance.now() - startedAt;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			stdoutText.push({ at, line });
			return;
		}
		events.push({ at, event });
		if (event.type === "agent_end") {
			marks.firstAgentEnd ??= at;
			marks.lastAgentEnd = at;
		}
		if (event.type === "agent_settled") marks.settled = at;
		if (event.type === "tool_execution_end" && event.isError) {
			const expected = expectedToolErrors.indexOf(event.toolName);
			if (expected >= 0) expectedToolErrors.splice(expected, 1);
			else failures.push(`tool ${event.toolName} failed: ${(event.result?.content ?? []).map((block) => block.text).join(" ")}`);
		}
		if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
			const message = event.message.errorMessage ?? "unknown error";
			failures.push(message.includes("No more faux responses queued") ? "script exhausted" : `provider error: ${message}`);
		}
		if (rpc && event.type === "agent_settled") {
			if (promptsSent < scenario.prompts.length) sendNextPrompt();
			else child.stdin.end();
		}
		if (rpc && event.type === "extension_ui_request" && DIALOG_METHODS.has(event.method)) {
			const index = pendingAnswers.findIndex((answer) => answer.method === event.method);
			if (index === -1) {
				failures.push(`no uiAnswers entry for ${event.method} request "${event.title}"`);
				send({ type: "extension_ui_response", id: event.id, cancelled: true });
			} else {
				send(uiResponse(pendingAnswers.splice(index, 1)[0], event.id));
			}
		}
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (line) handleLine(line);
			newline = buffered.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	if (rpc) sendNextPrompt();
	const timer = setTimeout(() => {
		failures.push(`timed out after ${timeoutMs} ms`);
		killProcessTree(child);
	}, timeoutMs);
	const exitCode = await new Promise((done) => {
		child.on("error", (error) => {
			failures.push(`cannot start the CLI: ${error.message}`);
			done(null);
		});
		child.on("close", done);
	});
	clearTimeout(timer);
	if (buffered.trim()) handleLine(buffered.trim());
	marks.exit = performance.now() - startedAt;

	if (exitCode !== 0) failures.push(`CLI exited with code ${exitCode}`);
	const report = readReport(sandbox.reportFile);
	if (report && report.pendingTurns > 0) failures.push(`${report.pendingTurns} scripted turn(s) were never requested`);
	for (const name of expectedToolErrors) failures.push(`expected tool ${name} to fail but it succeeded`);
	if (rpc && pendingAnswers.length > 0) failures.push(`${pendingAnswers.length} uiAnswers entries were never asked for`);

	const files = {};
	for (const [name, expected] of Object.entries(scenario.expectFiles ?? {})) {
		let actual;
		try {
			actual = readFileSync(join(sandbox.work, name), "utf8");
		} catch (error) {
			failures.push(`expected file ${name} is unreadable: ${error.message}`);
		}
		files[name] = actual;
		if (actual !== undefined && !actual.includes(expected)) failures.push(`${name} does not contain ${JSON.stringify(expected)}`);
	}
	const leftover = sandbox.cleanup();

	return {
		exitCode,
		events,
		stdoutText,
		stderr,
		files,
		failures: [...new Set(failures)],
		marks,
		peakRssKb: report?.peakRssKb,
		keptDir: keep ? sandbox.dir : undefined,
		leftover,
		agentDir: sandbox.agentDir,
	};
}

export function formatTranscript(scenarioPath, scenario, result) {
	const lines = [`# scenario: ${scenarioPath} mode=${scenario.mode}`];
	const rows = [
		...result.events.filter(({ event }) => !TRANSCRIPT_SKIPPED_EVENTS.has(event.type)).map(({ at, event }) => ({ at, text: `${event.type.padEnd(22)} ${summarize(event)}` })),
		...result.stdoutText.map(({ at, line }) => ({ at, text: `${"stdout".padEnd(22)} ${clip(line)}` })),
	].sort((a, b) => a.at - b.at);
	for (const { at, text } of rows) lines.push(`[+${at.toFixed(0).padStart(5)}ms] ${text}`.trimEnd());
	for (const [name, content] of Object.entries(result.files)) lines.push(`# file ${name}: ${JSON.stringify(content)}`);
	if (result.stderr.trim()) lines.push(`# stderr: ${result.stderr.trim()}`);
	const { firstAgentEnd, lastAgentEnd, settled, exit } = result.marks;
	const ms = (value) => (value === undefined ? "none" : value.toFixed(0));
	lines.push(
		`# timing ms from spawn: first agent_end=${ms(firstAgentEnd)} last agent_end=${ms(lastAgentEnd)} settled=${ms(settled)} exit=${ms(exit)}`,
	);
	if (result.peakRssKb !== undefined) lines.push(`# peak_rss_kb=${result.peakRssKb}`);
	if (result.keptDir) lines.push(`# kept: ${result.keptDir} (agent dir ${result.agentDir})`);
	if (result.leftover) lines.push(`# leftover temp dir: ${result.leftover}`);
	lines.push(result.failures.length === 0 ? "# result: PASS" : `# result: FAIL ${result.failures.join("; ")}`, `# exit ${result.failures.length === 0 ? 0 : 1}`);
	return `${lines.join("\n")}\n`;
}

export function parseCommandLine(argv, defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
	const options = { keep: false, timeoutMs: defaultTimeoutMs, root: repoRoot };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--keep") options.keep = true;
		else if (arg === "--out") options.out = argv[++i];
		else if (arg === "--root") options.root = resolve(argv[++i]);
		else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]);
		else if (arg.startsWith("--")) throw new ScenarioError(`unknown option ${arg}`);
		else positional.push(arg);
	}
	if (positional.length !== 1) throw new ScenarioError("expected exactly one scenario file");
	if ((argv.includes("--out") && !options.out) || !Number.isFinite(options.timeoutMs)) throw new ScenarioError("invalid option value");
	return { scenarioPath: positional[0], ...options };
}

async function main() {
	const { scenarioPath, out, ...options } = parseCommandLine(process.argv.slice(2));
	const scenario = loadHeadlessScenario(scenarioPath);
	const result = await runScenario(scenario, options);
	const transcript = formatTranscript(scenarioPath, scenario, result);
	if (out) {
		mkdirSync(dirname(resolve(out)), { recursive: true });
		writeFileSync(out, transcript);
	}
	process.stdout.write(transcript);
	process.exitCode = result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof ScenarioError ? `drive-live: ${error.message}` : error);
		process.exit(2);
	});
}
