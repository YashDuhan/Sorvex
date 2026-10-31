import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import planExtension from "../../src/extensions/plan/index.ts";
import { createHarness, createTestUiContext, type Harness, type HarnessOptions } from "./harness.ts";

const BUILT_IN_TOOLS = ["bash", "edit", "read", "write"];

function registerLate(pi: ExtensionAPI, name: string, options: { readOnly?: boolean } = {}): void {
	pi.registerTool({
		name,
		label: name,
		description: `Late tool ${name}`,
		parameters: Type.Object({}),
		...(options.readOnly ? { annotations: { readOnlyHint: true } } : {}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
	});
}

/** `/narrow` keeps only read; `/late <name>` registers a tool after startup, like an MCP server that connects. */
const lateTools: ExtensionFactory = (pi) => {
	pi.registerCommand("narrow", { handler: async () => pi.setActiveTools(["read"]) });
	pi.registerCommand("late", { handler: async (args) => registerLate(pi, args.trim()) });
	pi.registerCommand("late-read-only", { handler: async (args) => registerLate(pi, args.trim(), { readOnly: true }) });
};

describe("refreshing the tool registry after a late registration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Omit<HarnessOptions, "extensionFactories"> & { plan?: boolean } = {}) {
		const harness = await createHarness({
			...options,
			extensionFactories: options.plan ? [planExtension, lateTools] : [lateTools],
		});
		harnesses.push(harness);
		if (options.plan) harness.session.extensionRunner.setFlagValue("plan", true);
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
		return harness;
	}

	const activeTools = (harness: Harness) => harness.session.getActiveToolNames().sort();

	it("keeps tools an extension deactivated inactive under a tools allowlist", async () => {
		const harness = await setup({ allowedToolNames: [...BUILT_IN_TOOLS, "deploy"] });
		await harness.session.prompt("/narrow");
		expect(activeTools(harness)).toEqual(["read"]);

		await harness.session.prompt("/late deploy");

		expect(activeTools(harness)).toEqual(["deploy", "read"]);
	});

	it("does not register or activate a late tool the allowlist does not name", async () => {
		const harness = await setup({ allowedToolNames: BUILT_IN_TOOLS });
		await harness.session.prompt("/narrow");
		await harness.session.prompt("/late deploy");

		expect(activeTools(harness)).toEqual(["read"]);
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("deploy");
	});

	it("activates a late allowlisted tool next to the full set when no extension narrowed it", async () => {
		const harness = await setup({ allowedToolNames: [...BUILT_IN_TOOLS, "deploy"] });
		expect(activeTools(harness)).toEqual(BUILT_IN_TOOLS);

		await harness.session.prompt("/late deploy");

		expect(activeTools(harness)).toEqual(["bash", "deploy", "edit", "read", "write"]);
	});

	it("keeps tools an extension deactivated inactive without an allowlist", async () => {
		const harness = await setup();
		await harness.session.prompt("/narrow");
		await harness.session.prompt("/late deploy");

		expect(activeTools(harness)).toEqual(["deploy", "read"]);
	});

	it("keeps edit and write out of plan mode under --tools when a tool registers late", async () => {
		const harness = await setup({ allowedToolNames: [...BUILT_IN_TOOLS, "lookup"], plan: true });
		const planning = activeTools(harness);
		expect(planning).not.toContain("edit");
		expect(planning).not.toContain("write");

		await harness.session.prompt("/late-read-only lookup");
		expect(activeTools(harness)).toEqual([...planning, "lookup"].sort());

		let declared: string[] = [];
		harness.setResponses([
			(context: TranscriptContext) => {
				declared = getCurrentTools(context.messages)
					.map((tool) => tool.name)
					.sort();
				return fauxAssistantMessage("planning");
			},
		]);
		await harness.session.prompt("look around");
		expect(declared).toEqual([...planning, "lookup"].sort());
	});
});
