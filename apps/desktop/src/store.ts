import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { api, serverEvents } from "./api.ts";
import { describeElement, type SelectedElement } from "./element.ts";
import { rememberModel } from "./components/ModelPicker.tsx";
import { sessionTitle } from "./components/ThreadList.tsx";
import { buildReviewRequest, parseIssues, type ReviewIssue } from "./review.ts";
import {
	type AgentEvent,
	type AgentMessage,
	AgentClient,
	type AssistantMessage,
	type AssistantMessageEvent,
	type DialogRequest,
	type ExtensionUIResponse,
	type ImageContent,
	listSessions,
	type Model,
	type SessionState,
	type SessionStats,
	type SessionSummary,
	type SlashCommand,
	serverState,
	type ThinkingLevel,
	type ToolCall,
} from "./rpc.ts";
import type { DesktopSettings } from "./settings.ts";
import { Mic, speaker, transcribe } from "./voice.ts";

export type Mode = "build" | "plan" | "security";
export type Connection = "starting" | "ready" | "exited" | "error";

/** Title the bridge extension uses for tool approvals (apps/desktop/extension/gui-bridge.ts). */
export const APPROVAL_TITLE = "sorvex-gui:approval";
const TOOLS_STATUS = "sorvex-gui:tools";
/**
 * TUI widgets the GUI shows elsewhere: the todo list has the Todos panel, the subagent fleet has the Agent
 * Monitor. Showing them above the composer too would duplicate them.
 */
const HIDDEN_WIDGETS = new Set(["todos", "subagent-fleet"]);

export interface RunningTool {
	id: string;
	name: string;
	args: unknown;
	partial?: unknown;
	parentId?: string;
}

export interface ToolOutcome {
	result: unknown;
	isError: boolean;
	durationMs?: number;
}

export interface Toast {
	id: number;
	kind: "info" | "warning" | "error";
	text: string;
}

export interface Approval {
	requestId: string;
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	reason?: string;
	options: string[];
}

export interface Annotation {
	id: number;
	quote: string;
	comment: string;
}

export type ReviewResult =
	| { status: "running" }
	| { status: "done"; issues: ReviewIssue[] }
	| { status: "error"; error: string; raw?: string };

/**
 * A file attached in the composer. Images go to the model as images; text files are inlined in the message. An
 * element picked in the Browser pane is sent as an `<element>` block plus its screenshot.
 */
export interface Attachment {
	id: number;
	name: string;
	kind: "image" | "text" | "element";
	mimeType: string;
	/** Base64 for images, file contents for text; unused for elements. */
	data: string;
	size: number;
	element?: SelectedElement;
	/** Base64 JPEG screenshot of a selected element. */
	image?: string;
}

export interface VoiceState {
	dictating: boolean;
	voiceChat: boolean;
	transcribing: boolean;
	speaking: boolean;
}

export interface State {
	connection: Connection;
	connectionError?: string;
	launcher?: string;
	cwd: string;
	session?: SessionState;
	stats?: SessionStats;
	models: Model[];
	thinkingLevels: ThinkingLevel[];
	commands: SlashCommand[];
	tools: { name: string; description?: string }[];
	sessions: SessionSummary[];
	messages: AgentMessage[];
	/** Index into `messages` of the message currently streaming. */
	streamingIndex: number | null;
	isStreaming: boolean;
	isCompacting: boolean;
	running: Record<string, RunningTool>;
	/** Nested tool calls (for example from subagents), keyed by the parent tool call id. */
	children: Record<string, RunningTool[]>;
	outcomes: Record<string, ToolOutcome>;
	queue: { steering: string[]; followUp: string[] };
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
	dialogs: DialogRequest[];
	approvals: Approval[];
	toasts: Toast[];
	/** Text pushed into the composer; `append` adds to what is there (dictation). */
	editorText?: { text: string; nonce: number; append?: boolean };
	settings?: DesktopSettings;
	/** Guardrail reviews keyed by the reviewed assistant message's timestamp, then by reviewer name. */
	reviews: Record<number, Record<string, ReviewResult>>;
	annotations: Annotation[];
	voice: VoiceState;
	micAnalyser?: AnalyserNode;
	/** Ctrl+T: hide reasoning blocks, like the TUI's hideThinkingBlock. */
	hideThinking: boolean;
	/** Ctrl+O: expand every tool call, like the TUI's tool output toggle. */
	expandTools: boolean;
}

const initialState: State = {
	connection: "starting",
	cwd: "",
	models: [],
	thinkingLevels: [],
	commands: [],
	tools: [],
	sessions: [],
	messages: [],
	streamingIndex: null,
	isStreaming: false,
	isCompacting: false,
	running: {},
	children: {},
	outcomes: {},
	queue: { steering: [], followUp: [] },
	statuses: {},
	widgets: {},
	dialogs: [],
	approvals: [],
	toasts: [],
	reviews: {},
	annotations: [],
	voice: { dictating: false, voiceChat: false, transcribing: false, speaking: false },
	hideThinking: false,
	expandTools: false,
};

