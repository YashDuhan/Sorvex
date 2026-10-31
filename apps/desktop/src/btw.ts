import type { AgentMessage, ImageContent, TextContent } from "./rpc.ts";
import type { RunningTool } from "./store.ts";

/** About 50k tokens of transcript; older parts are cut first. */
const TRANSCRIPT_LIMIT = 200_000;
const TOOL_ARGS_LIMIT = 400;
const TOOL_RESULT_LIMIT = 2000;

function text(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
}

function clip(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit)}... [${value.length - limit} more characters]` : value;
}

/** The main chat as plain text for the side chat (/btw). Thinking is left out; tool calls and results are shortened. */
export function buildTranscript(messages: AgentMessage[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		switch (message.role) {
			case "user":
				parts.push(`User: ${text(message.content)}`);
				break;
			case "assistant":
				for (const block of message.content) {
					if (block.type === "text" && block.text.trim()) parts.push(`Assistant: ${block.text}`);
					else if (block.type === "toolCall") parts.push(`[tool call ${block.name} ${clip(JSON.stringify(block.arguments), TOOL_ARGS_LIMIT)}]`);
				}
				if (message.stopReason === "error" && message.errorMessage) parts.push(`[error: ${message.errorMessage}]`);
				break;
			case "toolResult":
				parts.push(`[tool result ${message.toolName}${message.isError ? " (error)" : ""}: ${clip(text(message.content), TOOL_RESULT_LIMIT)}]`);
				break;
			case "bashExecution":
				parts.push(`[shell $ ${message.command} (exit ${message.exitCode ?? "?"}): ${clip(message.output, TOOL_RESULT_LIMIT)}]`);
				break;
			case "custom":
				if (message.display) parts.push(`[${message.customType}: ${clip(text(message.content), TOOL_RESULT_LIMIT)}]`);
				break;
			case "compactionSummary":
			case "branchSummary":
				parts.push(`[summary of earlier conversation: ${message.summary}]`);
				break;
		}
	}
	const transcript = parts.join("\n\n");
	return transcript.length > TRANSCRIPT_LIMIT ? `[earlier conversation cut]\n\n${transcript.slice(-TRANSCRIPT_LIMIT)}` : transcript;
}

function partialText(partial: unknown): string {
	const content = partial && typeof partial === "object" && "content" in partial ? (partial as { content: unknown }).content : undefined;
	if (!Array.isArray(content)) return "";
	return content.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

/** What the main agent is doing right now: idle, or busy and which tools are running (with their latest output). */
export function liveStatus(isStreaming: boolean, running: Record<string, RunningTool>): string {
	const tools = Object.values(running);
	if (!isStreaming && tools.length === 0) return "[main agent status: idle, waiting for the user]";
	const lines = tools.map((tool) => {
		const output = partialText(tool.partial);
		return `- ${tool.parentId ? "(nested) " : ""}${tool.name} ${clip(JSON.stringify(tool.args ?? {}), TOOL_ARGS_LIMIT)}${output ? `\n  latest output: ${clip(output.slice(-TOOL_RESULT_LIMIT), TOOL_RESULT_LIMIT)}` : ""}`;
	});
	return `[main agent status: working${tools.length ? `; tools running now:\n${lines.join("\n")}` : ", generating a reply"}]`;
}
