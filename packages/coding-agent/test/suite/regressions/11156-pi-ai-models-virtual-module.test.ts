import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@sorvex/ai";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensions } from "../../../src/core/extensions/loader.ts";
import { VIRTUAL_MODULES } from "../../../src/core/extensions/virtual-modules.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "../harness.ts";

// Regression test for #11156: extensions importing @sorvex/ai/models
// (e.g. for clampThinkingLevel) failed with "Cannot find module" in embedded
// runtimes because the subpath was missing from the virtual module map.
describe("pi-ai/models virtual module", () => {
	it("exposes the pi-ai /models entrypoint to extensions", () => {
		const models = VIRTUAL_MODULES["@sorvex/ai/models"] as { clampThinkingLevel?: unknown } | undefined;
		expect(models).toBeDefined();
		expect(typeof models?.clampThinkingLevel).toBe("function");
	});

	it("exposes the same module under the pi scopes", () => {
		// rebrand-scope:keep-begin the pi scopes are the subject of this test (decision D4).
		expect(VIRTUAL_MODULES["@earendil-works/pi-ai/models"]).toBe(VIRTUAL_MODULES["@sorvex/ai/models"]);
		expect(VIRTUAL_MODULES["@mariozechner/pi-ai/models"]).toBe(VIRTUAL_MODULES["@sorvex/ai/models"]);
		// rebrand-scope:keep-end
	});
});

// rebrand-scope:keep-begin the pi scopes are the subject of this test (decision D4).
const ALIAS_FAMILIES = [
	{
		id: "sorvex",
		ai: "@sorvex/ai",
		codingAgent: "@sorvex/coding-agent",
		tui: "@sorvex/tui",
	},
	{
		id: "earendil",
		ai: "@earendil-works/pi-ai",
		codingAgent: "@earendil-works/pi-coding-agent",
		tui: "@earendil-works/pi-tui",
	},
	{
		id: "mariozechner",
		ai: "@mariozechner/pi-ai",
		codingAgent: "@mariozechner/pi-coding-agent",
		tui: "@mariozechner/pi-tui",
	},
];
// rebrand-scope:keep-end

function extensionSource(family: (typeof ALIAS_FAMILIES)[number]): string {
	return `import { Type } from "${family.ai}";
import { defineTool } from "${family.codingAgent}";
import { visibleWidth } from "${family.tui}";

export default function (pi) {
	pi.registerTool(
		defineTool({
			name: "alias_${family.id}",
			label: "Alias ${family.id}",
			description: "Reports the alias family it was loaded through",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "loaded via ${family.id} " + visibleWidth("abc") }], details: {} }),
		}),
	);
}
`;
}

describe("extension package alias families", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it.each(ALIAS_FAMILIES)("loads and runs an extension importing the $id package names", async (family) => {
		const dir = mkdtempSync(join(tmpdir(), "pi-alias-family-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const extensionPath = join(dir, `alias-${family.id}.ts`);
		writeFileSync(extensionPath, extensionSource(family));

		const extensionsResult = await loadExtensions([extensionPath], dir);
		expect(extensionsResult.errors).toEqual([]);
		expect(extensionsResult.extensions).toHaveLength(1);

		const harness: Harness = await createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult }) });
		cleanups.push(harness.cleanup);
		await harness.session.bindExtensions({ shutdownHandler: () => {} });
		harness.session.setActiveToolsByName([`alias_${family.id}`]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall(`alias_${family.id}`, {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the alias tool");

		const toolResult = getToolResult(harness, `alias_${family.id}`);
		expect(toolResult.isError).toBe(false);
		expect(getMessageText(toolResult)).toBe(`loaded via ${family.id} 3`);
	});
});
