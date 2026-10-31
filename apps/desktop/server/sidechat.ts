import { Type } from "typebox";
import { redactSecrets } from "../extension/redact.ts";
import type { Credentials, TurnContext, TurnMessage } from "./credentials.ts";
import type { Hub } from "./hub.ts";
import { listDir, readWorkspaceFile, searchFiles } from "./workspace.ts";

type Message = TurnContext["messages"][number];

const SYSTEM_PROMPT = [
	"You are a side chat next to a user's main session with an AI coding agent (Sorvex).",
	"The main session's transcript is in the first message, inside <conversation>. It is replaced with the latest transcript before each of your replies, ending with the main agent's current status, so always answer from it rather than from your earlier replies. The main agent keeps working on its own and never sees this side chat.",
	"Answer the user's questions about that session and the project. You can read files, search them and list folders with your tools, but you cannot edit files, run commands or browse the web. If a request needs that, tell the user to ask the main agent.",
	"Be brief and direct.",
].join(" ");

/** Tool rounds per message, so a confused model cannot loop forever. */
const MAX_ROUNDS = 12;
const READ_LIMIT = 60_000;
/** Files the side chat refuses to read, matching the main agent's env-file and key guardrails. */
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|.*\.pem|.*\.key|credentials(\.json)?|auth\.json)$/i;

const TOOLS: TurnContext["tools"] = [
	{
		name: "read_file",
		description: "Read a text file in the project. Paths are relative to the project root. Use offset/limit (1-based lines) for large files.",
		parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
	},
	{
		name: "search",
		description: "Case-insensitive text search across project files (git grep). Returns path:line: text.",
		parameters: Type.Object({ query: Type.String() }),
	},
	{
		name: "list_dir",
		description: "List a folder in the project. Use '' for the root.",
		parameters: Type.Object({ path: Type.String() }),
	},
];

interface Chat {
	messages: Message[];
	/** The first user message without the transcript, which is re-attached with the latest one on every send. */
	firstText?: string;
	controller?: AbortController;
}

/** What the UI shows for a tool call: "Read src/a.ts", "Searched “foo”", "Listed src". */
function describe(name: string, args: Record<string, unknown>): string {
	if (name === "read_file") return `Read ${String(args.path)}`;
	if (name === "search") return `Searched “${String(args.query)}”`;
	return `Listed ${String(args.path) || "project root"}`;
}

/**
 * Side chats (/btw): a conversation next to the main one that sees its transcript, uses the same model, can read the
 * project, and is never saved to the session. It runs in this server with its own read-only tools, so it cannot
 * change anything; tool output goes through the same secret redaction as the main agent's.
 */
export class SideChats {
	private readonly hub: Hub;
	private readonly credentials: Credentials;
	private readonly root: () => string;
	private readonly chats = new Map<string, Chat>();

	constructor(hub: Hub, credentials: Credentials, root: () => string) {
		this.hub = hub;
		this.credentials = credentials;
		this.root = root;
	}

	/** Adds a user message and runs the model (with tool rounds) until it answers. Events: side-* on the hub. */
	send(id: string, model: string, text: string, transcript?: string): void {
		let chat = this.chats.get(id);
		if (!chat) {
			chat = { messages: [] };
			this.chats.set(id, chat);
		}
		if (chat.controller) throw new Error("The side chat is still answering");
		const withTranscript = (question: string) => `<conversation>\n${transcript || "(no messages yet)"}\n</conversation>\n\n${question}`;
		if (chat.messages.length === 0) {
			chat.firstText = text;
			chat.messages.push({ role: "user", content: withTranscript(text), timestamp: Date.now() });
		} else {
			// The main chat moves on while this one runs: swap in its latest transcript so answers are current.
			const first = chat.messages[0];
			if (transcript !== undefined && first?.role === "user" && chat.firstText !== undefined) chat.messages[0] = { ...first, content: withTranscript(chat.firstText) };
			chat.messages.push({ role: "user", content: text, timestamp: Date.now() });
		}
		const controller = new AbortController();
		chat.controller = controller;
		void this.run(id, chat, model, controller.signal)
			.then(
				() => this.hub.broadcast("side-done", { id }),
				(error: unknown) => this.hub.broadcast("side-done", { id, error: error instanceof Error ? error.message : String(error) }),
			)
			.finally(() => {
				chat.controller = undefined;
			});
	}

	stop(id: string): void {
		this.chats.get(id)?.controller?.abort();
	}

	close(id: string): void {
		this.stop(id);
		this.chats.delete(id);
	}

	private async run(id: string, chat: Chat, model: string, signal: AbortSignal): Promise<void> {
		for (let round = 0; round < MAX_ROUNDS; round++) {
			const message: TurnMessage = await this.credentials.turn(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: chat.messages, tools: TOOLS },
				(event) => this.hub.broadcast("side-delta", { id, delta: event.delta }),
				signal,
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.stopReason === "aborted" ? "Stopped" : (message.errorMessage ?? "Request failed"));
			}
			chat.messages.push(message);
			const calls = message.content.filter((block) => block.type === "toolCall");
			if (calls.length === 0) return;
			for (const call of calls) {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				this.hub.broadcast("side-tool", { id, label: describe(call.name, args) });
				let output: string;
				let isError = false;
				try {
					output = redactSecrets(await this.tool(call.name, args)).text;
				} catch (error) {
					output = error instanceof Error ? error.message : String(error);
					isError = true;
				}
				chat.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: output }], isError, timestamp: Date.now() });
			}
		}
		throw new Error("Stopped after too many tool calls");
	}

	private async tool(name: string, args: Record<string, unknown>): Promise<string> {
		const root = this.root();
		if (name === "read_file") {
			const path = String(args.path ?? "");
			if (SECRET_FILE.test(path)) throw new Error(`Blocked: ${path} may contain secrets, so the side chat does not read it.`);
			const file = readWorkspaceFile(root, path);
			if (file.binary) return `${path} is a binary file (${file.size} bytes).`;
			const lines = file.content.split("\n");
			const start = Math.max(1, Number(args.offset) || 1);
			const count = Math.max(1, Number(args.limit) || lines.length);
			const text = lines
				.slice(start - 1, start - 1 + count)
				.map((line, index) => `${start + index}: ${line}`)
				.join("\n");
			return text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n[cut; use offset/limit to read more]` : text;
		}
		if (name === "search") {
			const results = await searchFiles(root, String(args.query ?? ""));
			return results.length ? results.map((result) => `${result.path}:${result.line}: ${result.text}`).join("\n") : "No matches.";
		}
		if (name === "list_dir") {
			return listDir(root, String(args.path ?? ""))
				.map((entry) => `${entry.path}${entry.dir ? "/" : ""}`)
				.join("\n");
		}
		throw new Error(`Unknown tool ${name}`);
	}
}
