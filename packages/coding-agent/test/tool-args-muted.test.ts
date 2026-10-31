import type { Component } from "@sorvex/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { renderToolPath } from "../src/core/tools/render-utils.ts";
import { findRenderers } from "../src/core/tools/renderers/find.ts";
import { grepRenderers } from "../src/core/tools/renderers/grep.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import { EMPTY_USAGE } from "../src/extensions/subagent/run.ts";
import { sorvexLogoLines, sorvexWordmark } from "../src/modes/interactive/components/sorvex-logo.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

type Renderers = Pick<ToolDefinition<any, any>, "renderCall">;

function renderCall(renderers: Renderers, args: unknown, expanded: boolean): string {
	const context = { lastComponent: undefined, expanded, cwd: "/work", args };
	const component = renderers.renderCall?.(args as never, theme, context as never);
	return component ? component.render(120).join("\n") : "";
}

const render = (component: Component) => component.render(120).join("\n");

describe("tool arguments in the minimal theme", () => {
	let accent: string;
	let muted: string;
	let text: string;

	beforeAll(() => {
		initTheme("dark");
		accent = theme.getFgAnsi("accent");
		muted = theme.getFgAnsi("muted");
		text = theme.getFgAnsi("text");
	});

	it("mutes the path and patterns of the read, find, and grep calls", () => {
		const calls = [
			renderCall(readRenderers, { path: "src/auth.ts" }, true),
			renderCall(readRenderers, { path: "src/auth.ts" }, false),
			renderCall(findRenderers, { pattern: "*.ts", path: "src" }, false),
			renderCall(grepRenderers, { pattern: "verifyToken", path: "src" }, false),
			renderToolPath("src/auth.ts", theme, "/work"),
		];
		for (const call of calls) {
			expect(call).not.toContain(accent);
			expect(call).toContain(muted);
		}
	});

	it("shows subagent names as bold text and the arguments muted", () => {
		const parallel = render(
			renderSubagentCall(
				{
					tasks: [
						{ agent: "scout", task: "Find auth" },
						{ agent: "scout", task: "Find db" },
					],
				},
				theme,
			),
		);
		const single = render(renderSubagentCall({ agent: "scout", task: "Find auth" }, theme));
		const action = render(renderSubagentCall({ action: "status", id: "sub_000001" }, theme));
		for (const call of [parallel, single, action]) expect(call).not.toContain(accent);
		expect(parallel).toContain(`${muted}parallel (2 tasks)`);
		expect(parallel).toContain(`${text}${theme.bold("scout")}`);
		expect(single).toContain(`${muted}Find auth`);
	});

	it("shows the child tool calls with a bold name and a muted summary", () => {
		const result = render(
			renderSubagentResult(
				{
					kind: "single",
					readOnly: false,
					runs: [
						{
							id: "sub_000001",
							startedAt: 0,
							context: "fresh",
							agent: "scout",
							source: "builtin",
							task: "Find auth",
							status: "done",
							output: "done",
							usage: EMPTY_USAGE,
							turns: 1,
							model: "faux/child",
							toolCalls: [{ name: "read", summary: "src/auth.ts" }],
						},
					],
				},
				"",
				false,
				theme,
			),
		);
		expect(result).not.toContain(accent);
		expect(result).toContain(`${text}${theme.bold("read")}`);
		expect(result).toContain(`${muted}src/auth.ts`);
	});
});

describe("header logo in the minimal theme", () => {
	beforeAll(() => initTheme("dark"));

	it("draws the mark in the accent and the highlight pixel in the text color", () => {
		const [top, bottom] = sorvexLogoLines();
		const accent = theme.getFgAnsi("accent");
		expect(top).toContain(accent);
		expect(bottom).toContain(accent);
		expect(bottom).toContain(theme.getFgAnsi("text"));
		expect(top + bottom).not.toContain("38;2;86;182;194");
		expect(top + bottom).not.toContain("38;2;234;182;93");
	});

	it("draws the wordmark in the text color", () => {
		expect(sorvexWordmark()).toBe(theme.fg("text", "Sorvex"));
	});
});
