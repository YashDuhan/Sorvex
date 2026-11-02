import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Hub } from "./hub.ts";

/**
 * Background tasks: long-running shell commands (dev servers, watchers, long builds) that the agent starts with
 * task_start instead of bash, so the chat is not blocked until they exit. The desktop server owns the processes, so
 * they keep running when a turn is stopped or the chat is switched; they end when stopped (by the agent or in the
 * Background tasks pane) or when the app quits.
 *
 * Each task runs `$SHELL -c <command>` in its own process group, so stopping it also stops whatever it started (npm
 * → node → vite). Output (stdout and stderr together, ANSI codes removed) is kept per task, capped at OUTPUT_CAP.
 */

const OUTPUT_CAP = 400_000;
/** Output events are batched per task, at most one per interval. */
const OUTPUT_FLUSH_MS = 150;
/** After SIGTERM, a task that has not exited is killed. */
const KILL_AFTER_MS = 4000;
const MAX_WAIT_MS = 300_000;

export type TaskStatus = "running" | "exited" | "failed" | "stopped";

interface Task {
	id: string;
	name: string;
	command: string;
	cwd: string;
	by: "agent" | "user";
	status: TaskStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	/** Total characters ever written; `output` holds the last OUTPUT_CAP of them. */
	written: number;
	lastOutputAt: number;
	output: string;
	child: ChildProcess | null;
	pending: string;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	waiters: Set<() => void>;
}

export interface TaskSummary {
	id: string;
	name: string;
	command: string;
	cwd: string;
	by: "agent" | "user";
	status: TaskStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	written: number;
}

// CSI and OSC sequences, and lone carriage returns that redraw progress lines.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const clean = (text: string) => text.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");

export class TaskManager {
	private readonly hub: Hub;
	private readonly token: string;
	private readonly tasks = new Map<string, Task>();

	constructor(hub: Hub, token: string) {
		this.hub = hub;
		this.token = token;
	}

