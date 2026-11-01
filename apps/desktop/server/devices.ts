import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, platform as osPlatform, arch as osArch } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Hub } from "./hub.ts";
import { desktopDir } from "./paths.ts";

/**
 * Android emulators for the Device pane, the way t3code does it:
 *
 *   - Finds the Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT, the Android Studio default). When parts are missing it
 *     installs them after the user accepts Google's license in the pane: a JDK if there is no Java 17+, the SDK
 *     command-line tools, platform-tools, the emulator, a Google APIs system image, and one virtual device.
 *   - Installs Expo Device Hub (expo-device-hub on npm) on first use into ~/.sorvex/agent/desktop/tools and runs it on
 *     127.0.0.1 with a session token. The pane shows its H.264 stream and sends input over its socket; settings,
 *     screenshots and metrics go through this server with the token.
 *   - Gives the agent device_* tools over adb (screenshot, UI tree with refs, tap, swipe, type, keys, apps, logcat).
 */

const HUB_PACKAGE = "expo-device-hub";
const HUB_VERSION = "0.19.1";
const REPOSITORY = "https://dl.google.com/android/repository/";
const AVD_NAME = "Sorvex_Pixel";
const MIN_JAVA = 17;

const toolsDir = join(desktopDir, "tools");
const androidDir = join(desktopDir, "android");
const hubDir = join(toolsDir, HUB_PACKAGE, HUB_VERSION);
const hubEntry = join(hubDir, "node_modules", HUB_PACKAGE, "dist", "server", "cli.mjs");
const hubSentinel = join(hubDir, ".install-complete");
/** The running hub's pid, so a server that exited without cleaning up does not leave it behind. */
const hubPidFile = join(desktopDir, "device-hub", "hub.pid");

const host = osPlatform();
const exe = (name: string) => (host === "win32" ? `${name}.exe` : name);
const script = (name: string) => (host === "win32" ? `${name}.bat` : name);

export interface Sdk {
	root: string | null;
	adb: string | null;
	emulator: string | null;
	sdkmanager: string | null;
	avdmanager: string | null;
	systemImages: string[];
}

export interface SetupState {
	running: boolean;
	step: string;
	message: string;
	percent: number | null;
	error: string | null;
	log: string[];
}

export interface DeviceStatus {
	sdk: Sdk;
	java: { path: string; version: number } | null;
	kvm: { ok: boolean; message?: string };
	avds: string[];
	missing: string[];
	ready: boolean;
	setup: SetupState;
	hub: { installed: boolean; running: boolean; starting: boolean; port: number | null; token: string | null; error: string | null };
}

export interface AvdInfo {
	name: string;
	displayName: string;
	api: number | null;
	version: string | null;
	device: string | null;
	/** adb serial while it runs. */
	serial: string | null;
}

export interface SystemImage {
	path: string;
	api: number;
	version: string;
	tag: string;
	abi: string;
}

const ANDROID_VERSIONS: Record<number, string> = {
	21: "5.0",
	22: "5.1",
	23: "6.0",
	24: "7.0",
	25: "7.1",
	26: "8.0",
	27: "8.1",
	28: "9",
	29: "10",
	30: "11",
	31: "12",
	32: "12L",
	33: "13",
	34: "14",
	35: "15",
	36: "16",
	37: "17",
};

const androidVersion = (api: number) => `Android ${ANDROID_VERSIONS[api] ?? `API ${api}`}`;

function describeImage(path: string): SystemImage {
	const [, platform = "", tag = "", abi = ""] = path.split(";");
	const api = Number(/android-(\d+)/.exec(platform)?.[1] ?? 0);
	return { path, api, version: androidVersion(api), tag, abi };
}

function avdHome(): string {
	if (process.env.ANDROID_AVD_HOME) return process.env.ANDROID_AVD_HOME;
	if (process.env.ANDROID_USER_HOME) return join(process.env.ANDROID_USER_HOME, "avd");
	return join(homedir(), ".android", "avd");
}

/** The AVD's config.ini as key/value pairs, merged over its <name>.ini. */
function readAvdConfig(name: string): Record<string, string> {
	const parse = (file: string) => {
		const entries: Record<string, string> = {};
		try {
			for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
				const at = line.indexOf("=");
				if (at > 0) entries[line.slice(0, at).trim()] = line.slice(at + 1).trim();
			}
		} catch {
			// Missing or unreadable: no details.
		}
		return entries;
	};
	const ini = parse(join(avdHome(), `${name}.ini`));
	const dir = ini.path && existsSync(ini.path) ? ini.path : join(avdHome(), `${name}.avd`);
	return { ...ini, ...parse(join(dir, "config.ini")) };
}

interface AccessibilityNode {
	text: string;
	contentDescription: string;
	resourceId: string;
	className: string;
	packageName: string;
	clickable: boolean;
	enabled: boolean;
	bounds: { left: number; top: number; right: number; bottom: number };
}

interface AccessibilitySnapshot {
	screen?: { width: number; height: number };
	nodes: AccessibilityNode[];
}

export interface DeviceElement {
	/** Fractions of the screen, 0 to 1. */
	rect: { x: number; y: number; width: number; height: number };
	label: string;
	className: string;
	text: string;
	contentDescription: string;
	resourceId: string;
	packageName: string;
	clickable: boolean;
	enabled: boolean;
	/** Device pixels. */
	bounds: { left: number; top: number; right: number; bottom: number };
	screen: { width: number; height: number };
	/** Text of elements on the same row, for context. */
	nearby: string[];
}

export type DeviceAction =
	| { action: "devices" }
	| { action: "boot"; avd?: string }
	| { action: "screenshot"; serial?: string }
	| { action: "ui"; serial?: string }
	| { action: "tap"; serial?: string; ref?: number; x?: number; y?: number; long?: boolean }
	| { action: "swipe"; serial?: string; x1?: number; y1?: number; x2?: number; y2?: number; direction?: string; ms?: number }
	| { action: "type"; serial?: string; text: string; ref?: number; submit?: boolean }
	| { action: "key"; serial?: string; key: string }
	| { action: "launch"; serial?: string; package: string }
	| { action: "open_url"; serial?: string; url: string }
	| { action: "install"; serial?: string; path: string }
	| { action: "apps"; serial?: string }
	| { action: "logcat"; serial?: string; lines?: number; filter?: string }
	| { action: "wait"; serial?: string; ms?: number; text?: string; timeoutMs?: number };

interface RunResult {
	code: number | null;
	stdout: Buffer;
	stderr: string;
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; timeout?: number; onData?: (text: string) => void } = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const out: Buffer[] = [];
		let err = "";
		const timer = options.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined;
		child.stdout.on("data", (chunk: Buffer) => {
			out.push(chunk);
			options.onData?.(chunk.toString("utf8"));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			err += chunk.toString("utf8");
			options.onData?.(chunk.toString("utf8"));
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out), stderr: err });
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

