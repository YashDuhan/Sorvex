import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Hub } from "./hub.ts";
import { appDir } from "./paths.ts";

/** Output kept per terminal, so a Terminal pane that is reopened (or a reloaded window) can show it again. */
const BUFFER_LIMIT = 256 * 1024;

interface Terminal {
	id: number;
	title: string;
	cwd: string;
	process: ChildProcess;
	buffer: string;
	/** Characters of output so far. Events carry it as `end`, so a client that loads the buffer can skip overlap. */
	total: number;
	exited: boolean;
}

export interface TerminalInfo {
	id: number;
	title: string;
	cwd: string;
	exited: boolean;
}

/**
 * The Terminal pane's shells. Each one runs the user's login shell on a real pseudo-terminal through `shell_pty.py`, so
 * prompts, colors, line editing and full-screen programs work. Output streams to the UI as `terminal-output` events.
 */
export class TerminalManager {
	private readonly hub: Hub;
	private readonly terminals = new Map<number, Terminal>();
	private nextId = 1;

	constructor(hub: Hub) {
		this.hub = hub;
	}

	list(): TerminalInfo[] {
		return [...this.terminals.values()].map(({ id, title, cwd, exited }) => ({ id, title, cwd, exited }));
	}

	create(cwd: string, rows: number, cols: number): TerminalInfo {
		const shell = process.env.SHELL || "/bin/bash";
		const python = existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
		const child = spawn(python, [join(appDir, "server/shell_pty.py"), shell, cwd, String(clamp(rows, 2, 500)), String(clamp(cols, 10, 1000))], {
			cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
			stdio: ["pipe", "pipe", "pipe", "pipe"],
		});
		const id = this.nextId++;
		const terminal: Terminal = { id, title: basename(cwd) || cwd, cwd, process: child, buffer: "", total: 0, exited: false };
		this.terminals.set(id, terminal);
		// Terminal output can split a multi-byte character across chunks; the decoder holds the partial bytes.
		const decoder = new StringDecoder("utf8");
		const emit = (data: string) => {
			if (!data) return;
			terminal.buffer = (terminal.buffer + data).slice(-BUFFER_LIMIT);
			terminal.total += data.length;
			this.hub.broadcast("terminal-output", { id, data, end: terminal.total });
		};
		child.stdout?.on("data", (chunk: Buffer) => emit(decoder.write(chunk)));
		child.stderr?.on("data", (chunk: Buffer) => emit(chunk.toString("utf8")));
		child.on("error", (error) => emit(`\r\n[could not start the terminal: ${error.message}]\r\n`));
		child.on("exit", (code) => {
			emit(decoder.end());
			terminal.exited = true;
			emit(`\r\n[process exited${code ? ` with code ${code}` : ""}]\r\n`);
			this.hub.broadcast("terminal-exit", { id, code });
		});
		return { id, title: terminal.title, cwd, exited: false };
	}

	buffer(id: number): { data: string; end: number } {
		const terminal = this.get(id);
		return { data: terminal.buffer, end: terminal.total };
	}

	input(id: number, data: string): void {
		const terminal = this.get(id);
		if (!terminal.exited) terminal.process.stdin?.write(data);
	}

	resize(id: number, rows: number, cols: number): void {
		const terminal = this.get(id);
		const control = terminal.process.stdio[3] as Writable | null;
		if (!terminal.exited) control?.write(`${clamp(rows, 2, 500)} ${clamp(cols, 10, 1000)}\n`);
	}

	close(id: number): void {
		const terminal = this.terminals.get(id);
		if (!terminal) return;
		this.terminals.delete(id);
		if (!terminal.exited) terminal.process.kill("SIGTERM");
	}

	closeAll(): void {
		for (const id of [...this.terminals.keys()]) this.close(id);
	}

	private get(id: number): Terminal {
		const terminal = this.terminals.get(id);
		if (!terminal) throw new Error(`No terminal ${id}`);
		return terminal;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.round(Number(value) || min), min), max);
}