type Action =
	| { type: "event"; event: AgentEvent }
	| { type: "patch"; patch: Partial<State> }
	| { type: "voice"; patch: Partial<VoiceState> }
	| { type: "review"; key: number; reviewer: string; result: ReviewResult }
	| { type: "toast"; kind: Toast["kind"]; text: string }
	| { type: "dismiss_toast"; id: number }
	| { type: "dismiss_dialog"; id: string };

let toastId = 0;
let annotationId = 0;

function applyDelta(message: AssistantMessage, event: AssistantMessageEvent): AssistantMessage {
	if (!("contentIndex" in event)) return message;
	const content = [...message.content];
	const index = event.contentIndex;
	const block = content[index];
	switch (event.type) {
		case "text_start":
			content[index] = { type: "text", text: "" };
			break;
		case "thinking_start":
			content[index] = { type: "thinking", thinking: "" };
			break;
		case "toolcall_start":
			content[index] = { type: "toolCall", id: event.id ?? "", name: event.toolName ?? "", arguments: {}, partialJson: "" };
			break;
		case "text_delta":
			if (block?.type === "text") content[index] = { ...block, text: block.text + event.delta };
			break;
		case "thinking_delta":
			if (block?.type === "thinking") content[index] = { ...block, thinking: block.thinking + event.delta };
			break;
		case "toolcall_delta":
			if (block?.type === "toolCall") content[index] = { ...block, partialJson: (block.partialJson ?? "") + event.delta };
			break;
		case "text_end":
			content[index] = { type: "text", text: event.content };
			break;
		case "thinking_end":
			content[index] = { type: "thinking", thinking: event.content };
			break;
		case "toolcall_end":
			content[index] = event.toolCall;
			break;
	}
	return { ...message, content };
}

function withToast(state: State, kind: Toast["kind"], text: string): State {
	return { ...state, toasts: [...state.toasts, { id: ++toastId, kind, text }].slice(-4) };
}

function parseApproval(request: Extract<DialogRequest, { method: "select" }>): Approval {
	let detail: Partial<Approval> = {};
	try {
		detail = JSON.parse(request.message ?? "{}") as Partial<Approval>;
	} catch {
		// Fall back to an approval without details.
	}
	return {
		requestId: request.id,
		toolCallId: detail.toolCallId ?? "",
		toolName: detail.toolName ?? "tool",
		input: detail.input ?? {},
		reason: detail.reason,
		options: request.options,
	};
}

function reduceEvent(state: State, event: AgentEvent): State {
	switch (event.type) {
		case "agent_start":
			return { ...state, isStreaming: true };
		case "agent_settled":
			return { ...state, isStreaming: false, running: {}, streamingIndex: null, approvals: [] };
		case "message_start": {
			const messages = [...state.messages, event.message];
			const next = { ...state, messages, streamingIndex: messages.length - 1 };
			return event.message.role === "user" ? { ...next, sessions: bumpSession(state, event.message) } : next;
		}
		case "message_update": {
			const index = state.streamingIndex;
			const current = index === null ? undefined : state.messages[index];
			if (index === null || current?.role !== "assistant") return state;
			const messages = [...state.messages];
			messages[index] = applyDelta(current, event.assistantMessageEvent);
			return { ...state, messages };
		}
		case "message_end": {
			const messages = [...state.messages];
			if (state.streamingIndex === null) messages.push(event.message);
			else messages[state.streamingIndex] = event.message;
			return { ...state, messages, streamingIndex: null };
		}
		case "tool_execution_start": {
			const tool: RunningTool = { id: event.toolCallId, name: event.toolName, args: event.args, parentId: event.parentToolCallId };
			const running = { ...state.running, [tool.id]: tool };
			if (!tool.parentId) return { ...state, running };
			const siblings = state.children[tool.parentId] ?? [];
			return { ...state, running, children: { ...state.children, [tool.parentId]: [...siblings, tool] } };
		}
		case "tool_execution_update": {
			const tool = state.running[event.toolCallId];
			if (!tool) return state;
			return { ...state, running: { ...state.running, [tool.id]: { ...tool, partial: event.partialResult } } };
		}
		case "tool_execution_end": {
			const { [event.toolCallId]: _done, ...running } = state.running;
			const outcome = { result: event.result, isError: event.isError, durationMs: event.durationMs };
			return { ...state, running, outcomes: { ...state.outcomes, [event.toolCallId]: outcome } };
		}
		case "queue_update":
			return { ...state, queue: { steering: event.steering, followUp: event.followUp } };
		case "compaction_start":
			return { ...state, isCompacting: true };
		case "compaction_end": {
			const next = { ...state, isCompacting: false };
			return event.errorMessage ? withToast(next, "error", `Compaction failed: ${event.errorMessage}`) : next;
		}
		case "session_info_changed":
			return state.session ? { ...state, session: { ...state.session, sessionName: event.name } } : state;
		case "thinking_level_changed":
			return state.session ? { ...state, session: { ...state.session, thinkingLevel: event.level } } : state;
		case "auto_retry_start":
			return withToast(state, "warning", `Retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`);
		case "auto_retry_end":
			return event.success ? state : withToast(state, "error", event.finalError ?? "Retry failed");
		case "extension_error":
			return withToast(state, "error", `Extension error: ${event.error}`);
		case "extension_ui_request":
			switch (event.method) {
				case "select":
					if (event.title === APPROVAL_TITLE) return { ...state, approvals: [...state.approvals, parseApproval(event)] };
					return { ...state, dialogs: [...state.dialogs, event] };
				case "confirm":
				case "input":
				case "editor":
					return { ...state, dialogs: [...state.dialogs, event] };
				case "notify":
					return withToast(state, event.notifyType ?? "info", event.message);
				case "setStatus": {
					if (event.statusKey === TOOLS_STATUS) {
						try {
							return { ...state, tools: JSON.parse(event.statusText ?? "[]") };
						} catch {
							return state;
						}
					}
					const { [event.statusKey]: _old, ...statuses } = state.statuses;
					if (event.statusText !== undefined) statuses[event.statusKey] = event.statusText;
					return { ...state, statuses };
				}
				case "setWidget": {
					if (HIDDEN_WIDGETS.has(event.widgetKey)) return state;
					const { [event.widgetKey]: _old, ...widgets } = state.widgets;
					if (event.widgetLines) {
						widgets[event.widgetKey] = { lines: event.widgetLines, placement: event.widgetPlacement ?? "aboveEditor" };
					}
					return { ...state, widgets };
				}
				case "setTitle":
					return state;
				case "set_editor_text":
					return { ...state, editorText: { text: event.text, nonce: Date.now() } };
			}
			return state;
		default:
			return state;
	}
}


