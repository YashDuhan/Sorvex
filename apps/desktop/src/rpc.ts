import { api, serverEvents } from "./api.ts";

// Wire types for Sorvex RPC mode. The source of truth is packages/coding-agent/src/modes/rpc/rpc-types.ts and
// packages/ai/src/types.ts; only the fields this app reads are declared here.

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
	type: "text";
	text: string;
}
export interface ThinkingContent {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}
export interface ToolCall {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	argumentsError?: string;
	/** Raw JSON argument fragments while the call is still streaming. Client-side only. */
	partialJson?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}
export interface AssistantMessage {
	role: "assistant";
	content: (TextContent | ThinkingContent | ToolCall)[];
	provider: string;
	model: string;
	usage?: Usage;
	stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
	errorMessage?: string;
	timestamp: number;
	durationMs?: number;
}
export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
	durationMs?: number;
}
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timestamp: number;
}
export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: unknown;
	timestamp: number;
}
export interface SummaryMessage {
	role: "compactionSummary" | "branchSummary";
	summary: string;
	timestamp: number;
}
export interface SystemMessage {
	role: "system";
	timestamp: number;
}

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomMessage
	| SummaryMessage
	| SystemMessage;

export interface Model {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	contextWindow: number;
	/** Accepted input modalities, e.g. ["text", "image"]. */
	input?: string[];
}

export interface SessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface SessionStats {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface SlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
}

export interface SessionSummary {
	path: string;
	id: string;
	name: string | null;
	firstMessage: string | null;
	cwd?: string;
	modified: number;
	messageCount: number;
}

export type AssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start" | "thinking_start"; contentIndex: number }
	| { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id?: string; toolName?: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| { type: "done" }
	| { type: "error" };

export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; message?: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText: string | undefined }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type DialogRequest = Extract<ExtensionUIRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; willRetry?: boolean }
	| { type: "agent_settled"; aborted?: boolean }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; assistantMessageEvent: AssistantMessageEvent; usage?: Usage }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; parentToolCallId?: string }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			partialResult: unknown;
			parentToolCallId?: string;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
			durationMs?: number;
			parentToolCallId?: string;
	  }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: string }
	| { type: "compaction_end"; aborted: boolean; errorMessage?: string }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; finalError?: string }
	| { type: "extension_error"; extensionPath: string; error: string }
	| ExtensionUIRequest;

export interface StartInfo {
	launcher: string;
	cwd: string;
}

/** Talks to the Sorvex RPC process through the desktop server. Events arrive on the shared event stream. */
export class AgentClient {
	start(cwd: string): Promise<StartInfo> {
		return api<StartInfo>("POST", "/api/agent/start", { cwd });
	}

	async request<T = unknown>(command: Record<string, unknown> & { type: string }): Promise<T> {
		return (await api<{ data: T }>("POST", "/api/agent/rpc", { command })).data;
	}

	respondUi(response: ExtensionUIResponse): Promise<unknown> {
		return api("POST", "/api/agent/ui", { response });
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		return serverEvents.on("agent", listener);
	}

	onStatus(listener: (status: AgentStatus) => void): () => void {
		return serverEvents.on("agent-status", listener);
	}
}

export interface AgentStatus {
	status: "stopped" | "starting" | "ready" | "exited" | "error";
	cwd: string;
	launcher: string;
	error?: string;
}

/** Sessions in `cwd`, or with `all` every session in every folder (each carries its `cwd`). */
export function listSessions(cwd: string, all = false): Promise<SessionSummary[]> {
	return api<SessionSummary[]>("GET", `/api/sessions?cwd=${encodeURIComponent(cwd)}${all ? "&all=1" : ""}`);
}

/** `dialogs`: extension dialogs and tool approvals still waiting for an answer. */
export async function serverState(): Promise<{ agent: AgentStatus; defaultCwd: string; dialogs: DialogRequest[] }> {
	return api("GET", "/api/state");
}
