/**
 * MCP prompts as slash commands. Each prompt a server offers runs as `/mcp__<server>__<prompt>`
 * with `key=value` arguments; missing required arguments are asked for, and the messages the
 * server returns are sent as the user's next message. Without dialogs (print and json modes) the
 * command runs that message as the turn and waits for it, and a command that cannot run fails
 * with its reason instead of a notice nobody sees.
 */

import type { ImageContent, TextContent } from "@sorvex/ai";
import { type GetPromptResult, type Prompt as McpPrompt, toLlmContent } from "@sorvex/mcp";
import { type AutocompleteItem, type AutocompleteProvider, fuzzyFilter } from "@sorvex/tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { cleanServerText } from "./elicitation.ts";
import { createMcpToolName } from "./tools.ts";

export interface McpPromptCommands {
	/** Make `prompts` the server's offered commands, registering commands for new prompts. */
	offer(server: string, prompts: readonly McpPrompt[]): void;
	withdraw(server: string): void;
	withdrawAll(): void;
	/** Completes offered prompt commands and their argument names in the TUI. */
	autocomplete(current: AutocompleteProvider): AutocompleteProvider;
}

/** Runs `prompts/get`, connecting to the server first when needed. */
export type McpPromptGetter = (
	server: string,
	prompt: string,
	args: Record<string, string>,
	ctx: ExtensionCommandContext,
) => Promise<GetPromptResult>;

interface PromptOwner {
	server: string;
	prompt: string;
}

const ARGUMENT = /\s*([^\s="']+)=(?:"([^"]*)"|'([^']*)'|([^\s"']*))/y;

function parsePromptArguments(text: string): Record<string, string> | undefined {
	const values: Record<string, string> = {};
	const pattern = new RegExp(ARGUMENT);
	let index = 0;
	while (text.slice(index).trim() !== "") {
		pattern.lastIndex = index;
		const match = pattern.exec(text);
		if (!match || (pattern.lastIndex < text.length && !/\s/.test(text[pattern.lastIndex] ?? ""))) return undefined;
		values[match[1]] = match[2] ?? match[3] ?? match[4] ?? "";
		index = pattern.lastIndex;
	}
	return values;
}

function usage(command: string, prompt: McpPrompt): string {
	const args = (prompt.arguments ?? []).map((arg) => (arg.required ? `${arg.name}=…` : `[${arg.name}=…]`));
	return [`/${command}`, ...args].join(" ");
}

function describe(server: string, prompt: McpPrompt): string {
	const summary = cleanServerText((prompt.description ?? prompt.title ?? "").split("\n", 1)[0] ?? "", 200);
	return summary ? `${summary} (MCP ${server})` : `MCP prompt ${cleanServerText(prompt.name, 100)} of ${server}`;
}

/** Most text a prompt may send as the user's message, in characters; the rest is cut with a note. */
export const MAX_PROMPT_TEXT = 100_000;
/** Most images a prompt may send, and their total base64 size; further images are left out with a note. */
export const MAX_PROMPT_IMAGES = 10;
export const MAX_PROMPT_IMAGE_BYTES = 20_000_000;