	list(): TaskSummary[] {
		return [...this.tasks.values()].map(summary).sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Output written after character `since` (0 for everything still kept), and the new end position. */
	output(id: string, since = 0): { text: string; next: number; truncated: boolean } {
		const task = this.get(id);
		const start = task.written - task.output.length;
		const from = Math.max(since, start);
		return { text: task.output.slice(from - start), next: task.written, truncated: since < start };
	}

	/** Starts a task for the agent. Needs the per-launch token, like the other agent-only routes. */
	agentStart(token: string, input: { command: string; cwd: string; name?: string }): TaskSummary {
		if (token !== this.token) throw new Error("Not allowed");
		return this.start({ ...input, by: "agent" });
	}

	start(input: { command: string; cwd: string; name?: string; by: "agent" | "user" }): TaskSummary {
		const command = input.command.trim();
		if (!command) throw new Error("Give a command to run");
		if (!existsSync(input.cwd)) throw new Error(`No such folder: ${input.cwd}`);
		const id = randomBytes(3).toString("hex");
		const task: Task = {
			id,
			name: input.name?.trim() || command.split("\n")[0]!.slice(0, 80),
			command,
			cwd: input.cwd,
			by: input.by,
			status: "running",
			exitCode: null,
			startedAt: Date.now(),
			endedAt: null,
			written: 0,
			lastOutputAt: 0,
			output: "",
			child: null,
			pending: "",
			flushTimer: undefined,
			waiters: new Set(),
		};
		this.tasks.set(id, task);
		const shell = process.env.SHELL || "/bin/bash";
		// No TTY: most tools then skip interactive prompts and spinners. CI-style color is off as well.
		const child = spawn(shell, ["-c", command], {
			cwd: input.cwd,
			env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		task.child = child;
		const append = (chunk: Buffer) => this.append(task, clean(chunk.toString("utf8")));
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => {
			this.append(task, `\n${error.message}\n`);
			this.finish(task, "failed", null);
		});
		child.on("exit", (code, signal) => {
			if (task.status !== "running") return;
			this.finish(task, signal ? "stopped" : code === 0 ? "exited" : "failed", code);
		});
		this.announce();
		return summary(task);
	}

	/** Stops a running task and everything it started. */
	stop(id: string): TaskSummary {
		const task = this.get(id);
		if (task.status !== "running" || !task.child) return summary(task);
		const child = task.child;
		this.signal(child, "SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) this.signal(child, "SIGKILL");
		}, KILL_AFTER_MS).unref();
		this.finish(task, "stopped", null);
		return summary(task);
	}

	/** Runs a finished task's command again, as a new task. */
	restart(id: string): TaskSummary {
		const task = this.get(id);
		if (task.status === "running") this.stop(id);
		return this.start({ command: task.command, cwd: task.cwd, name: task.name, by: "user" });
	}

	remove(id: string): void {
		const task = this.get(id);
		if (task.status === "running") this.stop(id);
		this.tasks.delete(id);
		this.announce();
	}

	clearFinished(): void {
		for (const [id, task] of this.tasks) if (task.status !== "running") this.tasks.delete(id);
		this.announce();
	}

	/**
	 * Waits until the task's output after `since` matches `pattern` (a case-insensitive regex, or plain text when it is
	 * not a valid one), the task ends, `timeoutMs` passes, or, with `quietMs`, the task has printed something after
	 * `since` and then nothing for `quietMs`. A dev server that is up goes quiet, so a pattern that never shows up (the
	 * agent guessed the wrong ready message) does not hold the chat until the timeout.
	 */
	async wait(
		id: string,
		options: { since: number; pattern?: string; timeoutMs: number; quietMs?: number },
	): Promise<{ matched: boolean; timedOut: boolean; quiet: boolean }> {
		const task = this.get(id);
		let regex: RegExp | undefined;
		if (options.pattern) {
			try {
				regex = new RegExp(options.pattern, "i");
			} catch {
				regex = new RegExp(options.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
			}
		}
		const matches = () => Boolean(regex?.test(this.output(id, options.since).text));
		if (matches()) return { matched: true, timedOut: false, quiet: false };
		if (task.status !== "running") return { matched: false, timedOut: false, quiet: false };
		return await new Promise((resolve) => {
			const check = () => {
				if (matches()) done({ matched: true, timedOut: false, quiet: false });
				else if (task.status !== "running") done({ matched: false, timedOut: false, quiet: false });
			};
			const timer = setTimeout(() => done({ matched: false, timedOut: true, quiet: false }), Math.min(Math.max(options.timeoutMs, 0), MAX_WAIT_MS));
			const quietMs = options.quietMs;
			const idle = quietMs
				? setInterval(() => {
						if (task.written > options.since && Date.now() - task.lastOutputAt >= quietMs) done({ matched: false, timedOut: false, quiet: true });
					}, 500)
				: undefined;
			const done = (result: { matched: boolean; timedOut: boolean; quiet: boolean }) => {
				clearTimeout(timer);
				clearInterval(idle);
				task.waiters.delete(check);
				resolve(result);
			};
			task.waiters.add(check);
		});
	}

	/** Stops every running task, when the app quits. */
	stopAll(): void {
		for (const task of this.tasks.values()) if (task.status === "running" && task.child) this.signal(task.child, "SIGKILL");
	}

	private get(id: string): Task {
		const task = this.tasks.get(String(id));
		if (!task) throw new Error(`No background task ${id}. task_list shows them.`);
		return task;
	}

	private signal(child: ChildProcess, signal: NodeJS.Signals): void {
		try {
			// The negative pid targets the task's process group: the shell and everything it started.
			if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch {
			// Already gone.
		}
	}

	private append(task: Task, text: string): void {
		if (!text) return;
		task.written += text.length;
		task.lastOutputAt = Date.now();
		task.output = (task.output + text).slice(-OUTPUT_CAP);
		task.pending += text;
		for (const waiter of task.waiters) waiter();
		task.flushTimer ??= setTimeout(() => {
			task.flushTimer = undefined;
			const chunk = task.pending.slice(-OUTPUT_CAP);
			task.pending = "";
			this.hub.broadcast("task-output", { id: task.id, text: chunk, written: task.written });
		}, OUTPUT_FLUSH_MS);
	}

	private finish(task: Task, status: TaskStatus, exitCode: number | null): void {
		task.status = status;
		task.exitCode = exitCode;
		task.endedAt = Date.now();
		task.child = null;
		for (const waiter of task.waiters) waiter();
		this.announce();
	}

	private announce(): void {
		this.hub.broadcast("tasks", this.list());
	}
}

function summary(task: Task): TaskSummary {
	return {
		id: task.id,
		name: task.name,
		command: task.command,
		cwd: task.cwd,
		by: task.by,
		status: task.status,
		exitCode: task.exitCode,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		written: task.written,
	};
}
