import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveThemeSetting } from "../src/modes/interactive/theme/theme.ts";

interface DarkThemeFile {
	vars: Record<string, string>;
	colors: Record<string, string>;
}

const darkTheme = JSON.parse(
	readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
) as DarkThemeFile;

function resolve(token: string): string {
	const value = darkTheme.colors[token];
	if (value === undefined) throw new Error(`dark.json is missing ${token}`);
	return darkTheme.vars[value] ?? value;
}

function channels(hex: string): [number, number, number] {
	const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) throw new Error(`Expected a #RRGGBB color, got ${hex}`);
	return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
}

function luminance(hex: string): number {
	const [r, g, b] = channels(hex).map((channel) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
	const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (light + 0.05) / (dark + 0.05);
}

function isGray(hex: string): boolean {
	const [r, g, b] = channels(hex);
	return r === g && g === b;
}

const PAGE_BG = "#0a0a0a";

describe("minimal dark theme", () => {
	it("keeps body and secondary text readable on the page background", () => {
		for (const token of ["text", "userMessageText", "toolTitle", "toolOutput", "muted", "customMessageText", "dim"]) {
			expect(contrast(resolve(token), PAGE_BG), token).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("keeps muted text readable on message, tool, and selected backgrounds", () => {
		for (const bg of [
			"userMessageBg",
			"customMessageBg",
			"toolPendingBg",
			"toolSuccessBg",
			"toolErrorBg",
			"selectedBg",
		]) {
			expect(contrast(resolve("muted"), resolve(bg)), bg).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("keeps dim text readable on the tool panel and the user message element", () => {
		for (const bg of ["toolPendingBg", "toolSuccessBg", "userMessageBg", "customMessageBg"]) {
			expect(contrast(resolve("dim"), resolve(bg)), bg).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("colors only state, accent, and code-token roles", () => {
		const colored = Object.keys(darkTheme.colors)
			.filter((token) => !isGray(resolve(token)))
			.sort();
		expect(colored).toEqual(
			[
				"accent",
				"error",
				"mdCode",
				"mdLink",
				"searchMatchBg",
				"searchMatchText",
				"success",
				"syntaxKeyword",
				"syntaxString",
				"thinkingMax",
				"toolDiffAdded",
				"toolDiffRemoved",
				"toolErrorBg",
				"warning",
				"bashMode",
			].sort(),
		);
	});

	it("uses one accent for links, selection, search, and the top thinking level", () => {
		const accent = resolve("accent");
		expect(resolve("mdLink")).toBe(accent);
		expect(resolve("searchMatchText")).toBe(accent);
		expect(resolve("thinkingMax")).toBe(accent);
	});

	it("renders titles, headings, and most syntax roles as plain text", () => {
		const text = resolve("text");
		for (const token of [
			"toolTitle",
			"mdHeading",
			"mdCodeBlock",
			"syntaxFunction",
			"syntaxVariable",
			"syntaxNumber",
			"syntaxType",
			"syntaxOperator",
			"syntaxPunctuation",
		]) {
			expect(resolve(token), token).toBe(text);
		}
		expect(resolve("syntaxComment")).toBe(resolve("muted"));
	});

	it("is the default on dark terminals only", () => {
		expect(resolveThemeSetting(undefined, "dark")).toBe("dark");
		expect(resolveThemeSetting(undefined, "light")).toBe("system");
		expect(resolveThemeSetting("light", "dark")).toBe("light");
	});
});
