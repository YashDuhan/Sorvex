import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Container, Editor, setKeybindings, TuiMainScreen } from "@sorvex/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";

const childProcessMocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(() => ({ status: 0 })),
}));

vi.mock("node:child_process", () => childProcessMocks);

import { printHelp } from "../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { BugReportBundle } from "../src/core/bug-report.ts";
import { uploadBugReport } from "../src/core/bug-report-upload.ts";
import { DEFAULT_ENDPOINTS, getEndpoints, resetEndpointWarnings } from "../src/core/endpoints.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { reportBug } from "../src/modes/interactive/bug-report.ts";
import { ExtensionEditorComponent } from "../src/modes/interactive/components/extension-editor.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { shareSession } from "../src/modes/interactive/session-share.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";
import { getLatestPiRelease } from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const OVERRIDE_VARS = [
	"SORVEX_VERSION_CHECK_URL",
	"SORVEX_INSTALLER_API_BASE",
	"SORVEX_INSTALL_REPORT_URL",
	"SORVEX_BUG_REPORT_URL",
	"SORVEX_SHARE_VIEWER_URL",
	"SORVEX_TELEMETRY",
	"SORVEX_SKIP_VERSION_CHECK",
	"SORVEX_MANAGED_INSTALL_ROOT",
	"SORVEX_OFFLINE",
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	allowNetwork();
	resetEndpointWarnings();
	vi.clearAllMocks();
	for (const name of OVERRIDE_VARS) vi.stubEnv(name, undefined);
	fetchMock = vi.fn(async () => Response.json({ version: "999.0.0" }));
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function requestedUrls(): string[] {
	return fetchMock.mock.calls.map(([input]) =>
		typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url,
	);
}

function bundle(): BugReportBundle {
	return {
		metadata: { id: "r1" },
		diagnostics: { crashes: [] },
	} as unknown as BugReportBundle;
}

describe("endpoint table", () => {
	it("keeps only the catalog and MCP OAuth metadata on by default", () => {
		const endpoints = getEndpoints();
		expect(endpoints.versionCheck).toBeUndefined();
		expect(endpoints.installerReleases).toBeUndefined();
		expect(endpoints.installReport).toBeUndefined();
		expect(endpoints.bugReportUpload).toBeUndefined();
		expect(endpoints.shareViewer).toBeUndefined();
		expect(endpoints.modelCatalog).toBe("https://pi.dev");
		expect(endpoints.mcpOAuthClientMetadata).toBe("https://pi.dev/oauth");
		expect(DEFAULT_ENDPOINTS.versionCheck).toBeUndefined();
	});

	it("turns a feature on from its override and ignores blank values", () => {
		expect(getEndpoints({ SORVEX_VERSION_CHECK_URL: " https://v.test/latest " }).versionCheck).toBe(
			"https://v.test/latest",
		);
		expect(getEndpoints({ SORVEX_VERSION_CHECK_URL: "  " }).versionCheck).toBeUndefined();
	});

	it("treats a malformed or non-http(s) override as absent and warns once per variable", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = {
			SORVEX_INSTALL_REPORT_URL: "not a url",
			SORVEX_BUG_REPORT_URL: "file:///etc/passwd",
			SORVEX_SHARE_VIEWER_URL: "javascript:alert(1)",
			SORVEX_VERSION_CHECK_URL: "http://v.test/latest",
		};
		const endpoints = getEndpoints(env);
		getEndpoints(env);
		expect(endpoints.installReport).toBeUndefined();
		expect(endpoints.bugReportUpload).toBeUndefined();
		expect(endpoints.shareViewer).toBeUndefined();
		expect(endpoints.versionCheck).toBe("http://v.test/latest");
		const warnings = warn.mock.calls.map(([message]) => String(message));
		expect(warnings).toHaveLength(3);
		expect(warnings.join("\n")).toContain("SORVEX_INSTALL_REPORT_URL");
	});
});

