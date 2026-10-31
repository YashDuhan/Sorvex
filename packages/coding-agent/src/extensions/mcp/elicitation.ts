/**
 * Answers MCP elicitation requests (form mode): one dialog per field of the server's flat schema,
 * then a choice to accept (send the answers) or decline. Dismissing any dialog cancels, and so does
 * aborting the agent turn the request arrived in. Without dialogs (print and json modes) every
 * request is declined.
 *
 * Server text is shown on single, indented lines with escape sequences and control characters
 * removed, below a header naming the server, so a server cannot restyle the dialog or pose as
 * another server; long text is shortened.
 */

import type {
	ElicitEnumSchema,
	ElicitMultiSelectSchema,
	ElicitNumberSchema,
	ElicitRequestParams,
	ElicitResult,
	ElicitSchema,
	ElicitStringSchema,
	ElicitTitledEnumSchema,
	ElicitValue,
} from "@sorvex/mcp";
import type { ExtensionContext, ExtensionUIContext } from "../../core/extensions/types.ts";
import { stripAnsi } from "../../utils/ansi.ts";

export type ElicitationUi = Pick<ExtensionUIContext, "select" | "input" | "notify">;

const ELICITATION_ACCEPT = "Accept";
const ELICITATION_DECLINE = "Decline";
const SKIP = "Skip";
export const DEFAULT_MARK = " (default)";

interface Choice<T> {
	value: T;
	label: string;
}

type Answer = { value: ElicitValue | undefined } | "cancel";

type Parse = (text: string) => { value: ElicitValue } | { error: string };

const FORMAT_CHECKS: Record<NonNullable<ElicitStringSchema["format"]>, (text: string) => boolean> = {
	email: (text) => /^[^@\s]+@[^@\s]+$/.test(text),
	uri: (text) => URL.canParse(text),
	date: (text) => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)),
	"date-time": (text) => /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text)),
};

/** Longest server text shown, in characters. */
const TEXT_LIMITS = { message: 500, label: 100, description: 300, option: 100 } as const;

// C0 and C1 controls (newlines and tabs included), and the invisible marks that reorder or hide text.
// The zero-width joiner is handled apart: it stays inside emoji sequences.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;
const STRAY_JOINER =
	/(?<!\p{Extended_Pictographic}[\u{1f3fb}-\u{1f3ff}\ufe0f]?)\u200d|\u200d(?!\p{Extended_Pictographic})/gu;
