import type { AgentTool } from "@sorvex/agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, type TranscriptContext } from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import todoExtension from "../../src/extensions/todo/index.ts";
import {
	createHarness,
	createTestUiContext,
	getMessageText,
	getToolResult,
	type Harness,
	type HarnessOptions,
} from "./harness.ts";

const compactWithoutModel: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", async (event) => ({
		compaction: {
			summary: "summary",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
};

interface Setup {
	harness: Harness;
	widget: () => string[] | undefined;
	widgetCalls: Array<string[] | undefined>;
	notifications: string[];
}

type ToolArgs = Parameters<typeof fauxToolCall>[1];

const THREE_TASKS: ToolArgs = {
	action: "create",
	tasks: [
		{ subject: "Write parser", activeForm: "Writing parser" },
		{ subject: "Write tests" },
		{ subject: "Update docs" },
	],
};

function todoCall(args: ToolArgs) {
	return fauxAssistantMessage(fauxToolCall("todo", args), { stopReason: "toolUse" });
}

function todoSections(context: TranscriptContext): string | undefined {
	return getCurrentSystemMessage(context.messages)?.sections?.todos ?? undefined;
}

describe("built-in todo extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: Pick<HarnessOptions, "sessionManager" | "models" | "tools"> & { settings?: object } = {},
	): Promise<Setup> {
		const harness = await createHarness({
			...options,
			extensionFactories: [todoExtension, compactWithoutModel],
			settings: { compaction: { keepRecentTokens: 1 }, ...options.settings },
		});
		harnesses.push(harness);
		const widgetCalls: Array<string[] | undefined> = [];
		const notifications: string[] = [];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				setWidget: (_key: string, content: unknown) => {
					widgetCalls.push(content as string[] | undefined);
				},
				notify: (message) => notifications.push(message),
			}),
		});
		return { harness, widgetCalls, notifications, widget: () => widgetCalls.at(-1) };
	}

	async function createThreeAndStartOne(harness: Harness): Promise<void> {
		harness.setResponses([
			todoCall(THREE_TASKS),
			todoCall({ action: "update", id: 1, status: "in_progress", activeForm: "Writing parser" }),
			fauxAssistantMessage("started"),
		]);
		await harness.session.prompt("plan the work");
	}

	it("creates tasks, starts one, and shows the widget above the editor", async () => {
		const { harness, widget, widgetCalls } = await setup();
		await createThreeAndStartOne(harness);

		expect(getMessageText(harness.session.messages.filter((m) => m.role === "toolResult")[0])).toBe(
			"Created #1: Write parser (pending)\nCreated #2: Write tests (pending)\nCreated #3: Update docs (pending)",
		);
		expect(getMessageText(getToolResult(harness, "todo"))).toBe("Updated #1 (pending -> in_progress)");
		expect(widget()).toEqual(["Todos (0/3)", "◐ #1 Writing parser", "○ #2 Write tests", "○ #3 Update docs"]);
		expect(widgetCalls.length).toBeGreaterThan(0);
	});

	it("returns an error and keeps the list when an update would create a cycle", async () => {
		const { harness, widget } = await setup();
		harness.setResponses([
			todoCall({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] }),
			todoCall({ action: "update", id: 1, addBlockedBy: [2] }),
			todoCall({ action: "update", id: 2, addBlockedBy: [1] }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const result = getToolResult(harness, "todo");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("addBlockedBy would create a cycle: #2 -> #1 -> #2");
		expect(widget()).toEqual(["Todos (0/2)", "○ #1 a (blocked by #2)", "○ #2 b"]);
	});

	it("creates a dependent batch in one call and restores the same list on resume", async () => {
		const first = await setup();
		first.harness.setResponses([
			todoCall({
				action: "create",
				tasks: [
					{ subject: "Design" },
					{ subject: "Build", blockedBy: [1] },
					{ subject: "Ship", blockedBy: [1, 2] },
				],
			}),
			todoCall({ action: "update", id: 1, status: "completed" }),
			fauxAssistantMessage("done"),
		]);
		await first.harness.session.prompt("plan");

		const results = first.harness.session.messages.filter((m) => m.role === "toolResult");
		expect(getMessageText(results[0])).toBe(
			"Created #1: Design (pending)\nCreated #2: Build (pending, blocked by #1)\nCreated #3: Ship (pending, blocked by #1, #2)",
		);
		expect(results.some((result) => result.isError)).toBe(false);
		const live = ["Todos (1/3)", "✓ #1 Design", "○ #2 Build", "○ #3 Ship (blocked by #2)"];
		expect(first.widget()).toEqual(live);

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(resumed.widget()).toEqual(live);
		await resumed.harness.session.prompt("/todos");
		expect(resumed.notifications.at(-1)).toBe(
			"Todos (1/3)\nPending:\n  ○ #2 Build\n  ○ #3 Ship (blocked by #2)\nCompleted:\n  ✓ #1 Design",
		);
	});

	it("rejects a task that waits on a later task of the same call", async () => {
		const { harness, widget } = await setup();
		harness.setResponses([
			todoCall({
				action: "create",
				tasks: [{ subject: "Ship", blockedBy: [2] }, { subject: "Build" }],
			}),
			fauxAssistantMessage("retry"),
		]);
		await harness.session.prompt("plan");

		const result = getToolResult(harness, "todo");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("task 1: blockedBy #2 comes later in this call; list prerequisites first");
		expect(widget()).toBeUndefined();
	});

	it("accepts a tasks array that the model sent as a JSON string", async () => {
		const { harness } = await setup();
		harness.setResponses([
			todoCall({
				action: "create",
				tasks: JSON.stringify([{ subject: "one" }, JSON.stringify({ subject: "two" })]),
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "todo"))).toBe(
			"Created #1: one (pending)\nCreated #2: two (pending)",
		);
	});

	it("removes a finished list when the next turn starts", async () => {
		const { harness, widget } = await setup();
		harness.setResponses([
			todoCall({ action: "create", tasks: [{ subject: "a" }] }),
			todoCall({ action: "update", id: 1, status: "completed" }),
			fauxAssistantMessage("all done"),
			fauxAssistantMessage("anything else?"),
		]);
		await harness.session.prompt("do it");
		expect(widget()).toEqual(["Todos (1/1)", "✓ #1 a"]);

		await harness.session.prompt("thanks");
		expect(widget()).toBeUndefined();
	});

	it("limits the widget to todo.widgetMaxLines and counts hidden tasks", async () => {
		const { harness, widget } = await setup({ settings: { todo: { widgetMaxLines: 5 } } });
		const tasks = Array.from({ length: 20 }, (_, index) => ({ subject: `task ${index + 1}` }));
		harness.setResponses([todoCall({ action: "create", tasks }), fauxAssistantMessage("done")]);
		await harness.session.prompt("many");

		expect(widget()).toEqual(["Todos (0/20)", "○ #1 task 1", "○ #2 task 2", "○ #3 task 3", "... +17 more"]);
	});

	it("follows the branch when navigating the session tree", async () => {
		const { harness, widget, notifications } = await setup();
		await createThreeAndStartOne(harness);

		const branch = harness.sessionManager.getBranch();
		const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const last = branch.at(-1);
		if (!firstUser || !last) throw new Error("Missing entries");

		await harness.session.navigateTree(firstUser.id);
		await harness.session.prompt("/todos");
		expect(notifications.at(-1)).toBe("No todos yet. Ask the agent to add some!");
		expect(widget()).toBeUndefined();

		await harness.session.navigateTree(last.id);
		await harness.session.prompt("/todos");
		expect(notifications.at(-1)).toBe(
			"Todos (0/3)\nIn progress:\n  ◐ #1 Writing parser\nPending:\n  ○ #2 Write tests\n  ○ #3 Update docs",
		);
		expect(widget()?.[0]).toBe("Todos (0/3)");
	});

	it("sets no todos section on ordinary turns", async () => {
		const { harness } = await setup();
		const seen: Array<string | undefined> = [];
		harness.setResponses([
			todoCall(THREE_TASKS),
			(context) => {
				seen.push(todoSections(context));
				return fauxAssistantMessage("one");
			},
		]);
		await harness.session.prompt("first");
		harness.appendResponses([
			(context) => {
				seen.push(todoSections(context));
				return fauxAssistantMessage("two");
			},
		]);
		await harness.session.prompt("second");

		expect(seen).toEqual([undefined, undefined]);
		const systemSections = harness.session.messages.flatMap((message) =>
			message.role === "system" && message.sections && "todos" in message.sections ? [message.sections] : [],
		);
		expect(systemSections).toEqual([]);
	});

	it("keeps the list across compaction and gives the model its open tasks once", async () => {
		const { harness, widget } = await setup();
		await createThreeAndStartOne(harness);
		await harness.session.compact();

		expect(widget()).toEqual(["Todos (0/3)", "◐ #1 Writing parser", "○ #2 Write tests", "○ #3 Update docs"]);

		const seen: Array<string | undefined> = [];
		const record = (text: string) => (context: TranscriptContext) => {
			seen.push(todoSections(context));
			return fauxAssistantMessage(text);
		};
		harness.setResponses([record("after compaction"), record("next turn")]);
		await harness.session.prompt("continue");
		await harness.session.prompt("and again");

		const expected =
			"<todos>\nOpen tasks when this session was resumed or compacted. Later todo tool results supersede this list.\n- #1 [in_progress] Write parser\n- #2 [pending] Write tests\n- #3 [pending] Update docs\n</todos>";
		expect(seen).toEqual([expected, expected]);

		const patches = harness.session.messages.flatMap((message) =>
			message.role === "system" && message.sections && "todos" in message.sections ? [message.sections.todos] : [],
		);
		expect(patches).toEqual([expected]);
	});

	it("gives the model its open tasks on the next turn after a compaction in the middle of a run", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "x".repeat(8000) }], details: {} }),
		};
		const { harness } = await setup({
			models: [{ id: "faux-1", contextWindow: 4000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 2000 } },
			tools: [largeTool],
		});
		harness.setResponses([fauxAssistantMessage(`old:${"a".repeat(8000)}`), fauxAssistantMessage("recent")]);
		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");

		const seen: Array<string | undefined> = [];
		const record = (response: ReturnType<typeof fauxAssistantMessage>) => (context: TranscriptContext) => {
			seen.push(todoSections(context));
			return response;
		};
		harness.setResponses([
			todoCall(THREE_TASKS),
			record(fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })),
			record(todoCall({ action: "update", id: 1, status: "in_progress", activeForm: "Writing parser" })),
			record(fauxAssistantMessage("done")),
		]);
		await harness.session.prompt("plan and run");

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		const expected =
			"<todos>\nOpen tasks when this session was resumed or compacted. Later todo tool results supersede this list.\n- #1 [pending] Write parser\n- #2 [pending] Write tests\n- #3 [pending] Update docs\n</todos>";
		expect(seen).toEqual([undefined, expected, expected]);
		const patches = harness.session.messages.flatMap((message) =>
			message.role === "system" && message.sections && "todos" in message.sections ? [message.sections.todos] : [],
		);
		expect(patches).toEqual([expected]);
	});

	it("restores the list and the prompt section when the session is resumed", async () => {
		const first = await setup();
		await createThreeAndStartOne(first.harness);
		await first.harness.session.prompt("/todos");

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(resumed.widget()).toEqual(["Todos (0/3)", "◐ #1 Writing parser", "○ #2 Write tests", "○ #3 Update docs"]);

		let section: string | undefined;
		resumed.harness.setResponses([
			(context) => {
				section = todoSections(context);
				return fauxAssistantMessage("welcome back");
			},
		]);
		await resumed.harness.session.prompt("where were we?");
		expect(section).toContain("- #1 [in_progress] Write parser");
	});

	it("does not show a list that was already finished when the session is resumed", async () => {
		const first = await setup();
		first.harness.setResponses([
			todoCall({ action: "create", tasks: [{ subject: "a" }] }),
			todoCall({ action: "update", id: 1, status: "completed" }),
			fauxAssistantMessage("done"),
		]);
		await first.harness.session.prompt("go");

		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(resumed.widgetCalls).toEqual([]);
	});

	it("adds a session entry only for calls that change the list", async () => {
		const { harness } = await setup();
		harness.setResponses([
			todoCall(THREE_TASKS),
			todoCall({ action: "list" }),
			todoCall({ action: "update", id: 1, status: "pending" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		const details = harness.session.messages
			.filter((message) => message.role === "toolResult")
			.map((message) => (message.details === undefined ? "none" : "snapshot"));
		expect(details).toEqual(["snapshot", "none", "none"]);
	});

	describe("app.todos.toggle", () => {
		it("binds the toggle handler to the configured keys", async () => {
			const { harness, widget } = await setup();
			await createThreeAndStartOne(harness);
			const runner = harness.session.extensionRunner;

			const defaults = runner.getShortcuts({ "app.todos.toggle": "alt+t" });
			expect([...defaults.keys()]).toEqual(["alt+t"]);
			expect(defaults.get("alt+t")?.description).toBe("Collapse or expand the todo list");

			const rebound = runner.getShortcuts({ "app.todos.toggle": ["ctrl+alt+x", "alt+y"] });
			expect([...rebound.keys()]).toEqual(["ctrl+alt+x", "alt+y"]);
			expect(runner.getShortcutDiagnostics()).toEqual([]);
			expect(runner.getShortcuts({ "app.todos.toggle": [] }).size).toBe(0);

			const toggle = rebound.get("alt+y");
			if (!toggle) throw new Error("Missing shortcut");
			await toggle.handler(runner.createContext());
			expect(widget()).toEqual(["Todos (0/3) · Writing parser"]);
			await toggle.handler(runner.createContext());
			expect(widget()).toEqual(["Todos (0/3)", "◐ #1 Writing parser", "○ #2 Write tests", "○ #3 Update docs"]);
		});

		it("does not override a reserved key", async () => {
			const { harness } = await setup();
			const runner = harness.session.extensionRunner;
			const shortcuts = runner.getShortcuts({ "app.todos.toggle": "ctrl+o", "app.tools.expand": "ctrl+o" });
			expect(shortcuts.size).toBe(0);
			expect(runner.getShortcutDiagnostics().map((diagnostic) => diagnostic.message)).toEqual([
				expect.stringMatching(
					/^Extension shortcut 'ctrl\+o' from .* conflicts with built-in shortcut\. Skipping\.$/,
				),
			]);
		});
	});
});
