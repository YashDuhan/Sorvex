import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	type ToolResultMessage,
	type TranscriptContext,
} from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import planExtension from "../../src/extensions/plan/index.ts";
import todoExtension from "../../src/extensions/todo/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const PLANNING_TOOLS = ["bash", "exit_plan_mode", "read", "todo"];
const NORMAL_TOOLS = ["bash", "edit", "read", "todo", "write"];
const PLAN = "1. Rename foo to bar in notes.txt";

const activateWrite: ExtensionFactory = (pi) => {
	pi.registerCommand("activate-write", {
		handler: async () => pi.setActiveTools([...pi.getActiveTools(), "write"]),
	});
};

const registerDeploy: ExtensionFactory = (pi) => {
	pi.registerCommand("register-deploy", {
		handler: async () =>
			pi.registerTool({
				name: "deploy",
				label: "Deploy",
				description: "Deploy the app",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "deployed" }], details: undefined }),
			}),
	});
};

const deactivateEdit: ExtensionFactory = (pi) => {
	pi.registerCommand("deactivate-edit", {
		handler: async () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "edit")),
	});
};

const deployAtLoad: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "deploy",
		label: "Deploy",
		description: "Deploy the app",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "deployed" }], details: undefined }),
	});
};

type ToolArgs = Parameters<typeof fauxToolCall>[1];

function call(name: string, args: ToolArgs) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function planSection(context: TranscriptContext): string | undefined {
	return getCurrentSystemMessage(context.messages)?.sections?.plan_mode ?? undefined;
}

interface Setup {
	harness: Harness;
	status: () => string | undefined;
	file: string;
}

