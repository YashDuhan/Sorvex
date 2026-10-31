import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatToolArgumentsError, parseStreamingJson, parseToolCallArguments } from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});
});

// #10897
describe("parseToolCallArguments", () => {
	it("parses complete JSON and repairs invalid escapes", () => {
		expect(parseToolCallArguments(String.raw`{"kind":"seek","note":"\url"}`)).toEqual({
			arguments: { kind: "seek", note: "\\url" },
		});
	});

	it("uses empty arguments for empty text", () => {
		expect(parseToolCallArguments("")).toEqual({ arguments: {} });
	});

	it("does not keep the valid prefix of malformed JSON", () => {
		const raw = '{"action":"apply","actions":[{"kind":"seek","time":.5}]}';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("does not complete cut-off JSON", () => {
		const raw = '{"kind":"seek","clipId":"clip-fl';
		const result = parseToolCallArguments(raw);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError?.endsWith(raw)).toBe(true);
	});

	it("rejects JSON that is not an object", () => {
		expect(parseToolCallArguments("[1,2]")).toEqual({
			arguments: {},
			argumentsError: "Tool arguments must be a JSON object\n\nReceived arguments:\n[1,2]",
		});
	});
});

describe("parseToolCallArguments with model control text", () => {
	const captured: { arguments: string } = JSON.parse(
		readFileSync(new URL("./fixtures/novita-deepseek-v4.1-flash-subagent-arguments.json", import.meta.url), "utf8"),
	);
	const raw = captured.arguments;
	const expected = JSON.parse(raw);

	it("parses the captured parallel subagent arguments", () => {
		expect(parseToolCallArguments(raw)).toEqual({ arguments: expected });
		expect(expected.tasks).toHaveLength(5);
	});

	it.each([
		["a tool-call end token", "<｜tool▁call▁end｜>"],
		["call and calls end tokens", "<｜tool▁call▁end｜><｜tool▁calls▁end｜>"],
		["the end-of-sentence token after whitespace", "\n<｜end▁of▁sentence｜>"],
		["DSML closing tags", "\n</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"],
		["a closing code fence", "\n```"],
		["a tool-outputs end token", "<｜tool▁outputs▁end｜>"],
	])("drops %s after the complete object", (_name, trailing) => {
		expect(parseToolCallArguments(raw + trailing)).toEqual({ arguments: expected });
	});

	it("drops control text after an object that also needs string repair", () => {
		expect(parseToolCallArguments('{"task":"line 1\nline 2 C:\\Users\\dev"}<｜tool▁call▁end｜>')).toEqual({
			arguments: { task: "line 1\nline 2 C:\\Users\\dev" },
		});
	});

	it.each([
		["ASCII markup", `${raw}<tool_call>`],
		["a second call", `${raw}{"tasks":[]}`],
		["a second call after a control token", `${raw}<｜tool▁call▁end｜><｜tool▁call▁begin｜>{"tasks":[]}`],
		["a second DSML call", '{"command":"ls"}<｜DSML｜ invoke name="bash"></｜DSML｜ invoke>'],
		["a DSML opening parameter tag", '{"command":"ls"}<｜DSML｜ parameter name="x" string="true">'],
		["a DSML opening tag after a closing tag", '{"command":"ls"}</｜DSML｜ invoke><｜DSML｜ invoke name="bash">'],
		["a tool-call begin token", '{"command":"ls"}<｜tool▁call▁begin｜>'],
		["text before the object", `<｜tool▁call▁begin｜>${raw}`],
		["an unescaped quote that ends the string early", '{"task":"use "<void>" here"}<｜tool▁call▁end｜>'],
		["an object that never closes", `${raw.slice(0, -2)}<｜tool▁call▁end｜>`],
	])("rejects %s", (_name, text) => {
		const result = parseToolCallArguments(text);
		expect(result.arguments).toEqual({});
		expect(result.argumentsError).toMatch(/\n\nReceived arguments:\n/);
	});

	it("echoes only the first and last 2 KB of long malformed arguments", () => {
		const text = `${raw}${raw}`;
		const error = parseToolCallArguments(text).argumentsError ?? "";
		const received = error.split("\n\nReceived arguments:\n")[1];
		expect(received.startsWith(text.slice(0, 2048))).toBe(true);
		expect(received.endsWith(text.slice(-2048))).toBe(true);
		expect(received).toContain(`\n... [${text.length - 4096} characters omitted] ...\n`);
		expect(error.length).toBeLessThan(4400);
	});
});

describe("formatToolArgumentsError", () => {
	const received = (error: string): string => error.split("\n\nReceived arguments:\n")[1];

	// 2048 units on each side of a cut: an emoji (2 units) straddles the boundary when 2047 units precede it.
	it("does not split a surrogate pair at the end of the head", () => {
		const text = `${"a".repeat(2047)}😀${"b".repeat(3000)}${"c".repeat(2048)}`;
		const error = formatToolArgumentsError("bad", text);
		expect(error.isWellFormed()).toBe(true);
		const head = received(error).split("\n... [")[0];
		expect(head).toBe("a".repeat(2047));
		expect(error).toContain(`[${text.length - 2047 - 2048} characters omitted]`);
	});

	it("does not split a surrogate pair at the start of the tail", () => {
		const text = `${"a".repeat(2048)}${"b".repeat(3000)}😀${"c".repeat(2047)}`;
		const error = formatToolArgumentsError("bad", text);
		expect(error.isWellFormed()).toBe(true);
		const tail = received(error).split("characters omitted] ...\n")[1];
		expect(tail).toBe("c".repeat(2047));
	});

	it("keeps pairs that sit wholly inside the shown edges", () => {
		const text = `😀${"a".repeat(5000)}😀`;
		const error = formatToolArgumentsError("bad", text);
		expect(error.isWellFormed()).toBe(true);
		expect(received(error).startsWith("😀")).toBe(true);
		expect(received(error).endsWith("😀")).toBe(true);
	});
});
