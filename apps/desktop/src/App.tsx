import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Diff, Folder, Globe, Plus, RotateCw, SquareTerminal } from "lucide-react";
import { VscLayoutSidebarLeft, VscLayoutSidebarLeftOff, VscLayoutSidebarRight, VscLayoutSidebarRightOff } from "react-icons/vsc";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer.tsx";
import { type Page, PageHeader, Rail, ResizeHandles } from "./components/Chrome.tsx";
import { AnnotationsBox, PendingApprovals, SelectionPopover } from "./components/Harness.tsx";
import { DownloadsTray } from "./components/DownloadsTray.tsx";
import { ExtensionDialog, Toasts } from "./components/Overlays.tsx";
import { AboutPage, LogsPage, SettingsPage, type Theme } from "./components/Pages.tsx";
import { BrowserPane } from "./components/BrowserPane.tsx";
import { ChangesPane } from "./components/ChangesPane.tsx";
import { ContextChips } from "./components/ContextChips.tsx";
import { FilesPane } from "./components/FilesPane.tsx";
import { SideChatPane } from "./components/SideChatPane.tsx";
import { TerminalPane } from "./components/TerminalPane.tsx";
import { LocalModelsPage } from "./components/LocalModels.tsx";
import { McpPage } from "./components/Mcp.tsx";
import { type ModalKind, Modals, shouldShowLocalNotice } from "./components/Modals.tsx";
import { ProvidersPage } from "./components/Providers.tsx";
import { SshPage } from "./components/Ssh.tsx";
import { type PanelTab, RightSidebar } from "./components/RightSidebar.tsx";
import { Thread } from "./components/Thread.tsx";
import { sessionTitle, ThreadList } from "./components/ThreadList.tsx";
import { buildTranscript, liveStatus } from "./btw.ts";
import { currentMode, type Mode, useSorvex } from "./store.ts";
import { api, serverEvents } from "./api.ts";
import { LOCAL_PROVIDER } from "./local.ts";
import { inTauri } from "./window.ts";

type SidePane = "terminal" | "changes" | "browser" | "files" | "sidechat";

function readStored<T extends string>(key: string, fallback: T): T {
	try {
		return (localStorage.getItem(key) as T | null) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// Storage can be unavailable; the preference just will not persist.
	}
}