function completeArguments(prompt: McpPrompt, text: string): AutocompleteItem[] | null {
	const start = text.search(/\S*$/);
	const word = text.slice(start);
	if (word.includes("=")) return null;
	const given = new Set([...text.slice(0, start).matchAll(/([^\s="']+)=/g)].map((match) => match[1]));
	const items = (prompt.arguments ?? [])
		.filter((arg) => !given.has(arg.name) && arg.name.startsWith(word))
		.map((arg) => ({
			value: `${text.slice(0, start)}${arg.name}=`,
			label: `${arg.name}=`,
			...(arg.description ? { description: arg.description } : {}),
		}));
	return items.length > 0 ? items : null;
}

function promptMessageContent(result: GetPromptResult): (TextContent | ImageContent)[] {
	const labelled = result.messages.length > 1 || result.messages.some((message) => message.role !== "user");
	const texts: string[] = [];
	const images: ImageContent[] = [];
	let imageBytes = 0;
	let droppedImages = 0;
	for (const message of result.messages) {
		for (const block of toLlmContent({ content: [message.content] })) {
			if (block.type === "text") texts.push(labelled ? `[${message.role}] ${block.text}` : block.text);
			else if (images.length < MAX_PROMPT_IMAGES && imageBytes + block.data.length <= MAX_PROMPT_IMAGE_BYTES) {
				images.push(block);
				imageBytes += block.data.length;
			} else droppedImages++;
		}
	}
	let text = texts.join("\n\n").trim();
	if (text.length > MAX_PROMPT_TEXT) {
		text = `${text.slice(0, MAX_PROMPT_TEXT)}\n\n[MCP prompt cut: ${text.length - MAX_PROMPT_TEXT} more characters left out]`;
	}
	if (droppedImages > 0) {
		text = `${text}${text ? "\n\n" : ""}[MCP prompt cut: ${droppedImages} more image${droppedImages === 1 ? "" : "s"} left out]`;
	}
	return [...(text ? [{ type: "text" as const, text }] : []), ...images];
}

export function createMcpPromptCommands(pi: ExtensionAPI, getPrompt: McpPromptGetter): McpPromptCommands {
	const offered = new Map<string, Map<string, McpPrompt>>();
	const names = new Map<string, string>();
	const owners = new Map<string, PromptOwner>();
	/** Shows why the command cannot run; without dialogs it fails with the reason, which print mode reports. */
	const refuse = (ctx: ExtensionCommandContext, message: string, type: "error" | "warning" = "error") => {
		if (!ctx.hasUI) throw new Error(message);
		ctx.ui.notify(message, type);
	};

	/**
	 * Print and json modes end the run when the command returns, so the command runs the message as
	 * the turn and waits for it. A message that cannot run fails the command with the reason.
	 */
	const runTurn = async (content: (TextContent | ImageContent)[], ctx: ExtensionCommandContext) => {
		const disposition = await ctx.sendUserMessage(content);
		if (disposition === "handled") throw new Error("An extension handled the prompt's message, so no turn ran.");
	};

	const offeredPrompt = (command: string): (PromptOwner & { definition: McpPrompt }) | undefined => {
		const owner = owners.get(command);
		const definition = owner && offered.get(owner.server)?.get(owner.prompt);
		return owner && definition ? { ...owner, definition } : undefined;
	};

	const run = async ({ server, prompt }: PromptOwner, command: string, text: string, ctx: ExtensionCommandContext) => {
		const definition = offered.get(server)?.get(prompt);
		if (!definition) return refuse(ctx, `MCP server "${server}" no longer offers the prompt "${prompt}".`);
		const args = parsePromptArguments(text);
		if (!args) return refuse(ctx, `Arguments are key=value pairs. Usage: ${usage(command, definition)}`);
		for (const arg of definition.arguments ?? []) {
			if (!arg.required || args[arg.name]) continue;
			if (!ctx.hasUI) return refuse(ctx, `Missing argument "${arg.name}". Usage: ${usage(command, definition)}`);
			const label = cleanServerText(arg.title ?? arg.name, 100);
			const description = arg.description ? cleanServerText(arg.description, 300) : "";
			const value = await ctx.ui.input(`/${command}: ${label}${description ? ` (${description})` : ""}`);
			if (value === undefined) return;
			args[arg.name] = value;
		}
		let result: GetPromptResult;
		try {
			result = await getPrompt(server, prompt, args, ctx);
		} catch (error) {
			return refuse(
				ctx,
				`MCP prompt ${server}/${prompt} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const content = promptMessageContent(result);
		if (content.length === 0) return refuse(ctx, `MCP prompt ${server}/${prompt} returned no content.`, "warning");
		if (!ctx.hasUI) return runTurn(content, ctx);
		pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	};

	const register = (server: string, prompt: McpPrompt) => {
		const key = `${server}\0${prompt.name}`;
		const owner = { server, prompt: prompt.name };
		const command = names.get(key) ?? createMcpToolName(server, prompt.name, (candidate) => owners.has(candidate));
		names.set(key, command);
		owners.set(command, owner);
		pi.registerCommand(command, {
			description: describe(server, prompt),
			getArgumentCompletions: (text) => {
				const target = offeredPrompt(command);
				return target ? completeArguments(target.definition, text) : null;
			},
			handler: (text, ctx) => run(owner, command, text, ctx),
		});
	};

	return {
		offer(server, prompts) {
			offered.set(server, new Map(prompts.map((prompt) => [prompt.name, prompt])));
			for (const prompt of prompts) register(server, prompt);
		},
		// Commands cannot be unregistered, so a prompt that is gone keeps its command, which reports it.
		withdraw(server) {
			offered.delete(server);
		},
		withdrawAll() {
			offered.clear();
		},
		autocomplete(current) {
			return {
				triggerCharacters: current.triggerCharacters,
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
					const text = (lines[cursorLine] ?? "").slice(0, cursorCol).trimStart();
					if (options.force || !text.startsWith("/")) return suggestions;
					const space = text.indexOf(" ");
					if (space !== -1) {
						const target = offeredPrompt(text.slice(1, space));
						if (!target) return suggestions;
						const argumentText = text.slice(space + 1);
						const items = completeArguments(target.definition, argumentText);
						return items ? { items, prefix: argumentText } : null;
					}
					const others = (suggestions?.items ?? []).filter((item) => !owners.has(item.value));
					const prompts = fuzzyFilter(
						[...owners.keys()].filter(offeredPrompt),
						text.slice(1),
						(command) => command,
					).map((command): AutocompleteItem => {
						const target = offeredPrompt(command);
						return {
							value: command,
							label: command,
							...(target ? { description: describe(target.server, target.definition) } : {}),
						};
					});
					const items = [...others, ...prompts];
					return items.length > 0 ? { items, prefix: text } : null;
				},
				applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
					current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
				shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
					? (lines, cursorLine, cursorCol) =>
							current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false
					: undefined,
			};
		},
	};
}