// DCS, SOS, OSC, PM, and APC strings with their payload, up to the terminator or the end of the text.
const CONTROL_STRING = /(?:\u001b[PX\]^_]|[\u0090\u0098\u009d-\u009f])[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const SECRET = /password|passphrase|passcode|secret|token|api[-_ ]?key|credential|private[-_ ]?key/i;

/** Server text as one line without escape sequences or control characters, at most `max` characters. */
export function cleanServerText(text: string, max: number): string {
	const line = stripAnsi(text.replace(CONTROL_STRING, ""))
		.replace(CONTROL, " ")
		.replace(STRAY_JOINER, " ")
		.replace(/\s+/g, " ")
		.trim();
	return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** `labels` with repeats (and any of `reserved`) numbered, so a chosen label names one choice. */
function uniqueLabels(labels: string[], reserved: string[]): string[] {
	const seen = new Set(reserved);
	return labels.map((label) => {
		let candidate = label;
		for (let n = 2; seen.has(candidate); n++) candidate = `${label} (${n})`;
		seen.add(candidate);
		return candidate;
	});
}

function singleChoices(schema: ElicitEnumSchema | ElicitTitledEnumSchema): Choice<string>[] {
	if ("oneOf" in schema) return schema.oneOf.map((option) => ({ value: option.const, label: option.title }));
	return schema.enum.map((value, index) => ({ value, label: schema.enumNames?.[index] ?? value }));
}

function multiChoices(schema: ElicitMultiSelectSchema): Choice<string>[] {
	return "anyOf" in schema.items
		? schema.items.anyOf.map((option) => ({ value: option.const, label: option.title }))
		: schema.items.enum.map((value) => ({ value, label: value }));
}

function parseText(schema: ElicitStringSchema): Parse {
	return (text) => {
		if (schema.minLength !== undefined && text.length < schema.minLength) {
			return { error: `Enter at least ${schema.minLength} characters.` };
		}
		if (schema.maxLength !== undefined && text.length > schema.maxLength) {
			return { error: `Enter at most ${schema.maxLength} characters.` };
		}
		const format = schema.format;
		if (format && Object.hasOwn(FORMAT_CHECKS, format) && !FORMAT_CHECKS[format](text)) {
			return { error: `Enter a valid ${format}.` };
		}
		return { value: text };
	};
}

function parseNumber(schema: ElicitNumberSchema): Parse {
	return (text) => {
		const value = Number(text.trim());
		if (!Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
			return { error: `Enter ${schema.type === "integer" ? "a whole number" : "a number"}.` };
		}
		if (schema.minimum !== undefined && value < schema.minimum) return { error: `Enter ${schema.minimum} or more.` };
		if (schema.maximum !== undefined && value > schema.maximum) return { error: `Enter ${schema.maximum} or less.` };
		return { value };
	};
}

function parseChoices(schema: ElicitMultiSelectSchema, choices: Choice<string>[]): Parse {
	return (text) => {
		const values: string[] = [];
		for (const word of text
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)) {
			const choice = choices.find((candidate) => candidate.value === word || candidate.label === word);
			if (!choice) {
				return { error: `"${cleanServerText(word, TEXT_LIMITS.option)}" is not one of the choices.` };
			}
			if (!values.includes(choice.value)) values.push(choice.value);
		}
		if (schema.minItems !== undefined && values.length < schema.minItems) {
			return { error: `Choose at least ${schema.minItems}.` };
		}
		if (schema.maxItems !== undefined && values.length > schema.maxItems) {
			return { error: `Choose at most ${schema.maxItems}.` };
		}
		return { value: values };
	};
}

async function select<T extends ElicitValue>(
	ui: ElicitationUi,
	title: string,
	choices: Choice<T>[],
	fallback: T | undefined,
	required: boolean,
	signal: AbortSignal,
): Promise<Answer> {
	const ordered = [
		...choices.filter((choice) => choice.value === fallback),
		...choices.filter((choice) => choice.value !== fallback),
	];
	const labels = uniqueLabels(
		ordered.map((choice) => {
			const label = cleanServerText(choice.label, TEXT_LIMITS.option);
			return choice.value === fallback ? `${label}${DEFAULT_MARK}` : label;
		}),
		required ? [] : [SKIP],
	);
	const answer = await ui.select(title, required ? labels : [...labels, SKIP], { signal });
	if (answer === undefined) return "cancel";
	if (!required && answer === SKIP) return { value: undefined };
	const choice = ordered[labels.indexOf(answer)];
	return choice ? { value: choice.value } : "cancel";
}

async function input(
	ui: ElicitationUi,
	title: string,
	fallback: ElicitValue | undefined,
	required: boolean,
	parse: Parse,
	signal: AbortSignal,
): Promise<Answer> {
	for (;;) {
		const text = await ui.input(title, undefined, { signal });
		if (text === undefined) return "cancel";
		if (text.trim() === "" && (fallback !== undefined || !required)) return { value: fallback };
		const parsed = text.trim() === "" ? { error: "This field is required." } : parse(text);
		if ("value" in parsed) return parsed;
		ui.notify(parsed.error, "warning");
	}
}

/** Lines that say what a text field takes: its choices and what an empty answer means. */
function inputHints(schema: ElicitSchema, required: boolean): string[] {
	const hints: string[] = [];
	if (schema.type === "array") {
		const choices = multiChoices(schema).map((choice) => cleanServerText(choice.label, TEXT_LIMITS.option));
		hints.push(`Choices (separate with commas): ${cleanServerText(choices.join(", "), TEXT_LIMITS.message)}`);
	} else if ("format" in schema && schema.format && Object.hasOwn(FORMAT_CHECKS, schema.format)) {
		hints.push(`Format: ${schema.format}`);
	}
	const fallback = schema.type === "array" ? schema.default?.join(", ") : schema.default?.toString();
	if (fallback !== undefined) {
		hints.push(`Default: ${cleanServerText(fallback, TEXT_LIMITS.option)} (leave empty to use it)`);
	} else if (!required) hints.push("Leave empty to skip.");
	return hints;
}

function askField(
	ui: ElicitationUi,
	title: string,
	schema: ElicitSchema,
	required: boolean,
	signal: AbortSignal,
): Promise<Answer> {
	switch (schema.type) {
		case "boolean": {
			const yesNo = [
				{ value: true, label: "Yes" },
				{ value: false, label: "No" },
			];
			return select(ui, title, yesNo, schema.default, required, signal);
		}
		case "number":
		case "integer":
			return input(ui, title, schema.default, required, parseNumber(schema), signal);
		case "array":
			return input(ui, title, schema.default, required, parseChoices(schema, multiChoices(schema)), signal);
		case "string":
			if ("enum" in schema || "oneOf" in schema) {
				return select(ui, title, singleChoices(schema), schema.default, required, signal);
			}
			return input(ui, title, schema.default, required, parseText(schema), signal);
	}
}

const isChoice = (schema: ElicitSchema) =>
	schema.type === "boolean" || (schema.type === "string" && ("enum" in schema || "oneOf" in schema));

/** Asks the user for every field of the form, then whether to send the answers. */
export async function askElicitation(
	ui: ElicitationUi,
	server: string,
	params: ElicitRequestParams,
	signal: AbortSignal,
): Promise<ElicitResult> {
	const header = [
		`MCP server "${cleanServerText(server, TEXT_LIMITS.label)}" asks:`,
		`  ${cleanServerText(params.message, TEXT_LIMITS.message)}`,
	];
	const required = new Set(params.requestedSchema.required ?? []);
	const content: Record<string, ElicitValue> = {};
	const summary: string[] = [];
	for (const [name, schema] of Object.entries(params.requestedSchema.properties)) {
		const label = cleanServerText(schema.title ?? name, TEXT_LIMITS.label);
		const isRequired = required.has(name);
		const description = schema.description ? cleanServerText(schema.description, TEXT_LIMITS.description) : "";
		const lines = [...header, `  ${label}${isRequired ? "" : " (optional)"}${description ? `: ${description}` : ""}`];
		if (!isChoice(schema)) lines.push(...inputHints(schema, isRequired).map((hint) => `  ${hint}`));
		if (SECRET.test(`${name} ${schema.title ?? ""}`)) {
			lines.push("  Warning: this looks like a secret. The server receives what you enter.");
		}
		const answer = await askField(ui, lines.join("\n"), schema, isRequired, signal);
		if (answer === "cancel") return { action: "cancel" };
		if (answer.value === undefined) continue;
		content[name] = answer.value;
		const shown = Array.isArray(answer.value) ? answer.value.join(", ") : String(answer.value);
		summary.push(`  ${label}: ${cleanServerText(shown, TEXT_LIMITS.option)}`);
	}
	const decision = await ui.select([...header, ...summary].join("\n"), [ELICITATION_ACCEPT, ELICITATION_DECLINE], {
		signal,
	});
	if (decision === ELICITATION_ACCEPT) return { action: "accept", content };
	return { action: decision === ELICITATION_DECLINE ? "decline" : "cancel" };
}

/**
 * Elicitation for the servers of a session. Requests are answered one at a time, so dialogs of
 * different servers do not interleave. `getContext` returns the session's context, or undefined
 * once the session ended.
 */
export function createMcpElicitationHandler(
	getContext: () => ExtensionContext | undefined,
): (server: string, params: ElicitRequestParams, signal: AbortSignal) => Promise<ElicitResult> {
	let previous: Promise<unknown> = Promise.resolve();
	return (server, params, signal) => {
		// The agent turn the request arrived in; aborting it closes the request's dialogs.
		const turn = getContext()?.signal;
		const cancelled = turn ? AbortSignal.any([signal, turn]) : signal;
		const answered = previous.then((): ElicitResult | Promise<ElicitResult> => {
			if (cancelled.aborted) return { action: "cancel" };
			const ctx = getContext();
			if (!ctx?.hasUI) return { action: "decline" };
			return askElicitation(ctx.ui, server, params, cancelled);
		});
		previous = answered.catch(() => undefined);
		return answered;
	};
}