async function check(command: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<string> {
	const result = await run(command, args, options);
	if (result.code !== 0) throw new Error(`${command.split(/[\\/]/).pop()} ${args[0] ?? ""} failed: ${(result.stderr || result.stdout.toString()).trim().slice(-600)}`);
	return result.stdout.toString("utf8");
}

const file = (path: string) => (existsSync(path) ? path : null);

function onPath(name: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	return null;
}

function defaultSdkRoot(): string {
	if (host === "darwin") return join(homedir(), "Library", "Android", "sdk");
	if (host === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Android", "Sdk");
	return join(homedir(), "Android", "Sdk");
}

function inspectSdk(root: string): Sdk {
	const cmdline = ["latest", ...(existsSync(join(root, "cmdline-tools")) ? readdirSync(join(root, "cmdline-tools")).filter((name) => name !== "latest") : [])]
		.map((version) => join(root, "cmdline-tools", version, "bin"))
		.find((bin) => existsSync(join(bin, script("sdkmanager"))));
	const imagesDir = join(root, "system-images");
	const systemImages: string[] = [];
	if (existsSync(imagesDir)) {
		for (const api of readdirSync(imagesDir)) {
			for (const tag of safeList(join(imagesDir, api))) {
				for (const abi of safeList(join(imagesDir, api, tag))) systemImages.push(`system-images;${api};${tag};${abi}`);
			}
		}
	}
	return {
		root,
		adb: file(join(root, "platform-tools", exe("adb"))),
		emulator: file(join(root, "emulator", exe("emulator"))),
		sdkmanager: cmdline ? join(cmdline, script("sdkmanager")) : null,
		avdmanager: cmdline ? file(join(cmdline, script("avdmanager"))) : null,
		systemImages,
	};
}

function safeList(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
	} catch {
		return [];
	}
}

/** The first candidate that looks like an SDK; otherwise the directory a fresh install goes to. */
function findSdk(): Sdk {
	const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, defaultSdkRoot()].filter((dir): dir is string => Boolean(dir?.trim()));
	const adb = onPath(exe("adb"));
	if (adb) candidates.push(dirname(dirname(adb)));
	for (const root of candidates) {
		const sdk = inspectSdk(root);
		if (sdk.adb || sdk.emulator || sdk.sdkmanager) return sdk;
	}
	return { root: null, adb: null, emulator: null, sdkmanager: null, avdmanager: null, systemImages: [] };
}

async function javaVersion(java: string): Promise<number | null> {
	try {
		const result = await run(java, ["-version"], { timeout: 10000 });
		const match = /version "(\d+)(?:\.(\d+))?/.exec(result.stderr + result.stdout.toString());
		if (!match) return null;
		const major = Number(match[1]);
		return major === 1 ? Number(match[2]) : major;
	} catch {
		return null;
	}
}

