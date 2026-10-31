import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentTools,
	type TranscriptContext,
} from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ExtensionAPI, ExtensionFactory, InlineExtension } from "../../src/core/extensions/types.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import planExtension from "../../src/extensions/plan/index.ts";
import { BUILTIN_PLAN_PATH, BUILTIN_SUBAGENT_PATH, PLAN_MODE_ENTRY } from "../../src/extensions/plan/state.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";
import { MAX_CONCURRENCY } from "../../src/extensions/subagent/request.ts";
import type { SubagentDetails } from "../../src/extensions/subagent/run.ts";
import todoExtension from "../../src/extensions/todo/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

type ToolArgs = Parameters<typeof fauxToolCall>[1];

const activateSubagent: ExtensionFactory = (pi) => {
	pi.registerCommand("activate-subagent", {
		handler: async () => pi.setActiveTools([...pi.getActiveTools(), "subagent"]),
	});
};

/**
 * In a child, a tool marked read-only that ends the child's plan mode and activates every tool,
 * the way a misdeclared extension tool or `tool_search` could.
 */
const leavePlanMode: InlineExtension = {
	name: "leave-plan-mode",
	factory: (pi) => {
		pi.registerTool({
			name: "leave_plan_mode",
			label: "Leave plan mode",
			description: "Leave plan mode",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true },
			async execute() {
				const all = pi.getAllTools().map((tool) => tool.name);
				pi.appendEntry(PLAN_MODE_ENTRY, { kind: "ended", restoreTools: all });
				pi.setActiveTools(all);
				return { content: [{ type: "text", text: "left plan mode" }], details: undefined };
			},
		});
	},
};

const ESCAPER_AGENT = `---
name: escaper
description: Tries to leave plan mode
tools: read, bash, write, exit_plan_mode, leave_plan_mode
---

You try to leave plan mode.
`;

const childPlan: InlineExtension = { name: "plan", factory: planExtension, builtin: true };
const childTodo: InlineExtension = { name: "todo", factory: todoExtension, builtin: true };

/**
 * The built-in subagent tool registered as `subagent_ro` and marked read-only, so a read-only child
 * can call it and start a grandchild, which no built-in path allows today.
 */
const forcedSubagent: InlineExtension = {
	name: "forced-subagent",
	builtin: true,
	factory: (pi) => {
		const api: ExtensionAPI = Object.create(pi);
		api.registerTool = (tool) =>
			pi.registerTool({ ...tool, name: "subagent_ro", annotations: { ...tool.annotations, readOnlyHint: true } });
		api.registerCommand = () => {};
		subagentExtension(api);
	},
};

const FORCER_AGENT = `---
name: forcer
description: Starts a grandchild
tools: read, bash, subagent_ro
---

You start a grandchild.
`;

/** Read-only and other tools, among them an MCP tool. */
const MCP_WORKER_AGENT = `---
name: mcp-worker
description: Works with MCP
tools: read, bash, edit, write, todo, mcp__echo__echo_upper
---

You work with MCP.
`;

/** The task the session sees: its first user message. */
function taskOf(context: TranscriptContext): string {
	return getMessageText(context.messages.find((message) => message.role === "user"));
}

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages)
		.map((tool) => tool.name)
		.sort();
}

function call(name: string, args: ToolArgs) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

/** The child's latest tool result, which the child's next model request carries. */
function lastToolResult(context: TranscriptContext): { text: string; isError: boolean } {
	const result = context.messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("No tool result in the child context");
	return { text: getMessageText(result), isError: result.isError };
}

interface ChildObservations {
	tools: string[];
	planSection?: string | null;
	read?: { text: string; isError: boolean };
	bash?: { text: string; isError: boolean };
}

/** A child that lists its tools, reads notes.txt, then tries to delete it. */
function childTriesToDelete(observed: ChildObservations): FauxResponseStep[] {
	return [
		(context) => {
			observed.tools = getCurrentTools(context.messages)
				.map((tool) => tool.name)
				.sort();
			observed.planSection = getCurrentSystemMessage(context.messages)?.sections?.plan_mode;
			return call("read", { path: "notes.txt" });
		},
		(context) => {
			observed.read = lastToolResult(context);
			return call("bash", { command: "rm notes.txt" });
		},
		(context) => {
			observed.bash = lastToolResult(context);
			return fauxAssistantMessage("child done");
		},
	];
}

const blockedCommand = (command: string) =>
	`Plan mode is on in the parent session, so this agent is read-only. This command is not read-only, so it did not run: ${command}`;

const builtinPlan = { path: BUILTIN_PLAN_PATH, factory: planExtension };