/**
 * Sending a message moves its session to the top of the sidebar right away, instead of when the run ends. A new
 * session is listed at once, before Sorvex has written its file; the next refresh replaces it with the real entry.
 */
function bumpSession(state: State, message: Extract<AgentMessage, { role: "user" }>): SessionSummary[] {
	const path = state.session?.sessionFile;
	if (!path) return state.sessions;
	const existing = state.sessions.find((session) => session.path === path);
	const text = typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
	const bumped: SessionSummary = existing
		? { ...existing, modified: Date.now(), messageCount: existing.messageCount + 1 }
		: { path, id: state.session?.sessionId ?? path, name: state.session?.sessionName ?? null, firstMessage: text, cwd: state.cwd, modified: Date.now(), messageCount: 1 };
	return [bumped, ...state.sessions.filter((session) => session.path !== path)];
}

function reducer(state: State, action: Action): State {
	switch (action.type) {
		case "event":
			return reduceEvent(state, action.event);
		case "patch":
			return { ...state, ...action.patch };
		case "voice":
			return { ...state, voice: { ...state.voice, ...action.patch } };
		case "review":
			return {
				...state,
				reviews: { ...state.reviews, [action.key]: { ...state.reviews[action.key], [action.reviewer]: action.result } },
			};
		case "toast":
			return withToast(state, action.kind, action.text);
		case "dismiss_toast":
			return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
		case "dismiss_dialog":
			return {
				...state,
				dialogs: state.dialogs.filter((dialog) => dialog.id !== action.id),
				approvals: state.approvals.filter((approval) => approval.requestId !== action.id),
			};
	}
}

/** The active mode, read from the status keys the built-in `modes` and `plan` extensions set. */
export function currentMode(statuses: Record<string, string>): Mode {
	if (statuses.plan === "plan") return "plan";
	if (statuses.mode === "security") return "security";
	return "build";
}

/** Tool results by tool call id, so assistant tool-call blocks can show their output. */
export function indexToolResults(messages: AgentMessage[]): Map<string, Extract<AgentMessage, { role: "toolResult" }>> {
	const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	return results;
}

export function isToolCall(block: AssistantMessage["content"][number]): block is ToolCall {
	return block.type === "toolCall";
}

/** Text of the last assistant reply in the current turn, for reading aloud. */
function lastAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "user") return "";
		if (message.role === "assistant") {
			const text = message.content
				.filter((block) => block.type === "text")
				.map((block) => (block as { text: string }).text)
				.join("\n");
			if (text.trim()) return text;
		}
	}
	return "";
}

function formatAnnotations(annotations: Annotation[]): string {
	return annotations
		.map((annotation, index) => `${index + 1}. "${annotation.quote}"${annotation.comment ? `\n   ${annotation.comment}` : ""}`)
		.join("\n");
}

/** "<title> (fork)", without stacking the suffix when forking a fork. */
const forkName = (title: string) => `${title.replace(/ \(fork\)$/, "")} (fork)`;

