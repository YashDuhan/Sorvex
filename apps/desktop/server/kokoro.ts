import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub.ts";
import { readLines, writeLine } from "./jsonl.ts";
import { appDir, kokoroDir } from "./paths.ts";

const KOKORO_VERSION = "1.2.1";

/**
 * Local Kokoro-82M text-to-speech. kokoro-js and its ONNX runtime are large (about 250MB), so they are
 * installed on demand into ~/.sorvex/agent/desktop/kokoro instead of the repository, and run in their own
 * process. Audio chunks stream to the UI as `kokoro` events keyed by stream id.
 */
export class Kokoro {
	private child: ChildProcessWithoutNullStreams | undefined;
	private installing = false;
	private nextId = 0;
	private readonly hub: Hub;

	constructor(hub: Hub) {
		this.hub = hub;
	}

	status() {
		return {
			installed: existsSync(join(kokoroDir, "node_modules/kokoro-js")),
			installing: this.installing,
			running: this.child !== undefined,
		};
	}

	install(): void {
		if (this.installing) return;
		this.installing = true;
		mkdirSync(kokoroDir, { recursive: true });
		copyFileSync(join(appDir, "server/kokoro-server.mjs"), join(kokoroDir, "kokoro-server.mjs"));
		if (!existsSync(join(kokoroDir, "package.json"))) {
			writeFileSync(join(kokoroDir, "package.json"), '{\n\t"private": true,\n\t"type": "module"\n}\n');
		}
		this.hub.broadcast("kokoro-install", { state: "running" });
		// Lifecycle scripts stay off: onnxruntime-node ships its CPU binaries in the package.
		execFile(
			"npm",
			["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", `kokoro-js@${KOKORO_VERSION}`],
			{ cwd: kokoroDir, maxBuffer: 16 * 1024 * 1024 },
			(error, _stdout, stderr) => {
				this.installing = false;
				this.hub.broadcast(
					"kokoro-install",
					error ? { state: "error", error: stderr.trim() || error.message } : { state: "done" },
				);
			},
		);
	}

	speak(text: string, voice: string, speed: number, dtype: string): string {
		const child = this.ensure();
		const id = `tts-${++this.nextId}`;
		writeLine(child, { id, type: "speak", text, voice, speed, dtype });
		return id;
	}

	abort(id: string): void {
		if (this.child) writeLine(this.child, { id, type: "abort" });
	}

	stop(): void {
		this.child?.stdin.end();
		this.child = undefined;
	}

	private ensure(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;
		if (!this.status().installed) throw new Error("Kokoro is not installed. Install it in Settings → Voice.");
		const child = spawn(process.execPath, [join(kokoroDir, "kokoro-server.mjs")], {
			cwd: kokoroDir,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child = child;
		readLines(child.stdout, (line) => {
			const record = JSON.parse(line) as { type: string; id?: string; audio?: string; success?: boolean; error?: string };
			if (record.type === "chunk") this.hub.broadcast("kokoro", { streamId: record.id, audio: record.audio });
			else if (record.type === "response") {
				this.hub.broadcast("kokoro", { streamId: record.id, done: true, error: record.success ? undefined : record.error });
			}
		});
		readLines(child.stderr, (line) => console.error(`[kokoro] ${line}`));
		child.on("exit", () => {
			if (this.child === child) this.child = undefined;
		});
		return child;
	}
}
