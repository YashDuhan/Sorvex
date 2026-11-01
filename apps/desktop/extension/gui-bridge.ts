/**
 * Sorvex Desktop bridge extension. The desktop app loads it into `sorvex --mode rpc` with `--extension`.
 *
 * - Tool permissions: each tool is "allow", "ask" or "deny". "ask" sends an approval request that the GUI
 *   shows inline above the composer (Allow once / Allow always / Deny).
 * - Safety rules: regex rules over bash commands and file paths that either ask or block, checked before
 *   tool permissions, so a rule can stop a call even when its tool is allowed.
 * - Approval mode: "edits" also allows file edits, "auto" allows every tool set to Ask unless a rule asks, and
 *   "full" asks for nothing. Block rules and Deny hold in every mode.
 * - `/gui-refresh-models`: rebuilds the available-model list after the GUI changes credentials.
 * - `/gui-reload`: reloads the session so MCP config edits take effect.
 * - Redacts credentials (tokens, keys, passwords in URLs or NAME=value pairs) from every tool result before the
 *   model sees it, so a harmless-looking command such as `git remote -v` cannot leak a token.
 * - Publishes the tool list to the GUI through the `sorvex-gui:tools` status key.
 *
 * Settings come from the JSON file in SORVEX_DESKTOP_SETTINGS, which the GUI writes. The file is re-read on
 * every tool call, so changes in the GUI apply to the next call without restarting the agent.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@sorvex/coding-agent";
import { Type } from "typebox";
import { redactSecrets } from "./redact.ts";

type Permission = "allow" | "ask" | "deny";

interface SafetyRule {
	id: string;
	name: string;
	enabled: boolean;
	/** "bash" matches the command; "path" matches the path argument of read/write/edit/grep/find/ls. */
	target: "bash" | "path";
	/** Regular expression source, matched case-insensitively. */
	pattern: string;
	action: "ask" | "block";
}

interface Settings {
	/** supervised | edits | auto | full; see ApprovalMode in src/settings.ts. */
	approvalMode?: "supervised" | "edits" | "auto" | "full";
	permissions?: { default?: Permission; tools?: Record<string, Permission> };
	rules?: SafetyRule[];
	[key: string]: unknown;
}

/** Title the GUI recognizes as a tool approval rather than a generic dialog. */
const APPROVAL_TITLE = "sorvex-gui:approval";
const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const ALLOW_ALWAYS = "Allow always";
const DENY = "Deny";
const APPROVED = new Set([ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS]);

/**
 * Approvals given with "Allow for this session", by key: a tool, a guardrail rule, an SSH rule on a host, or a kind
 * of browser action. Cleared when a session starts (new chat, switch, fork, reload or restart). Block rules never
 * consult this set.
 */
const sessionAllows = new Set<string>();

/** Asks the user unless this kind of action was already allowed for the session. Returns the choice. */
async function askApproval(ctx: ExtensionContext, key: string, options: string[], details: Record<string, unknown>): Promise<string | undefined> {
	if (sessionAllows.has(key)) return ALLOW_SESSION;
	const choice = await ctx.ui.select(APPROVAL_TITLE, options, { message: JSON.stringify(details) });
	if (choice === ALLOW_SESSION) sessionAllows.add(key);
	return choice;
}

const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
/** Tools "Auto-accept edits" approves: the ones that change files. */
const EDIT_TOOLS = new Set(["edit", "write"]);

const desktopUrl = process.env.SORVEX_DESKTOP_URL;
/**
 * Set by `/gui-ssh-init`, which the desktop server sends right after starting the agent. Kept in process memory
 * only, on globalThis so a session reload (which re-imports this module) keeps it.
 */
const tokenSlot = globalThis as { __sorvexDesktopSshToken?: string };