export function useSorvex() {
	const [state, dispatch] = useReducer(reducer, initialState);
	const stateRef = useRef(state);
	stateRef.current = state;
	const clientRef = useRef<AgentClient | null>(null);
	if (!clientRef.current) clientRef.current = new AgentClient();
	const client = clientRef.current;
	const cwdRef = useRef("");
	const micRef = useRef<Mic | null>(null);

	const toast = useCallback((kind: Toast["kind"], text: string) => dispatch({ type: "toast", kind, text }), []);

	const run = useCallback(
		async (action: () => Promise<unknown>) => {
			try {
				await action();
			} catch (error) {
				toast("error", error instanceof Error ? error.message : String(error));
			}
		},
		[toast],
	);

	const refreshSessions = useCallback(async () => {
		if (!cwdRef.current) return;
		// Every folder's sessions: the sidebar groups them by folder.
		dispatch({ type: "patch", patch: { sessions: await listSessions(cwdRef.current, true) } });
	}, []);

	const refreshState = useCallback(async () => {
		const [session, stats] = await Promise.all([
			client.request<SessionState>({ type: "get_state" }),
			client.request<SessionStats>({ type: "get_session_stats" }).catch(() => undefined),
		]);
		dispatch({ type: "patch", patch: { session, stats } });
		return session;
	}, [client]);

	const refreshModels = useCallback(async () => {
		const [models, levels] = await Promise.all([
			client.request<{ models: Model[] }>({ type: "get_available_models" }),
			client.request<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" }),
		]);
		dispatch({ type: "patch", patch: { models: models.models, thinkingLevels: levels.levels } });
	}, [client]);

	const reloadMessages = useCallback(async () => {
		const { messages } = await client.request<{ messages: AgentMessage[] }>({ type: "get_messages" });
		dispatch({ type: "patch", patch: { messages, streamingIndex: null, running: {}, children: {}, outcomes: {} } });
	}, [client]);

	/** Loads everything about an agent that is already running. */
	const hydrate = useCallback(async () => {
		const session = await refreshState();
		const [{ commands }, server] = await Promise.all([
			client.request<{ commands: SlashCommand[] }>({ type: "get_commands" }),
			serverState(),
			refreshModels(),
			reloadMessages(),
			refreshSessions(),
		]);
		// The extension publishes its tool list on session start; ask again in case that was missed.
		void client.request({ type: "prompt", message: "/gui-refresh-models" }).catch(() => undefined);
		// Dialogs opened before this window connected (or while it reloaded), e.g. an approval a phone also sees.
		const approvals = server.dialogs.filter((d) => d.method === "select" && d.title === APPROVAL_TITLE).map((d) => parseApproval(d as Extract<DialogRequest, { method: "select" }>));
		const dialogs = server.dialogs.filter((d) => !(d.method === "select" && d.title === APPROVAL_TITLE));
		dispatch({ type: "patch", patch: { connection: "ready", commands, isStreaming: session.isStreaming, approvals, dialogs } });
	}, [client, refreshState, refreshModels, reloadMessages, refreshSessions]);

	const connect = useCallback(
		async (cwd: string) => {
			cwdRef.current = cwd;
			// Reset the per-agent state only. Settings are app-wide and may have been loaded moments ago,
			// before stateRef caught up, so they must not be part of the reset.
			const { settings: _settings, hideThinking: _hide, expandTools: _expand, ...reset } = initialState;
			dispatch({ type: "patch", patch: { ...reset, cwd, connection: "starting" } });
			try {
				const info = await client.start(cwd);
				dispatch({ type: "patch", patch: { launcher: info.launcher } });
				await hydrate();
			} catch (error) {
				dispatch({ type: "patch", patch: { connection: "error", connectionError: String(error) } });
			}
		},
		[client, hydrate],
	);

	const runReviews = useCallback(async () => {
		const { settings, messages } = stateRef.current;
		const reviewers = settings?.reviewers.filter((reviewer) => reviewer.enabled && reviewer.model) ?? [];
		if (reviewers.length === 0) return;
		for (const reviewer of reviewers) {
			const request = buildReviewRequest(messages, reviewer);
			if (!request) continue;
			dispatch({ type: "review", key: request.key, reviewer: reviewer.name, result: { status: "running" } });
			api<{ text: string }>("POST", "/api/review", { model: reviewer.model, systemPrompt: request.systemPrompt, content: request.content })
				.then(({ text }) => {
					const issues = parseIssues(text, request.toolCallIds);
					dispatch({
						type: "review",
						key: request.key,
						reviewer: reviewer.name,
						result: issues ? { status: "done", issues } : { status: "error", error: "Reviewer did not return a JSON list", raw: text },
					});
				})
				.catch((error: unknown) =>
					dispatch({ type: "review", key: request.key, reviewer: reviewer.name, result: { status: "error", error: String(error) } }),
				);
		}
	}, []);

	const speakText = useCallback(
		(text: string) => {
			const settings = stateRef.current.settings;
			if (!settings) return;
			void speaker.speak(text, settings.voice).catch((error: unknown) => toast("error", `Speech failed: ${String(error)}`));
		},
		[toast],
	);

	useEffect(() => {
		const offEvent = client.onEvent((event) => {
			dispatch({ type: "event", event });
			if (event.type === "agent_settled") {
				void refreshState().catch(() => undefined);
				void refreshSessions();
				if (!event.aborted) {
					void runReviews();
					const { voice, settings, messages } = stateRef.current;
					if ((voice.voiceChat && settings?.voice.autoSpeak) || settings?.voice.speakReplies) {
						const text = lastAssistantText(messages);
						if (text) speakText(text);
					}
				}
			} else if (event.type === "compaction_end" && !event.aborted) {
				void reloadMessages().catch(() => undefined);
			} else if (event.type === "thinking_level_changed") {
				void refreshModels().catch(() => undefined);
			}
		});
		const offStatus = client.onStatus((status) => {
			if (status.status === "exited" || status.status === "error") {
				dispatch({ type: "patch", patch: { connection: status.status, connectionError: status.error } });
			}
		});
		// Answered elsewhere: another window or a paired phone (server/agent.ts).
		const offResolved = serverEvents.on<{ id: string }>("dialog-resolved", ({ id }) => dispatch({ type: "dismiss_dialog", id }));
		const offModels = serverEvents.on("models-changed", () => void refreshModels().then(refreshState).catch(() => undefined));
		const offSpeaker = speaker.subscribe((speaking) => dispatch({ type: "voice", patch: { speaking } }));
		// After the server restarts, the event stream reconnects; bring a missing agent back in the same folder.
		let opened = false;
		const offOpen = serverEvents.onOpen(() => {
			if (!opened) {
				opened = true;
				return;
			}
			void serverState().then((server) => {
				if (server.agent.status !== "ready" && cwdRef.current) void connect(cwdRef.current);
			});
		});
		return () => {
			offOpen();
			offEvent();
			offStatus();
			offModels();
			offResolved();
			offSpeaker();
		};
	}, [client, connect, refreshState, refreshSessions, reloadMessages, refreshModels, runReviews, speakText]);

	// On load, attach to an agent the server already runs (e.g. after a page reload); otherwise start one.
	// The window can open before the server listens, so keep retrying for a while instead of failing once.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			let lastError: unknown;
			for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
				try {
					const [server, settings] = await Promise.all([serverState(), api<DesktopSettings>("GET", "/api/settings")]);
					if (cancelled) return;
					dispatch({ type: "patch", patch: { settings } });
					if (server.agent.status === "ready" && server.agent.cwd) {
						cwdRef.current = server.agent.cwd;
						dispatch({ type: "patch", patch: { cwd: server.agent.cwd, launcher: server.agent.launcher } });
						await hydrate();
					} else {
						await connect(server.defaultCwd);
					}
					return;
				} catch (error) {
					lastError = error;
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			if (!cancelled) {
				dispatch({ type: "patch", patch: { connection: "error", connectionError: `Desktop server unreachable: ${String(lastError)}` } });
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [connect, hydrate]);

	const send = useCallback(
		(message: string, streaming: boolean, attachments: Attachment[] = []) =>
			run(async () => {
				const { annotations } = stateRef.current;
				const files = attachments
					.filter((file) => file.kind === "text")
					.map((file) => `<file name="${file.name}">\n${file.data}\n</file>`)
					.join("\n\n");
				// Element screenshots go first, in element order, so the chat history can pair each block with its image.
				const elements = attachments.filter((file) => file.kind === "element" && file.element);
				const elementText = elements.map((file) => describeElement({ ...file.element!, hasScreenshot: Boolean(file.image) })).join("\n\n");
				const images: ImageContent[] = [
					...elements.flatMap((file) => (file.image ? [{ type: "image" as const, data: file.image, mimeType: "image/jpeg" }] : [])),
					...attachments.filter((file) => file.kind === "image").map((file) => ({ type: "image" as const, data: file.data, mimeType: file.mimeType })),
				];
				const parts = [annotations.length > 0 ? formatAnnotations(annotations) : "", elementText, files, message].filter(Boolean);
				const text = parts.join("\n\n").trim();
				if (annotations.length > 0 && !message.startsWith("/")) dispatch({ type: "patch", patch: { annotations: [] } });
				const extra = images.length > 0 ? { images } : {};
				await client.request(
					streaming
						? { type: "steer", message: text, ...extra }
						: { type: "prompt", message: text, streamingBehavior: "followUp", ...extra },
				);
			}),
		[client, run],
	);

	const forkAt = useCallback(
		async (userIndex: number): Promise<string | undefined> => {
			const { messages } = await client.request<{ messages: { entryId: string; text: string }[] }>({ type: "get_fork_messages" });
			const entry = messages[userIndex];
			if (!entry) throw new Error("That message can no longer be forked");
			const result = await client.request<{ text: string; cancelled: boolean }>({ type: "fork", entryId: entry.entryId });
			if (result.cancelled) return undefined;
			await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
			return result.text;
		},
		[client, refreshState, reloadMessages, refreshSessions],
	);

	const openSessionAt = useCallback(
		async (sessionPath: string, sessionCwd?: string) => {
			const result = await client.request<{ cancelled: boolean }>({ type: "switch_session", sessionPath });
			if (result?.cancelled) return;
			if (sessionCwd && sessionCwd !== cwdRef.current) {
				await api("POST", "/api/agent/cwd", { cwd: sessionCwd });
				cwdRef.current = sessionCwd;
				dispatch({ type: "patch", patch: { cwd: sessionCwd } });
			}
			dispatch({ type: "patch", patch: { reviews: {}, widgets: {} } });
			await Promise.all([refreshState(), reloadMessages()]);
		},
		[client, refreshState, reloadMessages],
	);

	const stopVoice = useCallback(() => {
		micRef.current?.stop();
		micRef.current = null;
		dispatch({ type: "voice", patch: { dictating: false, voiceChat: false } });
		dispatch({ type: "patch", patch: { micAnalyser: undefined } });
	}, []);

	const actions = useMemo(
		() => ({
			connect,
			toast,
			dismissToast: (id: number) => dispatch({ type: "dismiss_toast", id }),
			send,
			abort: () => run(() => client.request({ type: "abort" })),
			newSession: () =>
				run(async () => {
					await client.request({ type: "new_session" });
					dispatch({ type: "patch", patch: { reviews: {}, widgets: {} } });
					await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
				}),
			/**
			 * Opens a session from any folder without restarting Sorvex: `switch_session` rebuilds the session in its
			 * own folder, so only the GUI's notion of the current folder needs to follow.
			 */
			openSession: (sessionPath: string, sessionCwd?: string) => run(() => openSessionAt(sessionPath, sessionCwd)),
			/**
			 * The sidebar's Fork: copies the whole session into a new one named "<title> (fork)" and opens it. The open
			 * session is cloned over RPC so its current branch is what gets copied.
			 */
			forkSession: (path: string) =>
				run(async () => {
					const summary = stateRef.current.sessions.find((session) => session.path === path);
					const name = forkName(summary ? sessionTitle(summary) : "Session");
					if (path === stateRef.current.session?.sessionFile) {
						const { cancelled } = await client.request<{ cancelled: boolean }>({ type: "clone" });
						if (cancelled) return;
						await client.request({ type: "set_session_name", name });
						await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
					} else {
						const fork = await api<{ path: string; cwd: string }>("POST", "/api/sessions/fork", { path, name });
						await openSessionAt(fork.path, fork.cwd);
						await refreshSessions();
					}
					toast("info", "Forked into a new session");
				}),
			/**
			 * "Fork from here" under a reply: a new session holding everything up to the end of that reply's turn, i.e.
			 * branched just before the next user message, or a clone when the reply is the latest. `userIndex` is the
			 * index of the user message the reply answers (-1 before any).
			 */
			forkFromReply: (userIndex: number) =>
				run(async () => {
					const current = stateRef.current;
					const summary = current.sessions.find((session) => session.path === current.session?.sessionFile);
					const name = forkName(current.session?.sessionName || (summary ? sessionTitle(summary) : "Session"));
					const { messages } = await client.request<{ messages: { entryId: string; text: string }[] }>({ type: "get_fork_messages" });
					const next = messages[userIndex + 1];
					const { cancelled } = next
						? await client.request<{ cancelled: boolean }>({ type: "fork", entryId: next.entryId })
						: await client.request<{ cancelled: boolean }>({ type: "clone" });
					if (cancelled) return;
					await client.request({ type: "set_session_name", name });
					dispatch({ type: "patch", patch: { reviews: {}, widgets: {} } });
					await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
					toast("info", "Forked into a new session");
				}),
			/** A new chat in `folder`: a fresh session here, or Sorvex restarted in another folder. */
			newChatIn: (folder: string) =>
				run(async () => {
					if (folder !== cwdRef.current) return connect(folder);
					await client.request({ type: "new_session" });
					dispatch({ type: "patch", patch: { reviews: {}, widgets: {} } });
					await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
				}),
			switchSession: (sessionPath: string) =>
				run(async () => {
					await client.request({ type: "switch_session", sessionPath });
					dispatch({ type: "patch", patch: { reviews: {}, widgets: {} } });
					await Promise.all([refreshState(), reloadMessages()]);
				}),
			/** Renames the open session, or the session file at `path` (the sidebar's Rename). */
			renameSession: (name: string, path?: string) =>
				run(async () => {
					if (!path || path === stateRef.current.session?.sessionFile) {
						await client.request({ type: "set_session_name", name });
						await Promise.all([refreshState(), refreshSessions()]);
					} else {
						await api("POST", "/api/sessions/rename", { path, name });
						await refreshSessions();
					}
				}),
			/**
			 * Reloads the agent's model catalog (credentials, local llama.cpp models) and returns the new list. With
			 * `until`, polls briefly until it holds, because the catalog refresh finishes after the command returns.
			 */
			refreshModelCatalog: async (until?: (models: Model[]) => boolean): Promise<Model[]> => {
				await client.request({ type: "prompt", message: "/gui-refresh-models" }).catch(() => undefined);
				let models: Model[] = [];
				for (let attempt = 0; attempt < 12; attempt++) {
					models = (await client.request<{ models: Model[] }>({ type: "get_available_models" })).models;
					if (!until || until(models)) break;
					await new Promise((resolve) => setTimeout(resolve, 400));
				}
				dispatch({ type: "patch", patch: { models } });
				return models;
			},
			setModel: (model: Model) =>
				run(async () => {
					await client.request({ type: "set_model", provider: model.provider, modelId: model.id });
					// The last model you pick becomes Sorvex's default, so new sessions and restarts start on it
					// instead of whichever provider happens to have an environment key.
					rememberModel(model);
					void api("PUT", "/api/sorvex-settings", { cwd: cwdRef.current, key: "defaultModel", value: `${model.provider}/${model.id}` }).catch(() => undefined);
					await refreshModels();
					await refreshState();
				}),
			setThinking: (level: ThinkingLevel) =>
				run(async () => {
					await client.request({ type: "set_thinking_level", level });
					// Like the model, the last thinking level becomes the default for new sessions and restarts.
					void api("PUT", "/api/sorvex-settings", { cwd: cwdRef.current, key: "defaultThinkingLevel", value: level }).catch(() => undefined);
					await refreshState();
				}),
			setMode: (mode: Mode) => run(() => client.request({ type: "prompt", message: `/mode ${mode}` })),
			compact: (customInstructions?: string) => run(() => client.request({ type: "compact", customInstructions })),
			sessionCommand: (command: Record<string, unknown> & { type: string }) =>
				run(async () => {
					await client.request(command);
					await refreshState();
				}),
			exportHtml: () =>
				run(async () => {
					const { path } = await client.request<{ path: string }>({ type: "export_html" });
					toast("info", `Exported to ${path}`);
				}),
			editMessage: (userIndex: number) =>
				run(async () => {
					const text = await forkAt(userIndex);
					if (text !== undefined) dispatch({ type: "patch", patch: { editorText: { text, nonce: Date.now() } } });
				}),
			regenerate: (userIndex: number) =>
				run(async () => {
					const text = await forkAt(userIndex);
					if (text) await client.request({ type: "prompt", message: text });
				}),
			answerDialog: (response: ExtensionUIResponse) =>
				run(async () => {
					dispatch({ type: "dismiss_dialog", id: response.id });
					await client.respondUi(response);
				}),
			dismissDialog: (id: string) => dispatch({ type: "dismiss_dialog", id }),
			setComposerText: (text: string, append = false) =>
				dispatch({ type: "patch", patch: { editorText: { text, nonce: Date.now(), append } } }),
			saveSettings: (settings: DesktopSettings) =>
				run(async () => {
					dispatch({ type: "patch", patch: { settings } });
					await api("PUT", "/api/settings", settings);
				}),
			addAnnotation: (quote: string, comment: string) =>
				dispatch({ type: "patch", patch: { annotations: [...stateRef.current.annotations, { id: ++annotationId, quote, comment }] } }),
			updateAnnotation: (id: number, comment: string) =>
				dispatch({
					type: "patch",
					patch: { annotations: stateRef.current.annotations.map((a) => (a.id === id ? { ...a, comment } : a)) },
				}),
			removeAnnotation: (id: number) =>
				dispatch({ type: "patch", patch: { annotations: stateRef.current.annotations.filter((a) => a.id !== id) } }),
			clearAnnotations: () => dispatch({ type: "patch", patch: { annotations: [] } }),
			speak: speakText,
			stopSpeaking: () => speaker.stop(),
			toggleDictation: () =>
				run(async () => {
					const { voice, settings } = stateRef.current;
					if (!settings) return;
					if (voice.dictating && micRef.current) {
						const audio = micRef.current.stop();
						micRef.current = null;
						dispatch({ type: "voice", patch: { dictating: false, transcribing: Boolean(audio) } });
						dispatch({ type: "patch", patch: { micAnalyser: undefined } });
						if (!audio) return;
						try {
							const text = await transcribe(settings.voice, audio);
							if (text) dispatch({ type: "patch", patch: { editorText: { text, nonce: Date.now(), append: true } } });
						} finally {
							dispatch({ type: "voice", patch: { transcribing: false } });
						}
						return;
					}
					stopVoice();
					const mic = await Mic.open("dictation");
					micRef.current = mic;
					dispatch({ type: "voice", patch: { dictating: true } });
					dispatch({ type: "patch", patch: { micAnalyser: mic.analyser } });
				}),
			toggleVoiceChat: () =>
				run(async () => {
					const { voice, settings } = stateRef.current;
					if (!settings) return;
					if (voice.voiceChat) {
						stopVoice();
						speaker.stop();
						return;
					}
					stopVoice();
					const mic = await Mic.open("voice", settings.voice.micThreshold, {
						onSpeechStart: () => {
							// Barge in: talking over the agent stops its speech and the current run.
							speaker.stop();
							if (stateRef.current.isStreaming) void client.request({ type: "abort" }).catch(() => undefined);
						},
						onUtterance: (audio) => {
							dispatch({ type: "voice", patch: { transcribing: true } });
							transcribe(settings.voice, audio)
								.then((text) => {
									if (text) return send(text, false);
								})
								.catch((error: unknown) => toast("error", `Transcription failed: ${String(error)}`))
								.finally(() => dispatch({ type: "voice", patch: { transcribing: false } }));
						},
					});
					micRef.current = mic;
					dispatch({ type: "voice", patch: { voiceChat: true } });
					dispatch({ type: "patch", patch: { micAnalyser: mic.analyser } });
				}),
			/** `!cmd` adds the output to context; `!!cmd` runs it without sending output to the model. */
			bash: (command: string, excludeFromContext: boolean) =>
				run(async () => {
					await client.request({ type: "bash", command, excludeFromContext });
					await Promise.all([reloadMessages(), refreshState()]);
				}),
			abortBash: () => run(() => client.request({ type: "abort_bash" })),
			followUp: (message: string) => run(() => client.request({ type: "follow_up", message })),
			/** Alt+Up: take queued steering and follow-up messages back into the editor. */
			restoreQueue: () =>
				run(async () => {
					const { steering, followUp } = await client.request<{ steering: string[]; followUp: string[] }>({ type: "clear_queue" });
					const text = [...steering, ...followUp].join("\n\n");
					if (text) dispatch({ type: "patch", patch: { editorText: { text, nonce: Date.now(), append: true } } });
				}),
			cycleModel: (direction: 1 | -1) =>
				run(async () => {
					if (direction === 1) {
						await client.request({ type: "cycle_model" });
					} else {
						const { models, session } = stateRef.current;
						if (models.length === 0) return;
						const index = models.findIndex((m) => m.provider === session?.model?.provider && m.id === session?.model?.id);
						const previous = models[(index - 1 + models.length) % models.length]!;
						await client.request({ type: "set_model", provider: previous.provider, modelId: previous.id });
					}
					await refreshModels();
					await refreshState();
				}),
			cycleThinking: () =>
				run(async () => {
					await client.request({ type: "cycle_thinking_level" });
					await refreshState();
				}),
			clone: () =>
				run(async () => {
					await client.request({ type: "clone" });
					await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
					toast("info", "Session cloned");
				}),
			forkMessages: () => client.request<{ messages: { entryId: string; text: string }[] }>({ type: "get_fork_messages" }),
			fork: (entryId: string) =>
				run(async () => {
					const result = await client.request<{ text: string; cancelled: boolean }>({ type: "fork", entryId });
					if (result.cancelled) return;
					await Promise.all([refreshState(), reloadMessages(), refreshSessions()]);
					dispatch({ type: "patch", patch: { editorText: { text: result.text, nonce: Date.now() } } });
				}),
			tree: () => client.request<{ tree: unknown[]; leafId: string | null }>({ type: "get_tree" }),
			copyLast: () =>
				run(async () => {
					const { text } = await client.request<{ text: string | null }>({ type: "get_last_assistant_text" });
					if (!text) return toast("warning", "No agent message to copy yet");
					await navigator.clipboard.writeText(text);
					toast("info", "Copied the last agent message");
				}),
			deleteSession: (path: string) =>
				run(async () => {
					const { trashed } = await api<{ trashed: boolean }>("POST", "/api/sessions/delete", { path });
					toast("info", trashed ? "Session moved to the trash" : "Session deleted");
					await refreshSessions();
				}),
			exportJsonl: (path: string) =>
				run(async () => {
					const sessionFile = stateRef.current.session?.sessionFile;
					if (!sessionFile) throw new Error("This session has not been saved yet");
					await api("POST", "/api/sessions/export-jsonl", { sessionFile, path });
					toast("info", `Exported to ${path}`);
				}),
			exportHtmlTo: (outputPath?: string) =>
				run(async () => {
					const { path } = await client.request<{ path: string }>({ type: "export_html", outputPath });
					toast("info", `Exported to ${path}`);
				}),
			reload: () =>
				run(async () => {
					await client.request({ type: "prompt", message: "/gui-reload" });
					await hydrate();
					toast("info", "Reloaded extensions, skills, prompts and MCP servers");
				}),
			setUi: (patch: Partial<Pick<State, "hideThinking" | "expandTools">>) => dispatch({ type: "patch", patch }),
			refreshSessions,
			refreshModels,
		}),
		[client, connect, toast, run, send, hydrate, refreshState, reloadMessages, refreshSessions, refreshModels, forkAt, openSessionAt, speakText, stopVoice],
	);

	return { state, actions };
}

export type SorvexActions = ReturnType<typeof useSorvex>["actions"];
