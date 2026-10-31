import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, freemem, platform, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { LlamaClient, type LlamaModelInfo } from "@sorvex/coding-agent/extensions/llama/client.js";
import { findHuggingFaceToken, HuggingFaceClient } from "@sorvex/coding-agent/extensions/llama/huggingface.js";
import type { Hub } from "./hub.ts";
import { desktopDir } from "./paths.ts";
import { readSettings, writeSettings } from "./settings.ts";

const run = promisify(execFile);

const PORT = Number(process.env.SORVEX_LLAMA_PORT ?? 4518);
/** The llama.cpp router the agent's built-in `llama.cpp` provider talks to (passed as LLAMA_BASE_URL). */
export const llamaUrl = `http://127.0.0.1:${PORT}`;
const llamaDir = join(desktopDir, "llama");
export const modelsDir = join(desktopDir, "models");
const installFile = join(llamaDir, "install.json");
const RELEASES = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=20";
const LOG_LINES = 400;

/** One prebuilt llama.cpp build for this platform. `extra` is a second archive unpacked alongside, e.g. CUDA runtime libraries. */
interface Variant {
	id: string;
	label: string;
	asset: RegExp;
	extra?: RegExp;
}

/** Prebuilt llama.cpp releases per platform, best first. Names follow the release assets, e.g. llama-b12020-bin-ubuntu-vulkan-x64.tar.gz. */
const VARIANTS: Record<string, Variant[]> = {
	"linux-x64": [
		{ id: "cuda", label: "NVIDIA (CUDA 12)", asset: /^llama-b\d+-bin-ubuntu-cuda-12\.\d+-x64\.tar\.gz$/, extra: /^cudart-llama-b\d+-bin-ubuntu-cuda-12\.\d+-x64\.tar\.gz$/ },
		{ id: "rocm", label: "AMD (ROCm)", asset: /^llama-b\d+-bin-ubuntu-rocm-[\d.]+-x64\.tar\.gz$/ },
		{ id: "vulkan", label: "Any GPU (Vulkan)", asset: /^llama-b\d+-bin-ubuntu-vulkan-x64\.tar\.gz$/ },
		{ id: "cpu", label: "CPU only", asset: /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/ },
	],
	"linux-arm64": [
		{ id: "vulkan", label: "Any GPU (Vulkan)", asset: /^llama-b\d+-bin-ubuntu-vulkan-arm64\.tar\.gz$/ },
		{ id: "cpu", label: "CPU only", asset: /^llama-b\d+-bin-ubuntu-arm64\.tar\.gz$/ },
	],
	"darwin-arm64": [{ id: "metal", label: "Apple Silicon (Metal)", asset: /^llama-b\d+-bin-macos-arm64\.tar\.gz$/ }],
	"darwin-x64": [{ id: "cpu", label: "Intel Mac", asset: /^llama-b\d+-bin-macos-x64\.tar\.gz$/ }],
	"win32-x64": [
		{ id: "cuda", label: "NVIDIA (CUDA 12)", asset: /^llama-b\d+-bin-win-cuda-12\.\d+-x64\.zip$/, extra: /^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/ },
		{ id: "vulkan", label: "Any GPU (Vulkan)", asset: /^llama-b\d+-bin-win-vulkan-x64\.zip$/ },
		{ id: "cpu", label: "CPU only", asset: /^llama-b\d+-bin-win-cpu-x64\.zip$/ },
	],
};

