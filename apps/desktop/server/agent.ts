import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import type { Hub } from "./hub.ts";
import { readLines, writeLine } from "./jsonl.ts";
import { bridgeExtension, cliPath, hasSourceCheckout, resolverUrl, settingsPath } from "./paths.ts";

export type AgentStatus = "stopped" | "starting" | "ready" | "exited" | "error";

/** Extension dialogs that wait for an answer; tool approvals are `select` dialogs. */
const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
/** Title the bridge extension uses for tool approvals (extension/gui-bridge.ts). */
const APPROVAL_TITLE = "sorvex-gui:approval";

export interface PendingDialog {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	timeout?: number;
	[key: string]: unknown;
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

/**
 * The single `sorvex --mode rpc` child. Responses are matched to requests by id; every other stdout record is
 * broadcast to the UI as an `agent` event. Restarting replaces the child, and records from an old child are
 * dropped because each listener checks that its child is still current.
 */
export class Agent {
	status: AgentStatus = "stopped";
	cwd = "";
	launcher = "";
	error: string | undefined;
	private child: ChildProcessWithoutNullStreams | undefined;
	private pending = new Map<string, Pending>();
	private nextId = 0;
	/**
	 * Dialogs still waiting for an answer, so a window or phone that connects mid-run can show them. Every answer,
	 * from any window, broadcasts `dialog-resolved` so the others close theirs.
	 */
	private dialogs = new Map<string, PendingDialog>();
	private readonly hub: Hub;
	/** Extra environment for the agent process, e.g. the SSH tool token. */
	private readonly env: Record<string, string>;

	constructor(hub: Hub, env: Record<string, string> = {}) {
		this.hub = hub;
		this.env = env;
	}

	snapshot() {
		return { status: this.status, cwd: this.cwd, launcher: this.launcher, error: this.error };
	}

	pendingDialogs(): PendingDialog[] {
		return [...this.dialogs.values()];
	}

	/**
	 * Records the folder after `switch_session` resumed a session from another folder: Sorvex rebuilds the session in
	 * that session's own folder without restarting, and the Files, Changes and Terminal panes follow `cwd`.
	 */
	setCwd(cwd: string): void {
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
		this.cwd = cwd;
	}

	start(cwd: string): { launcher: string; cwd: string } {
		this.stop();
		if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);

		const args = ["--mode", "rpc"];
		if (existsSync(bridgeExtension)) args.push("--extension", bridgeExtension);
		const bin = process.env.SORVEX_DESKTOP_BIN;
		const [command, commandArgs] = bin
			? [bin, args]
			: hasSourceCheckout
				? [process.execPath, ["--import", resolverUrl, cliPath, ...args]]
				: ["sorvex", args];

		this.hub.clearSticky();
		this.clearDialogs(() => true);
		this.cwd = cwd;
		this.launcher = `${command === process.execPath ? "node" : command} ${commandArgs.join(" ")}`;
		this.error = undefined;
		this.setStatus("starting");

		const child = spawn(command, commandArgs, {
			cwd,
			env: { ...process.env, ...this.env, SORVEX_DESKTOP_SETTINGS: settingsPath },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;

		readLines(child.stdout, (line) => {
			if (this.child === child) this.onLine(line);
		});
		readLines(child.stderr, (line) => {
			if (this.child === child) this.hub.broadcast("agent-stderr", { line });
		});
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.error = `Failed to start Sorvex (${this.launcher}): ${error.message}`;
			this.rejectAll(this.error);
			this.setStatus("error");
		});
		child.on("exit", (code) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.error = `Sorvex exited (code ${code ?? "?"})`;
			this.rejectAll(this.error);
			this.clearDialogs(() => true);
			this.setStatus("exited");
		});

		this.setStatus("ready");
		return { launcher: this.launcher, cwd };
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.rejectAll("Sorvex stopped");
		if (!child) return;
		// Closing stdin asks Sorvex to shut down; the kill covers a process that ignores it.
		child.stdin.end();
		setTimeout(() => child.kill(), 2000).unref();
	}

	request<T = unknown>(command: Record<string, unknown> & { type: string }): Promise<T> {
		const child = this.child;
		if (!child) return Promise.reject(new Error("Sorvex is not running"));
		const id = `srv-${++this.nextId}`;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject });
			writeLine(child, { ...command, id });
		});
	}

	/** Answers an extension UI request (dialogs and tool approvals). These get no response record. */
	respond(response: Record<string, unknown>): void {
		if (!this.child) throw new Error("Sorvex is not running");
		writeLine(this.child, response);
		const id = String(response.id);
		if (this.dialogs.delete(id)) this.hub.broadcast("dialog-resolved", { id });
	}

	private onLine(line: string): void {
		let record: { type?: string; id?: string; success?: boolean; data?: unknown; error?: string; command?: string };
		try {
			record = JSON.parse(line);
		} catch {
			this.hub.broadcast("agent-stderr", { line });
			return;
		}
		if (record.type === "response" && record.id && this.pending.has(record.id)) {
			const pending = this.pending.get(record.id)!;
			this.pending.delete(record.id);
			if (record.success) pending.resolve(record.data);
			else pending.reject(new Error(record.error ?? `${record.command} failed`));
			return;
		}
		this.trackDialog(record as PendingDialog);
		// Status, widgets and the tool list are announced once; keep the latest so a window that connects or
		// reconnects later (for example while the server was still starting) still gets them.
		const ui = record as { type?: string; method?: string; statusKey?: string; widgetKey?: string };
		const sticky =
			ui.type === "extension_ui_request" && (ui.method === "setStatus" || ui.method === "setWidget")
				? `${ui.method}:${ui.statusKey ?? ui.widgetKey}`
				: undefined;
		this.hub.broadcast("agent", record, sticky);
	}

	private trackDialog(record: PendingDialog): void {
		if (record.type === "extension_ui_request" && DIALOG_METHODS.has(record.method)) {
			const id = record.id;
			this.dialogs.set(id, record);
			// Sorvex cancels a dialog with a timeout by itself and sends nothing, so drop it then too.
			if (record.timeout) {
				setTimeout(() => {
					if (this.dialogs.delete(id)) this.hub.broadcast("dialog-resolved", { id });
				}, record.timeout).unref();
			}
		} else if ((record as { type?: string }).type === "agent_settled") {
			// An aborted run cancels its open approvals without a record, like the GUI's own reducer assumes.
			this.clearDialogs((dialog) => dialog.title === APPROVAL_TITLE);
		}
	}

	private clearDialogs(match: (dialog: PendingDialog) => boolean): void {
		for (const [id, dialog] of this.dialogs) {
			if (!match(dialog)) continue;
			this.dialogs.delete(id);
			this.hub.broadcast("dialog-resolved", { id });
		}
	}

	private rejectAll(reason: string): void {
		for (const pending of this.pending.values()) pending.reject(new Error(reason));
		this.pending.clear();
	}

	private setStatus(status: AgentStatus): void {
		this.status = status;
		this.hub.broadcast("agent-status", this.snapshot());
	}
}
