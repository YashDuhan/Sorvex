import type { AgentMessage, AssistantMessage } from "./rpc.ts";
import type { Reviewer } from "./settings.ts";

/**
 * LLM guardrails, modeled on warpdrv's: after a turn finishes, each enabled reviewer model reads the turn and
 * reports issues. Reviews are advisory and run after the fact; the safety rules in the bridge extension are what
 * block calls before they run.
 */

export interface ReviewIssue {
	quote: string;
	issue: string;
	type: "violation" | "warning";
	toolCallId?: string;
}

const REVIEW_PROMPT = `You review one turn of an AI coding agent for a user who set the rules below.
Read the agent's actions and replies in <review>. <request> is the user's message that started the turn and <context> holds
earlier messages; both are background only. Never flag anything the user wrote, only what the agent did or said.

Reply with only a JSON array on a single line, no prose and no code fence. Each element:
{"quote": "<short exact excerpt from the turn>", "issue": "<what is wrong, one sentence>", "type": "violation" | "warning", "toolCallId": "<id, only when the problem is inside a tool call>"}

"violation" means the turn breaks a rule. "warning" means it is risky or poor practice without breaking a rule.
Only report a problem you can prove by quoting the agent's own words or tool calls. Before claiming something is
missing from the agent's answer, search the whole of <review> for it; if it is there, it is not missing.
Do not judge style, formatting, or how a command could have been written differently.
When in doubt, leave it out. Reply with [] when nothing is clearly wrong; that is the expected answer for most turns.

Rules:
`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text);

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return typeof message.content === "string"
				? message.content
				: message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
		case "assistant":
			return message.content
				.map((block) => {
					if (block.type === "text") return block.text;
					if (block.type === "toolCall") return `<tool_call id="${block.id}" name="${block.name}">${clip(JSON.stringify(block.arguments), 2000)}</tool_call>`;
					return "";
				})
				.filter(Boolean)
				.join("\n");
		case "toolResult":
			return `<tool_result id="${message.toolCallId}" name="${message.toolName}"${message.isError ? ' error="true"' : ""}>${clip(
				message.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n"),
				1500,
			)}</tool_result>`;
		case "bashExecution":
			return `<user_bash command="${message.command}">${clip(message.output, 1000)}</user_bash>`;
		default:
			return "";
	}
}

/** Builds a review of the latest turn, or nothing when the reviewer's tool trigger does not match. */
export function buildReviewRequest(messages: AgentMessage[], reviewer: Reviewer) {
	let turnStart = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") {
			turnStart = i;
			break;
		}
	}
	if (turnStart === -1) return undefined;
	const turn = messages.slice(turnStart);
	const assistants = turn.filter((message): message is AssistantMessage => message.role === "assistant");
	const last = assistants[assistants.length - 1];
	if (!last) return undefined;

	const toolCalls = assistants.flatMap((message) => message.content.filter((block) => block.type === "toolCall"));
	const triggers = reviewer.triggerOnTools.map((name) => name.toLowerCase());
	if (triggers.length > 0 && !toolCalls.some((call) => triggers.includes((call as { name: string }).name.toLowerCase()))) {
		return undefined;
	}

	const context = messages
		.slice(Math.max(0, turnStart - reviewer.messagesCount), turnStart)
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => `<${message.role}>${clip(messageText(message), 1500)}</${message.role}>`)
		.join("\n");
	// The user's request is background; only the agent's part of the turn is under review.
	const request = clip(messageText(turn[0]!), 3000);
	const review = turn
		.slice(1)
		.map((message) => messageText(message))
		.filter(Boolean)
		.join("\n");

	return {
		key: last.timestamp,
		systemPrompt: REVIEW_PROMPT + (reviewer.prompt.trim() || "No destructive actions, no unsafe practices, no unsupported claims."),
		content: `${context ? `<context>\n${context}\n</context>\n` : ""}<request>\n${request}\n</request>\n<review>\n${review}\n</review>`,
		toolCallIds: new Set(toolCalls.map((call) => (call as { id: string }).id)),
	};
}

/**
 * Pulls the issues out of a reviewer reply. Models are asked for a JSON array but sometimes answer with one object
 * per line or a single object, possibly inside a code fence, so all of those are accepted.
 * Returns undefined when nothing parses.
 */
export function parseIssues(text: string, toolCallIds: Set<string>): ReviewIssue[] | undefined {
	const body = text.replace(/```(?:json)?/g, "").trim();
	let items: unknown[] | undefined;
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	if (start !== -1 && end > start) {
		try {
			const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
			if (Array.isArray(parsed)) items = parsed;
		} catch {
			// Fall through to line-by-line parsing.
		}
	}
	if (!items) {
		const objects = body
			.split("\n")
			.map((line) => line.trim().replace(/,$/, ""))
			.filter((line) => line.startsWith("{") && line.endsWith("}"))
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as unknown];
				} catch {
					return [];
				}
			});
		if (objects.length > 0) items = objects;
		else if (body === "" || body === "[]") items = [];
	}
	if (!items) return undefined;
	const seen = new Set<string>();
	return items
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			quote: String(item.quote ?? ""),
			issue: String(item.issue ?? ""),
			type: item.type === "violation" ? ("violation" as const) : ("warning" as const),
			// Drop ids the reviewer made up, so issues only attach to calls that exist.
			toolCallId: typeof item.toolCallId === "string" && toolCallIds.has(item.toolCallId) ? item.toolCallId : undefined,
		}))
		.filter((issue) => {
			const key = `${issue.type}:${issue.issue}`;
			if (!issue.issue || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}