export function App() {
	const { state, actions } = useSorvex();
	const [page, setPage] = useState<Page>("chat");
	const [threadsOpen, setThreadsOpen] = useState(() => readStored("threadsOpen", "1") === "1");
	const [panel, setPanel] = useState<PanelTab | null>(() => (readStored("panel", "") || null) as PanelTab | null);
	const [lastPanel, setLastPanel] = useState<PanelTab>(() => (readStored("lastPanel", "search") as PanelTab) || "search");
	const [theme, setTheme] = useState<Theme>(() => readStored<Theme>("theme", "dark"));
	const [modal, setModal] = useState<ModalKind | null>(null);
	const [sideRequest, setSideRequest] = useState<{ text: string; nonce: number } | null>(null);
	// Read on every side-chat message, so it always sees the main chat as it is at that moment.
	const liveRef = useRef(state);
	liveRef.current = state;
	const mainTranscript = useCallback(() => {
		const { messages, isStreaming, running, widgets } = liveRef.current;
		// Widgets carry live state that is not in messages yet, such as subagent progress and the todo list.
		const live = Object.entries(widgets)
			.filter(([, widget]) => widget.lines.length > 0)
			.map(([key, widget]) => `[${key}]\n${widget.lines.join("\n")}`)
			.join("\n\n");
		return [buildTranscript(messages), live, liveStatus(isStreaming, running)].filter(Boolean).join("\n\n");
	}, []);
	// One pane at a time to the right of the chat, like Claude Code's: Terminal, Changes, Browser or Files.
	const [sidePane, setSidePane] = useState<SidePane | null>(() => (readStored("sidePane", "") || null) as SidePane | null);
	const [paneExpanded, setPaneExpanded] = useState(false);
	const [paneWidth, setPaneWidth] = useState(() => Number(readStored<string>("browserWidth", "620")) || 620);
	// Files and Terminal stay mounted once opened, so open files and running shells survive switching panes.
	const [mounted, setMounted] = useState<Set<SidePane>>(() => new Set(sidePane ? [sidePane] : []));
	const [fileTarget, setFileTarget] = useState<{ path: string; line?: number; nonce: number } | null>(null);
	// Bumped when a turn ends, so Files and Changes pick up the agent's edits.
	const [refreshKey, setRefreshKey] = useState(0);
	useEffect(() => writeStored("sidePane", sidePane ?? ""), [sidePane]);
	useEffect(() => writeStored("browserWidth", String(paneWidth)), [paneWidth]);
	useEffect(() => {
		if (!state.isStreaming) setRefreshKey((key) => key + 1);
	}, [state.isStreaming]);
	// When a local model starts working on a reply, explain (once per chat) why the first one takes a while.
	const localWorking = state.isStreaming && state.session?.model?.provider === LOCAL_PROVIDER;
	const noticedChats = useRef(new Set<string>());
	useEffect(() => {
		const chat = state.session?.sessionFile ?? state.session?.sessionId ?? "";
		if (!localWorking || noticedChats.current.has(chat) || !shouldShowLocalNotice()) return;
		noticedChats.current.add(chat);
		setModal({ kind: "local-first-reply" });
	}, [localWorking, state.session?.sessionFile, state.session?.sessionId]);
	// Local engine problems (install failures, a GPU crash and the switch to CPU) show on every page, not only Local models.
	useEffect(() => serverEvents.on<{ message: string }>("local-error", (event) => actions.toast("error", event.message)), [actions]);
	// "Response completions" setting: a desktop notification when a response finishes in the background.
	const wasStreaming = useRef(false);
	const chatTitleRef = useRef("");
	useEffect(() => {
		const finished = wasStreaming.current && !state.isStreaming;
		wasStreaming.current = state.isStreaming;
		if (!finished || state.settings?.notifications?.completions === false) return;
		const last = [...state.messages].reverse().find((message) => message.role === "assistant");
		const reply = last?.role === "assistant" ? last.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(" ") : "";
		const failed = last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
		const body = failed ? (last.errorMessage ?? "Stopped") : reply.replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Response finished";
		const title = `${failed ? "Stopped" : "Done"}: ${chatTitleRef.current}`;
		// WebKitGTK keeps document.hasFocus() true after the window loses focus to another one (seen on Hyprland), so
		// ask the window itself. The decision goes to Logs, so a missing notification can be traced.
		void (inTauri ? getCurrentWindow().isFocused() : Promise.resolve(document.hasFocus()))
			.catch(() => false)
			.then((focused) => {
				void api("POST", "/api/log", { line: `notification ${focused ? "skipped (window focused)" : "sent"}: ${title}` }).catch(() => undefined);
				if (!focused) void api("POST", "/api/notify", { title, body }).catch(() => undefined);
			});
	}, [state.isStreaming, state.messages, state.settings]);
	const showPane = useCallback((next: SidePane | null) => {
		setSidePane(next);
		if (next) setMounted((current) => (current.has(next) ? current : new Set([...current, next])));
		else setPaneExpanded(false);
	}, []);
	const togglePane = (next: SidePane) => showPane(sidePane === next ? null : next);
	const resizePane = (width: number) => setPaneWidth(Math.min(Math.max(width, 360), window.innerWidth - 300));
	const browserOpen = sidePane === "browser";
	// The full-window pane covers the chat, so leave it when the AI needs an approval.
	const approvalsPending = state.approvals.length > 0;
	useEffect(() => {
		if (approvalsPending) setPaneExpanded(false);
	}, [approvalsPending]);
	// Open the Browser pane when the AI starts using the browser, so the user sees what it does.
	const usingBrowser = Object.values(state.running).some((tool) => tool.name.startsWith("browser_"));
	useEffect(() => {
		if (usingBrowser) showPane("browser");
	}, [usingBrowser, showPane]);
	const lastEscape = useRef(0);

	// "system" follows the OS light/dark preference, like the TUI's automatic theme.
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: light)");
		const apply = () => document.documentElement.classList.toggle("theme-light", theme === "light" || (theme === "system" && media.matches));
		apply();
		writeStored("theme", theme);
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	useEffect(() => writeStored("threadsOpen", threadsOpen ? "1" : "0"), [threadsOpen]);
	useEffect(() => {
		writeStored("panel", panel ?? "");
		if (panel) {
			setLastPanel(panel);
			writeStored("lastPanel", panel);
		}
	}, [panel]);

	// A pending approval should never be hidden: switch to the chat if it arrives elsewhere.
	useEffect(() => {
		if (state.approvals.length > 0) setPage("chat");
	}, [state.approvals.length]);

	const changeCwd = useCallback(async () => {
		const picked = inTauri
			? await open({ directory: true, defaultPath: state.cwd, title: "Choose a working directory" })
			: window.prompt("Working directory", state.cwd);
		if (typeof picked === "string" && picked && picked !== state.cwd) await actions.connect(picked);
	}, [state.cwd, actions]);

	const activeSession = state.sessions.find((session) => session.path === state.session?.sessionFile);
	const chatTitle =
		state.session?.sessionName ||
		(activeSession ? sessionTitle(activeSession) : state.messages.some((m) => m.role === "user") ? "Untitled session" : "New session");
	chatTitleRef.current = chatTitle;

	// Window title like the TUI's terminal title: "Sorvex - <session> - <folder>".
	useEffect(() => {
		const folder = state.cwd.split("/").filter(Boolean).pop() ?? "";
		const title = ["Sorvex", state.session?.sessionName, folder].filter(Boolean).join(" - ");
		document.title = title;
		if (inTauri) void getCurrentWindow().setTitle(title).catch(() => undefined);
	}, [state.session?.sessionName, state.cwd]);

	const exportSession = useCallback(
		async (path?: string) => {
			const target =
				path ||
				(inTauri
					? await save({ title: "Export session", defaultPath: `${state.cwd}/session.html`, filters: [{ name: "HTML or JSONL", extensions: ["html", "jsonl"] }] })
					: undefined);
			if (target === null) return;
			if (target?.endsWith(".jsonl")) await actions.exportJsonl(target);
			else await actions.exportHtmlTo(target || undefined);
		},
		[state.cwd, actions],
	);

	/** The TUI's built-in slash commands, handled here instead of being sent to the model. */
	const runCommand = useCallback(
		(name: string, args: string) => {
			const unquote = (value: string) => value.replace(/^["']|["']$/g, "");
			switch (name) {
				case "settings":
					return setPage("settings");
				case "model":
					return setModal({ kind: "model", query: args });
				case "scoped-models":
					return setModal({ kind: "scoped-models" });
				case "thinking": {
					const level = state.thinkingLevels.find((l) => l === args);
					return level ? void actions.setThinking(level) : setModal({ kind: "thinking" });
				}
				case "tree":
					return setModal({ kind: "tree" });
				case "fork":
					return setModal({ kind: "fork" });
				case "clone":
					return void actions.clone();
				case "new":
					return void actions.newSession();
				case "resume":
					return setModal({ kind: "resume" });
				case "name":
					return args ? void actions.renameSession(args) : actions.toast("info", `Session name: ${state.session?.sessionName ?? "(none)"}`);
				case "session":
					return setModal({ kind: "session" });
				case "compact":
					return void actions.compact(args || undefined);
				case "copy":
					return void actions.copyLast();
				case "export":
					return void exportSession(unquote(args));
				case "import": {
					const path = unquote(args);
					if (path) return void actions.switchSession(path);
					if (inTauri) {
						return void open({ title: "Import session", filters: [{ name: "Session", extensions: ["jsonl"] }] }).then((picked) => {
							if (typeof picked === "string") void actions.switchSession(picked);
						});
					}
					return actions.toast("warning", "Usage: /import <path.jsonl>");
				}
				case "login":
				case "logout":
					return setPage("providers");
				case "trust":
					return void fetch("/api/sorvex-settings", {
						method: "PUT",
						headers: { "content-type": "application/json", "x-sorvex-desktop": "1" },
						body: JSON.stringify({ cwd: state.cwd, key: "projectTrust", value: args !== "no" && args !== "false" }),
					}).then(() => actions.toast("info", args === "no" || args === "false" ? "This folder is now untrusted" : "This folder is now trusted"));
				case "reload":
					return void actions.reload();
				case "hotkeys":
					return setModal({ kind: "hotkeys" });
				case "changelog":
					return setModal({ kind: "changelog" });
				case "quit":
					return inTauri ? void getCurrentWindow().close() : actions.toast("info", "Close the browser tab to quit");
				case "btw":
					// Opens the side chat; the main task keeps running and never sees it.
					if (args) setSideRequest({ text: args, nonce: Date.now() });
					return showPane("sidechat");
			}
		},
		[state.thinkingLevels, state.session?.sessionName, state.cwd, actions, exportSession, showPane],
	);

	const cycleMode = useCallback(() => {
		const order: Mode[] = ["build", "plan", "security"];
		const next = order[(order.indexOf(currentMode(state.statuses)) + 1) % order.length]!;
		void actions.setMode(next);
	}, [state.statuses, actions]);

	// Global shortcuts, matching the TUI's defaults where a desktop app allows it.
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			// Keys typed into a terminal or the side chat belong there (Escape, Ctrl+L, Ctrl+P...), not to these shortcuts.
			if ((event.target as HTMLElement | null)?.closest?.(".xterm, .sidechat")) return;
			const key = event.key.toLowerCase();
			const ctrl = event.ctrlKey || event.metaKey;
			if (ctrl && !event.shiftKey && !event.altKey && key === "l") return event.preventDefault(), setModal({ kind: "model" });
			if (ctrl && !event.altKey && key === "p") return event.preventDefault(), void actions.cycleModel(event.shiftKey ? -1 : 1);
			if (event.shiftKey && !ctrl && key === "tab") return event.preventDefault(), void actions.cycleThinking();
			if (ctrl && event.altKey && key === "n") return event.preventDefault(), cycleMode();
			if (ctrl && event.altKey && key === "p") return event.preventDefault(), void actions.setMode(currentMode(state.statuses) === "plan" ? "build" : "plan");
			if (event.altKey && !ctrl && key === "t") return event.preventDefault(), setPanel((current) => (current === "todos" ? null : "todos"));
			if (ctrl && !event.shiftKey && key === "o") return event.preventDefault(), actions.setUi({ expandTools: !state.expandTools });
			if (ctrl && !event.shiftKey && key === "t") return event.preventDefault(), actions.setUi({ hideThinking: !state.hideThinking });
			if (ctrl && event.shiftKey && key === "f") return event.preventDefault(), setPanel("search");
			if (ctrl && !event.shiftKey && key === "n") return event.preventDefault(), void actions.newSession();
			if (event.key === "Escape" && !modal && state.dialogs.length === 0) {
				if (state.isStreaming) return void actions.abort();
				// Double Escape opens the tree or fork picker, per Sorvex's doubleEscapeAction setting (tree by default).
				const now = Date.now();
				if (now - lastEscape.current < 500) {
					lastEscape.current = 0;
					void fetch(`/api/sorvex-settings?cwd=${encodeURIComponent(state.cwd)}`)
						.then((response) => response.json())
						.then((settings: { doubleEscapeAction: string }) => {
							if (settings.doubleEscapeAction === "tree") setModal({ kind: "tree" });
							else if (settings.doubleEscapeAction === "fork") setModal({ kind: "fork" });
						});
				} else {
					lastEscape.current = now;
				}
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [actions, cycleMode, modal, state.statuses, state.expandTools, state.hideThinking, state.isStreaming, state.dialogs.length, state.cwd]);

	const dialog = state.dialogs[0];
	const widgets = (placement: "aboveEditor" | "belowEditor") =>
		Object.entries(state.widgets)
			.filter(([, widget]) => widget.placement === placement)
			.map(([key, widget]) => (
				<div key={key} className="widget">
					{widget.lines.join("\n")}
				</div>
			));

	return (
		<div className="shell">
			<Rail page={page} onPage={setPage} connection={state.connection} busy={state.isStreaming} />
			<main className="main">
				{page === "chat" && (
					<>
						<PageHeader
							title={chatTitle}
							left={
								<>
									<button
										type="button"
										className="icon-btn header-toggle"
										aria-label="Toggle threads list"
										title="Threads"
										onClick={() => setThreadsOpen(!threadsOpen)}
									>
										{threadsOpen ? <VscLayoutSidebarLeft size={20} /> : <VscLayoutSidebarLeftOff size={20} />}
									</button>
									<button
										type="button"
										className="btn-accent"
										disabled={state.connection !== "ready" || state.isStreaming}
										onClick={() => void actions.newSession()}
									>
										<Plus size={15} />
										New Chat
									</button>
								</>
							}
							right={
								<>
									{(
										[
											["terminal", "Terminal", <SquareTerminal key="t" size={17} />],
											["changes", "Changes", <Diff key="c" size={17} />],
											["browser", "Browser", <Globe key="b" size={17} />],
											["files", "Files", <Folder key="f" size={17} />],
										] as const
									).map(([id, label, icon]) => (
										<button
											key={id}
											type="button"
											className={`icon-btn panel-toggle${sidePane === id ? " active" : ""}`}
											aria-label={`Toggle ${label.toLowerCase()}`}
											aria-pressed={sidePane === id}
											title={label}
											onClick={() => togglePane(id)}
										>
											{icon}
										</button>
									))}
									<button
										type="button"
										className="icon-btn panel-toggle"
										aria-label="Toggle right panel"
										title="Right panel"
										onClick={() => setPanel(panel ? null : lastPanel)}
									>
										{panel ? <VscLayoutSidebarRight size={20} /> : <VscLayoutSidebarRightOff size={20} />}
									</button>
								</>
							}
						/>
						{(state.connection === "error" || state.connection === "exited") && (
							<div className="banner">
								<span className="text">{state.connectionError ?? "Sorvex is not running."}</span>
								<button type="button" className="btn-ghost" onClick={() => void actions.connect(state.cwd)}>
									<RotateCw size={14} />
									Restart
								</button>
							</div>
						)}
						{state.connection === "ready" && state.models.length === 0 && (
							<div className="banner info">
								<span className="text">No models have credentials yet.</span>
								<button type="button" className="btn-accent" onClick={() => setPage("providers")}>
									Add a provider
								</button>
							</div>
						)}
						<div className="chat">
							{threadsOpen && !(sidePane && paneExpanded) && (
								<ThreadList
									cwd={state.cwd}
									sessions={state.sessions}
									activePath={state.session?.sessionFile}
									runningPath={state.isStreaming ? state.session?.sessionFile : undefined}
									onPick={(path, cwd) => void actions.openSession(path, cwd)}
									onNewChat={(folder) => void actions.newChatIn(folder)}
									onChangeCwd={() => void changeCwd()}
									onRefresh={() => void actions.refreshSessions()}
								/>
							)}
							<section className="thread" hidden={Boolean(sidePane) && paneExpanded}>
								<Thread state={state} actions={actions} />
								<div className="footer">
									<div className="footer-inner">
										{widgets("aboveEditor")}
										<PendingApprovals approvals={state.approvals} actions={actions} />
										{(state.queue.steering.length > 0 || state.queue.followUp.length > 0) && (
											<div className="queue">
												{state.queue.steering.map((text, index) => (
													<div key={`s${index}`}>Steering: {text}</div>
												))}
												{state.queue.followUp.map((text, index) => (
													<div key={`f${index}`}>Queued: {text}</div>
												))}
											</div>
										)}
										<AnnotationsBox annotations={state.annotations} actions={actions} />
										<Composer
											state={state}
											actions={actions}
											onCommand={runCommand}
											onOpen={(target) => (target === "ssh" || target === "local" ? setPage(target) : setPanel("guardrails"))}
										/>
										{state.messages.length === 0 && <ContextChips cwd={state.cwd} refreshKey={refreshKey} onChangeCwd={() => void changeCwd()} />}
										{widgets("belowEditor")}
									</div>
								</div>
							</section>
							{browserOpen && (
								<BrowserPane
									actions={actions}
									expanded={paneExpanded}
									onToggleExpand={() => setPaneExpanded(!paneExpanded)}
									width={paneWidth}
									onResize={resizePane}
									onClose={() => showPane(null)}
								/>
							)}
							{sidePane === "changes" && (
								<ChangesPane
									refreshKey={refreshKey}
									expanded={paneExpanded}
									onToggleExpand={() => setPaneExpanded(!paneExpanded)}
									width={paneWidth}
									onResize={resizePane}
									onClose={() => showPane(null)}
									onOpenFile={(path) => {
										setFileTarget({ path, nonce: Date.now() });
										showPane("files");
									}}
								/>
							)}
							{mounted.has("files") && (
								<FilesPane
									target={fileTarget}
									refreshKey={refreshKey}
									hidden={sidePane !== "files"}
									expanded={paneExpanded}
									onToggleExpand={() => setPaneExpanded(!paneExpanded)}
									width={paneWidth}
									onResize={resizePane}
									onClose={() => showPane(null)}
									toast={actions.toast}
								/>
							)}
							{mounted.has("sidechat") && (
								<SideChatPane
									request={sideRequest}
									model={state.session?.model ? `${state.session.model.provider}/${state.session.model.id}` : undefined}
									transcript={mainTranscript}
									hidden={sidePane !== "sidechat"}
									expanded={paneExpanded}
									onToggleExpand={() => setPaneExpanded(!paneExpanded)}
									width={paneWidth}
									onResize={resizePane}
									onClose={() => showPane(null)}
								/>
							)}
							{mounted.has("terminal") && (
								<TerminalPane
									hidden={sidePane !== "terminal"}
									expanded={paneExpanded}
									onToggleExpand={() => setPaneExpanded(!paneExpanded)}
									width={paneWidth}
									onResize={resizePane}
									onClose={() => showPane(null)}
									toast={actions.toast}
								/>
							)}
							<RightSidebar state={state} actions={actions} tab={panel} onTab={setPanel} />
						</div>
						<SelectionPopover onAnnotate={actions.addAnnotation} />
					</>
				)}
				{page === "mcp" && <McpPage state={state} actions={actions} />}
				{page === "ssh" && <SshPage actions={actions} />}
				{page === "local" && (
					<>
						<PageHeader title="Local models" />
						<LocalModelsPage state={state} actions={actions} onUseInChat={() => setPage("chat")} />
					</>
				)}
				{page === "providers" && (
					<>
						<PageHeader title="Providers" />
						<ProvidersPage actions={actions} />
					</>
				)}
				{page === "settings" && (
					<>
						<PageHeader title="Settings" />
						<SettingsPage state={state} actions={actions} theme={theme} onTheme={setTheme} onChangeCwd={() => void changeCwd()} />
					</>
				)}
				{page === "logs" && (
					<>
						<PageHeader title="Logs" />
						<LogsPage state={state} onClear={actions.clearLogs} />
					</>
				)}
				{page === "about" && (
					<>
						<PageHeader title="About" />
						<AboutPage />
					</>
				)}
				{dialog && (
					<ExtensionDialog
						key={dialog.id}
						request={dialog}
						onAnswer={(response) => void actions.answerDialog(response)}
						onExpire={() => actions.dismissDialog(dialog.id)}
					/>
				)}
				<Modals modal={modal} state={state} actions={actions} onClose={() => setModal(null)} />
				<Toasts toasts={state.toasts} onDismiss={actions.dismissToast} />
				<DownloadsTray />
			</main>
			<ResizeHandles />
		</div>
	);
}
