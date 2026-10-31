import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import type { LayoutNode } from "../src/layout-node.ts";
import type { Component } from "../src/tui.ts";
import { isViewportTUI, type TUI } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const BUNDLED_PI_TUI_SCOPES = ["@earendil-works/pi-tui", "@mariozechner/pi-tui"]; // rebrand-scope:keep

// A VStack as a copy of pi-tui bundled by an extension builds it: the layout lives under that copy's key.
function bundledVStack(scope: string, children: Component[]): Component {
	const node: LayoutNode = {
		type: "vstack",
		entries: children.map((component) => ({ component, basis: 1, shrink: 0 })),
		gap: 0,
		align: "stretch",
	};
	return {
		render: () => [],
		invalidate: () => {},
		[Symbol.for(`${scope}/layout-node`)]: () => node,
	} as Component;
}

describe("components and TUIs from bundled pi-tui copies", () => {
	for (const scope of BUNDLED_PI_TUI_SCOPES) {
		it(`lays out a stack built by ${scope}`, () => {
			const frame = renderLayoutFrame(
				bundledVStack(scope, [new Text("top", 0, 0), new Text("bottom", 0, 0)]),
				10,
				3,
				() => {},
			);
			assert.deepStrictEqual(
				frame.lines.map((line) => stripTerminalSequences(line).trimEnd()),
				["top", "bottom", ""],
			);
		});

		it(`marks the fullscreen TUI as a viewport for ${scope}`, () => {
			const tui = new TuiAltScreen(new VirtualTerminal(20, 4));
			assert.strictEqual((tui as unknown as Record<symbol, unknown>)[Symbol.for(`${scope}/viewport`)], true);
			const bundled = { [Symbol.for(`${scope}/viewport`)]: true } as unknown as TUI;
			assert.strictEqual(isViewportTUI(bundled), true);
		});
	}
});
