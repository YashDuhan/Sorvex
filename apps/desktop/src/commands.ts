import type { SlashCommand } from "./rpc.ts";

/**
 * The TUI's built-in slash commands (packages/coding-agent/src/core/slash-commands.ts). They are handled by the
 * interactive mode, not the agent, so RPC would send them to the model as text. The GUI handles them itself.
 */
export const BUILTIN_COMMANDS: { name: string; description: string }[] = [
	{ name: "btw", description: "Side chat about this chat and project, with follow-ups (not saved)" },
	{ name: "settings", description: "Open settings" },
	{ name: "model", description: "Select model" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "thinking", description: "Set thinking level" },
	{ name: "tree", description: "Navigate the session tree" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "export", description: "Export session (HTML default, or a .html/.jsonl path)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "trust", description: "Save project trust decision for this folder" },
	{ name: "reload", description: "Reload extensions, skills, prompts, MCP servers and context files" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "quit", description: "Quit Sorvex" },
];

const BUILTIN_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));

/** Built-ins first, then the agent's extension commands, prompt templates and skills. */
export function allCommands(agentCommands: SlashCommand[]): { name: string; description?: string; source: string }[] {
	return [
		...BUILTIN_COMMANDS.map((command) => ({ ...command, source: "builtin" })),
		...agentCommands.filter((command) => !BUILTIN_NAMES.has(command.name) && !command.name.startsWith("gui-")),
	];
}

/** Splits "/name rest" when `name` is a GUI-handled built-in. */
export function parseBuiltin(text: string): { name: string; args: string } | undefined {
	const match = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match || !BUILTIN_NAMES.has(match[1]!)) return undefined;
	return { name: match[1]!, args: (match[2] ?? "").trim() };
}

export const HOTKEYS: { group: string; keys: [string, string][] }[] = [
	{
		group: "Editor",
		keys: [
			["Enter", "Send (steers while the agent runs)"],
			["Shift+Enter", "New line"],
			["Alt+Enter", "Queue a follow-up message"],
			["Alt+Up", "Put queued messages back in the editor"],
			["Up / Down", "Prompt history (at the start or end of the text)"],
			["/", "Commands, prompt templates and skills"],
			["@", "Reference a file"],
			["!cmd / !!cmd", "Run a shell command (!! keeps the output out of context)"],
			["Esc", "Stop the agent or the running shell command"],
			["Esc Esc", "Open the tree or fork picker (Settings → double-escape)"],
		],
	},
	{
		group: "Models and modes",
		keys: [
			["Ctrl+L", "Select model"],
			["Ctrl+P / Ctrl+Shift+P", "Next / previous model"],
			["Shift+Tab", "Cycle thinking level"],
			["Ctrl+Alt+N", "Next mode (build, plan, security)"],
			["Ctrl+Alt+P", "Toggle plan mode"],
		],
	},
	{
		group: "View",
		keys: [
			["Ctrl+O", "Expand or collapse all tool output"],
			["Ctrl+T", "Show or hide thinking blocks"],
			["Alt+T", "Show or hide the todos panel"],
			["Ctrl+Shift+F", "Search the conversation"],
			["Ctrl+N", "New session"],
		],
	},
];
