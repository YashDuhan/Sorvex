import { setKeybindings } from "@sorvex/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OPTIONS = ["Approve", "Keep planning", "Exit"];
const PLAN = Array.from({ length: 120 }, (_, index) => `Plan line ${index + 1}`).join("\n");
const SHIFT_DOWN = "\x1b[1;2B";
const SHIFT_UP = "\x1b[1;2A";
const PAGE_DOWN = "\x1b[6~";

function planDialog(maxHeight: number | undefined, onSelect: (option: string) => void = () => {}) {
	return new ExtensionSelectorComponent("Plan ready", OPTIONS, onSelect, () => {}, {
		description: PLAN,
		...(maxHeight === undefined ? {} : { maxHeight: () => maxHeight }),
	});
}

function visibleText(selector: ExtensionSelectorComponent): { lines: string[]; text: string } {
	const lines = selector.render(110).map((line) => stripAnsi(line));
	return { lines, text: lines.join("\n") };
}

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders a short description in full", () => {
		const selector = new ExtensionSelectorComponent(
			"Plan ready",
			OPTIONS,
			() => {},
			() => {},
			{
				description: "Short plan",
				maxHeight: () => 40,
			},
		);
		const unbounded = new ExtensionSelectorComponent(
			"Plan ready",
			OPTIONS,
			() => {},
			() => {},
			{
				description: "Short plan",
			},
		);
		const { text } = visibleText(selector);
		expect(text).toBe(visibleText(unbounded).text);
		expect(text).toContain("Short plan");
		expect(text).not.toContain("lines ");
	});

	it.each([20, 44, 90])("keeps the options visible for a long description at %i rows", (rows) => {
		const { lines, text } = visibleText(planDialog(rows));
		expect(lines.length).toBeLessThanOrEqual(rows);
		expect(text).toContain("Plan ready");
		for (const option of OPTIONS) expect(text).toContain(option);
		expect(text).toMatch(/^\s*Plan line 1\s*$/m);
		expect(text).not.toContain("Plan line 120");
		expect(text).toMatch(/lines 1-\d+ of 122/);
		expect(text).toContain("shift+down more");
	});

	it("renders everything without a height limit", () => {
		const { text } = visibleText(planDialog(undefined));
		expect(text).toContain("Plan line 120");
		expect(text).not.toContain("lines ");
	});

	it("scrolls the description and clamps at both ends", () => {
		const selector = planDialog(44);
		const first = visibleText(selector).lines;

		selector.handleInput(SHIFT_DOWN);
		const second = visibleText(selector);
		expect(second.lines).not.toEqual(first);
		expect(second.text).not.toContain("Plan ready");
		expect(second.text).toMatch(/lines \d+-\d+ of 122/);
		for (const option of OPTIONS) expect(second.text).toContain(option);

		for (let page = 0; page < 10; page++) selector.handleInput(PAGE_DOWN);
		const last = visibleText(selector);
		expect(last.text).toContain("Plan line 120");
		expect(last.text).toMatch(/lines \d+-122 of 122/);
		expect(last.text).toContain("shift+down down");
		expect(last.lines.length).toBeLessThanOrEqual(44);

		for (let page = 0; page < 10; page++) selector.handleInput(SHIFT_UP);
		expect(visibleText(selector).lines).toEqual(first);
	});

	it("selects the highlighted option after scrolling", () => {
		const onSelect = vi.fn();
		const selector = planDialog(44, onSelect);
		visibleText(selector);
		selector.handleInput(SHIFT_DOWN);
		selector.handleInput("\x1b[B");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("Keep planning");
	});

	it("scrolls a long multi-line title, as confirm dialogs pass their message there", () => {
		const selector = new ExtensionSelectorComponent(
			`Approve tool call?\n${PLAN}`,
			["Yes", "No"],
			() => {},
			() => {},
			{
				maxHeight: () => 30,
			},
		);
		const { lines, text } = visibleText(selector);
		expect(lines.length).toBeLessThanOrEqual(30);
		expect(text).toContain("Approve tool call?");
		expect(text).toContain("→ Yes");
		expect(text).toContain("  No");
		expect(text).toMatch(/lines 1-\d+ of 121/);
	});
});
