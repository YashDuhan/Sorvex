/**
 * Sorvex Desktop server. Like warpdrv's server, it does the real work and the Tauri shell only opens a window
 * on it: it runs `sorvex --mode rpc`, manages credentials and voice, and serves the built UI.
 *
 * Run from the repository with the source resolver:
 *   node --import ./packages/coding-agent/src/experimental/source-resolver.ts apps/desktop/server/index.ts
 *
 * Security: it listens on 127.0.0.1 only. It also rejects requests whose Host is not a loopback name (which
 * stops DNS rebinding) and mutating requests without the `x-sorvex-desktop` header. A custom header forces a
 * CORS preflight, which this server never approves, so other websites open in a browser cannot drive the agent.
 */

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { Agent } from "./agent.ts";
import { Credentials } from "./credentials.ts";
import { Hub } from "./hub.ts";
import { Kokoro } from "./kokoro.ts";
import { addMcpServer, listMcpServers, mcpGlobalPath, removeMcpServer, setMcpServerEnabled, setMcpServerExposure } from "./mcp.ts";
import { builtinAgents, changelog, deleteSession, exportJsonl, listFiles, listSessions, readSorvexSettings, writeSorvexSetting } from "./parity.ts";
import { distDir, repoRoot, settingsPath } from "./paths.ts";
import { type LocalSettings, LocalModels, llamaUrl } from "./local.ts";
import { notify } from "./notify.ts";
import { RemoteAccess } from "./remote.ts";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "./settings.ts";
import { type BrowserAction, BrowserManager, browserGuardrails } from "./browser.ts";
import { DEFAULT_SSH_GUARDRAILS, type SshPolicy, SshManager, sshGuardrails } from "./ssh.ts";
import { SideChats } from "./sidechat.ts";
import { AndroidDevices, type DeviceAction } from "./devices.ts";
import { type CommandInfo, listInstalledSkills, readSkillFile, removeSkill, SkillRegistry } from "./skills.ts";
import { TerminalManager } from "./terminals.ts";
import { type SpeechEndpoint, speak, transcribe } from "./voice.ts";
import { changeSummary, type ChangedFile, currentBranch, fileDiff, listDir, readWorkspaceFile, searchFiles } from "./workspace.ts";

const PORT = Number(process.env.SORVEX_DESKTOP_PORT ?? 4517);
const HOST = "127.0.0.1";

const hub = new Hub();
const ssh = new SshManager(hub);
// The browser tools share the SSH tools' per-launch token, which only the bridge extension holds.
const browser = new BrowserManager(hub, ssh.token);
const devices = new AndroidDevices(hub, ssh.token);
// The agent's built-in llama.cpp provider talks to the local engine on the Local models page.
const agent = new Agent(hub, { SORVEX_DESKTOP_URL: `http://${HOST}:${PORT}`, LLAMA_BASE_URL: process.env.LLAMA_BASE_URL ?? llamaUrl });
const local = new LocalModels(hub);
const credentials = await Credentials.create(hub);
const kokoro = new Kokoro(hub);
const terminals = new TerminalManager(hub);
/** The Files, Changes and Terminal panes work in the agent's working directory. */
const workspaceRoot = () => agent.cwd || process.env.SORVEX_DESKTOP_CWD || repoRoot;
const sideChats = new SideChats(hub, credentials, workspaceRoot);