/** Java 17+ for the SDK tools: JAVA_HOME, then PATH, then a JDK this app installed. */
async function findJava(): Promise<{ path: string; version: number } | null> {
	const managed = findJavaIn(join(androidDir, "jdk"));
	const candidates = [process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", exe("java")) : null, onPath(exe("java")), managed];
	for (const path of candidates) {
		if (!path || !existsSync(path)) continue;
		const version = await javaVersion(path);
		if (version && version >= MIN_JAVA) return { path, version };
	}
	return null;
}

function findJavaIn(dir: string): string | null {
	for (const name of safeList(dir)) {
		for (const bin of [join(dir, name, "bin"), join(dir, name, "Contents", "Home", "bin")]) {
			if (existsSync(join(bin, exe("java")))) return join(bin, exe("java"));
		}
	}
	return null;
}

function kvmStatus(): { ok: boolean; message?: string } {
	if (host !== "linux") return { ok: true };
	if (!existsSync("/dev/kvm")) return { ok: false, message: "/dev/kvm is missing. Enable virtualization (VT-x or AMD-V) in the BIOS; the emulator is very slow without it." };
	try {
		accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
		return { ok: true };
	} catch {
		return { ok: false, message: "No permission for /dev/kvm. Add yourself to the kvm group (sudo usermod -aG kvm $USER) and log in again." };
	}
}

function sdkEnv(sdk: Sdk, java: { path: string } | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (sdk.root) {
		env.ANDROID_HOME = sdk.root;
		env.ANDROID_SDK_ROOT = sdk.root;
		env.PATH = [join(sdk.root, "platform-tools"), join(sdk.root, "emulator"), env.PATH ?? ""].join(delimiter);
	}
	if (java) env.JAVA_HOME = dirname(dirname(java.path));
	// The emulator publishes its gRPC token under XDG_RUNTIME_DIR; some sessions do not set it.
	if (host === "linux" && !env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
		const dir = `/run/user/${process.getuid()}`;
		if (existsSync(dir)) env.XDG_RUNTIME_DIR = dir;
	}
	return env;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Escapes text for `adb shell input text`, which runs through the device shell and reads %s as a space. */
function inputText(text: string): string {
	return text.replace(/[\\'"`$&|;<>()*~!#?[\]{}^]/g, (char) => `\\${char}`).replace(/ /g, "%s");
}

const KEYS: Record<string, number> = {
	back: 4,
	home: 3,
	recents: 187,
	enter: 66,
	delete: 67,
	backspace: 67,
	tab: 61,
	escape: 111,
	power: 26,
	volume_up: 24,
	volume_down: 25,
	menu: 82,
	search: 84,
	up: 19,
	down: 20,
	left: 21,
	right: 22,
};

interface UiNode {
	ref: number;
	label: string;
	x: number;
	y: number;
}

/** Turns a uiautomator dump into numbered elements the agent can act on by ref. */
function parseUi(xml: string): UiNode[] {
	const nodes: UiNode[] = [];
	for (const match of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
		const attrs: Record<string, string> = {};
		for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[attr[1]!] = decode(attr[2]!);
		const bounds = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attrs.bounds ?? "");
		if (!bounds) continue;
		const [x1, y1, x2, y2] = bounds.slice(1).map(Number) as [number, number, number, number];
		if (x2 <= x1 || y2 <= y1) continue;
		const text = attrs.text?.trim();
		const desc = attrs["content-desc"]?.trim();
		const interactive = attrs.clickable === "true" || attrs["long-clickable"] === "true" || attrs.checkable === "true" || attrs.scrollable === "true";
		const editable = attrs.class === "android.widget.EditText";
		if (!text && !desc && !interactive && !editable) continue;
		const kind = (attrs.class ?? "View").split(".").pop();
		const id = attrs["resource-id"] ? ` #${attrs["resource-id"].split("/").pop()}` : "";
		const state = [attrs.checked === "true" ? "checked" : "", attrs.selected === "true" ? "selected" : "", attrs.enabled === "false" ? "disabled" : "", attrs.focused === "true" ? "focused" : ""]
			.filter(Boolean)
			.join(", ");
		const words = [text ? `"${text}"` : "", desc && desc !== text ? `(${desc})` : ""].filter(Boolean).join(" ");
		nodes.push({
			ref: nodes.length + 1,
			label: `${kind}${id}${words ? ` ${words}` : ""}${state ? ` [${state}]` : ""}`,
			x: Math.round((x1 + x2) / 2),
			y: Math.round((y1 + y2) / 2),
		});
	}
	return nodes;
}

function decode(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " ").replace(/&amp;/g, "&");
}

/** Stops a hub an earlier server started and did not stop (a crash, a killed process), if it is still our hub. */
function stopStaleHub(): void {
	try {
		const pid = Number(readFileSync(hubPidFile, "utf8").trim());
		rmSync(hubPidFile, { force: true });
		if (!pid) return;
		// On Linux the command line confirms the pid still belongs to the hub, not a reused pid.
		if (existsSync(`/proc/${pid}/cmdline`) && !readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(HUB_PACKAGE)) return;
		process.kill(pid, "SIGTERM");
	} catch {
		// No pid file, or the process is gone.
	}
}

export class AndroidDevices {
	private readonly hub: Hub;
	private readonly agentToken: string;
	private setup: SetupState = { running: false, step: "", message: "", percent: null, error: null, log: [] };
	private hubChild: ChildProcess | undefined;
	private hubPort: number | null = null;
	private hubToken: string | null = null;
	private hubStarting: Promise<void> | undefined;
	private hubError: string | null = null;
	/** The last UI dump's elements per device, so taps and typing can name a ref. */
	private refs = new Map<string, UiNode[]>();
	private profiles: Promise<string[]> | undefined;
	private latest: Promise<SystemImage> | undefined;
	private metrics: { serial: string; abort: AbortController } | undefined;
	private metricsRenewed = 0;
	private snapshots = new Map<string, { at: number; snapshot: AccessibilitySnapshot }>();

	constructor(hub: Hub, agentToken: string) {
		this.hub = hub;
		this.agentToken = agentToken;
		stopStaleHub();
	}

	async status(): Promise<DeviceStatus> {
		const sdk = findSdk();
		const java = await findJava();
		const kvm = kvmStatus();
		const avds = await this.listAvds(sdk, java);
		const missing: string[] = [];
		if (!sdk.adb) missing.push("Android SDK Platform-Tools (adb)");
		if (!sdk.emulator) missing.push("Android Emulator");
		if (avds.length === 0) {
			if (!sdk.sdkmanager) missing.push("Android SDK Command-line Tools");
			if (!java) missing.push(`Java ${MIN_JAVA} or newer (for the SDK tools)`);
			if (!sdk.systemImages.some((image) => /google_apis|default|google_atd/.test(image))) missing.push("An Android system image");
			missing.push("A virtual device");
		}
		return {
			sdk,
			java,
			kvm,
			avds,
			missing,
			ready: missing.length === 0,
			setup: this.setup,
			hub: {
				installed: this.hubInstalled(),
				running: this.hubChild !== undefined && this.hubPort !== null && !this.hubStarting,
				starting: this.hubStarting !== undefined,
				port: this.hubPort,
				token: this.hubToken,
				error: this.hubError,
			},
		};
	}

	private async listAvds(sdk: Sdk, java: { path: string } | null): Promise<string[]> {
		if (!sdk.emulator) return [];
		try {
			const output = await check(sdk.emulator, ["-list-avds"], { env: sdkEnv(sdk, java), timeout: 15000 });
			return output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line && !line.startsWith("INFO") && !line.includes("|"));
		} catch {
			return [];
		}
	}

	// ---------- SDK setup ----------

	private report(patch: Partial<SetupState>, line?: string): void {
		this.setup = { ...this.setup, ...patch };
		if (line) this.setup.log = [...this.setup.log, line].slice(-200);
		this.hub.broadcast("device-setup", this.setup, "device-setup");
	}

	/** Installs whatever the SDK is missing. Requires the user's acceptance of the Android SDK license. */
	installSdk(licenseAccepted: boolean): { started: boolean } {
		if (!licenseAccepted) throw new Error("Accept the Android SDK License Agreement first");
		if (this.setup.running) return { started: false };
		this.setup = { running: true, step: "Checking", message: "Checking what is installed", percent: null, error: null, log: [] };
		this.report({});
		void this.runSetup().then(
			() => this.report({ running: false, step: "Done", message: "Android SDK is ready", percent: null }, "Done."),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.report({ running: false, error: message, percent: null }, `Error: ${message}`);
			},
		);
		return { started: true };
	}

	private async runSetup(): Promise<void> {
		let java = await findJava();
		if (!java) {
			await this.installJdk();
			java = await findJava();
			if (!java) throw new Error("The downloaded JDK did not run");
		}
		let sdk = findSdk();
		const root = sdk.root || process.env.ANDROID_HOME?.trim() || defaultSdkRoot();
		mkdirSync(root, { recursive: true });
		if (!sdk.sdkmanager) {
			await this.installCmdlineTools(root);
		}
		sdk = inspectSdk(root);
		if (!sdk.sdkmanager || !sdk.avdmanager) throw new Error(`SDK command-line tools are missing from ${root}`);
		const env = sdkEnv(sdk, java);

		this.report({ step: "License", message: "Recording the accepted SDK licenses", percent: null }, "Accepting SDK licenses");
		await run(sdk.sdkmanager, ["--licenses", `--sdk_root=${root}`], { env, input: "y\n".repeat(30), timeout: 120000 });

		const image = sdk.systemImages.find((name) => /;google_apis;(x86_64|arm64-v8a)$/.test(name)) ?? (await this.latestSystemImage(sdk, env));
		const packages = [!sdk.adb && "platform-tools", !sdk.emulator && "emulator", !sdk.systemImages.includes(image) && image].filter((name): name is string => Boolean(name));
		if (packages.length > 0) {
			this.report({ step: "Packages", message: `Installing ${packages.join(", ")}`, percent: 0 }, `sdkmanager ${packages.join(" ")}`);
			await this.sdkInstall(sdk, env, packages);
		}

		sdk = inspectSdk(root);
		const avds = await this.listAvds(sdk, java);
		if (avds.length === 0) await this.createAvd(sdk, env, image);
	}

	/** Installs SDK packages, reporting sdkmanager's progress. */
	private async sdkInstall(sdk: Sdk, env: NodeJS.ProcessEnv, packages: string[]): Promise<void> {
		const root = sdk.root!;
		let last = "";
		const result = await run(sdk.sdkmanager!, [`--sdk_root=${root}`, ...packages], {
			env,
			input: "y\n".repeat(30),
			timeout: 60 * 60 * 1000,
			// Older tools print "[====   ] 45% Downloading ..."; newer ones print the archive URL, then "Unzipping <path>...".
			onData: (text) => {
				for (const part of text.split(/[\r\n]+/)) {
					const percent = /(\d+)%\s*(.*)$/.exec(part);
					const url = /^(https?:\/\/\S+?)\.*$/.exec(part.trim());
					const unzip = /^Unzipping (.+?)\.*$/.exec(part.trim());
					if (percent) {
						last = percent[2]?.trim() || last;
						this.report({ percent: Number(percent[1]), message: last || `Installing ${packages.join(", ")}` });
					} else if (url && url[1] !== last) {
						last = url[1]!;
						this.report({ percent: null, message: `Downloading ${url[1]!.split("/").pop()}` }, `Downloading ${url[1]}`);
					} else if (unzip && unzip[1] !== last) {
						last = unzip[1]!;
						this.report({ percent: null, message: `Unpacking ${unzip[1]}` }, `Unpacking ${unzip[1]}`);
					}
				}
			},
		});
		if (result.code !== 0) throw new Error(`sdkmanager failed: ${(result.stderr || result.stdout.toString()).trim().slice(-600)}`);
	}

	private async latestSystemImage(sdk: Sdk, env: NodeJS.ProcessEnv): Promise<string> {
		if (this.setup.running) this.report({ step: "Packages", message: "Finding the newest Android system image", percent: null }, "sdkmanager --list");
		const output = await check(sdk.sdkmanager!, ["--list", `--sdk_root=${sdk.root}`], { env, timeout: 180000 });
		const abi = osArch() === "arm64" ? "arm64-v8a" : "x86_64";
		let best: { api: number; name: string } | null = null;
		// Newer command-line tools list paths with "/" separators; installs take the ";" form.
		for (const match of output.matchAll(/system-images[;/]android-(\d+)[;/]google_apis[;/]([\w-]+)/g)) {
			if (match[2] !== abi) continue;
			const api = Number(match[1]);
			if (!best || api > best.api) best = { api, name: `system-images;android-${api};google_apis;${abi}` };
		}
		if (!best) throw new Error(`No Google APIs ${abi} system image is available from sdkmanager`);
		return best.name;
	}

	private async createAvd(sdk: Sdk, env: NodeJS.ProcessEnv, image: string): Promise<void> {
		this.report({ step: "Virtual device", message: `Creating ${AVD_NAME}`, percent: null }, `avdmanager create avd ${AVD_NAME}`);
		const devices = await check(sdk.avdmanager!, ["list", "device", "-c"], { env, timeout: 60000 });
		const profile = ["pixel_7", "pixel_6", "pixel_5"].find((name) => devices.split(/\r?\n/).includes(name)) ?? devices.split(/\r?\n/).find((name) => name.startsWith("pixel"));
		const args = ["create", "avd", "-n", AVD_NAME, "-k", image, ...(profile ? ["-d", profile] : [])];
		await check(sdk.avdmanager!, args, { env, input: "no\n", timeout: 120000 });
	}

	private async download(url: string, target: string, label: string): Promise<void> {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
		const total = Number(response.headers.get("content-length") ?? 0);
		let received = 0;
		let shown = -1;
		const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
		body.on("data", (chunk: Buffer) => {
			received += chunk.length;
			const percent = total ? Math.floor((received / total) * 100) : null;
			if (percent !== null && percent !== shown) {
				shown = percent;
				this.report({ percent, message: `${label}: ${(received / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB` });
			}
		});
		mkdirSync(dirname(target), { recursive: true });
		await pipeline(body, createWriteStream(target));
	}

	private async extract(archive: string, into: string): Promise<void> {
		rmSync(into, { recursive: true, force: true });
		mkdirSync(into, { recursive: true });
		if (archive.endsWith(".zip") && onPath(exe("unzip"))) await check("unzip", ["-q", "-o", archive, "-d", into], { timeout: 600000 });
		else await check("tar", [archive.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", into], { timeout: 600000 });
	}

	private async installJdk(): Promise<void> {
		const os = host === "darwin" ? "mac" : host === "win32" ? "windows" : "linux";
		const arch = osArch() === "arm64" ? "aarch64" : "x64";
		const url = `https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
		const archive = join(androidDir, `jdk-21.${host === "win32" ? "zip" : "tar.gz"}`);
		this.report({ step: "Java", message: "Downloading the Temurin 21 JDK", percent: 0 }, `Downloading ${url}`);
		await this.download(url, archive, "JDK");
		this.report({ message: "Unpacking the JDK", percent: null }, "Unpacking JDK");
		await this.extract(archive, join(androidDir, "jdk"));
		rmSync(archive, { force: true });
	}

	/** The SDK command-line tools zip for this OS, read from Google's repository index. */
	private async installCmdlineTools(root: string): Promise<void> {
		this.report({ step: "Command-line tools", message: "Reading the Android SDK repository", percent: null }, `GET ${REPOSITORY}repository2-3.xml`);
		const response = await fetch(`${REPOSITORY}repository2-3.xml`);
		if (!response.ok) throw new Error(`Could not read the Android SDK repository (${response.status})`);
		const xml = await response.text();
		const os = host === "darwin" ? "macosx" : host === "win32" ? "windows" : "linux";
		const archiveName = (path: string) => {
			const body = new RegExp(`<remotePackage path="${path.replace(/[.;]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</remotePackage>`).exec(xml)?.[1];
			if (!body) return undefined;
			for (const archive of body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)) {
				const block = archive[1]!;
				if (!block.includes(`<host-os>${os}</host-os>`)) continue;
				const hostArch = /<host-arch>([^<]+)<\/host-arch>/.exec(block)?.[1];
				if (hostArch && hostArch !== (osArch() === "arm64" ? "aarch64" : "x64")) continue;
				return /<url>([^<]+)<\/url>/.exec(block)?.[1];
			}
			return undefined;
		};
		const name =
			archiveName("cmdline-tools;latest") ??
			[...xml.matchAll(/path="(cmdline-tools;[\d.]+)"/g)]
				.map((match) => match[1]!)
				.sort((a, b) => Number(b.split(";")[1]) - Number(a.split(";")[1]))
				.map(archiveName)
				.find(Boolean);
		if (!name) throw new Error(`No Android command-line tools download for ${os}`);
		const archive = join(androidDir, name);
		this.report({ message: "Downloading the SDK command-line tools", percent: 0 }, `Downloading ${REPOSITORY}${name}`);
		await this.download(`${REPOSITORY}${name}`, archive, "Command-line tools");
		// Unpacked next to its destination: a rename cannot cross filesystems, and the SDK may live on another disk.
		const staging = join(root, "cmdline-tools", ".staging");
		await this.extract(archive, staging);
		const target = join(root, "cmdline-tools", "latest");
		rmSync(target, { recursive: true, force: true });
		mkdirSync(dirname(target), { recursive: true });
		renameSync(join(staging, "cmdline-tools"), target);
		rmSync(staging, { recursive: true, force: true });
		rmSync(archive, { force: true });
	}

	// ---------- Device hub ----------

	private hubInstalled(): boolean {
		try {
			return existsSync(hubEntry) && readFileSync(hubSentinel, "utf8").trim() === HUB_VERSION;
		} catch {
			return false;
		}
	}

	private async installHub(): Promise<void> {
		if (this.hubInstalled()) return;
		this.hub.broadcast("device-hub", { state: "installing" });
		const staging = `${hubDir}.staging`;
		rmSync(staging, { recursive: true, force: true });
		mkdirSync(staging, { recursive: true });
		// Lifecycle scripts stay off: the hub and its dependencies ship ready-to-run JavaScript and prebuilt binaries.
		await check(host === "win32" ? "npm.cmd" : "npm", ["install", "--prefix", staging, "--ignore-scripts", "--no-fund", "--no-audit", `${HUB_PACKAGE}@${HUB_VERSION}`], {
			timeout: 10 * 60 * 1000,
		});
		if (!existsSync(join(staging, "node_modules", HUB_PACKAGE, "dist", "server", "cli.mjs"))) throw new Error("Device hub install is incomplete");
		writeFileSync(join(staging, ".install-complete"), `${HUB_VERSION}\n`);
		rmSync(hubDir, { recursive: true, force: true });
		renameSync(staging, hubDir);
	}

	/** Installs the hub on first use and starts it. Concurrent callers share one start. */
	startHub(): Promise<void> {
		if (this.hubChild && this.hubPort) return Promise.resolve();
		this.hubStarting ??= this.spawnHub()
			.catch((error: unknown) => {
				this.hubError = error instanceof Error ? error.message : String(error);
				this.stopHub();
				throw error;
			})
			.finally(() => {
				this.hubStarting = undefined;
				this.hub.broadcast("device-hub", { state: this.hubChild ? "running" : "stopped", error: this.hubError });
			});
		return this.hubStarting;
	}

	private async spawnHub(): Promise<void> {
		this.hubError = null;
		const sdk = findSdk();
		if (!sdk.adb || !sdk.emulator) throw new Error("Install the Android SDK first");
		await this.installHub();
		this.hub.broadcast("device-hub", { state: "starting" });
		const port = await freePort();
		const java = await findJava();
		const args = [hubEntry, "--port", String(port), "--host", "127.0.0.1", "--require-token", "--platform", "android"];
		const stateDir = join(desktopDir, "device-hub");
		mkdirSync(stateDir, { recursive: true });
		const child = spawn(process.execPath, args, {
			env: { ...sdkEnv(sdk, java), EXPO_DEVICE_HUB_STATE_DIR: stateDir, NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		// With --require-token the CLI mints the session token itself and prints it in its startup link.
		let output = "";
		const collect = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-4000);
			if (this.hubChild === child && !this.hubToken) this.hubToken = /[?&]token=([A-Za-z0-9._~-]+)/.exec(output)?.[1] ?? null;
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		child.on("exit", (code) => {
			if (this.hubChild !== child) return;
			this.hubChild = undefined;
			this.hubPort = null;
			this.hubToken = null;
			if (code) this.hubError = `Device hub exited (${code}): ${output.trim().slice(-400)}`;
			this.hub.broadcast("device-hub", { state: "stopped", error: this.hubError });
		});
		this.hubChild = child;
		this.hubPort = port;
		this.hubToken = null;
		if (child.pid) writeFileSync(hubPidFile, String(child.pid));
		for (let attempt = 0; attempt < 60; attempt++) {
			if (this.hubChild !== child) throw new Error(this.hubError ?? "Device hub stopped while starting");
			const ready = this.hubToken !== null && await fetch(`http://127.0.0.1:${port}/readyz`).then(
				(response) => response.ok,
				() => false,
			);
			if (ready) return;
			await delay(250);
		}
		throw new Error(`Device hub did not start: ${output.trim().slice(-400)}`);
	}

	stopHub(): void {
		const child = this.hubChild;
		this.hubChild = undefined;
		this.hubPort = null;
		this.hubToken = null;
		child?.kill("SIGTERM");
		rmSync(hubPidFile, { force: true });
	}

	private async hubApi<T>(path: string, body: unknown): Promise<T> {
		await this.startHub();
		const response = await fetch(`http://127.0.0.1:${this.hubPort}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.hubToken}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const data = (await response.json().catch(() => ({}))) as T & { error?: string; errors?: string[] };
		if (!response.ok) throw new Error(data.error ?? data.errors?.join("; ") ?? `Device hub request failed (${response.status})`);
		return data;
	}

	/** Boots a virtual device through the hub, which the pane is showing. */
	async boot(avd: string): Promise<{ serial: string }> {
		const result = await this.hubApi<{ serial?: string; id?: string; errors?: string[] }>("/api/devices/boot", { id: avd, platform: "android" });
		if (result.errors?.length) throw new Error(result.errors.join("; "));
		return { serial: result.serial ?? result.id ?? "" };
	}

	async shutdown(serial: string): Promise<void> {
		await this.hubApi("/api/devices/shutdown", { id: serial, platform: "android" });
	}

	// ---------- Device list, new emulators, controls ----------

	/** Every virtual device with its Android version and whether it runs, plus devices that are not emulators. */
	async devices(): Promise<{ avds: AvdInfo[]; others: string[] }> {
		const sdk = findSdk();
		const java = await findJava();
		const names = await this.listAvds(sdk, java);
		const running = new Map<string, string>();
		const others: string[] = [];
		if (sdk.adb) {
			const env = sdkEnv(sdk, java);
			for (const serial of await this.running().catch(() => [])) {
				if (!serial.startsWith("emulator-")) {
					others.push(serial);
					continue;
				}
				const name = await run(sdk.adb, ["-s", serial, "emu", "avd", "name"], { env, timeout: 5000 }).then(
					(result) => result.stdout.toString().split(/\r?\n/)[0]?.trim() ?? "",
					() => "",
				);
				if (name) running.set(name, serial);
			}
		}
		const avds = names.map((name) => {
			const config = readAvdConfig(name);
			const api = Number(/android-(\d+)/.exec(config["image.sysdir.1"] ?? config.target ?? "")?.[1] ?? 0);
			return {
				name,
				displayName: config["avd.ini.displayname"] || name.replace(/_/g, " "),
				api: api || null,
				version: api ? androidVersion(api) : null,
				device: config["hw.device.name"] ?? null,
				serial: running.get(name) ?? null,
			};
		});
		return { avds, others };
	}

	/** Installed system images and device profiles for a new virtual device, newest first. */
	async newDeviceOptions(): Promise<{ images: SystemImage[]; profiles: string[]; sdkReady: boolean }> {
		const sdk = findSdk();
		const java = await findJava();
		if (!sdk.root || !sdk.avdmanager || !java) return { images: [], profiles: [], sdkReady: false };
		const images = sdk.systemImages
			.filter((path) => existsSync(join(sdk.root!, ...path.split(";"), "system.img")))
			.map(describeImage)
			.sort((a, b) => b.api - a.api);
		this.profiles ??= check(sdk.avdmanager, ["list", "device", "-c"], { env: sdkEnv(sdk, java), timeout: 60000 }).then((output) =>
			output
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => /^(pixel|medium_|small_|resizable)/.test(line)),
		);
		const profiles = await this.profiles.catch(() => [] as string[]);
		return { images, profiles, sdkReady: true };
	}

	/** The newest Google APIs image sdkmanager offers for this machine, for the "download" option. */
	async latestImage(): Promise<SystemImage | null> {
		const sdk = findSdk();
		const java = await findJava();
		if (!sdk.sdkmanager || !java) return null;
		this.latest ??= this.latestSystemImage(sdk, sdkEnv(sdk, java)).then(describeImage);
		return this.latest.catch(() => {
			this.latest = undefined;
			return null;
		});
	}

	/** Downloads one system image with sdkmanager, reporting progress like the SDK setup. */
	installImage(image: string, licenseAccepted: boolean): { started: boolean } {
		if (!licenseAccepted) throw new Error("Accept the Android SDK License Agreement first");
		if (!/^system-images;android-[\w.-]+;[\w-]+;[\w-]+$/.test(image)) throw new Error("Not a system image package");
		if (this.setup.running) return { started: false };
		this.setup = { running: true, step: "System image", message: `Installing ${image}`, percent: null, error: null, log: [] };
		this.report({});
		void (async () => {
			const sdk = findSdk();
			const java = await findJava();
			if (!sdk.sdkmanager || !java) throw new Error("Set up the Android SDK first");
			await this.sdkInstall(sdk, sdkEnv(sdk, java), [image]);
		})().then(
			() => this.report({ running: false, step: "Done", message: `${image} is installed`, percent: null }, "Done."),
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				this.report({ running: false, error: message, percent: null }, `Error: ${message}`);
			},
		);
		return { started: true };
	}

	/** Creates a virtual device from an installed image and profile, then boots it through the hub. */
	async createAndBoot(name: string, image: string, profile: string): Promise<{ serial: string }> {
		if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error("Use letters, digits, '.', '_' or '-' for the name");
		const sdk = findSdk();
		const java = await findJava();
		if (!sdk.avdmanager || !java) throw new Error("Set up the Android SDK first");
		if (!sdk.systemImages.includes(image)) throw new Error(`${image} is not installed`);
		if ((await this.listAvds(sdk, java)).includes(name)) throw new Error(`A virtual device named ${name} already exists`);
		const args = ["create", "avd", "-n", name, "-k", image, ...(profile ? ["-d", profile] : [])];
		await check(sdk.avdmanager, args, { env: sdkEnv(sdk, java), input: "no\n", timeout: 120000 });
		return this.boot(name);
	}

	/** Emulators rotate through their console; `cmd window user-rotation` is missing before Android 10. */
	async rotate(serial: string): Promise<void> {
		const { adb, env } = this.adb();
		await check(adb, ["-s", serial, "emu", "rotate"], { env, timeout: 10000 });
	}

	/**
	 * Calls the hub's Android API (/vendor/serve-emu/api/...) with the session token, so the pane does not need
	 * cross-origin access. Screenshots come back as base64 PNG.
	 */
	async hubProxy(method: "GET" | "POST", path: string, serial: string, body?: unknown): Promise<unknown> {
		if (!/^\/api\/[a-z-]+(\/[a-z-]+)?$/.test(path)) throw new Error("Not a device hub API path");
		await this.startHub();
		const url = `http://127.0.0.1:${this.hubPort}/vendor/serve-emu${path}?device=${encodeURIComponent(serial)}`;
		const response = await fetch(url, {
			method,
			headers: { authorization: `Bearer ${this.hubToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if ((response.headers.get("content-type") ?? "").startsWith("image/")) {
			return { image: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: response.headers.get("content-type") };
		}
		const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
		if (!response.ok || data.ok === false) throw new Error(data.error ?? `Device hub request failed (${response.status})`);
		return data;
	}

	/**
	 * Relays one device's CPU, memory and network samples as `device-metrics` events. The pane renews the watch while
	 * it shows the device; without a renewal for 30 seconds the relay stops.
	 */
	watchMetrics(serial: string): void {
		this.metricsRenewed = Date.now();
		if (this.metrics?.serial === serial) return;
		this.metrics?.abort.abort();
		const abort = new AbortController();
		this.metrics = { serial, abort };
		void (async () => {
			await this.startHub();
			const response = await fetch(`http://127.0.0.1:${this.hubPort}/vendor/serve-emu/api/metrics?device=${encodeURIComponent(serial)}`, {
				headers: { authorization: `Bearer ${this.hubToken}` },
				signal: abort.signal,
			});
			if (!response.ok || !response.body) throw new Error(`metrics ${response.status}`);
			const decoder = new TextDecoder();
			let buffer = "";
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				if (Date.now() - this.metricsRenewed > 30000) break;
				buffer += decoder.decode(chunk, { stream: true });
				let end = buffer.indexOf("\n\n");
				while (end !== -1) {
					const event = buffer.slice(0, end);
					buffer = buffer.slice(end + 2);
					end = buffer.indexOf("\n\n");
					if (/^event:/m.test(event)) continue;
					const data = /^data: ?(.*)$/m.exec(event)?.[1];
					if (data) {
						try {
							this.hub.broadcast("device-metrics", { serial, ...JSON.parse(data) });
						} catch {
							// A partial or malformed sample is skipped.
						}
					}
				}
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				if (this.metrics?.abort === abort) this.metrics = undefined;
				abort.abort();
			});
	}

	/**
	 * The element under a point of the screen (x and y from 0 to 1), from the hub's accessibility snapshot, for the
	 * Device pane's "Select element" tool. Hovering reuses a snapshot for a second; a click (`full`) takes a fresh one.
	 */
	async inspect(serial: string, x: number, y: number, full: boolean): Promise<DeviceElement | null> {
		const cached = this.snapshots.get(serial);
		const snapshot =
			!full && cached && Date.now() - cached.at < 1000
				? cached.snapshot
				: ((await this.hubProxy("GET", "/api/accessibility", serial)) as AccessibilitySnapshot);
		this.snapshots.set(serial, { at: Date.now(), snapshot });
		const width = snapshot.screen?.width || Math.max(...snapshot.nodes.map((node) => node.bounds.right), 1);
		const height = snapshot.screen?.height || Math.max(...snapshot.nodes.map((node) => node.bounds.bottom), 1);
		const px = x * width;
		const py = y * height;
		const area = (node: AccessibilityNode) => (node.bounds.right - node.bounds.left) * (node.bounds.bottom - node.bounds.top);
		const hits = snapshot.nodes.filter(
			(node) => px >= node.bounds.left && px <= node.bounds.right && py >= node.bounds.top && py <= node.bounds.bottom && area(node) < width * height * 0.95,
		);
		// The smallest element that says something or can be tapped; the smallest of any kind otherwise.
		const meaningful = hits.filter((node) => node.text || node.contentDescription || node.clickable);
		const node = (meaningful.length > 0 ? meaningful : hits).sort((a, b) => area(a) - area(b))[0];
		if (!node) return null;
		const kind = node.className.split(".").pop() || "View";
		const id = node.resourceId.split("/").pop() ?? "";
		const words = node.text || node.contentDescription;
		const { left, top, right, bottom } = node.bounds;
		return {
			rect: { x: left / width, y: top / height, width: (right - left) / width, height: (bottom - top) / height },
			label: `${kind}${id ? ` #${id}` : ""}${words ? ` "${words.length > 40 ? `${words.slice(0, 40)}…` : words}"` : ""}`,
			className: node.className,
			text: node.text,
			contentDescription: node.contentDescription,
			resourceId: node.resourceId,
			packageName: node.packageName,
			clickable: node.clickable,
			enabled: node.enabled,
			bounds: { left, top, right, bottom },
			screen: { width, height },
			nearby: full
				? snapshot.nodes
						.filter((other) => other !== node && (other.text || other.contentDescription) && Math.abs(other.bounds.top - top) < height * 0.15)
						.slice(0, 8)
						.map((other) => other.text || other.contentDescription)
				: [],
		};
	}

	// ---------- Agent tools ----------

	private adb(): { adb: string; env: NodeJS.ProcessEnv } {
		const sdk = findSdk();
		if (!sdk.adb) throw new Error("The Android SDK is not installed. Ask the user to set it up in the Device pane.");
		return { adb: sdk.adb, env: sdkEnv(sdk, null) };
	}

	private async running(): Promise<string[]> {
		const { adb, env } = this.adb();
		const output = await check(adb, ["devices"], { env, timeout: 15000 });
		return output
			.split(/\r?\n/)
			.slice(1)
			.map((line) => line.trim().split(/\s+/))
			.filter((parts) => parts[1] === "device")
			.map((parts) => parts[0]!);
	}

	private async serial(requested?: string): Promise<string> {
		const devices = await this.running();
		if (requested) {
			if (!devices.includes(requested)) throw new Error(`${requested} is not running. Running: ${devices.join(", ") || "none"}`);
			return requested;
		}
		if (devices.length === 0) throw new Error("No Android device is running. Call device_boot, or ask the user to start one in the Device pane.");
		return devices.find((serial) => serial.startsWith("emulator-")) ?? devices[0]!;
	}

	private async shell(serial: string, args: string[], timeout = 30000): Promise<string> {
		const { adb, env } = this.adb();
		return check(adb, ["-s", serial, "shell", ...args], { env, timeout });
	}

	/** Reads the screen's elements and remembers their refs for tap and type. */
	private async dumpUi(serial: string): Promise<UiNode[]> {
		const { adb, env } = this.adb();
		const result = await run(adb, ["-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"], { env, timeout: 30000 });
		const xml = result.stdout.toString("utf8");
		if (!xml.includes("<hierarchy")) throw new Error(`Could not read the screen: ${(result.stderr || xml).trim().slice(0, 300)}`);
		const nodes = parseUi(xml);
		this.refs.set(serial, nodes);
		return nodes;
	}

	private async foregroundApp(serial: string): Promise<string | undefined> {
		return (await this.shell(serial, ["dumpsys", "window"]).catch(() => "")).match(/mCurrentFocus=.*?\s([\w.]+)\/[\w.$]+/)?.[1];
	}

	private async tapPoint(serial: string, input: { ref?: number; x?: number; y?: number }): Promise<{ x: number; y: number; label?: string }> {
		if (input.ref !== undefined) {
			const node = this.refs.get(serial)?.find((entry) => entry.ref === input.ref);
			if (!node) throw new Error(`No element ${input.ref}. Call device_ui again; refs change when the screen changes.`);
			return node;
		}
		if (input.x === undefined || input.y === undefined) throw new Error("Give a ref from device_ui, or x and y in screen pixels");
		return { x: Math.round(input.x), y: Math.round(input.y) };
	}

	async agentAct(token: string, input: DeviceAction): Promise<{ text: string; image?: string; mimeType?: string }> {
		if (token !== this.agentToken) throw new Error("Not allowed");
		switch (input.action) {
			case "devices": {
				const sdk = findSdk();
				const java = await findJava();
				const [avds, running] = await Promise.all([this.listAvds(sdk, java), sdk.adb ? this.running() : Promise.resolve([])]);
				return { text: `Running: ${running.join(", ") || "none"}\nVirtual devices: ${avds.join(", ") || "none"}` };
			}
			case "boot": {
				const sdk = findSdk();
				const avds = await this.listAvds(sdk, await findJava());
				const avd = input.avd ?? avds[0];
				if (!avd) throw new Error("There is no virtual device. Ask the user to set one up in the Device pane.");
				const { serial } = await this.boot(avd);
				const { adb, env } = this.adb();
				for (let attempt = 0; attempt < 120; attempt++) {
					const done = await run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { env, timeout: 5000 }).catch(() => undefined);
					if (done?.stdout.toString().trim() === "1") return { text: `${avd} is running as ${serial}.` };
					await delay(1000);
				}
				return { text: `${avd} started as ${serial} but has not finished booting yet.` };
			}
			case "screenshot": {
				const serial = await this.serial(input.serial);
				const { adb, env } = this.adb();
				const result = await run(adb, ["-s", serial, "exec-out", "screencap", "-p"], { env, timeout: 30000 });
				if (result.code !== 0 || result.stdout.length === 0) throw new Error(`Screenshot failed: ${result.stderr.trim()}`);
				return { text: `Screenshot of ${serial}.`, image: result.stdout.toString("base64"), mimeType: "image/png" };
			}
			case "ui": {
				const serial = await this.serial(input.serial);
				const nodes = await this.dumpUi(serial);
				const app = await this.foregroundApp(serial);
				const lines = nodes.map((node) => `[${node.ref}] ${node.label} @${node.x},${node.y}`);
				const empty =
					"(nothing labelled on screen yet: an app may still be loading or a dialog closing, or the screen is a WebView, game or canvas. Call device_wait, then device_ui again; use device_screenshot to see the screen.)";
				return { text: `${serial}${app ? `, foreground app ${app}` : ""}\n${lines.join("\n") || empty}` };
			}
			case "wait": {
				const serial = await this.serial(input.serial);
				// A plain pause, capped like browser_wait.
				if (input.text === undefined && input.ms !== undefined) {
					const ms = Math.min(Math.max(input.ms, 0), 10000);
					await delay(ms);
					return { text: `Waited ${ms} ms.` };
				}
				// Otherwise read the screen until the text shows (or, with no text, until anything is labelled).
				const timeout = Math.min(Math.max(input.timeoutMs ?? input.ms ?? 10000, 500), 30000);
				const needle = input.text?.trim().toLowerCase();
				const started = Date.now();
				let nodes: UiNode[] = [];
				while (Date.now() - started < timeout) {
					nodes = await this.dumpUi(serial).catch(() => []);
					const hit = needle ? nodes.find((node) => node.label.toLowerCase().includes(needle)) : nodes[0];
					if (hit) {
						const waited = Date.now() - started;
						return {
							text: needle
								? `"${input.text}" is on screen after ${waited} ms: [${hit.ref}] ${hit.label} @${hit.x},${hit.y}. Refs from this read are current.`
								: `The screen has ${nodes.length} labelled elements after ${waited} ms. Call device_ui to list them.`,
						};
					}
					await delay(700);
				}
				const app = await this.foregroundApp(serial);
				throw new Error(
					`${needle ? `"${input.text}" did not appear` : "Nothing labelled appeared"} within ${timeout} ms${app ? ` (foreground app ${app})` : ""}. Take a device_screenshot to see what is on screen.`,
				);
			}
			case "tap": {
				const serial = await this.serial(input.serial);
				const point = await this.tapPoint(serial, input);
				const args = input.long ? ["input", "swipe", String(point.x), String(point.y), String(point.x), String(point.y), "700"] : ["input", "tap", String(point.x), String(point.y)];
				await this.shell(serial, args);
				return { text: `${input.long ? "Long-pressed" : "Tapped"} ${point.label ?? ""} at ${point.x},${point.y}.`.replace("  ", " ") };
			}
			case "swipe": {
				const serial = await this.serial(input.serial);
				let { x1, y1, x2, y2 } = input;
				if (input.direction) {
					const size = /(\d+)x(\d+)/.exec(await this.shell(serial, ["wm", "size"]))?.slice(1).map(Number) ?? [1080, 1920];
					const [w, h] = size as [number, number];
					const cx = Math.round(w / 2);
					const cy = Math.round(h / 2);
					const span = { up: [cx, Math.round(h * 0.75), cx, Math.round(h * 0.25)], down: [cx, Math.round(h * 0.25), cx, Math.round(h * 0.75)], left: [Math.round(w * 0.8), cy, Math.round(w * 0.2), cy], right: [Math.round(w * 0.2), cy, Math.round(w * 0.8), cy] }[
						input.direction
					];
					if (!span) throw new Error("direction is up, down, left or right (up scrolls the content down)");
					[x1, y1, x2, y2] = span;
				}
				if ([x1, y1, x2, y2].some((value) => value === undefined)) throw new Error("Give x1, y1, x2, y2 or a direction");
				await this.shell(serial, ["input", "swipe", String(x1), String(y1), String(x2), String(y2), String(input.ms ?? 300)]);
				return { text: `Swiped from ${x1},${y1} to ${x2},${y2}.` };
			}
			case "type": {
				const serial = await this.serial(input.serial);
				if (input.ref !== undefined) {
					const point = await this.tapPoint(serial, input);
					await this.shell(serial, ["input", "tap", String(point.x), String(point.y)]);
					await delay(300);
				}
				if (/[^\x20-\x7e]/.test(input.text)) throw new Error("adb can only type printable ASCII. Ask the user to type other characters in the Device pane.");
				if (input.text) await this.shell(serial, ["input", "text", inputText(input.text)]);
				if (input.submit) await this.shell(serial, ["input", "keyevent", "66"]);
				return { text: `Typed ${input.text.length} characters${input.submit ? " and pressed Enter" : ""}.` };
			}
			case "key": {
				const serial = await this.serial(input.serial);
				const name = input.key.toLowerCase().replace(/^keycode_/, "");
				const code = KEYS[name] ?? (/^\d+$/.test(name) ? Number(name) : undefined);
				if (code === undefined) throw new Error(`Unknown key ${input.key}. Use ${Object.keys(KEYS).join(", ")} or a keycode number.`);
				await this.shell(serial, ["input", "keyevent", String(code)]);
				return { text: `Pressed ${input.key}.` };
			}
			case "launch": {
				const serial = await this.serial(input.serial);
				if (!/^[\w.]+$/.test(input.package)) throw new Error("package is an Android package name, e.g. com.android.settings");
				const output = await this.shell(serial, ["monkey", "-p", input.package, "-c", "android.intent.category.LAUNCHER", "1"]);
				if (/No activities found|monkey aborted/i.test(output)) throw new Error(`${input.package} has no launcher activity or is not installed`);
				return { text: `Launched ${input.package}.` };
			}
			case "open_url": {
				const serial = await this.serial(input.serial);
				if (!/^[a-z][a-z0-9+.-]*:/i.test(input.url)) throw new Error("url needs a scheme, e.g. https:// or a deep link like myapp://");
				await this.shell(serial, ["am", "start", "-a", "android.intent.action.VIEW", "-d", `'${input.url.replace(/'/g, "'\\''")}'`]);
				return { text: `Opened ${input.url}.` };
			}
			case "install": {
				const serial = await this.serial(input.serial);
				if (!input.path.endsWith(".apk") || !existsSync(input.path)) throw new Error(`No APK at ${input.path}`);
				const { adb, env } = this.adb();
				const output = await check(adb, ["-s", serial, "install", "-r", "-t", input.path], { env, timeout: 5 * 60 * 1000 });
				return { text: output.trim() || "Installed." };
			}
			case "apps": {
				const serial = await this.serial(input.serial);
				const output = await this.shell(serial, ["pm", "list", "packages", "-3"]);
				const packages = output
					.split(/\r?\n/)
					.map((line) => line.replace(/^package:/, "").trim())
					.filter(Boolean)
					.sort();
				return { text: packages.length ? `Installed apps (not system):\n${packages.join("\n")}` : "No apps besides the system ones." };
			}
			case "logcat": {
				const serial = await this.serial(input.serial);
				const lines = Math.min(Math.max(input.lines ?? 200, 1), 2000);
				const { adb, env } = this.adb();
				const output = await check(adb, ["-s", serial, "logcat", "-d", "-t", String(lines), ...(input.filter ? input.filter.trim().split(/\s+/) : [])], { env, timeout: 30000 });
				return { text: output.trim().slice(-20000) || "(empty)" };
			}
		}
	}
}
