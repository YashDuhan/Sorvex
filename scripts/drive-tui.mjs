#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cliArguments, createSandbox, loadScenarioFile, parseCommandLine, ScenarioError } from "./drive-live.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { Terminal } = createRequire(import.meta.url)("@xterm/headless");

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 50;
const FRAME_INPUT = "D";
const FRAME_RESIZE = "R";

const NAMED_KEYS = {
	enter: "\r",
	tab: "\t",
	escape: "\x1b",
	backspace: "\x7f",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	delete: "\x1b[3~",
	"shift+tab": "\x1b[Z",
};

export function keyBytes(key) {
	if (key in NAMED_KEYS) return NAMED_KEYS[key];
	const metaChord = /^ctrl\+alt\+([a-z])$/.exec(key);
	if (metaChord) return `\x1b${String.fromCharCode(metaChord[1].charCodeAt(0) - 96)}`;
	const chord = /^(ctrl|alt)\+([a-z])$/.exec(key);
	if (chord?.[1] === "ctrl") return String.fromCharCode(chord[2].charCodeAt(0) - 96);
	if (chord?.[1] === "alt") return `\x1b${chord[2]}`;
	throw new ScenarioError(`unknown key "${key}"`);
}

export function validateSteps(scenario) {
	for (const key of ["cols", "rows"]) {
		if (!Number.isInteger(scenario[key]) || scenario[key] <= 0) throw new ScenarioError(`"${key}" must be a positive integer`);
	}
	if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new ScenarioError('"steps" must be a non-empty array');
	scenario.steps.forEach((step, index) => {
		const where = `steps[${index}]`;
		switch (step?.type) {
			case "text":
				if (typeof step.text !== "string") throw new ScenarioError(`${where}.text must be a string`);
				return;
			case "key":
				keyBytes(step.key);
				return;
			case "raw":
				if (typeof step.bytes !== "string") throw new ScenarioError(`${where}.bytes must be a string`);
				return;
			case "resize":
				if (![step.cols, step.rows].every((value) => Number.isInteger(value) && value > 0)) {
					throw new ScenarioError(`${where} needs positive integer cols and rows`);
				}
				return;
			case "wait_for":
				if (typeof step.text !== "string") throw new ScenarioError(`${where}.text must be a string`);
				return;
			case "sleep":
				if (!Number.isFinite(step.ms)) throw new ScenarioError(`${where}.ms must be a number`);
				return;
			case "expect_exit":
				return;
			default:
				throw new ScenarioError(`${where} has unknown type ${JSON.stringify(step?.type)}`);
		}
	});
}

function frame(type, payload) {
	const header = Buffer.alloc(5);
	header.write(type, 0, "ascii");
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, payload]);
}

function screenText(terminal) {
	const buffer = terminal.buffer.active;
	const lines = [];
	for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines.join("\n");
}

const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function runTui(scenario, { root, keep = false, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	if (process.platform !== "win32") throw new ScenarioError("drive-tui.mjs needs Windows ConPTY. Use tmux, per .sorvex/skills/interactive-testing.md");
	const sandbox = createSandbox(scenario, { keep });
	const terminal = new Terminal({ cols: scenario.cols, rows: scenario.rows, allowProposedApi: true, scrollback: 2000 });
	const command = [
		join(here, "conpty-host.py"),
		String(scenario.cols),
		String(scenario.rows),
		"--",
		process.execPath,
		...cliArguments(scenario, root),
		"--approve",
	];
	const child = spawn("python", command, {
		cwd: sandbox.work,
		env: { ...sandbox.env, TERM: "xterm-256color" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let exitCode;
	let stderr = "";
	let cols = scenario.cols;
	let rows = scenario.rows;
	const exited = new Promise((done) => child.on("close", (code) => done(code)));
	exited.then((code) => {
		exitCode = code;
	});
	child.stdin.on("error", () => {});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout.on("data", (chunk) => terminal.write(chunk));
	const sendInput = (text) => child.stdin.write(frame(FRAME_INPUT, Buffer.from(text, "utf8")));
	terminal.onData(sendInput);

	const sections = [];
	const failures = [];
	const dump = async (label) => {
		await new Promise((done) => terminal.write("", done));
		const status = exitCode === undefined ? "running" : `exited ${exitCode}`;
		sections.push(`=== ${label} | ${cols}x${rows} | ${status} ===\n${screenText(terminal)}`);
	};
	const waitFor = async (predicate, limitMs) => {
		const deadline = Date.now() + limitMs;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await delay(POLL_MS);
		}
		return predicate();
	};

	const run = async () => {
		for (const [index, step] of scenario.steps.entries()) {
			const label = `step ${index + 1} ${JSON.stringify(step)}`;
			switch (step.type) {
				case "text":
					sendInput(step.text);
					await delay(POLL_MS * 4);
					break;
				case "key":
					sendInput(keyBytes(step.key));
					await delay(POLL_MS * 4);
					break;
				case "raw":
					sendInput(step.bytes);
					await delay(POLL_MS * 4);
					break;
				case "resize":
					cols = step.cols;
					rows = step.rows;
					terminal.resize(cols, rows);
					child.stdin.write(frame(FRAME_RESIZE, Buffer.from([cols >> 8, cols & 255, rows >> 8, rows & 255])));
					await delay(POLL_MS * 4);
					break;
				case "sleep":
					await delay(step.ms);
					break;
				case "wait_for":
					if (!(await waitFor(() => screenText(terminal).includes(step.text), step.timeoutMs ?? DEFAULT_WAIT_MS))) {
						failures.push(`step ${index + 1}: screen never showed ${JSON.stringify(step.text)}`);
					}
					break;
				case "expect_exit":
					if (!(await waitFor(() => exitCode !== undefined, step.timeoutMs ?? DEFAULT_WAIT_MS))) {
						failures.push(`step ${index + 1}: the process did not exit`);
					}
					break;
			}
			await dump(label);
			if (failures.length > 0) return;
		}
	};

	const timer = setTimeout(() => {
		failures.push(`timed out after ${timeoutMs} ms`);
		child.kill();
	}, timeoutMs);
	await run();
	clearTimeout(timer);
	if (exitCode === undefined) {
		child.stdin.end();
		await Promise.race([exited, delay(5000)]);
	}
	sandbox.cleanup();
	terminal.dispose();
	return { sections, failures, exitCode, stderr, keptDir: keep ? sandbox.dir : undefined };
}

async function main() {
	const { scenarioPath, out, ...options } = parseCommandLine(process.argv.slice(2), DEFAULT_TIMEOUT_MS);
	const scenario = loadScenarioFile(scenarioPath, ["tui"]);
	validateSteps(scenario);
	const result = await runTui(scenario, options);
	const lines = [`# scenario: ${scenarioPath} mode=tui`, ...result.sections];
	if (result.stderr.trim()) lines.push(`# stderr: ${result.stderr.trim()}`);
	lines.push(`# child exit code: ${result.exitCode ?? "still running"}`);
	if (result.keptDir) lines.push(`# kept: ${result.keptDir}`);
	lines.push(result.failures.length === 0 ? "# result: PASS" : `# result: FAIL ${result.failures.join("; ")}`);
	const transcript = `${lines.join("\n")}\n`;
	if (out) {
		mkdirSync(dirname(resolve(out)), { recursive: true });
		writeFileSync(out, transcript);
	}
	process.stdout.write(transcript);
	process.exitCode = result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof ScenarioError ? `drive-tui: ${error.message}` : error);
		process.exit(2);
	});
}