describe("version check", () => {
	it("makes no request when off", async () => {
		await expect(getLatestPiRelease("1.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls the table URL when on", async () => {
		vi.stubEnv("SORVEX_VERSION_CHECK_URL", "https://v.test/latest");
		await expect(getLatestPiRelease("1.0.0")).resolves.toEqual({ version: "999.0.0" });
		expect(requestedUrls()).toEqual(["https://v.test/latest"]);
	});

	it("makes no request in offline mode even when on", async () => {
		vi.stubEnv("SORVEX_VERSION_CHECK_URL", "https://v.test/latest");
		vi.stubEnv("SORVEX_OFFLINE", "1");
		await expect(getLatestPiRelease("1.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("SORVEX_OFFLINE values", () => {
	it.each(["0", "false", "no", ""])("treats %j as online", async (value) => {
		vi.stubEnv("SORVEX_VERSION_CHECK_URL", "https://v.test/latest");
		vi.stubEnv("SORVEX_OFFLINE", value);
		await expect(getLatestPiRelease("1.0.0")).resolves.toEqual({ version: "999.0.0" });
	});

	it.each(["1", "true", "TRUE", "yes"])("treats %j as offline", async (value) => {
		vi.stubEnv("SORVEX_VERSION_CHECK_URL", "https://v.test/latest");
		vi.stubEnv("SORVEX_OFFLINE", value);
		await expect(getLatestPiRelease("1.0.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("install report", () => {
	const report = (version: string) =>
		(
			InteractiveMode.prototype as unknown as { reportInstallTelemetry(this: unknown, version: string): void }
		).reportInstallTelemetry.call({ settingsManager: SettingsManager.inMemory() }, version);

	it("sends nothing when off", () => {
		report("1.2.3");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("calls the table URL with the version when on", () => {
		vi.stubEnv("SORVEX_INSTALL_REPORT_URL", "https://r.test/report");
		report("1.2.3");
		expect(requestedUrls()).toEqual(["https://r.test/report?version=1.2.3"]);
	});

	it("does not throw and sends nothing when the override is malformed", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("SORVEX_INSTALL_REPORT_URL", "::not-a-url::");
		expect(() => report("1.2.3")).not.toThrow();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("sends nothing in offline mode or with telemetry disabled even when on", () => {
		vi.stubEnv("SORVEX_INSTALL_REPORT_URL", "https://r.test/report");
		vi.stubEnv("SORVEX_TELEMETRY", "0");
		report("1.2.3");
		vi.stubEnv("SORVEX_TELEMETRY", undefined);
		vi.stubEnv("SORVEX_OFFLINE", "1");
		report("1.2.3");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("bug report upload", () => {
	it("makes no request when off", async () => {
		await expect(uploadBugReport(bundle())).rejects.toThrow("not available");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("posts to the table URL when on", async () => {
		vi.stubEnv("SORVEX_BUG_REPORT_URL", "https://b.test/v1/bug-reports");
		fetchMock.mockImplementation(async () => Response.json({ ok: true, bug_report: { id: "abc" } }));
		await expect(uploadBugReport(bundle())).resolves.toEqual({ id: "abc" });
		expect(requestedUrls()).toEqual(["https://b.test/v1/bug-reports"]);
	});
});

describe("/bug", () => {
	const RADIUS_TOKEN = "radius-secret-token";
	let tempDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;

	beforeAll(() => initTheme("dark"));

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "endpoints-bug-"));
		mkdirSync(join(tempDir, "agent"), { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = join(tempDir, "agent");
		process.chdir(tempDir);
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function bugContext(statuses: string[], errors: string[]) {
		const ui = new TuiMainScreen(new VirtualTerminal());
		const editorContainer = new Container();
		const editor = new Editor(ui, getEditorTheme());
		const getAuth = vi.fn(async () => ({ type: "api_key", key: RADIUS_TOKEN }));
		const session = {
			model: undefined,
			sessionId: "s",
			messages: [],
			thinkingLevel: "off",
			resourceLoader: { getExtensions: () => ({ extensions: [], errors: [] }) },
			modelRuntime: { getProvider: () => ({ id: "radius" }), getAuth },
			sessionManager: {
				getCwd: () => tempDir,
				getEntries: () => [],
				getSessionId: () => "s",
				appendCustomEntry: vi.fn(),
			},
			settingsManager: {
				getExternalEditorCommand: () => "nano",
				getGlobalSettings: () => ({}),
				getProjectSettings: () => ({}),
			},
		} as unknown as AgentSession;
		return {
			getAuth,
			editorContainer,
			context: {
				session,
				ui,
				editorContainer,
				editor,
				keybindings: new KeybindingsManager(),
				showStatus: (message: string) => statuses.push(message),
				showError: (message: string) => errors.push(message),
			},
		};
	}

	async function nextSelector(editorContainer: Container): Promise<ExtensionSelectorComponent> {
		await vi.waitFor(() => expect(editorContainer.children[0]).toBeInstanceOf(ExtensionSelectorComponent));
		return editorContainer.children[0] as ExtensionSelectorComponent;
	}

	/** Answer the description and transcript prompts, decline the summary, and return the delivery selector. */
	async function reachDelivery(editorContainer: Container): Promise<ExtensionSelectorComponent> {
		const description = editorContainer.children[0];
		if (!(description instanceof ExtensionEditorComponent)) throw new Error("Missing description editor");
		description.handleInput("\r");
		(await nextSelector(editorContainer)).handleInput("j");
		(editorContainer.children[0] as ExtensionSelectorComponent).handleInput("\r");
		const summary = await nextSelector(editorContainer);
		summary.handleInput("j");
		summary.handleInput("\r");
		return nextSelector(editorContainer);
	}

	it("offers only Export as Zip by default and uploads nothing", async () => {
		const statuses: string[] = [];
		const errors: string[] = [];
		const { context, editorContainer } = bugContext(statuses, errors);
		const report = reportBug(context);
		const delivery = await reachDelivery(editorContainer);
		const text = delivery.render(120).join("\n");
		expect(text).toContain("Export as Zip");
		expect(text).not.toContain("Upload Report");
		delivery.handleInput("\r");
		await report;
		expect(errors).toEqual([]);
		expect(statuses.join("\n")).toContain("Bug report exported to:");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("uploads without the Radius token when an upload URL is set", async () => {
		vi.stubEnv("SORVEX_BUG_REPORT_URL", "https://b.test/v1/bug-reports");
		fetchMock.mockImplementation(async () => Response.json({ ok: true, bug_report: { id: "abc" } }));
		const statuses: string[] = [];
		const errors: string[] = [];
		const { context, editorContainer, getAuth } = bugContext(statuses, errors);
		const report = reportBug(context);
		const delivery = await reachDelivery(editorContainer);
		expect(delivery.render(120).join("\n")).toContain("b.test");
		delivery.handleInput("\r");
		await report;
		expect(errors).toEqual([]);
		expect(statuses.join("\n")).toContain("Report ID: abc");
		expect(requestedUrls()).toEqual(["https://b.test/v1/bug-reports"]);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(RADIUS_TOKEN);
		expect(getAuth).not.toHaveBeenCalled();
	});

	it("does not throw on a malformed upload URL and offers only Export as Zip", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("SORVEX_BUG_REPORT_URL", "not a url");
		const statuses: string[] = [];
		const errors: string[] = [];
		const { context, editorContainer } = bugContext(statuses, errors);
		const report = reportBug(context);
		const delivery = await reachDelivery(editorContainer);
		expect(delivery.render(120).join("\n")).not.toContain("Upload Report");
		delivery.handleInput("\r");
		await report;
		expect(errors).toEqual([]);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not offer Upload Report under SORVEX_OFFLINE even when an upload URL is set", async () => {
		vi.stubEnv("SORVEX_BUG_REPORT_URL", "https://b.test/v1/bug-reports");
		vi.stubEnv("SORVEX_OFFLINE", "1");
		const statuses: string[] = [];
		const errors: string[] = [];
		const { context, editorContainer } = bugContext(statuses, errors);
		const report = reportBug(context);
		const delivery = await reachDelivery(editorContainer);
		const text = delivery.render(120).join("\n");
		expect(text).toContain("Export as Zip");
		expect(text).not.toContain("Upload Report");
		expect(text).not.toContain("b.test");
		delivery.handleInput("\r");
		await report;
		expect(errors).toEqual([]);
		expect(statuses.join("\n")).toContain("Bug report exported to:");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("still offers Upload Report when SORVEX_OFFLINE=0", async () => {
		vi.stubEnv("SORVEX_BUG_REPORT_URL", "https://b.test/v1/bug-reports");
		vi.stubEnv("SORVEX_OFFLINE", "0");
		const { context, editorContainer } = bugContext([], []);
		const report = reportBug(context);
		const delivery = await reachDelivery(editorContainer);
		expect(delivery.render(120).join("\n")).toContain("Upload Report");
		delivery.handleInput("j");
		delivery.handleInput("j");
		delivery.handleInput("\r");
		await report;
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("share", () => {
	beforeAll(() => initTheme("dark"));

	function shareContext(statuses: string[], errors: string[], destination = "auto") {
		return {
			session: {
				sessionManager: { getSessionId: () => "s", getCwd: () => "/tmp", getBranch: () => [] },
				state: { systemPrompt: "", tools: [] },
				settingsManager: { getSessionShareDestination: () => destination },
				// A signed-in Radius provider: /share must still not upload to Radius.
				modelRuntime: {
					getProvider: () => ({ id: "radius" }),
					getAuth: async () => ({ type: "api_key", key: "radius-secret-token" }),
				},
				exportToHtml: async () => {},
			},
			ui: { setFocus() {}, requestRender() {} },
			editorContainer: { clear() {}, addChild() {} },
			editor: {},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
		} as never;
	}

	it("reports sharing is off and makes no gist or network call when off", async () => {
		const statuses: string[] = [];
		const errors: string[] = [];
		await shareSession(shareContext(statuses, errors));
		expect(statuses.join("\n")).toContain("Sharing is off");
		expect(statuses.join("\n")).toContain("SORVEX_SHARE_VIEWER_URL");
		expect(errors).toEqual([]);
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
		expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	function mockGist(): void {
		childProcessMocks.spawn.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(),
			});
			queueMicrotask(() => {
				child.stdout.end("https://gist.github.com/test/g1\n");
				child.stderr.end();
				child.emit("close", 0);
			});
			return child;
		});
	}

	it("uses the table viewer URL when on", async () => {
		vi.stubEnv("SORVEX_SHARE_VIEWER_URL", "https://s.test/session/");
		mockGist();
		const statuses: string[] = [];
		await shareSession(shareContext(statuses, []));
		expect(statuses[0]).toContain("https://s.test/session/#g1");
	});

	it.each(["auto", "radius"])(
		"makes no Radius request with a viewer set and Radius signed in (destination %s)",
		async (destination) => {
			vi.stubEnv("SORVEX_SHARE_VIEWER_URL", "https://s.test/session/");
			mockGist();
			const statuses: string[] = [];
			const errors: string[] = [];
			await shareSession(shareContext(statuses, errors, destination));
			expect(fetchMock).not.toHaveBeenCalled();
			expect(errors).toEqual([]);
			expect(childProcessMocks.spawn).toHaveBeenCalledWith("gh", [
				"gist",
				"create",
				"--public=false",
				expect.any(String),
			]);
			expect(statuses[0]).toContain("https://s.test/session/#g1");
		},
	);

	it("shares when SORVEX_OFFLINE=0", async () => {
		vi.stubEnv("SORVEX_SHARE_VIEWER_URL", "https://s.test/session/");
		vi.stubEnv("SORVEX_OFFLINE", "0");
		mockGist();
		const statuses: string[] = [];
		const errors: string[] = [];
		await shareSession(shareContext(statuses, errors));
		expect(errors).toEqual([]);
		expect(statuses[0]).toContain("https://s.test/session/#g1");
	});

	it("shows an invalid viewer URL in the UI instead of only on stderr", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.stubEnv("SORVEX_SHARE_VIEWER_URL", "javascript:alert(1)");
		const statuses: string[] = [];
		const errors: string[] = [];
		await shareSession(shareContext(statuses, errors));
		await shareSession(shareContext(statuses, errors));
		expect(errors).toHaveLength(2);
		expect(errors[0]).toContain("SORVEX_SHARE_VIEWER_URL");
		expect(errors[0]).toContain("not an http(s) URL");
		expect(statuses).toEqual([]);
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
	});

	it("is off under SORVEX_OFFLINE even with a viewer set", async () => {
		vi.stubEnv("SORVEX_SHARE_VIEWER_URL", "https://s.test/session/");
		vi.stubEnv("SORVEX_OFFLINE", "1");
		mockGist();
		const errors: string[] = [];
		await shareSession(shareContext([], errors));
		expect(errors.join("\n")).toContain("requires online mode");
		expect(childProcessMocks.spawn).not.toHaveBeenCalled();
		expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("reads a saved radius destination as the default", () => {
		const settings = SettingsManager.inMemory({ sessionShareDestination: "radius" } as never);
		expect(settings.getSessionShareDestination()).toBe("auto");
	});
});

describe("self-update", () => {
	let tempDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "endpoints-update-"));
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		process.chdir(projectDir);
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		process.exitCode = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("says self-update is not available, exits 0, and makes no request when off", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await handlePackageCommand(["update", "--self"])).toBe(true);
		const output = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
		expect(output).toContain("self-update is not available yet");
		expect(output).toContain("npm run build");
		expect(errorSpy).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats SORVEX_INSTALLER_API_BASE alone as off: not available, no request", async () => {
		vi.stubEnv("SORVEX_INSTALLER_API_BASE", "https://i.test/releases");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await handlePackageCommand(["update", "--self"])).toBe(true);
		expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
			"self-update is not available yet",
		);
		expect(process.exitCode).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("documents in help that SORVEX_INSTALLER_API_BASE needs SORVEX_VERSION_CHECK_URL", () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		printHelp();
		const line = logSpy.mock.calls
			.map(([message]) => String(message))
			.join("\n")
			.split("\n")
			.find((entry) => entry.includes("SORVEX_INSTALLER_API_BASE"));
		expect(line).toContain("SORVEX_VERSION_CHECK_URL");
	});

	it("asks the version check URL when on", async () => {
		vi.stubEnv("SORVEX_VERSION_CHECK_URL", "https://v.test/latest");
		fetchMock.mockImplementation(async () => Response.json({ version: "0.0.1" }));
		vi.spyOn(console, "log").mockImplementation(() => {});
		await handlePackageCommand(["update", "--self"]);
		expect(requestedUrls()).toEqual(["https://v.test/latest"]);
	});
});