describe("built-in plan mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: {
			ui?: Partial<ExtensionUIContext> | "none";
			sessionManager?: SessionManager;
			planFlag?: boolean;
			extensions?: ExtensionFactory[];
		} = {},
	): Promise<Setup> {
		const harness = await createHarness({
			extensionFactories: [
				todoExtension,
				planExtension,
				activateWrite,
				registerDeploy,
				deactivateEdit,
				...(options.extensions ?? []),
			],
			sessionManager: options.sessionManager,
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "notes.txt");
		if (!existsSync(file)) writeFileSync(file, "foo\n");
		if (options.planFlag) harness.session.extensionRunner.setFlagValue("plan", true);
		const statuses = new Map<string, string | undefined>();
		if (options.ui === "none") {
			await harness.session.bindExtensions({ mode: "print" });
		} else {
			await harness.session.bindExtensions({
				mode: "rpc",
				uiContext: createTestUiContext({
					setStatus: (key, text) => statuses.set(key, text),
					...options.ui,
				}),
			});
		}
		return { harness, file, status: () => statuses.get("plan") };
	}

	const activeTools = (harness: Harness) => harness.session.getActiveToolNames().sort();

	const planEntryCount = (harness: Harness) =>
		harness.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "plan-mode")
			.length;

	it("restricts the tools, shows the footer status, and sets the plan_mode section", async () => {
		const { harness, status } = await setup();
		await harness.session.prompt("/plan");

		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		expect(status()).toBe("plan");

		let section: string | undefined;
		harness.setResponses([
			(context) => {
				section = planSection(context);
				return fauxAssistantMessage("exploring");
			},
		]);
		await harness.session.prompt("look around");
		expect(section).toMatch(/^<plan_mode>\nPlan mode is on\./);
	});

	it("runs a read and blocks an edit and a destructive shell command", async () => {
		const { harness, file } = await setup();
		await harness.session.prompt("/plan");
		harness.setResponses([
			call("read", { path: "notes.txt" }),
			call("edit", { path: "notes.txt", edits: [{ oldText: "foo", newText: "bar" }] }),
			call("bash", { command: "rm notes.txt" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("change notes");

		expect(getToolResult(harness, "read").isError).toBe(false);
		expect(getMessageText(getToolResult(harness, "read"))).toContain("foo");
		expect(getToolResult(harness, "edit").isError).toBe(true);
		const bash = getToolResult(harness, "bash");
		expect(bash.isError).toBe(true);
		expect(getMessageText(bash)).toBe(
			"Plan mode: this command is not read-only, so it did not run: rm notes.txt\nUse read-only commands, or call exit_plan_mode with your plan.",
		);
		expect(readFileSync(file, "utf8")).toBe("foo\n");
	});

	it("blocks a write tool that another extension activates while planning", async () => {
		const { harness } = await setup();
		await harness.session.prompt("/plan");
		await harness.session.prompt("/activate-write");
		harness.setResponses([call("write", { path: "new.txt", content: "x" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("write a file");

		const write = getToolResult(harness, "write");
		expect(write.isError).toBe(true);
		expect(getMessageText(write)).toBe(
			"Plan mode: write is not read-only, so it did not run. Explore with read-only tools, then call exit_plan_mode with your plan.",
		);
		expect(existsSync(join(harness.tempDir, "new.txt"))).toBe(false);
	});

	it("approves the plan, restores the tools, and lets the model record todos and edit", async () => {
		const prompts: string[] = [];
		const { harness, file, status } = await setup({
			ui: {
				select: async (title, options, opts) => {
					prompts.push(`${title}: ${opts?.message}: ${options.join(" | ")}`);
					return "Approve and start";
				},
			},
		});
		await harness.session.prompt("/plan");
		harness.setResponses([
			call("exit_plan_mode", { plan: PLAN }),
			call("todo", { action: "create", subject: "Rename foo to bar" }),
			call("edit", { path: "notes.txt", edits: [{ oldText: "foo", newText: "bar" }] }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("plan the rename");

		expect(prompts).toEqual([`Plan ready: ${PLAN}: Approve and start | Keep planning | Exit plan mode`]);
		expect(getMessageText(getToolResult(harness, "exit_plan_mode"))).toBe(
			"The user approved the plan. Plan mode is off. Record the plan's steps with todo, then start the first step.",
		);
		expect(getToolResult(harness, "todo").isError).toBe(false);
		expect(getToolResult(harness, "edit").isError).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("bar\n");
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
		expect(status()).toBeUndefined();
	});

	it("keeps a tool registered while planning after the plan is approved", async () => {
		const { harness } = await setup({ ui: { select: async () => "Approve and start" } });
		await harness.session.prompt("/plan");
		await harness.session.prompt("/register-deploy");
		harness.setResponses([
			call("deploy", {}),
			call("exit_plan_mode", { plan: PLAN }),
			call("deploy", {}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("plan the deploy");

		const results = harness.session.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "deploy",
		);
		expect(results.map((result) => [result.isError, getMessageText(result)])).toEqual([
			[
				true,
				"Plan mode: deploy is not read-only, so it did not run. Explore with read-only tools, then call exit_plan_mode with your plan.",
			],
			[false, "deployed"],
		]);
		expect(activeTools(harness)).toEqual([...NORMAL_TOOLS, "deploy"].sort());
	});

	it("keeps a tool registered after a planning session resumes, and restores it on approval", async () => {
		const first = await setup();
		await first.harness.session.prompt("/plan");
		await first.harness.session.prompt("/register-deploy");
		first.harness.setResponses([fauxAssistantMessage("planning")]);
		await first.harness.session.prompt("first");

		const resumed = await setup({
			sessionManager: first.harness.sessionManager,
			ui: { select: async () => "Approve and start" },
		});
		expect(activeTools(resumed.harness)).toEqual(PLANNING_TOOLS);
		await resumed.harness.session.prompt("/register-deploy");
		resumed.harness.setResponses([
			call("deploy", {}),
			call("exit_plan_mode", { plan: PLAN }),
			fauxAssistantMessage("done"),
		]);
		await resumed.harness.session.prompt("approve");

		expect(getToolResult(resumed.harness, "deploy").isError).toBe(true);
		expect(activeTools(resumed.harness)).toEqual([...NORMAL_TOOLS, "deploy"].sort());
	});

	it("keeps planning and returns the user's feedback", async () => {
		const { harness, status } = await setup({
			ui: {
				select: async () => "Keep planning",
				input: async () => "  Split step 1 into two steps  ",
			},
		});
		await harness.session.prompt("/plan");
		harness.setResponses([call("exit_plan_mode", { plan: PLAN }), fauxAssistantMessage("revising")]);
		await harness.session.prompt("plan the rename");

		expect(getMessageText(getToolResult(harness, "exit_plan_mode"))).toBe(
			"The user wants changes before approving. Plan mode stays on.\n\nFeedback: Split step 1 into two steps\n\nRevise the plan and call exit_plan_mode again.",
		);
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		expect(status()).toBe("plan");
	});

	it("leaves plan mode without approval and ends the run", async () => {
		const { harness, status } = await setup({ ui: { select: async () => "Exit plan mode" } });
		await harness.session.prompt("/plan");
		harness.setResponses([call("exit_plan_mode", { plan: PLAN }), fauxAssistantMessage("unused")]);
		await harness.session.prompt("plan the rename");

		expect(getMessageText(getToolResult(harness, "exit_plan_mode"))).toBe(
			"The user left plan mode without approving the plan. Do not start it.",
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
		expect(status()).toBeUndefined();
	});

	it("in print mode returns the plan as the final output and stays in planning", async () => {
		const { harness } = await setup({ ui: "none", planFlag: true });
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		harness.setResponses([call("exit_plan_mode", { plan: PLAN }), fauxAssistantMessage("unused")]);
		await harness.session.prompt("plan it");

		const last = harness.session.messages.at(-1);
		expect(last?.role).toBe("toolResult");
		expect(getMessageText(last)).toBe(PLAN);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
	});

	it("sets the plan_mode section only when planning starts and ends", async () => {
		const { harness } = await setup();
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("three")]);
		await harness.session.prompt("third");

		const patches = harness.session.messages.flatMap((message) =>
			message.role === "system" && message.sections && "plan_mode" in message.sections
				? [message.sections.plan_mode === null ? "removed" : "set"]
				: [],
		);
		expect(patches).toEqual(["set", "removed"]);
	});

	it("follows the branch when navigating the session tree", async () => {
		const { harness, status } = await setup();
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("planning")]);
		await harness.session.prompt("first");
		const planningLeaf = harness.sessionManager.getLeafId();
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("normal")]);
		await harness.session.prompt("second");
		const normalLeaf = harness.sessionManager.getLeafId();
		if (!planningLeaf || !normalLeaf) throw new Error("Missing leaves");

		await harness.session.navigateTree(planningLeaf);
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		expect(status()).toBe("plan");

		await harness.session.navigateTree(normalLeaf);
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
		expect(status()).toBeUndefined();
	});

	it("restores planning when the session is resumed", async () => {
		const first = await setup();
		await first.harness.session.prompt("/plan");
		first.harness.setResponses([fauxAssistantMessage("planning")]);
		await first.harness.session.prompt("first");

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(activeTools(resumed.harness)).toEqual(PLANNING_TOOLS);
		expect(resumed.status()).toBe("plan");

		await resumed.harness.session.prompt("/plan");
		expect(activeTools(resumed.harness)).toEqual(NORMAL_TOOLS);
	});

	it("restores the tools when a session that left plan mode before any run resumes", async () => {
		const first = await setup();
		await first.harness.session.prompt("/plan");
		first.harness.setResponses([fauxAssistantMessage("planning")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("/plan");
		expect(activeTools(first.harness)).toEqual(NORMAL_TOOLS);

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(activeTools(resumed.harness)).toEqual(NORMAL_TOOLS);
		expect(resumed.status()).toBeUndefined();

		await resumed.harness.session.prompt("/plan");
		await resumed.harness.session.prompt("/plan");
		expect(activeTools(resumed.harness)).toEqual(NORMAL_TOOLS);
	});

	it("restores the tools when navigating to an entry that left plan mode before any run", async () => {
		const { harness, status } = await setup();
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("planning")]);
		await harness.session.prompt("first");
		const planningLeaf = harness.sessionManager.getLeafId();
		await harness.session.prompt("/plan");
		const offLeaf = harness.sessionManager.getLeafId();
		if (!planningLeaf || !offLeaf) throw new Error("Missing leaves");

		await harness.session.navigateTree(planningLeaf);
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		await harness.session.navigateTree(offLeaf);
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
		expect(status()).toBeUndefined();
	});

	it("keeps tool changes that a run recorded after plan mode ended", async () => {
		const first = await setup();
		await first.harness.session.prompt("/plan");
		first.harness.setResponses([fauxAssistantMessage("planning"), fauxAssistantMessage("normal")]);
		await first.harness.session.prompt("first");
		await first.harness.session.prompt("/plan");
		await first.harness.session.prompt("/deactivate-edit");
		await first.harness.session.prompt("second");

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(activeTools(resumed.harness)).toEqual(NORMAL_TOOLS.filter((name) => name !== "edit"));
	});

	it("does not write to the session when a resumed planning session gains a tool", async () => {
		const first = await setup();
		await first.harness.session.prompt("/plan");
		first.harness.setResponses([fauxAssistantMessage("planning")]);
		await first.harness.session.prompt("first");
		const entries = planEntryCount(first.harness);

		const resumed = await setup({
			ui: "none",
			sessionManager: first.harness.sessionManager,
			extensions: [deployAtLoad],
		});
		expect(activeTools(resumed.harness)).toEqual(PLANNING_TOOLS);
		expect(planEntryCount(resumed.harness)).toBe(entries);

		await resumed.harness.session.prompt("/plan");
		expect(activeTools(resumed.harness)).toEqual([...NORMAL_TOOLS, "deploy"].sort());
	});

	it("dismisses the approval prompt when the run is aborted", async () => {
		let opened: () => void = () => {};
		const dialogOpen = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const { harness } = await setup({
			ui: {
				select: (_title, _options, opts) =>
					new Promise((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
						opened();
					}),
			},
		});
		await harness.session.prompt("/plan");
		harness.setResponses([call("exit_plan_mode", { plan: PLAN }), fauxAssistantMessage("unused")]);
		const run = harness.session.prompt("plan the rename");
		await dialogOpen;
		void harness.session.abort();

		const outcome = await Promise.race([
			run.then(() => "finished"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
		]);
		expect(outcome).toBe("finished");
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
	});

	it("dismisses the feedback prompt when the run is aborted", async () => {
		let opened: () => void = () => {};
		const dialogOpen = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const { harness } = await setup({
			ui: {
				select: async () => "Keep planning",
				input: (_title, _placeholder, opts) =>
					new Promise((resolve) => {
						opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
						opened();
					}),
			},
		});
		await harness.session.prompt("/plan");
		harness.setResponses([call("exit_plan_mode", { plan: PLAN }), fauxAssistantMessage("unused")]);
		const run = harness.session.prompt("plan the rename");
		await dialogOpen;
		void harness.session.abort();

		const outcome = await Promise.race([
			run.then(() => "finished"),
			new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
		]);
		expect(outcome).toBe("finished");
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
	});

	it("binds app.plan.toggle to its configured keys", async () => {
		const { harness, status } = await setup();
		const runner = harness.session.extensionRunner;

		const todos = { "app.todos.toggle": "alt+t" } as const;

		expect([...runner.getShortcuts({ ...todos, "app.plan.toggle": "ctrl+alt+p" }).keys()].sort()).toEqual([
			"alt+t",
			"ctrl+alt+p",
		]);
		const rebound = runner.getShortcuts({ ...todos, "app.plan.toggle": "alt+m" });
		expect([...rebound.keys()].sort()).toEqual(["alt+m", "alt+t"]);
		expect(runner.getShortcutDiagnostics()).toEqual([]);

		const toggle = rebound.get("alt+m");
		if (!toggle) throw new Error("Missing shortcut");
		await toggle.handler(runner.createContext());
		expect(status()).toBe("plan");
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		await toggle.handler(runner.createContext());
		expect(status()).toBeUndefined();
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
	});
});
