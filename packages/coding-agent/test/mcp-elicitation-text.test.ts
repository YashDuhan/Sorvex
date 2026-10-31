import { beforeAll, describe, expect, it } from "vitest";
import { cleanServerText } from "../src/extensions/mcp/elicitation.ts";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("cleanServerText", () => {
	it("drops DCS, SOS, OSC, PM, and APC strings with their payload", () => {
		const strings = [
			"\u001bPq#0;2;0;0;0\u001b\\",
			"\u001bXsos payload\u001b\\",
			"\u001b]0;fake title\u0007",
			"\u001b^pm payload\u001b\\",
			"\u001b_apc payload\u009c",
			"\u0090c1 dcs\u009c",
			"\u009dc1 osc\u0007",
		];
		expect(cleanServerText(`a${strings.join("")}b`, 100)).toBe("ab");
	});

	it("drops an unterminated control string to the end of the text", () => {
		expect(cleanServerText("visible\u001bPhidden payload", 100)).toBe("visible");
	});

	it("keeps zero-width joiners inside emoji sequences and drops the others", () => {
		const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
		const coder = "\u{1f468}\u{1f3fd}\u200d\u{1f4bb}";
		expect(cleanServerText(`${family} ${coder}`, 100)).toBe(`${family} ${coder}`);
		expect(cleanServerText("pass\u200dword", 100)).toBe("pass word");
	});
});

describe("extension dialog titles", () => {
	beforeAll(() => initTheme("dark"));

	// A server message that wraps must not start a line at the title's margin, where it could pose
	// as the header of another server.
	const title = [
		'MCP server "fixture" asks:',
		`  ${"x".repeat(114)} MCP server "other" asks: enter your admin password`,
		"  Name",
	].join("\n");

	const renderTitle = (lines: string[]) =>
		lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.includes("MCP") || line.includes("x"));

	it("keeps the indent of wrapped title lines in text dialogs", () => {
		const dialog = new ExtensionInputComponent(
			title,
			undefined,
			() => {},
			() => {},
		);
		const lines = renderTitle(dialog.render(120));

		expect(lines[0]).toBe(' MCP server "fixture" asks:');
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines.slice(1)) expect(line).toMatch(/^ {3}\S/);
	});

	it("keeps the indent of wrapped title lines in choice dialogs", () => {
		const dialog = new ExtensionSelectorComponent(
			title,
			["Accept", "Decline"],
			() => {},
			() => {},
		);
		const lines = renderTitle(dialog.render(120));

		expect(lines[0]).toBe(' MCP server "fixture" asks:');
		expect(lines.length).toBeGreaterThan(2);
		for (const line of lines.slice(1)) expect(line).toMatch(/^ {3}\S/);
	});
});
