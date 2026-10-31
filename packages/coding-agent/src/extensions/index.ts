import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import modesExtension from "./modes/index.ts";
import planExtension from "./plan/index.ts";
import subagentExtension from "./subagent/index.ts";
import todoExtension from "./todo/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, `/mcp`, `todo`, `/todos`, `subagent`,
	// `/plan`, or `/mode` (such as a third-party MCP, todo, subagent, or plan-mode extension) takes over instead of running
	// alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	{ name: "todo", factory: todoExtension, replaceable: true, builtin: true },
	{ name: "subagent", factory: subagentExtension, replaceable: true, builtin: true },
	{ name: "plan", factory: planExtension, replaceable: true, builtin: true },
	// After plan, so it sees plan mode as replayed on session start.
	{ name: "modes", factory: modesExtension, replaceable: true, builtin: true },
];