/** Small, tool-calling models that work as a coding agent, smallest first. Sizes are the Q4 download. */
export const RECOMMENDED = [
	{ repo: "unsloth/Qwen3-4B-Instruct-2507-GGUF", quant: "Q4_K_M", size: 2.5e9, note: "Fast on any laptop. Good tool calling for its size." },
	{ repo: "unsloth/Qwen3-8B-GGUF", quant: "Q4_K_M", size: 5.03e9, note: "Noticeably smarter; needs about 8 GB free." },
	{ repo: "unsloth/Qwen3.5-9B-GGUF", quant: "Q4_K_M", size: 5.68e9, note: "Newer Qwen; strong agent and coding skills." },
	{ repo: "ggml-org/gpt-oss-20b-GGUF", quant: "MXFP4", size: 12.11e9, note: "OpenAI gpt-oss 20B. Needs 16 GB+ of GPU or unified memory." },
	{ repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", quant: "Q4_K_M", size: 18.56e9, note: "Best local coder here; needs 24 GB+." },
];

export interface LocalSettings {
	contextSize: number;
	gpu: boolean;
	autoStart: boolean;
	variant?: string;
}

const DEFAULT_LOCAL: LocalSettings = { contextSize: 32768, gpu: true, autoStart: true };

interface Installed {
	tag: string;
	variant: string;
	binary: string;
}

export interface Hardware {
	os: string;
	arch: string;
	cpu: string;
	cores: number;
	ramTotal: number;
	ramFree: number;
	gpus: { name: string; vram?: number; kind: "nvidia" | "amd" | "intel" | "apple" | "other" }[];
	vulkan: boolean;
	recommended: string;
}

type ServerState = "stopped" | "starting" | "running" | "external" | "error";

/** A download the Downloads tray shows: the engine install or a model download. */
export interface DownloadTask {
	task: string;
	label: string;
	state: "running" | "done" | "failed";
	message: string;
	ratio?: number;
	/** Bytes so far and in total, when known, for speed and time left. */
	done?: number;
	total?: number;
	error?: string;
	startedAt: number;
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function findFile(dir: string, name: string): string | undefined {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isFile() && entry.name === name) return path;
		if (entry.isDirectory()) {
			const found = findFile(path, name);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Local models through llama.cpp: the app installs a prebuilt `llama-server` for this
 * machine's hardware, runs it in router mode on 127.0.0.1, and downloads GGUF models from Hugging Face into it. Sorvex's
 * built-in `llama.cpp` provider talks to that router (the agent starts with LLAMA_BASE_URL), so loaded models show up
 * in the model picker like any cloud model. Everything stays on this machine.
 */
export class LocalModels {
	private readonly hub: Hub;
	private child: ChildProcess | undefined;
	private state: ServerState = "stopped";
	private error: string | undefined;
	private logs: string[] = [];
	private installing: { message: string; ratio?: number } | undefined;
	private hardware: Hardware | undefined;
	private flags: string | undefined;
	private recovering = false;
	private readonly tasks = new Map<string, AbortController>();
	private readonly downloads = new Map<string, DownloadTask>();
	private downloadsTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(hub: Hub) {
		this.hub = hub;
	}

	settings(): LocalSettings {
		return { ...DEFAULT_LOCAL, ...((readSettings() as { local?: Partial<LocalSettings> }).local ?? {}) };
	}

	saveSettings(next: Partial<LocalSettings>): LocalSettings {
		const settings = { ...this.settings(), ...next };
		writeSettings({ ...readSettings(), local: settings });
		this.publish();
		return settings;
	}

	installed(): Installed | undefined {
		const installed = readJson<Installed>(installFile);
		return installed && existsSync(installed.binary) ? installed : undefined;
	}

	async detectHardware(): Promise<Hardware> {
		if (this.hardware) return this.hardware;
		const gpus: Hardware["gpus"] = [];
		const quiet = (command: string, args: string[]) => run(command, args, { timeout: 5000 }).then((r) => r.stdout, () => "");
		const nvidia = await quiet("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]);
		for (const line of nvidia.split("\n").filter(Boolean)) {
			const [name, memory] = line.split(",").map((part) => part.trim());
			gpus.push({ name: name!, vram: Number(memory) * 1024 * 1024, kind: "nvidia" });
		}
		if (platform() === "darwin" && arch() === "arm64") gpus.push({ name: "Apple Silicon GPU (unified memory)", kind: "apple" });
		if (platform() === "linux" && gpus.length === 0) {
			for (const line of (await quiet("lspci", [])).split("\n")) {
				if (!/VGA|3D|Display/.test(line)) continue;
				const name = line.replace(/^.*?: /, "").replace(/ \(rev .*\)$/, "");
				gpus.push({ name, kind: /NVIDIA/i.test(line) ? "nvidia" : /AMD|ATI|Radeon/i.test(line) ? "amd" : /Intel/i.test(line) ? "intel" : "other" });
			}
		}
		const vulkan =
			platform() === "win32" ||
			(platform() === "linux" && ((await quiet("vulkaninfo", ["--summary"])).includes("deviceName") || (await quiet("ldconfig", ["-p"])).includes("libvulkan.so.1")));
		const rocm = platform() === "linux" && (await quiet("rocminfo", [])).includes("gfx");
		const key = `${platform()}-${arch()}`;
		const options = (VARIANTS[key] ?? []).map((variant) => variant.id);
		const recommended =
			(options.includes("metal") && "metal") ||
			(gpus.some((gpu) => gpu.kind === "nvidia" && gpu.vram) && options.includes("cuda") && "cuda") ||
			(rocm && options.includes("rocm") && "rocm") ||
			(vulkan && gpus.length > 0 && options.includes("vulkan") && "vulkan") ||
			options.at(-1) ||
			"cpu";
		this.hardware = {
			os: platform(),
			arch: arch(),
			cpu: cpus()[0]?.model ?? "CPU",
			cores: cpus().length,
			ramTotal: totalmem(),
			ramFree: freemem(),
			gpus,
			vulkan,
			recommended,
		};
		return this.hardware;
	}

	async status() {
		const hardware = await this.detectHardware();
		return {
			url: llamaUrl,
			modelsDir,
			hardware: { ...hardware, ramFree: freemem() },
			variants: (VARIANTS[`${platform()}-${arch()}`] ?? []).map(({ id, label }) => ({ id, label })),
			installed: this.installed(),
			installing: this.installing,
			server: this.state,
			error: this.error,
			settings: this.settings(),
			recommended: RECOMMENDED,
		};
	}

	private publish(): void {
		void this.status().then((status) => this.hub.broadcast("local-status", status, "local-status"));
	}

	private progress(task: string, message: string, ratio?: number, bytes?: { done: number; total: number }): void {
		this.hub.broadcast("local-progress", { task, message, ratio });
		const download = this.downloads.get(task);
		if (!download || download.state !== "running") return;
		download.message = message;
		download.ratio = ratio;
		if (bytes) {
			download.done = bytes.done;
			download.total = bytes.total;
		} else if (ratio !== undefined && download.total) {
			download.done = ratio * download.total;
		}
		this.publishDownloads();
	}

	/** Sends the Downloads tray its list, at most 4 times a second; it is replayed to windows that open later. */
	private publishDownloads(now = false): void {
		const send = () => {
			this.downloadsTimer = undefined;
			this.hub.broadcast("local-downloads", [...this.downloads.values()], "local-downloads");
		};
		if (now) {
			clearTimeout(this.downloadsTimer);
			send();
		} else {
			this.downloadsTimer ??= setTimeout(send, 250);
		}
	}

	/** Runs `work` as a tracked download; a finished entry stays in the tray for a few seconds. */
	private async tracked<T>(task: string, label: string, total: number | undefined, work: () => Promise<T>): Promise<T> {
		const entry: DownloadTask = { task, label, state: "running", message: "Starting", total, startedAt: Date.now() };
		this.downloads.set(task, entry);
		this.publishDownloads(true);
		try {
			const result = await work();
			entry.state = "done";
			entry.message = "Done";
			entry.ratio = 1;
			return result;
		} catch (error) {
			entry.state = "failed";
			entry.error = error instanceof Error ? error.message : String(error);
			entry.message = /abort/i.test(entry.error) ? "Cancelled" : "Failed";
			throw error;
		} finally {
			this.publishDownloads(true);
			setTimeout(() => {
				if (this.downloads.get(task) === entry) {
					this.downloads.delete(task);
					this.publishDownloads(true);
				}
			}, entry.state === "done" ? 5000 : 12000);
		}
	}

	private log(line: string): void {
		this.logs.push(line);
		if (this.logs.length > LOG_LINES) this.logs.shift();
		this.hub.broadcast("local-log", { line });
	}

	recentLogs(): string[] {
		return this.logs;
	}

	/** Downloads and unpacks the newest prebuilt `llama-server` for `variantId` (default: the one this hardware suits). */
	async install(variantId?: string): Promise<void> {
		if (this.installing) throw new Error("An install is already running");
		return this.tracked("install", "llama.cpp engine", undefined, () => this.installNow(variantId));
	}

	private async installNow(variantId?: string): Promise<void> {
		const hardware = await this.detectHardware();
		const variants = VARIANTS[`${platform()}-${arch()}`] ?? [];
		const variant = variants.find((candidate) => candidate.id === (variantId ?? hardware.recommended)) ?? variants.at(-1);
		if (!variant) throw new Error(`No prebuilt llama.cpp for ${platform()}-${arch()}. Build it yourself and point SORVEX_LLAMA_SERVER at llama-server.`);
		this.installing = { message: "Finding the latest llama.cpp release" };
		this.publish();
		try {
			const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json" } });
			if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
			const releases = (await response.json()) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] }[];
			const release = releases.find((candidate) => candidate.assets.some((asset) => variant.asset.test(asset.name)));
			if (!release) throw new Error(`No recent release has a ${variant.label} build`);
			const assets = [variant.asset, variant.extra]
				.filter((pattern): pattern is RegExp => Boolean(pattern))
				.map((pattern) => release.assets.find((asset) => pattern.test(asset.name)))
				.filter((asset): asset is (typeof release.assets)[number] => Boolean(asset));
			const target = join(llamaDir, `${release.tag_name}-${variant.id}`);
			rmSync(target, { recursive: true, force: true });
			mkdirSync(target, { recursive: true });
			for (const asset of assets) {
				const archive = join(llamaDir, asset.name);
				await this.fetchFile(asset.browser_download_url, archive, asset.size, `Downloading ${asset.name}`);
				this.installing = { message: `Unpacking ${asset.name}` };
				this.progress("install", `Unpacking ${asset.name}`);
				this.publish();
				// tar reads .tar.gz everywhere and .zip on Windows 10+ (bsdtar).
				await run("tar", ["-xf", archive, "-C", target], { timeout: 120_000 });
				rmSync(archive, { force: true });
			}
			const binary = findFile(target, platform() === "win32" ? "llama-server.exe" : "llama-server");
			if (!binary) throw new Error("The download did not contain llama-server");
			if (platform() !== "win32") await run("chmod", ["755", binary]);
			// Remove older installs; the new one replaces them.
			for (const entry of readdirSync(llamaDir, { withFileTypes: true })) {
				if (entry.isDirectory() && join(llamaDir, entry.name) !== target) rmSync(join(llamaDir, entry.name), { recursive: true, force: true });
			}
			writeFileSync(installFile, JSON.stringify({ tag: release.tag_name, variant: variant.id, binary } satisfies Installed, null, "\t"));
			this.flags = undefined;
			this.saveSettings({ variant: variant.id });
			this.installing = undefined;
			this.log(`[sorvex] installed llama.cpp ${release.tag_name} (${variant.label})`);
			if (this.state === "running") await this.restart();
		} catch (error) {
			this.installing = undefined;
			this.publish();
			throw error;
		}
		this.publish();
	}

	private async fetchFile(url: string, path: string, total: number, message: string): Promise<void> {
		mkdirSync(dirname(path), { recursive: true });
		const response = await fetch(url);
		if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
		let done = 0;
		let last = 0;
		const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
		body.on("data", (chunk: Buffer) => {
			done += chunk.length;
			if (Date.now() - last > 250) {
				last = Date.now();
				this.installing = { message, ratio: total ? done / total : undefined };
				this.progress("install", message, total ? done / total : undefined, { done, total });
				this.publish();
			}
		});
		await pipeline(body, createWriteStream(path));
	}

	/** Options this llama-server build understands, read from --help once, so older or newer builds get only valid flags. */
	private async supported(binary: string): Promise<string> {
		this.flags ??= await run(binary, ["--help"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: this.libraryEnv(binary) }).then(
			(r) => r.stdout + r.stderr,
			(error: { stdout?: string; stderr?: string }) => `${error.stdout ?? ""}${error.stderr ?? ""}`,
		);
		return this.flags;
	}

	private libraryEnv(binary: string): NodeJS.ProcessEnv {
		const dir = dirname(binary);
		if (platform() === "linux") return { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") };
		if (platform() === "darwin") return { ...process.env, DYLD_LIBRARY_PATH: [dir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(":") };
		return { ...process.env, PATH: [dir, process.env.PATH].filter(Boolean).join(";") };
	}

	private async reachable(): Promise<boolean> {
		try {
			return (await fetch(`${llamaUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok;
		} catch {
			return false;
		}
	}

	/** Starts the router. If something already serves llama.cpp on the port (e.g. the user's own server), uses that instead. */
	async start(): Promise<void> {
		// A second caller (e.g. two downloads clicked together) waits for the start already in progress.
		while (this.state === "starting") await new Promise((resolve) => setTimeout(resolve, 300));
		if (this.child) return;
		if (await this.reachable()) {
			this.state = "external";
			this.error = undefined;
			this.log(`[sorvex] using the llama.cpp server already running at ${llamaUrl}`);
			this.publish();
			return;
		}
		const binary = process.env.SORVEX_LLAMA_SERVER || this.installed()?.binary;
		if (!binary) throw new Error("llama.cpp is not installed yet");
		const settings = this.settings();
		const help = await this.supported(binary);
		mkdirSync(modelsDir, { recursive: true });
		const args = ["--host", "127.0.0.1", "--port", String(PORT), "--models-dir", modelsDir, "--jinja", "-c", String(settings.contextSize)];
		args.push("-ngl", settings.gpu ? "999" : "0");
		// llama.cpp counts only performance cores on hybrid CPUs (2 threads on an i5-1230U with 10 cores), which makes
		// CPU generation several times slower. Use all but two logical CPUs, leaving room for the app and the system.
		if (help.includes("--threads")) args.push("--threads", String(Math.max(2, cpus().length - 2)));
		// Integrated GPUs (Intel Iris/UHD) are reset by their driver when one GPU job runs too long, which kills the
		// engine mid-reply ("ErrorDeviceLost"). Reading the prompt in small chunks keeps each job short.
		const integrated = (await this.detectHardware()).gpus.every((gpu) => !gpu.vram && gpu.kind !== "apple");
		if (settings.gpu && integrated && help.includes("--ubatch-size")) args.push("--ubatch-size", "128");
		// Keep one model in memory: selecting another unloads the last instead of running out of RAM.
		if (help.includes("--models-max")) args.push("--models-max", "1");
		this.state = "starting";
		this.error = undefined;
		this.log(`[sorvex] ${binary} ${args.join(" ")}`);
		this.publish();
		const child = spawn(binary, args, { env: this.libraryEnv(binary), stdio: ["ignore", "pipe", "pipe"] });
		this.child = child;
		let pending = "";
		const onData = (chunk: Buffer) => {
			pending += chunk.toString("utf8");
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.trim()) continue;
				this.log(line);
				if (/ErrorDeviceLost|DeviceLostError|GPU hang/i.test(line)) this.onGpuCrash();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", (error) => {
			this.error = error.message;
			this.state = "error";
			this.publish();
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			if (this.state !== "stopped") {
				this.state = "error";
				this.error = `llama-server exited (${signal ?? `code ${code}`}). ${this.logs.slice(-3).join(" ")}`.trim();
			}
			this.publish();
		});
		for (let attempt = 0; attempt < 120 && this.child === child; attempt++) {
			if (await this.reachable()) {
				this.state = "running";
				this.publish();
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		if (this.child === child) {
			this.stop();
			this.state = "error";
			this.error = "llama-server did not start within 60 seconds";
			this.publish();
		}
	}

	/**
	 * The GPU driver reset the engine's GPU work (seen on Intel integrated graphics). Switch to the CPU, which is
	 * reliable everywhere, restart, and tell the user; they can turn the GPU back on in Local models.
	 */
	private onGpuCrash(): void {
		if (this.recovering || !this.settings().gpu) return;
		this.recovering = true;
		this.log("[sorvex] the GPU driver reset the engine; switching to CPU and restarting");
		this.hub.broadcast("local-error", {
			message: "The GPU crashed while running the model (the graphics driver reset it). Switched local models to the CPU and restarted the engine. Send your message again. You can turn the GPU back on in Local models.",
		});
		this.saveSettings({ gpu: false });
		void this.restart().finally(() => {
			this.recovering = false;
		});
	}

	stop(): void {
		const child = this.child;
		this.state = "stopped";
		this.child = undefined;
		child?.kill("SIGTERM");
		this.publish();
	}

	async restart(): Promise<void> {
		this.stop();
		await new Promise((resolve) => setTimeout(resolve, 800));
		await this.start();
	}

	/** Starts the router on app launch when it is installed and auto-start is on. */
	async autoStart(): Promise<void> {
		if (this.settings().autoStart && (this.installed() || process.env.SORVEX_LLAMA_SERVER)) await this.start().catch((error: unknown) => this.log(`[sorvex] auto-start failed: ${String(error)}`));
	}

	private client(): LlamaClient {
		if (this.state !== "running" && this.state !== "external") throw new Error("Start the local engine first");
		return new LlamaClient(llamaUrl);
	}

	/**
	 * Models the router knows: GGUF files in the models folder and models downloaded from Hugging Face. A loaded
	 * model also gets `tools`: whether its chat template supports tool calls. Without it (e.g. Gemma 3) the model
	 * writes tool calls as plain text that never run, so it can chat but cannot work as an agent.
	 */
	async models(): Promise<{ models: (LlamaModelInfo & { tools?: boolean })[] }> {
		if (this.state !== "running" && this.state !== "external") return { models: [] };
		const client = this.client();
		const models = await client.list({ reload: true });
		return {
			models: await Promise.all(
				models.map(async (model) => {
					if (model.status.value !== "loaded") return model;
					const props = await client.props({ model: model.id }).catch(() => undefined);
					const template = props?.chat_template;
					return typeof template === "string" ? { ...model, tools: /\btools?\b/.test(template) } : model;
				}),
			),
		};
	}

	async load(model: string): Promise<void> {
		await this.ensureRunning(`load:${model}`);
		const controller = new AbortController();
		this.tasks.set(`load:${model}`, controller);
		try {
			await this.client().loadAndWait(model, (progress) => this.progress(`load:${model}`, progress.message, progress.ratio), controller.signal);
		} finally {
			this.tasks.delete(`load:${model}`);
		}
	}

	/**
	 * What the engine is doing for each request in flight, from llama-server's /slots: prompt tokens read so far
	 * (local models read the whole agent prompt before the first word, which takes a while on small GPUs) and
	 * tokens written. Empty when nothing is running.
	 */
	async activity(): Promise<{ model: string; prompt: number; processed: number; cached: number; decoded: number }[]> {
		if (!this.up()) return [];
		const loaded = (await this.client().list()).filter((model) => model.status.value === "loaded");
		const busy = await Promise.all(
			loaded.map(async (model) => {
				const response = await fetch(`${llamaUrl}/slots?${new URLSearchParams({ model: model.id })}`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
				if (!response?.ok) return [];
				const slots = (await response.json().catch(() => [])) as {
					is_processing?: boolean;
					n_prompt_tokens?: number;
					n_prompt_tokens_processed?: number;
					n_prompt_tokens_cache?: number;
					next_token?: { n_decoded?: number }[];
				}[];
				return (Array.isArray(slots) ? slots : [])
					.filter((slot) => slot.is_processing)
					.map((slot) => ({
						model: model.id,
						prompt: slot.n_prompt_tokens ?? 0,
						processed: slot.n_prompt_tokens_processed ?? 0,
						cached: slot.n_prompt_tokens_cache ?? 0,
						decoded: slot.next_token?.[0]?.n_decoded ?? 0,
					}));
			}),
		);
		return busy.flat();
	}

	async unload(model: string): Promise<void> {
		await this.client().unloadAndWait(model);
	}

	/**
	 * Deletes a downloaded model, or the partial files of an interrupted download, through the router (which owns its
	 * cache). A loaded model is unloaded first. GGUF files the user put in the models folder are not removable here.
	 */
	async remove(model: string): Promise<void> {
		const client = this.client();
		const entry = (await client.list()).find((candidate) => candidate.id === model);
		if (!entry) throw new Error(`${model} is not in the engine's list`);
		if ((entry as { can_remove?: boolean }).can_remove === false) throw new Error(`${model} is a file in your models folder; delete it there`);
		if (entry.status.value === "loaded" || entry.status.value === "sleeping") await client.unloadAndWait(model);
		this.cancel(`download:${model}`);
		const response = await fetch(`${llamaUrl}/models?${new URLSearchParams({ model })}`, { method: "DELETE" });
		if (!response.ok) {
			const payload = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
			throw new Error(payload?.error?.message ?? `Delete failed: HTTP ${response.status}`);
		}
	}

	/**
	 * Makes the engine usable: installs the build this hardware suits if nothing is installed, then starts it. Lets
	 * "Download" or "Use in chat" work from a fresh install with one click.
	 */
	private up(): boolean {
		return this.state === "running" || this.state === "external";
	}

	async ensureRunning(task: string): Promise<void> {
		if (this.up()) return;
		if (!this.installed() && !process.env.SORVEX_LLAMA_SERVER && !(await this.reachable())) {
			this.progress(task, "Installing the llama.cpp engine first");
			await this.install();
		}
		this.progress(task, "Starting the engine");
		await this.start();
		if (!this.up()) throw new Error(this.error ?? "The engine did not start");
	}

	/** Downloads `owner/repo:QUANT` from Hugging Face through the router, which stores it in llama.cpp's cache. */
	async download(model: string, size?: number): Promise<void> {
		const task = `download:${model}`;
		await this.tracked(task, model, size, async () => {
			await this.ensureRunning(task);
			const controller = new AbortController();
			this.tasks.set(task, controller);
			try {
				await this.client().downloadAndWait(model, (progress) => this.progress(task, progress.message, progress.ratio), controller.signal);
			} finally {
				this.tasks.delete(task);
			}
		});
	}

	downloadList(): DownloadTask[] {
		return [...this.downloads.values()];
	}

	cancel(task: string): void {
		this.tasks.get(task)?.abort();
	}

	async search(query: string) {
		const client = new HuggingFaceClient(await findHuggingFaceToken());
		return { results: await client.search(query.trim()) };
	}

	async details(repo: string) {
		const client = new HuggingFaceClient(await findHuggingFaceToken());
		return client.details(repo);
	}
}