// The bridge extension reads this file on every tool call, so make the defaults real on first run.
if (!existsSync(settingsPath)) writeSettings(readSettings());
// Safety rules added after a settings file was created are added once. A rule the user deletes later stays deleted.
{
	const settings = readSettings() as ReturnType<typeof readSettings> & { addedRules?: string[] };
	const added = new Set(settings.addedRules ?? settings.rules.map((rule) => rule.id));
	const missing = DEFAULT_SETTINGS.rules.filter((rule) => !added.has(rule.id) && !settings.rules.some((r) => r.id === rule.id));
	if (missing.length > 0 || !settings.addedRules) {
		writeSettings({ ...settings, rules: [...settings.rules, ...missing], addedRules: DEFAULT_SETTINGS.rules.map((rule) => rule.id) });
	}
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/** The MCP extension reads its config on session start, so config edits need a session reload. */
async function reloadAgent(): Promise<void> {
	if (agent.status === "ready") await agent.request({ type: "prompt", message: "/gui-reload" }).catch(() => undefined);
}

const skillRegistry = new SkillRegistry();
/** The skills the running agent loaded; throws when it is not running, so the Skills page scans the folders instead. */
async function installedSkillCommands() {
	if (agent.status !== "ready") throw new Error("Agent not running");
	return agent.request<{ commands: CommandInfo[] }>({ type: "get_commands" });
}

/** After credentials change, the agent's cached model list must be rebuilt before the UI asks for it. */
function refreshAgentModels(): void {
	if (agent.status !== "ready") return;
	agent
		.request({ type: "prompt", message: "/gui-refresh-models" })
		.then(() => hub.broadcast("models-changed", {}))
		.catch((error: unknown) => hub.broadcast("agent-stderr", { line: `model refresh failed: ${String(error)}` }));
}

type Handler = (body: Record<string, unknown>, url: URL) => Promise<unknown> | unknown;

const routes: Record<string, Handler> = {
	"GET /api/health": () => ({ ok: true }),

	// Files, Changes and Terminal panes. Reads are POSTs so they need the x-sorvex-desktop header too.
	"POST /api/fs/list": (body) => ({ root: workspaceRoot(), entries: listDir(workspaceRoot(), String(body.path ?? "")) }),
	"POST /api/fs/read": (body) => readWorkspaceFile(workspaceRoot(), String(body.path)),
	"POST /api/fs/search": async (body) => ({ results: await searchFiles(workspaceRoot(), String(body.query ?? "")) }),
	"POST /api/git/branch": async () => ({ root: workspaceRoot(), branch: await currentBranch(workspaceRoot()) }),
	"POST /api/git/changes": (body) => changeSummary(workspaceRoot(), typeof body.base === "string" ? body.base : undefined),
	"POST /api/git/diff": async (body) => ({ diff: await fileDiff(workspaceRoot(), String(body.base), body.file as ChangedFile, body.full === true) }),
	"GET /api/terminals": () => ({ terminals: terminals.list() }),
	"POST /api/terminals/create": (body) => terminals.create(workspaceRoot(), Number(body.rows ?? 24), Number(body.cols ?? 80)),
	"POST /api/terminals/buffer": (body) => terminals.buffer(Number(body.id)),
	"POST /api/terminals/input": (body) => {
		terminals.input(Number(body.id), String(body.data ?? ""));
		return { ok: true };
	},
	"POST /api/terminals/resize": (body) => {
		terminals.resize(Number(body.id), Number(body.rows), Number(body.cols));
		return { ok: true };
	},
	"POST /api/terminals/close": (body) => {
		terminals.close(Number(body.id));
		return { ok: true };
	},
	"GET /api/state": () => ({ agent: agent.snapshot(), defaultCwd: process.env.SORVEX_DESKTOP_CWD ?? repoRoot, dialogs: agent.pendingDialogs() }),

	"POST /api/agent/cwd": (body) => {
		agent.setCwd(String(body.cwd));
		return { ok: true };
	},
	"POST /api/agent/start": async (body) => {
		const info = agent.start(String(body.cwd));
		// The SSH tool token goes to the bridge extension through an in-process command, not the environment,
		// because the agent's own shell commands could read its environment from /proc.
		await agent.request({ type: "prompt", message: `/gui-ssh-init ${ssh.token}` }).catch(() => undefined);
		return info;
	},
	"POST /api/agent/rpc": async (body) => ({ data: await agent.request(body.command as { type: string }) }),
	"POST /api/agent/ui": (body) => {
		agent.respond(body.response as Record<string, unknown>);
		return { ok: true };
	},

	"GET /api/sessions": (_body, url) =>
		listSessions(url.searchParams.get("cwd") || agent.cwd, url.searchParams.get("all") === "1"),
	"POST /api/sessions/delete": (body) => deleteSession(String(body.path)),
	"POST /api/sessions/export-jsonl": (body) => exportJsonl(String(body.sessionFile), String(body.path)),
	"GET /api/sorvex-settings": (_body, url) => readSorvexSettings(url.searchParams.get("cwd") || agent.cwd),
	"PUT /api/sorvex-settings": async (body) => {
		await writeSorvexSetting(String(body.cwd || agent.cwd), String(body.key), body.value);
		return readSorvexSettings(String(body.cwd || agent.cwd));
	},
	"GET /api/changelog": () => ({ text: changelog() }),
	"GET /api/agents": () => builtinAgents(),
	"GET /api/files": async (_body, url) => ({ files: await listFiles(url.searchParams.get("cwd") || agent.cwd) }),

	// UI-side diagnostics (e.g. whether the webview exposes the microphone), shown in the Logs page and the server log.
	"POST /api/log": (body) => {
		const line = `[ui] ${String(body.line).slice(0, 2000)}`;
		console.log(line);
		hub.broadcast("agent-stderr", { line });
		return { ok: true };
	},

	"GET /api/settings": () => readSettings(),
	"PUT /api/settings": (body) => {
		writeSettings(body);
		return { ok: true };
	},

	"GET /api/providers": () => credentials.providers(),
	"POST /api/providers/login": (body) => ({
		loginId: credentials.startLogin(
			String(body.loginId),
			String(body.provider),
			body.authType === "oauth" ? "oauth" : "api_key",
			refreshAgentModels,
		),
	}),
	"POST /api/providers/answer": (body) => {
		credentials.answer(String(body.promptId), String(body.value ?? ""));
		return { ok: true };
	},
	"POST /api/providers/cancel": (body) => {
		credentials.cancel(String(body.loginId));
		return { ok: true };
	},
	"POST /api/providers/logout": async (body) => {
		await credentials.logout(String(body.provider));
		refreshAgentModels();
		return { ok: true };
	},

	"POST /api/voice/transcribe": async (body) => ({
		text: await transcribe(credentials, body.endpoint as SpeechEndpoint, String(body.audio), String(body.mimeType ?? "audio/wav")),
	}),
	"POST /api/voice/speak": async (body) => ({
		audio: await speak(credentials, body.endpoint as SpeechEndpoint, String(body.text)),
		mimeType: "audio/wav",
	}),

	"GET /api/mcp": (_body, url) => listMcpServers(url.searchParams.get("cwd") || agent.cwd || repoRoot),
	"POST /api/mcp/add": async (body) => {
		const result = addMcpServer(String(body.cwd || agent.cwd), body.scope === "project" ? "project" : "global", String(body.name), body.config);
		await reloadAgent();
		return result;
	},
	"POST /api/mcp/remove": async (body) => {
		const result = removeMcpServer(String(body.cwd || agent.cwd), body.scope === "project" ? "project" : "global", String(body.name));
		await reloadAgent();
		return result;
	},
	"POST /api/mcp/enabled": async (body) => {
		setMcpServerEnabled(String(body.source), String(body.name), Boolean(body.enabled));
		await reloadAgent();
		return { ok: true };
	},
	"POST /api/mcp/exposure": async (body) => {
		setMcpServerExposure(String(body.source), String(body.name), body.exposure as "codemode" | "deferred" | "direct" | "hidden");
		await reloadAgent();
		return { ok: true };
	},
	// Sign-in runs inside the agent's MCP extension; its prompts arrive as extension dialogs in the chat window.
	"POST /api/mcp/command": async (body) => ({
		data: await agent.request({ type: "prompt", message: `/mcp ${String(body.action)} ${String(body.name ?? "")}`.trim() }),
	}),

	"GET /api/skills": (_body, url) => listInstalledSkills(url.searchParams.get("cwd") || agent.cwd || repoRoot, installedSkillCommands),
	"GET /api/skills/file": async (_body, url) => {
		const cwd = url.searchParams.get("cwd") || agent.cwd || repoRoot;
		const { skills } = await listInstalledSkills(cwd, installedSkillCommands);
		return readSkillFile(cwd, String(url.searchParams.get("path")), skills.map((skill) => skill.path));
	},
	"POST /api/skills/remove": async (body) => {
		const result = removeSkill(String(body.cwd || agent.cwd || repoRoot), String(body.path));
		await reloadAgent();
		return result;
	},
	"GET /api/skills/registry": (_body, url) =>
		skillRegistry.browse({
			query: url.searchParams.get("q") ?? "",
			sources: url.searchParams.getAll("source"),
			page: Number(url.searchParams.get("page") ?? 1),
			pageSize: Number(url.searchParams.get("pageSize") ?? 25),
			force: url.searchParams.get("refresh") === "1",
		}),
	"GET /api/skills/registry/detail": (_body, url) => skillRegistry.detail(String(url.searchParams.get("id"))),
	"POST /api/skills/registry/install": async (body) => {
		const result = await skillRegistry.install(String(body.id), String(body.cwd || agent.cwd || repoRoot), body.scope === "project" ? "project" : "user");
		await reloadAgent();
		return result;
	},

	// PDF attachments: the UI sends the file, the agent gets its text. Uses poppler's pdftotext.
	"POST /api/extract-pdf": (body) =>
		new Promise((resolve, reject) => {
			const child = execFile("pdftotext", ["-layout", "-", "-"], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
				if (error) reject(new HttpError(500, `PDF text extraction failed (is poppler's pdftotext installed?): ${error.message}`));
				else resolve({ text: stdout });
			});
			child.stdin?.end(Buffer.from(String(body.data), "base64"));
		}),

	"GET /api/mcp/raw": () => ({ path: mcpGlobalPath, text: existsSync(mcpGlobalPath) ? readFileSync(mcpGlobalPath, "utf8") : '{\n\t"mcpServers": {}\n}\n' }),
	"PUT /api/mcp/raw": async (body) => {
		const text = String(body.text);
		JSON.parse(text);
		mkdirSync(dirname(mcpGlobalPath), { recursive: true });
		writeFileSync(mcpGlobalPath, text, { mode: 0o600 });
		await reloadAgent();
		return { ok: true };
	},

	"GET /api/ssh": async () => ({
		hosts: ssh.publicHosts(),
		statuses: await ssh.statuses(),
		guardrails: sshGuardrails(),
		audit: ssh.auditLog(),
	}),
	"POST /api/ssh/hosts": (body) => ssh.save(body as never),
	"POST /api/ssh/remove": async (body) => {
		await ssh.remove(String(body.id));
		return { ok: true };
	},
	"POST /api/ssh/policy": (body) => {
		ssh.setPolicy(String(body.id), body.policy as SshPolicy);
		return { ok: true };
	},
	"POST /api/ssh/connect": (body) => ssh.connect(String(body.alias)),
	"POST /api/ssh/disconnect": async (body) => {
		await ssh.disconnect(String(body.alias));
		return { ok: true };
	},
	"PUT /api/ssh/guardrails": (body) => {
		// Remember which default rules existed, so a default the user deletes is not added back later.
		const ids = [...DEFAULT_SSH_GUARDRAILS.block, ...DEFAULT_SSH_GUARDRAILS.ask].map((rule) => rule.id);
		writeSettings({ ...readSettings(), ssh: { ...(body as object), addedRules: ids } });
		return { ok: true };
	},
	// Used only by the bridge extension's SSH tools; `exec` also requires the per-launch token.
	"POST /api/ssh/agent/hosts": async () => ({ hosts: ssh.publicHosts().map(({ id: _id, hasKey: _k, ...host }) => host), statuses: await ssh.statuses() }),
	"POST /api/ssh/agent/check": (body) => ssh.check(String(body.alias), String(body.command)),
	"POST /api/ssh/agent/exec": (body) =>
		ssh.exec(String(body.token), String(body.alias), String(body.command), body.approved === true, Number(body.timeout ?? 120)),

	"GET /api/browser": async () => ({ ...browser.status(), tabs: await browser.tabs() }),
	"POST /api/browser/view": async (body) => {
		await browser.view(body.on === true);
		return { ...browser.status(), tabs: await browser.tabs() };
	},
	// The user's own toolbar and input in the Browser pane.
	"POST /api/browser/act": (body) => browser.act(body as unknown as BrowserAction),
	"POST /api/browser/viewport": async (body) => {
		await browser.resize(Number(body.width), Number(body.height));
		return { ok: true };
	},
	"POST /api/browser/inspect": (body) => browser.inspect(Number(body.x), Number(body.y), body.full === true),
	"POST /api/browser/input": async (body) => {
		await browser.userInput(body as never);
		return { ok: true };
	},
	"PUT /api/browser/guardrails": (body) => {
		writeSettings({ ...readSettings(), browser: body });
		return browserGuardrails();
	},
	// Used only by the bridge extension's browser tools; `act` also requires the per-launch token.
	"POST /api/browser/agent/check": (body) => browser.check(body.input as BrowserAction),
	"GET /api/device/status": () => devices.status(),
	"POST /api/device/setup": (body) => devices.installSdk(body.acceptLicense === true),
	"POST /api/device/hub/start": async () => {
		await devices.startHub();
		return devices.status();
	},
	"POST /api/device/hub/restart": async () => {
		devices.stopHub();
		await devices.startHub();
		return devices.status();
	},
	"POST /api/device/boot": (body) => devices.boot(String(body.avd)),
	"POST /api/device/shutdown": async (body) => {
		await devices.shutdown(String(body.serial));
		return { ok: true };
	},
	"GET /api/device/list": () => devices.devices(),
	"GET /api/device/new-options": () => devices.newDeviceOptions(),
	"GET /api/device/latest-image": async () => ({ image: await devices.latestImage() }),
	"POST /api/device/install-image": (body) => devices.installImage(String(body.image), body.acceptLicense === true),
	"POST /api/device/create": (body) => devices.createAndBoot(String(body.name), String(body.image), String(body.profile ?? "")),
	"POST /api/device/rotate": async (body) => {
		await devices.rotate(String(body.serial));
		return { ok: true };
	},
	"POST /api/device/hub": (body) =>
		devices.hubProxy(body.method === "GET" ? "GET" : "POST", String(body.path), String(body.serial), body.body),
	"POST /api/device/inspect": (body) => devices.inspect(String(body.serial), Number(body.x), Number(body.y), body.full === true),
	"POST /api/device/metrics/watch": (body) => {
		devices.watchMetrics(String(body.serial));
		return { ok: true };
	},
	"POST /api/device/agent/act": (body) => devices.agentAct(String(body.token), body.input as DeviceAction),
	"POST /api/browser/agent/act": (body) => browser.agentAct(String(body.token), body.input as BrowserAction, body.approved === true),

	"GET /api/kokoro": () => kokoro.status(),
	"POST /api/kokoro/install": () => {
		kokoro.install();
		return kokoro.status();
	},
	"POST /api/kokoro/speak": (body) => ({
		streamId: kokoro.speak(String(body.text), String(body.voice ?? "af_heart"), Number(body.speed ?? 1), String(body.dtype ?? "q8")),
	}),
	"POST /api/kokoro/abort": (body) => {
		kokoro.abort(String(body.streamId));
		return { ok: true };
	},

	// Opens sign-in pages in the user's browser; the Tauri webview cannot open new windows itself.
	"POST /api/open": (body) => {
		const url = new URL(String(body.url));
		if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Only http(s) URLs can be opened");
		const [command, args] =
			process.platform === "darwin" ? ["open", [url.href]] : process.platform === "win32" ? ["explorer", [url.href]] : ["xdg-open", [url.href]];
		execFile(command, args, () => undefined).unref();
		return { ok: true };
	},

	// Side chat (/btw): see server/sidechat.ts. Answers stream as side-delta/side-tool/side-done events.
	"POST /api/sidechat/send": (body) => {
		sideChats.send(String(body.id), String(body.model), String(body.text ?? ""), typeof body.transcript === "string" ? body.transcript : undefined);
		return { ok: true };
	},
	"POST /api/sidechat/stop": (body) => {
		sideChats.stop(String(body.id));
		return { ok: true };
	},
	"POST /api/sidechat/close": (body) => {
		sideChats.close(String(body.id));
		return { ok: true };
	},
	// Local models (server/local.ts): llama.cpp engine, Hugging Face downloads, load/unload.
	"GET /api/local": () => local.status(),
	"GET /api/local/logs": () => ({ lines: local.recentLogs() }),
	"PUT /api/local/settings": async (body) => {
		const settings = local.saveSettings(body as Partial<LocalSettings>);
		return settings;
	},
	"POST /api/local/install": (body) => {
		void local.install(typeof body.variant === "string" ? body.variant : undefined).catch((error: unknown) => hub.broadcast("local-error", { message: String(error instanceof Error ? error.message : error) }));
		return { ok: true };
	},
	"POST /api/local/start": async () => {
		await local.start();
		return local.status();
	},
	"POST /api/local/stop": () => {
		local.stop();
		return { ok: true };
	},
	"POST /api/local/restart": async () => {
		await local.restart();
		return local.status();
	},
	"GET /api/local/models": () => local.models(),
	"GET /api/local/activity": async () => ({ requests: await local.activity() }),
	"POST /api/local/load": async (body) => {
		await local.load(String(body.model));
		return { ok: true };
	},
	"POST /api/local/remove": async (body) => {
		await local.remove(String(body.model));
		return { ok: true };
	},
	"POST /api/local/unload": async (body) => {
		await local.unload(String(body.model));
		return { ok: true };
	},
	"GET /api/local/downloads": () => ({ downloads: local.downloadList() }),
	"POST /api/local/download": async (body) => {
		await local.download(String(body.model), typeof body.size === "number" ? body.size : undefined);
		return { ok: true };
	},
	"POST /api/local/cancel": (body) => {
		local.cancel(String(body.task));
		return { ok: true };
	},
	"POST /api/local/search": (body) => local.search(String(body.query ?? "")),
	"POST /api/local/details": (body) => local.details(String(body.repo)),
	"POST /api/notify": (body) => {
		notify(String(body.title ?? "Sorvex").slice(0, 120), String(body.body ?? "").slice(0, 300));
		return { ok: true };
	},
	// Remote access (server/remote.ts). Phones cannot call these: they are not in its route allowlist.
	"GET /api/remote": () => remote.status(),
	"PUT /api/remote": (body) => remote.configure(body),
	"POST /api/remote/pair/start": () => remote.startPairing(),
	"POST /api/remote/pair/stop": () => remote.stopPairing(),
	"POST /api/remote/pair/answer": (body) => remote.answerPairing(String(body.id), body.allow === true),
	"POST /api/remote/revoke": (body) => remote.revoke(String(body.id)),
	"POST /api/remote/revoke-all": () => remote.revokeAll(),
	"POST /api/review": async (body) => ({
		text: await credentials.complete(String(body.model), String(body.systemPrompt), String(body.content)),
	}),
};