async function desktopApi<T>(path: string, body: unknown): Promise<T> {
	if (!desktopUrl) throw new Error("SSH tools are only available in Sorvex Desktop");
	const response = await fetch(`${desktopUrl}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-sorvex-desktop": "1" },
		body: JSON.stringify(body),
	});
	const data = (await response.json()) as T & { error?: string };
	if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
	return data;
}

const settingsPath = process.env.SORVEX_DESKTOP_SETTINGS;

function loadSettings(): Settings {
	if (!settingsPath) return {};
	try {
		return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
	} catch {
		return {};
	}
}

function saveToolPermission(toolName: string, permission: Permission): void {
	if (!settingsPath) return;
	const settings = loadSettings();
	const permissions = settings.permissions ?? {};
	settings.permissions = { ...permissions, tools: { ...permissions.tools, [toolName]: permission } };
	mkdirSync(dirname(settingsPath), { recursive: true });
	const temp = `${settingsPath}.ext.tmp`;
	writeFileSync(temp, JSON.stringify(settings, null, 2));
	renameSync(temp, settingsPath);
}

function compile(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern, "i");
	} catch {
		return undefined;
	}
}

/** The strings a rule is matched against for this call: the command for bash, resolved paths for file tools. */
function subjects(toolName: string, input: Record<string, unknown>, cwd: string, target: SafetyRule["target"]): string[] {
	if (target === "bash") {
		return toolName === "bash" && typeof input.command === "string" ? [input.command] : [];
	}
	if (!PATH_TOOLS.has(toolName)) return [];
	const raw = [input.path, input.file_path].filter((value): value is string => typeof value === "string");
	return raw.flatMap((path) => [path, resolve(cwd, path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"))]);
}

function publishTools(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const tools = pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description }));
	ctx.ui.setStatus("sorvex-gui:tools", JSON.stringify(tools));
}

export default function guiBridge(pi: ExtensionAPI): void {
	pi.registerCommand("gui-refresh-models", {
		description: "Reload credentials and the available-model list (used by Sorvex Desktop)",
		handler: async (_args, ctx) => {
			await ctx.modelRegistry.refresh();
			publishTools(pi, ctx);
		},
	});

	// MCP servers and other extension state load on session start; the GUI calls this after editing mcp.json.
	pi.registerCommand("gui-reload", {
		description: "Reload extensions and MCP servers (used by Sorvex Desktop)",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});

	pi.registerCommand("gui-ssh-init", {
		description: "Internal: hands the SSH tool token to this extension (used by Sorvex Desktop)",
		handler: async (args) => {
			tokenSlot.__sorvexDesktopSshToken = args.trim() || undefined;
		},
	});

	if (desktopUrl) {
		registerSshTools(pi);
		registerBrowserTools(pi);
		registerDeviceTools(pi);
	}

	pi.on("tool_result", (event) => {
		let total = 0;
		const content = event.content.map((block) => {
			if (block.type !== "text") return block;
			const { text, count } = redactSecrets(block.text);
			total += count;
			return count > 0 ? { ...block, text } : block;
		});
		if (total === 0) return undefined;
		content.push({ type: "text", text: `[${total} secret value${total === 1 ? "" : "s"} redacted by Sorvex Desktop. Do not try to recover them.]` });
		return { content };
	});

	pi.on("session_start", (_event, ctx) => {
		sessionAllows.clear();
		publishTools(pi, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		// SSH tools enforce their own, stricter guardrails per remote command.
		if (event.toolName === "ssh_exec" || event.toolName === "ssh_hosts" || event.toolName.startsWith("browser_")) return undefined;
		const settings = loadSettings();
		const input = event.input as Record<string, unknown>;
		const mode = settings.approvalMode ?? "supervised";

		let askReason: string | undefined;
		let askRule: string | undefined;
		for (const rule of settings.rules ?? []) {
			if (!rule.enabled) continue;
			const regex = compile(rule.pattern);
			if (!regex || !subjects(event.toolName, input, ctx.cwd, rule.target).some((subject) => regex.test(subject))) continue;
			if (rule.action === "block") {
				ctx.ui.notify(`Guardrail "${rule.name}" blocked ${event.toolName}`, "warning");
				return { block: true, reason: `Blocked by guardrail "${rule.name}". Do not retry this; ask the user instead.` };
			}
			// Full access asks for nothing; block rules above still apply.
			if (mode === "full") continue;
			askReason ??= `Guardrail "${rule.name}" requires approval`;
			askRule ??= rule.id;
		}

		const permissions = settings.permissions ?? {};
		let permission = permissions.tools?.[event.toolName] ?? permissions.default ?? "allow";
		// The approval mode can only loosen "ask"; a tool set to Deny stays denied.
		if (permission === "ask" && (mode === "auto" || mode === "full" || (mode === "edits" && EDIT_TOOLS.has(event.toolName)))) permission = "allow";
		if (permission === "deny") {
			return { block: true, reason: `Tool "${event.toolName}" is denied by the user's tool permissions.` };
		}
		if (permission === "allow" && !askReason) return undefined;

		if (!ctx.hasUI) return { block: true, reason: "Approval required, but no UI is attached." };

		// A rule-triggered prompt cannot be silenced with "Allow always": that would only allow the tool, not the pattern.
		const options = askReason ? [ALLOW_ONCE, ALLOW_SESSION, DENY] : [ALLOW_ONCE, ALLOW_SESSION, ALLOW_ALWAYS, DENY];
		const choice = await askApproval(ctx, askRule ? `rule:${askRule}` : `tool:${event.toolName}`, options, {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			input,
			reason: askReason,
		});

		if (choice === ALLOW_ALWAYS) {
			saveToolPermission(event.toolName, "allow");
			return undefined;
		}
		if (choice && APPROVED.has(choice)) return undefined;
		return { block: true, reason: "The user denied this tool call. Stop and ask how to proceed." };
	});
}

