import { parse as partialParse } from "partial-json";
import type { ToolCall } from "../types.ts";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/** Separates the problem from the echoed arguments in a tool-argument error message. */
export const RECEIVED_ARGUMENTS_SEPARATOR = "\n\nReceived arguments:\n";

const RECEIVED_ARGUMENTS_EDGE_CHARS = 2048;

function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
	return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Formats a tool-argument error for the model: the problem, then the arguments it sent. Long arguments keep only their
 * first and last 2 KB, so the error stays cheap to resend while still showing where the text broke. Cuts never split a
 * surrogate pair, which providers reject as invalid text.
 */
export function formatToolArgumentsError(message: string, received: string): string {
	let shown = received;
	const omitted = received.length - 2 * RECEIVED_ARGUMENTS_EDGE_CHARS;
	if (omitted > 0) {
		let headEnd = RECEIVED_ARGUMENTS_EDGE_CHARS;
		if (isHighSurrogate(received.charCodeAt(headEnd - 1))) headEnd--;
		let tailStart = received.length - RECEIVED_ARGUMENTS_EDGE_CHARS;
		if (isLowSurrogate(received.charCodeAt(tailStart))) tailStart++;
		shown = `${received.slice(0, headEnd)}\n... [${tailStart - headEnd} characters omitted] ...\n${received.slice(tailStart)}`;
	}
	return `${message}${RECEIVED_ARGUMENTS_SEPARATOR}${shown}`;
}

/** Thrown by tool validation when the model's arguments are malformed or fail the schema. */
export class ToolArgumentsError extends Error {
	override name = "ToolArgumentsError";
}

/** Tool-result `details` that mark the result as a {@link ToolArgumentsError}. */
export const TOOL_ARGUMENTS_ERROR_DETAILS = { toolArgumentsError: true } as const;

/** Whether tool-result `details` mark an argument error rather than an error the tool itself produced. */
export function isToolArgumentsErrorDetails(details: unknown): boolean {
	return (
		typeof details === "object" &&
		details !== null &&
		(details as { toolArgumentsError?: unknown }).toolArgumentsError === true
	);
}

/**
 * Text a model may leak after the arguments object: DeepSeek closing special tokens (spelled with the fullwidth bar
 * U+FF5C and an `end` word, e.g. `<｜tool▁call▁end｜>`, `<｜end▁of▁sentence｜>`), DSML closing tags
 * (`</｜DSML｜ invoke>`) and the closing fence of a ```json block. Opening tags are excluded: they start a second call.
 */
const TRAILING_CONTROL_TEXT = /^(?:\s|<\/｜[^<>\n]{0,64}>|<｜[\w▁]{0,64}end[\w▁]{0,64}｜>|```)*$/;

/** End index (exclusive) of the object that opens `text` at `start`, or undefined when it never closes. */
function findObjectEnd(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
		} else if (char === "{" || char === "[") {
			depth++;
		} else if (char === "}" || char === "]") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return undefined;
}

/**
 * The leading JSON object of `text` when everything after it is whitespace or model control text, as when a provider
 * passes a stray `<｜tool▁call▁end｜>` through with the arguments. Anything else after the object is ambiguous (a
 * second call, a broken string) and stays an error.
 */
function stripTrailingControlText(text: string): string | undefined {
	const start = text.search(/\S/);
	if (text[start] !== "{") return undefined;
	const end = findObjectEnd(text, start);
	if (end === undefined || end === text.length || !TRAILING_CONTROL_TEXT.test(text.slice(end))) return undefined;
	return text.slice(start, end);
}

/**
 * Parses the model's complete arguments text of a finished tool call.
 *
 * Unlike {@link parseStreamingJson}, this never keeps a partially parsed prefix: once the call is
 * finished, text that is not a valid JSON object means the model sent malformed arguments. In that
 * case `arguments` is `{}` and `argumentsError` describes the problem, including the text the
 * model sent, so tool validation can report it back to the model. The one recovery beyond
 * {@link repairJson} is dropping model control text after a complete object.
 */
export function parseToolCallArguments(json: string | undefined): Pick<ToolCall, "arguments" | "argumentsError"> {
	if (!json?.trim()) return { arguments: {} };
	let parsed: ToolCall["arguments"] | null;
	try {
		parsed = parseJsonWithRepair<ToolCall["arguments"] | null>(json);
	} catch (error) {
		const object = stripTrailingControlText(json);
		try {
			if (object === undefined) throw error;
			parsed = parseJsonWithRepair<ToolCall["arguments"]>(object);
		} catch {
			return {
				arguments: {},
				argumentsError: formatToolArgumentsError(error instanceof Error ? error.message : String(error), json),
			};
		}
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { arguments: {}, argumentsError: formatToolArgumentsError("Tool arguments must be a JSON object", json) };
	}
	return { arguments: parsed };
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
