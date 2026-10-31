import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@sorvex/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import { getEndpoints, getInvalidOverride } from "../../core/endpoints.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { isOfflineMode } from "../../utils/env-flag.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

/** Trailing `pi.share` entry carrying the system prompt and tool schemas for the session viewer. */
export function createShareTrailingEntries(
	session: AgentSession,
	parentId: string | null,
	timestamp: string,
): object[] {
	return [
		{
			type: "custom",
			customType: "pi.share",
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	];
}

/** Export the current branch with presentation metadata for the session viewer. */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) =>
		createShareTrailingEntries(session, parentId, timestamp),
	);
}

/** Share the current session as a private GitHub gist, linked through the configured session viewer. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const viewerUrl = getEndpoints().shareViewer;
	if (!viewerUrl) {
		const invalid = getInvalidOverride("SORVEX_SHARE_VIEWER_URL");
		if (invalid !== undefined) {
			context.showError(
				`Sharing is off: SORVEX_SHARE_VIEWER_URL is ${JSON.stringify(invalid)}, which is not an http(s) URL. Nothing was uploaded.`,
			);
			return;
		}
		context.showStatus(
			"Sharing is off: no session viewer is configured, so nothing was uploaded. To turn it on, set SORVEX_SHARE_VIEWER_URL to a session viewer base URL.",
		);
		return;
	}
	if (isOfflineMode()) {
		context.showError("Sharing requires online mode. Unset SORVEX_OFFLINE to share; nothing was uploaded.");
		return;
	}
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-share-"));
	const htmlFile = path.join(tempDir, "session.html");

	try {
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		try {
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		await shareViaGist(htmlFile, viewerUrl, context);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

async function shareViaGist(tmpFile: string, viewerUrl: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ReturnType<typeof spawn> | null = null;
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = `${viewerUrl}#${gistId}`;
		context.showStatus(`Share URL: ${hyperlink(previewUrl, previewUrl)}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}