/**
 * `ssh_hosts` and `ssh_exec`: run commands on servers the user added in Sorvex Desktop. The model only sees
 * aliases. Each command is checked by the SSH guardrails on the desktop server (block / ask / allow, plus
 * read-only hosts); "ask" shows the inline approval box, and the server re-checks before running anything.
 */
/** Remote commands per agent run before every further one needs approval, even on "auto" hosts. */
const SSH_BURST_LIMIT = 6;

function registerSshTools(pi: ExtensionAPI): void {
	let commandsThisRun = 0;
	pi.on("agent_start", () => {
		commandsThisRun = 0;
	});

	pi.registerTool({
		name: "ssh_hosts",
		label: "SSH hosts",
		description:
			"List the remote servers the user configured for SSH, with their connection status and command policy (read-only, ask, auto). Call this before ssh_exec.",
		parameters: Type.Object({}),
		async execute() {
			const { hosts, statuses } = await desktopApi<{
				hosts: { alias: string; user: string; host: string; port: number; policy: string }[];
				statuses: Record<string, string>;
			}>("/api/ssh/agent/hosts", {});
			const text =
				hosts.length === 0
					? "No SSH hosts are configured. Ask the user to add one on the SSH page."
					: hosts.map((h) => `${h.alias}: ${h.user}@${h.host}:${h.port}, ${statuses[h.alias] ?? "unknown"}, policy ${h.policy}`).join("\n");
			return { content: [{ type: "text", text }], details: { hosts, statuses } };
		},
	});

	pi.registerTool({
		name: "ssh_exec",
		label: "SSH exec",
		description:
			"Run a shell command on a configured SSH server, by alias from ssh_hosts. Use as few calls as possible: " +
			"combine related read-only checks into one command (separate them with `;`), and stop as soon as you can answer. " +
			"If a command fails for lack of permission or a missing binary, report it instead of trying variants (sudo, full paths, other tools). " +
			"Never read secrets: .env files, environment dumps, keys, tokens, or credentials. " +
			"SSH guardrails apply: destructive commands are blocked, risky ones need the user's approval, read-only hosts allow only inspection, " +
			`and after ${SSH_BURST_LIMIT} commands in one reply every further command needs approval. ` +
			"If a command is blocked or denied, do not work around it; explain and ask the user.",
		parameters: Type.Object({
			host: Type.String({ description: "Host alias from ssh_hosts" }),
			command: Type.String({ description: "Command for the remote login shell" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 120, max 900)" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const { host, command, timeout } = params as { host: string; command: string; timeout?: number };
			const sshToken = tokenSlot.__sorvexDesktopSshToken;
			if (!sshToken) throw new Error("SSH is not ready in this session. Ask the user to restart the agent from Sorvex Desktop.");
			const check = await desktopApi<{ decision: "allow" | "ask" | "block"; reason?: string; key?: string }>("/api/ssh/agent/check", { alias: host, command });
			if (check.decision === "block") throw new Error(`${check.reason}. The command was not run. Do not retry it; ask the user.`);
			commandsThisRun++;
			const overBudget = commandsThisRun > SSH_BURST_LIMIT && check.decision === "allow";
			const reason = overBudget ? `More than ${SSH_BURST_LIMIT} remote commands in this reply` : check.reason;
			let approved = false;
			if (check.decision === "ask" || overBudget) {
				if (!ctx.hasUI) throw new Error("This command needs approval, but no UI is attached.");
				const key = overBudget ? `ssh:${host}:burst` : (check.key ?? `ssh:${host}:${command}`);
				const choice = await askApproval(ctx, key, [ALLOW_ONCE, ALLOW_SESSION, DENY], { toolCallId, toolName: "ssh_exec", input: { host, command }, reason });
				if (!choice || !APPROVED.has(choice)) throw new Error("The user denied this remote command. It was not run. Stop and ask how to proceed.");
				approved = true;
			}
			const result = await desktopApi<{ stdout: string; stderr: string; code: number | null; truncated: boolean }>("/api/ssh/agent/exec", {
				token: sshToken,
				alias: host,
				command,
				approved,
				timeout,
			});
			const text = [
				result.stdout.trimEnd(),
				result.stderr.trim() ? `[stderr]\n${result.stderr.trimEnd()}` : "",
				`[exit code ${result.code ?? "?"}${result.truncated ? ", output truncated" : ""}]`,
			]
				.filter(Boolean)
				.join("\n");
			return { content: [{ type: "text", text }], details: { host, command, exitCode: result.code } };
		},
	});
}

/**
 * browser_* tools: drive the shared Chromium tab that the user sees in the Browser pane. Each action is checked by
 * the browser guardrails on the desktop server: typing into password or payment fields and non-http URLs are
 * blocked, and form submits (and optionally new domains) wait for the user's approval.
 */
function registerBrowserTools(pi: ExtensionAPI): void {
	type Input = Record<string, unknown> & { action: string };

	const run = async (toolCallId: string, input: Input, ctx: ExtensionContext) => {
		const token = tokenSlot.__sorvexDesktopSshToken;
		if (!token) throw new Error("The browser is not ready in this session. Ask the user to restart the agent from Sorvex Desktop.");
		const check = await desktopApi<{ decision: "allow" | "ask" | "block"; reason?: string; key?: string }>("/api/browser/agent/check", { input });
		if (check.decision === "block") throw new Error(`${check.reason}`);
		let approved = false;
		if (check.decision === "ask") {
			if (!ctx.hasUI) throw new Error("This browser action needs approval, but no UI is attached.");
			const choice = await askApproval(ctx, check.key ?? `browser:${input.action}`, [ALLOW_ONCE, ALLOW_SESSION, DENY], {
				toolCallId,
				toolName: `browser_${input.action}`,
				input,
				reason: check.reason,
			});
			if (!choice || !APPROVED.has(choice)) throw new Error("The user denied this browser action. Nothing was done. Stop and ask how to proceed.");
			approved = true;
		}
		const result = await desktopApi<{ text: string; image?: string }>("/api/browser/agent/act", { token, input, approved });
		const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: result.text }];
		if (result.image) content.push({ type: "image", data: result.image, mimeType: "image/jpeg" });
		return { content, details: { action: input.action, show: input.action === "screenshot" && input.show === true } };
	};

	const tool = (name: string, description: string, parameters: ReturnType<typeof Type.Object>, toInput: (params: Record<string, unknown>) => Input) =>
		pi.registerTool({
			name,
			label: name.replace("_", " "),
			description,
			parameters,
			execute: (toolCallId, params, _signal, _onUpdate, ctx) => run(toolCallId, toInput(params as Record<string, unknown>), ctx),
		});

	const guide =
		" The browser is shared with the user, who watches it in the Browser pane. Use browser_snapshot to get numbered elements, then act by ref." +
		" Never type passwords, card numbers or one-time codes; ask the user to do that in the Browser pane.";

	tool("browser_navigate", `Open a URL (http or https) in the shared browser.${guide}`, Type.Object({ url: Type.String() }), (p) => ({ action: "navigate", url: p.url }));
	tool(
		"browser_snapshot",
		`List the page's interactive elements with numbers (refs), plus URL, title and headings. Refs change after the page changes, so snapshot again before acting.${guide}`,
		Type.Object({}),
		() => ({ action: "snapshot" }),
	);
	tool(
		"browser_click",
		`Click an element by ref from browser_snapshot, or at x/y page coordinates.${guide}`,
		Type.Object({ ref: Type.Optional(Type.Number()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }),
		(p) => ({ action: "click", ref: p.ref, x: p.x, y: p.y }),
	);
	tool(
		"browser_type",
		`Type text into an element by ref (replacing its value), optionally pressing Enter afterwards.${guide}`,
		Type.Object({ ref: Type.Number(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
		(p) => ({ action: "type", ref: p.ref, text: p.text, submit: p.submit }),
	);
	tool("browser_press", `Press a key, such as Enter, Escape, Tab, ArrowDown or Control+A.${guide}`, Type.Object({ key: Type.String() }), (p) => ({ action: "press", key: p.key }));
	tool("browser_scroll", "Scroll the page vertically by dy pixels (negative scrolls up).", Type.Object({ dy: Type.Number() }), (p) => ({ action: "scroll", dy: p.dy }));
	tool("browser_read", "Return the visible text of the current page (up to 20,000 characters).", Type.Object({}), () => ({ action: "read" }));
	tool(
		"browser_screenshot",
		"Take a screenshot of the current page and return it as an image. Set show to true only when the user should see this image in the chat, e.g. they asked for a screenshot or it shows the result they asked for. Leave it false for screenshots you take to inspect the page yourself.",
		Type.Object({ show: Type.Optional(Type.Boolean()) }),
		(p) => ({ action: "screenshot", show: p.show === true }),
	);
	tool(
		"browser_viewport",
		"Set the page's viewport size, e.g. to check a responsive layout: then take browser_screenshot at each size. preset: a device id such as iphone-12-pro, pixel-7, ipad-air or desktop-1440, " +
			'"list" to list every preset and the current viewport, or "responsive" to follow the Browser pane again; or give width and height in CSS pixels for a custom size. ' +
			"The user sees the same viewport, so set it back to responsive when you are done unless they asked to keep it.",
		Type.Object({ preset: Type.Optional(Type.String()), width: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()) }),
		(p) => ({ action: "viewport", preset: p.preset, width: p.width, height: p.height }),
	);
	tool("browser_back", "Go back to the previous page.", Type.Object({}), () => ({ action: "back" }));
	tool(
		"browser_tabs",
		"List, open, switch or close browser tabs. op: list | new (optional url) | switch (id) | close (id). The active tab is marked with *.",
		Type.Object({ op: Type.String(), id: Type.Optional(Type.Number()), url: Type.Optional(Type.String()) }),
		(p) => ({ action: "tabs", op: p.op, id: p.id, url: p.url }),
	);
	tool("browser_console", "Return the last 50 console messages and page errors.", Type.Object({}), () => ({ action: "console" }));
	tool(
		"browser_wait",
		"Wait for some text to appear on the page, or for a number of milliseconds (max 10s).",
		Type.Object({ text: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()) }),
		(p) => ({ action: "wait", text: p.text, ms: p.ms }),
	);
}

/**
 * device_* tools: drive the Android emulator the user sees in the Device pane, over adb. device_ui lists the screen's
 * elements with refs; tap and type act on a ref or on screen pixel coordinates.
 */
function registerDeviceTools(pi: ExtensionAPI): void {
	type Input = Record<string, unknown> & { action: string };

	const run = async (input: Input) => {
		const token = tokenSlot.__sorvexDesktopSshToken;
		if (!token) throw new Error("Device tools are not ready in this session. Ask the user to restart the agent from Sorvex Desktop.");
		const result = await desktopApi<{ text: string; image?: string; mimeType?: string }>("/api/device/agent/act", { token, input });
		const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: result.text }];
		if (result.image) content.push({ type: "image", data: result.image, mimeType: result.mimeType ?? "image/png" });
		return { content, details: { action: input.action, show: input.action === "screenshot" && input.show === true } };
	};

	const serial = { serial: Type.Optional(Type.String({ description: "adb serial, e.g. emulator-5554. Defaults to the running emulator." })) };
	const tool = (name: string, description: string, parameters: ReturnType<typeof Type.Object>, toInput: (params: Record<string, unknown>) => Input) =>
		pi.registerTool({
			name,
			label: name.replace("_", " "),
			description,
			parameters,
			execute: (_toolCallId, params) => run(toInput(params as Record<string, unknown>)),
		});

	const guide = " The device is an Android emulator shared with the user, who watches it in the Device pane. Call device_ui to get numbered elements, then act by ref.";

	tool("device_list", "List running Android devices and the virtual devices (AVDs) that can be booted.", Type.Object({}), () => ({ action: "devices" }));
	tool(
		"device_boot",
		`Boot an Android virtual device (the first one when avd is omitted) and wait until it has started.${guide}`,
		Type.Object({ avd: Type.Optional(Type.String()) }),
		(p) => ({ action: "boot", avd: p.avd }),
	);
	tool(
		"device_ui",
		`List the current screen's elements with refs, labels and center coordinates, plus the foreground app. Refs change when the screen changes, so call it again before acting.${guide}`,
		Type.Object(serial),
		(p) => ({ action: "ui", serial: p.serial }),
	);
	tool(
		"device_screenshot",
		"Take a screenshot of the device screen. Set show to true only when the user should see the image in the chat; leave it false when you are inspecting the screen yourself.",
		Type.Object({ ...serial, show: Type.Optional(Type.Boolean()) }),
		(p) => ({ action: "screenshot", serial: p.serial, show: p.show === true }),
	);
	tool(
		"device_tap",
		`Tap an element by ref from device_ui, or at x/y screen pixels. Set long to true for a long press.${guide}`,
		Type.Object({ ...serial, ref: Type.Optional(Type.Number()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), long: Type.Optional(Type.Boolean()) }),
		(p) => ({ action: "tap", serial: p.serial, ref: p.ref, x: p.x, y: p.y, long: p.long }),
	);
	tool(
		"device_type",
		`Type ASCII text into the focused field, or tap the element with ref first. Set submit to press Enter afterwards. Never type passwords or payment details; ask the user to enter them in the Device pane.${guide}`,
		Type.Object({ ...serial, text: Type.String(), ref: Type.Optional(Type.Number()), submit: Type.Optional(Type.Boolean()) }),
		(p) => ({ action: "type", serial: p.serial, text: p.text, ref: p.ref, submit: p.submit }),
	);
	tool(
		"device_swipe",
		"Swipe from x1,y1 to x2,y2 in screen pixels, or in a direction: up (scrolls content down), down, left, right. ms sets the duration (default 300).",
		Type.Object({
			...serial,
			direction: Type.Optional(Type.String()),
			x1: Type.Optional(Type.Number()),
			y1: Type.Optional(Type.Number()),
			x2: Type.Optional(Type.Number()),
			y2: Type.Optional(Type.Number()),
			ms: Type.Optional(Type.Number()),
		}),
		(p) => ({ action: "swipe", serial: p.serial, direction: p.direction, x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, ms: p.ms }),
	);
	tool(
		"device_key",
		"Press a hardware or system key: back, home, recents, enter, delete, tab, escape, power, volume_up, volume_down, menu, search, up, down, left, right, or an Android keycode number.",
		Type.Object({ ...serial, key: Type.String() }),
		(p) => ({ action: "key", serial: p.serial, key: p.key }),
	);
	tool("device_launch", "Launch an installed app by package name, e.g. com.android.settings.", Type.Object({ ...serial, package: Type.String() }), (p) => ({
		action: "launch",
		serial: p.serial,
		package: p.package,
	}));
	tool("device_open_url", "Open a URL or deep link (myapp://...) on the device.", Type.Object({ ...serial, url: Type.String() }), (p) => ({ action: "open_url", serial: p.serial, url: p.url }));
	tool("device_install", "Install or update an APK from an absolute path on this computer.", Type.Object({ ...serial, path: Type.String() }), (p) => ({
		action: "install",
		serial: p.serial,
		path: p.path,
	}));
	tool("device_apps", "List the apps installed on the device, excluding system apps.", Type.Object(serial), (p) => ({ action: "apps", serial: p.serial }));
	tool(
		"device_wait",
		"Wait on the device. With text: re-read the screen until that text (or content description) appears, up to timeoutMs (default 10s, max 30s). With only ms: pause that long (max 10s). With neither: wait until the screen has labelled elements again, e.g. after an app launch or a dialog closing. Use it instead of guessing; then call device_ui.",
		Type.Object({ ...serial, text: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()), timeoutMs: Type.Optional(Type.Number()) }),
		(p) => ({ action: "wait", serial: p.serial, text: p.text, ms: p.ms, timeoutMs: p.timeoutMs }),
	);
	tool(
		"device_logcat",
		"Return recent device logs. lines defaults to 200; filter is a logcat filter spec such as 'ActivityManager:I *:S'.",
		Type.Object({ ...serial, lines: Type.Optional(Type.Number()), filter: Type.Optional(Type.String()) }),
		(p) => ({ action: "logcat", serial: p.serial, lines: p.lines, filter: p.filter }),
	);
}