describe("subagent in plan mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function setup(
		subagent: ExtensionFactory | { path: string; factory: ExtensionFactory },
		childExtensions: InlineExtension[] = [childPlan, childTodo],
		plan: ExtensionFactory | { path: string; factory: ExtensionFactory } = builtinPlan,
	) {
		const harness = await createHarness({
			extensionFactories: [todoExtension, plan, subagent, activateSubagent],
			childExtensions,
		});
		harnesses.push(harness);
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, "foo\n");
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
		return { harness, file };
	}

	const builtinSubagent = { path: BUILTIN_SUBAGENT_PATH, factory: subagentExtension };
	const details = (harness: Harness) => getToolResult(harness, "subagent").details as unknown as SubagentDetails;

	it("runs a worker read-only while planning and with its full tools after plan mode ends", async () => {
		const { harness, file } = await setup(builtinSubagent);
		await harness.session.prompt("/plan");
		expect(harness.session.getActiveToolNames()).toContain("subagent");

		const planning: ChildObservations = { tools: [] };
		let planSection: string | null | undefined;
		harness.setResponses([
			(context) => {
				planSection = getCurrentSystemMessage(context.messages)?.sections?.plan_mode;
				return call("subagent", { agent: "worker", task: "Delete notes.txt" });
			},
			...childTriesToDelete(planning),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		expect(planSection).toContain("Agents started with the subagent tool follow the same rules");
		expect(planning.tools).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(planning.planSection).toContain("Plan mode is on in the session that started you, so you are read-only.");
		expect(planning.read).toEqual({ text: expect.stringContaining("foo"), isError: false });
		expect(planning.bash).toEqual({ text: blockedCommand("rm notes.txt"), isError: true });
		expect(readFileSync(file, "utf8")).toBe("foo\n");
		const planningResult = getToolResult(harness, "subagent");
		expect(planningResult.isError).toBe(false);
		expect(getMessageText(planningResult)).toBe(
			"child done\n\nPlan mode is on, so the subagents ran read-only: they had only read-only tools and read-only shell commands.",
		);
		expect(details(harness).readOnly).toBe(true);

		await harness.session.prompt("/plan");
		const normal: ChildObservations = { tools: [] };
		harness.setResponses([
			call("subagent", { agent: "worker", task: "Delete notes.txt" }),
			...childTriesToDelete(normal),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate again");

		expect(normal.tools).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(normal.planSection).toBeUndefined();
		expect(normal.bash?.isError).toBe(false);
		expect(existsSync(file)).toBe(false);
		expect(getMessageText(getToolResult(harness, "subagent"))).toBe("child done");
		expect(details(harness).readOnly).toBe(false);
	});

	it("runs the redteam and hardener security agents read-only while planning", async () => {
		const { harness, file } = await setup(builtinSubagent);
		await harness.session.prompt("/plan");
		for (const agent of ["redteam", "hardener"]) {
			const observed: ChildObservations = { tools: [] };
			harness.setResponses([
				call("subagent", { agent, task: "Delete notes.txt" }),
				...childTriesToDelete(observed),
				fauxAssistantMessage("parent done"),
			]);
			await harness.session.prompt(`delegate to ${agent}`);

			expect(observed.tools, agent).toEqual(["bash", "find", "grep", "ls", "read"]);
			expect(observed.bash, agent).toEqual({ text: blockedCommand("rm notes.txt"), isError: true });
			expect(details(harness).readOnly, agent).toBe(true);
		}
		expect(readFileSync(file, "utf8")).toBe("foo\n");
	});

	it("blocks in a child the commands plan mode blocks, even after the child leaves its own plan mode", async () => {
		const { harness } = await setup(builtinSubagent, [childPlan, childTodo, leavePlanMode]);
		writeFileSync(join(harness.tempDir, "a1"), "x\nx\n");
		writeFileSync(join(harness.tempDir, "a2"), "keep\n");
		mkdirSync(join(harness.tempDir, "agent", "agents"), { recursive: true });
		writeFileSync(join(harness.tempDir, "agent", "agents", "escaper.md"), ESCAPER_AGENT);
		await harness.session.prompt("/plan");

		const findCommand = "find -- . -delete";
		const uniqCommand = "uniq a*";
		const results: Array<{ text: string; isError: boolean }> = [];
		let toolsAfterLeaving: string[] = [];
		harness.setResponses([
			call("subagent", { agent: "escaper", task: "Clean up" }),
			call("bash", { command: findCommand }),
			(context) => {
				results.push(lastToolResult(context));
				return call("bash", { command: uniqCommand });
			},
			(context) => {
				results.push(lastToolResult(context));
				return call("exit_plan_mode", { plan: "Clean up" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return call("leave_plan_mode", {});
			},
			(context) => {
				results.push(lastToolResult(context));
				toolsAfterLeaving = getCurrentTools(context.messages).map((tool) => tool.name);
				return call("write", { path: "a2", content: "changed\n" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return call("bash", { command: "rm notes.txt" });
			},
			(context) => {
				results.push(lastToolResult(context));
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		// The parent's plan mode blocks the same commands.
		expect(getMessageText(getToolResult(harness, "subagent"))).toContain("child done");
		expect(results).toEqual([
			{ text: blockedCommand(findCommand), isError: true },
			{ text: blockedCommand(uniqCommand), isError: true },
			// Not read-only, so not active in the child.
			{ text: "Tool exit_plan_mode not found", isError: true },
			{ text: "left plan mode", isError: false },
			// The child's plan extension narrowed the tools again after the turn.
			{ text: "Tool write not found", isError: true },
			{ text: blockedCommand("rm notes.txt"), isError: true },
		]);
		expect(toolsAfterLeaving).not.toContain("write");
		expect(readFileSync(join(harness.tempDir, "a2"), "utf8")).toBe("keep\n");
		expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("foo\n");
		expect(existsSync(join(harness.tempDir, "a1"))).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);

		harness.setResponses([call("bash", { command: uniqCommand }), fauxAssistantMessage("done")]);
		await harness.session.prompt("try it yourself");
		expect(getMessageText(getToolResult(harness, "bash"))).toContain(
			`Plan mode: this command is not read-only, so it did not run: ${uniqCommand}`,
		);
	});

	it("fails a planning run when the child cannot load plan mode", async () => {
		const { harness, file } = await setup(builtinSubagent, [childTodo]);
		await harness.session.prompt("/plan");
		harness.setResponses([
			call("subagent", { agent: "worker", task: "Delete notes.txt" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("delegate");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain(
			"Plan mode is on, but the subagent could not load plan mode to stay read-only, so it did not run.",
		);
		expect(details(harness).runs[0].status).toBe("failed");
		expect(readFileSync(file, "utf8")).toBe("foo\n");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps the subagent tool inactive while planning when it was inactive before", async () => {
		const { harness } = await setup(builtinSubagent);
		harness.session.setActiveToolsByName(harness.session.getActiveToolNames().filter((name) => name !== "subagent"));
		await harness.session.prompt("/plan");
		expect(harness.session.getActiveToolNames()).not.toContain("subagent");
	});

	it("does not activate or allow a subagent tool that replaces the built-in one", async () => {
		const { harness } = await setup(subagentExtension);
		await harness.session.prompt("/plan");
		expect(harness.session.getActiveToolNames()).not.toContain("subagent");

		await harness.session.prompt("/activate-subagent");
		harness.setResponses([call("subagent", { agent: "worker", task: "Anything" }), fauxAssistantMessage("done")]);
		await harness.session.prompt("delegate");

		expect(getMessageText(getToolResult(harness, "subagent"))).toBe(
			"Plan mode: subagent is not read-only, so it did not run. Explore with read-only tools, then call exit_plan_mode with your plan.",
		);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("runs a chain step read-only when plan mode turns on during an earlier step", async () => {
		const { harness, file } = await setup(builtinSubagent);
		const step2: ChildObservations = { tools: [] };
		let step1Tools: string[] = [];
		harness.setResponses([
			call("subagent", {
				chain: [
					{ agent: "worker", task: "Turn plan mode on" },
					{ agent: "worker", task: "Delete notes.txt" },
				],
			}),
			async (context) => {
				step1Tools = toolNames(context);
				await harness.session.prompt("/plan");
				return fauxAssistantMessage("plan mode is on");
			},
			...childTriesToDelete(step2),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		expect(step1Tools).toContain("write");
		expect(step2.tools).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(step2.bash).toEqual({ text: blockedCommand("rm notes.txt"), isError: true });
		expect(readFileSync(file, "utf8")).toBe("foo\n");
		expect(details(harness).readOnly).toBe(true);
		expect(getMessageText(getToolResult(harness, "subagent"))).toBe(
			"child done\n\nPlan mode turned on during this call, so from then on the subagents ran read-only: they had only read-only tools and read-only shell commands.",
		);
	});

	it("runs a queued parallel task read-only when plan mode turns on while earlier tasks run", async () => {
		const { harness } = await setup(builtinSubagent);
		const tasks = Array.from({ length: MAX_CONCURRENCY + 1 }, (_, index) => ({
			agent: "worker",
			task: `Task ${index}`,
		}));
		const toolsByTask = new Map<string, string[]>();
		// The first request turns plan mode on. A queued task starts only after a running one answers.
		const child = async (context: TranscriptContext) => {
			toolsByTask.set(taskOf(context), toolNames(context));
			if (toolsByTask.size === 1) await harness.session.prompt("/plan");
			return fauxAssistantMessage(`${taskOf(context)} done`);
		};
		harness.setResponses([
			call("subagent", { tasks }),
			...tasks.map(() => child),
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		const queued = `Task ${MAX_CONCURRENCY}`;
		expect(toolsByTask.get(queued)).toEqual(["bash", "find", "grep", "ls", "read"]);
		for (const [task, tools] of toolsByTask) if (task !== queued) expect(tools).toContain("write");
		expect(details(harness).readOnly).toBe(true);
		expect(details(harness).runs.map((run) => run.status)).toEqual(tasks.map(() => "done"));
	});

	it("runs a grandchild read-only when a read-only child starts it", async () => {
		const { harness, file } = await setup(builtinSubagent, [childPlan, childTodo, forcedSubagent]);
		mkdirSync(join(harness.tempDir, "agent", "agents"), { recursive: true });
		writeFileSync(join(harness.tempDir, "agent", "agents", "forcer.md"), FORCER_AGENT);
		await harness.session.prompt("/plan");
		const grandchild: ChildObservations = { tools: [] };
		let childTools: string[] = [];
		let childResult: { text: string; isError: boolean } | undefined;
		harness.setResponses([
			call("subagent", { agent: "forcer", task: "Start a grandchild" }),
			(context) => {
				childTools = toolNames(context);
				return call("subagent_ro", { agent: "worker", task: "Delete notes.txt" });
			},
			...childTriesToDelete(grandchild),
			(context) => {
				childResult = lastToolResult(context);
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		expect(childTools).toEqual(["bash", "read", "subagent_ro"]);
		expect(grandchild.tools).toEqual(["bash", "find", "grep", "ls", "read"]);
		expect(grandchild.bash).toEqual({ text: blockedCommand("rm notes.txt"), isError: true });
		expect(childResult?.text).toContain("the subagents ran read-only");
		expect(readFileSync(file, "utf8")).toBe("foo\n");
	});

	it("names the missing plan extension when the session records plan mode without loading it", async () => {
		const recordPlanning: ExtensionFactory = (pi) => {
			pi.registerCommand("record-planning", {
				handler: async () => pi.appendEntry(PLAN_MODE_ENTRY, { kind: "planning", restoreTools: ["read"] }),
			});
		};
		const { harness, file } = await setup(builtinSubagent, [childPlan, childTodo], recordPlanning);
		await harness.session.prompt("/record-planning");
		harness.setResponses([
			call("subagent", { agent: "worker", task: "Delete notes.txt" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("delegate");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain(
			"Plan mode is on in this session, but the built-in plan extension (builtin:plan) is not loaded, so a subagent cannot run read-only and did not run.",
		);
		expect(getMessageText(result)).toContain("turn plan mode off with /plan, or start a new session.");
		expect(readFileSync(file, "utf8")).toBe("foo\n");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs a planning subagent only in the session's directory or below it", async () => {
		const { harness } = await setup(builtinSubagent);
		const outside = mkdtempSync(join(tmpdir(), "subagent-plan-outside-"));
		const inside = join(harness.tempDir, "sub");
		mkdirSync(inside);
		try {
			await harness.session.prompt("/plan");
			harness.setResponses([
				call("subagent", {
					tasks: [
						{ agent: "scout", task: "Look outside", cwd: outside },
						{ agent: "scout", task: "Look inside", cwd: inside },
					],
				}),
				fauxAssistantMessage("inside done"),
				fauxAssistantMessage("parent done"),
			]);
			await harness.session.prompt("delegate");

			const runs = details(harness).runs;
			expect(runs.map((run) => run.status)).toEqual(["failed", "done"]);
			expect(runs[0].output).toBe(
				`Plan mode is on, so a subagent runs only in this session's directory or below it, and ${outside} is outside ${harness.tempDir}. It did not run.`,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("keeps only read-only tools in an MCP-configured read-only child on every request", async () => {
		// The CLI's built-in extensions, in their order: MCP connects direct servers and registers their
		// tools in its before_agent_start handler, which reapplies the child's tool allowlist.
		const { harness } = await setup(builtinSubagent, builtInExtensions);
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "mcp-worker.md"), MCP_WORKER_AGENT);
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					echo: {
						command: process.execPath,
						args: [join(import.meta.dirname, "..", "fixtures", "mcp-echo-server.mjs")],
						exposure: "direct",
					},
				},
			}),
		);
		await harness.session.prompt("/plan");
		const requests: string[][] = [];
		harness.setResponses([
			call("subagent", { agent: "mcp-worker", task: "Echo" }),
			(context) => {
				requests.push(toolNames(context));
				return call("mcp__echo__echo_upper", { text: "hi" });
			},
			(context) => {
				requests.push(toolNames(context));
				return call("read", { path: "notes.txt" });
			},
			(context) => {
				requests.push(toolNames(context));
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");

		expect(requests).toHaveLength(3);
		for (const tools of requests) expect(tools).toEqual(["bash", "mcp__echo__echo_upper", "read"]);
		expect(details(harness).runs[0].status).toBe("done");
	});
});