/** Runs one route. Used by the HTTP server and by paired phones (through remote access's allowlist). */
async function dispatch(method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
	const handler = routes[`${method} ${url.pathname}`];
	if (!handler) throw new HttpError(404, `No route ${method} ${url.pathname}`);
	return (await handler(body, url)) ?? { ok: true };
}

const remote = new RemoteAccess(hub, async (method, path, body) => {
	try {
		return { status: 200, body: await dispatch(method, new URL(path, `http://${HOST}`), body) };
	} catch (error) {
		return { status: error instanceof HttpError ? error.status : 500, body: { error: error instanceof Error ? error.message : String(error) } };
	}
});

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json",
	".woff2": "font/woff2",
};

function serveStatic(url: URL, response: ServerResponse): void {
	const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
	let file = join(distDir, relative);
	if (!file.startsWith(distDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(distDir, "index.html");
	if (!existsSync(file)) {
		send(response, 404, { error: "UI not built. Run `npm run build` in apps/desktop, or use the Vite dev server." });
		return;
	}
	response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
	createReadStream(file).pipe(response);
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

const server = createServer(async (request, response) => {
	const url = new URL(request.url ?? "/", `http://${HOST}`);
	try {
		if (!LOOPBACK.test(request.headers.host ?? "")) throw new HttpError(403, "Forbidden host");
		if (!url.pathname.startsWith("/api/")) {
			serveStatic(url, response);
			return;
		}
		if (url.pathname === "/api/events") {
			hub.attach(response);
			return;
		}
		if (request.method !== "GET" && request.headers["x-sorvex-desktop"] !== "1") throw new HttpError(403, "Missing header");
		const method = request.method ?? "GET";
		send(response, 200, await dispatch(method, url, method === "GET" ? {} : await readBody(request)));
	} catch (error) {
		send(response, error instanceof HttpError ? error.status : 500, {
			error: error instanceof Error ? error.message : String(error),
		});
	}
});

// One failed async task (for example a browser tab closing mid-request) must not take the whole app down.
process.on("unhandledRejection", (error) => {
	const line = `unhandled error: ${error instanceof Error ? error.message : String(error)}`;
	console.error(`[sorvex-desktop] ${line}`);
	hub.broadcast("agent-stderr", { line });
});

function shutdown(): void {
	remote.stop();
	void browser.close();
	local.stop();
	terminals.closeAll();
	agent.stop();
	kokoro.stop();
	devices.stopHub();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
	console.log(`[sorvex-desktop] server on http://${HOST}:${PORT}`);
	void local.autoStart();
});
