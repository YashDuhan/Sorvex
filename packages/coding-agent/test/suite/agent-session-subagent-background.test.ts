import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
	type Message,
	type TranscriptContext,
} from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory, InlineExtension } from "../../src/core/extensions/types.ts";
import planExtension from "../../src/extensions/plan/index.ts";
import { BUILTIN_PLAN_PATH, BUILTIN_SUBAGENT_PATH } from "../../src/extensions/plan/state.ts";
import { FLEET_WIDGET_KEY } from "../../src/extensions/subagent/fleet-widget.ts";
import subagentExtension, {
	BACKGROUND_RESULT_MESSAGE,
	isInsideDirectory,
} from "../../src/extensions/subagent/index.ts";
import type { SubagentDetails } from "../../src/extensions/subagent/run.ts";
import { createHarness, createTestUiContext, getMessageText, type Harness } from "./harness.ts";

const BG_AGENT = `---
name: bg
description: Background helper
tools: read, bash, write
---

You are the bg agent.
`;

const AGENT_MARKER = "You are the bg agent.";

function call(name: string, args: JsonObject) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function isChildRequest(context: TranscriptContext): boolean {
	return (
		getCurrentSystemPrompt(context.messages).includes(AGENT_MARKER) ||
		context.messages.some((message) => message.role === "user" && getMessageText(message).includes(AGENT_MARKER))
	);
}

/**
 * Parent and child requests share one faux queue and may interleave, so each step answers from
 * the parent's or the child's script by who sent the request.
 */
function routed(parent: FauxResponseStep[], child: FauxResponseStep[]): FauxResponseStep[] {
	const queues = { parent: [...parent], child: [...child] };
	const step: FauxResponseStep = (context, options, state, model) => {
		const queue = isChildRequest(context) ? queues.child : queues.parent;
		const next = queue.shift();
		if (!next) throw new Error(`No scripted ${isChildRequest(context) ? "child" : "parent"} response left`);
		return typeof next === "function" ? next(context, options, state, model) : next;
	};
	return Array.from({ length: parent.length + child.length }, () => step);
}

function lastToolResult(context: TranscriptContext): { text: string; isError: boolean } {
	const result = context.messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("No tool result in the context");
	return { text: getMessageText(result), isError: result.isError };
}

function runIdIn(text: string): string {
	const id = /sub_[0-9a-f]{6}/.exec(text)?.[0];
	if (!id) throw new Error(`No run id in: ${text}`);
	return id;
}

/** A parent step that calls `subagent` with an action on the run id from the latest tool result. */
function control(action: "status" | "wait" | "cancel", onId: (id: string) => void = () => {}): FauxResponseStep {
	return (context) => {
		const id = runIdIn(lastToolResult(context).text);
		onId(id);
		return call("subagent", { action, id });
	};
}

function followUps(harness: Harness): Array<{ text: string; details: SubagentDetails }> {
	return harness.session.messages.flatMap((message) =>
		message.role === "custom" && message.customType === BACKGROUND_RESULT_MESSAGE
			? [{ text: getMessageText(message), details: message.details as SubagentDetails }]
			: [],
	);
}

function toolResults(harness: Harness, toolName: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === toolName ? [message] : [],
	);
}

const childPlan: InlineExtension = { name: "plan", factory: planExtension, builtin: true };
const childSubagent: InlineExtension = { name: "subagent", factory: subagentExtension, builtin: true };
const builtinPlan = { path: BUILTIN_PLAN_PATH, factory: planExtension };
const builtinSubagent = { path: BUILTIN_SUBAGENT_PATH, factory: subagentExtension };

describe("subagent fork context and background runs", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const harness of harnesses) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		}
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	async function setup(
		options: {
			plan?: boolean;
			widget?: Array<string[] | undefined>;
			extensions?: Array<ExtensionFactory | { path: string; factory: ExtensionFactory }>;
		} = {},
	) {
		const harness = await createHarness({
			extensionFactories: options.extensions ?? (options.plan ? [builtinPlan, builtinSubagent] : [builtinSubagent]),
			childExtensions: options.plan ? [childPlan] : [],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "bg.md"), BG_AGENT);
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, "foo\n");
		const widget = options.widget;
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				setWidget: ((key: string, content: unknown) => {
					if (key === FLEET_WIDGET_KEY && widget) widget.push(content as string[] | undefined);
				}) as never,
			}),
		});
		return { harness, file };
	}

	/** Wait until `predicate` holds and the session is idle again. */
	async function settle(harness: Harness, predicate: () => boolean): Promise<void> {
		await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5000, interval: 10 });
		await harness.session.waitForIdle();
	}

	describe("fork context", () => {
		it("starts the child from the parent's request, with the same system prompt and tools", async () => {
			const { harness } = await setup();
			// The CLI sends the session id with each request; the faux provider caches prompts by it.
			harness.session.agent.sessionId = harness.sessionManager.getSessionId();
			let parentRequest: Message[] = [];
			let childRequest: Message[] = [];
			let parentPromptTokens = 0;
			harness.setResponses([
				call("read", { path: "notes.txt" }),
				fauxAssistantMessage("read it"),
				(context) => {
					parentRequest = structuredClone(context.messages) as Message[];
					return call("subagent", { agent: "bg", task: "Summarize what we read", context: "fork" });
				},
				(context) => {
					childRequest = structuredClone(context.messages) as Message[];
					return fauxAssistantMessage("forked answer");
				},
				fauxAssistantMessage("parent done"),
			]);

			await harness.session.prompt("read notes.txt");
			await harness.session.prompt("fork a summarizer");

			const callMessage = harness.session.messages.find(
				(message) =>
					message.role === "assistant" &&
					message.content.some((part) => part.type === "toolCall" && part.name === "subagent"),
			);
			if (callMessage?.role === "assistant") {
				parentPromptTokens = callMessage.usage.cacheRead + callMessage.usage.cacheWrite + callMessage.usage.input;
			}
			// Byte-identical prefix: every message of the parent's request, the system message with its
			// tool declarations first, then only the task message.
			expect(parentRequest.some((message) => message.role === "toolResult")).toBe(true);
			expect(JSON.stringify(childRequest.slice(0, parentRequest.length))).toBe(JSON.stringify(parentRequest));
			expect(childRequest).toHaveLength(parentRequest.length + 1);
			expect(getCurrentSystemPrompt(childRequest)).toBe(getCurrentSystemPrompt(parentRequest));
			expect(JSON.stringify(getCurrentTools(childRequest))).toBe(JSON.stringify(getCurrentTools(parentRequest)));
			expect(getCurrentTools(childRequest).map((tool) => tool.name)).toContain("edit");
			const task = childRequest[childRequest.length - 1];
			expect(task.role).toBe("user");
			const taskText = getMessageText(task);
			expect(taskText).toMatch(/^<subagent_instructions>\n/);
			expect(taskText).toContain(AGENT_MARKER);
			expect(taskText).toContain("You can call only these tools: read, bash, write.");
			expect(taskText).toMatch(/<\/subagent_instructions>\n\nSummarize what we read$/);

			const result = toolResults(harness, "subagent")[0];
			expect(getMessageText(result)).toBe("forked answer");
			const run = (result.details as unknown as SubagentDetails).runs[0];
			expect(run).toMatchObject({ context: "fork", status: "done", task: "Summarize what we read" });
			// The child's provider session id is the parent's, so the whole parent prompt is a cache hit.
			expect(parentPromptTokens).toBeGreaterThan(0);
			expect(run.usage.cacheRead).toBe(parentPromptTokens);
		});

		it("blocks the fork child's calls to tools outside the agent's list", async () => {
			const { harness } = await setup();
			let blocked: { text: string; isError: boolean } | undefined;
			let childTools: string[] = [];
			harness.setResponses([
				call("subagent", { agent: "bg", task: "Edit notes.txt", context: "fork" }),
				(context) => {
					childTools = getCurrentTools(context.messages).map((tool) => tool.name);
					return call("edit", { path: "notes.txt", edits: [{ oldText: "foo", newText: "bar" }] });
				},
				(context) => {
					blocked = lastToolResult(context);
					return fauxAssistantMessage("could not edit");
				},
				fauxAssistantMessage("parent done"),
			]);

			await harness.session.prompt("fork an editor");

			expect(childTools).toContain("edit");
			expect(childTools).toContain("subagent");
			expect(blocked).toEqual({
				text: "edit is not one of this agent's tools, so it did not run. Its tools: read, bash, write.",
				isError: true,
			});
			expect(readFileSync(join(harness.tempDir, "notes.txt"), "utf8")).toBe("foo\n");
		});

		it("lets the fork child run the tools in the agent's list", async () => {
			const { harness } = await setup();
			let written: { text: string; isError: boolean } | undefined;
			harness.setResponses([
				call("subagent", { agent: "bg", task: "Write out.txt", context: "fork" }),
				call("write", { path: "out.txt", content: "forked\n" }),
				(context) => {
					written = lastToolResult(context);
					return fauxAssistantMessage("wrote it");
				},
				fauxAssistantMessage("parent done"),
			]);

			await harness.session.prompt("fork a writer");

			expect(written?.isError).toBe(false);
			expect(readFileSync(join(harness.tempDir, "out.txt"), "utf8")).toBe("forked\n");
		});

		it("keeps the parent's planning prompt and tools in a fork child and blocks its changes", async () => {
			const { harness, file } = await setup({ plan: true });
			await harness.session.prompt("/plan");
			let parentRequest: Message[] = [];
			let childRequest: Message[] = [];
			const results: Array<{ text: string; isError: boolean }> = [];
			harness.setResponses([
				(context) => {
					parentRequest = structuredClone(context.messages) as Message[];
					return call("subagent", { agent: "bg", task: "Delete notes.txt", context: "fork" });
				},
				(context) => {
					childRequest = structuredClone(context.messages) as Message[];
					return call("bash", { command: "rm notes.txt" });
				},
				(context) => {
					results.push(lastToolResult(context));
					return call("write", { path: "notes.txt", content: "gone\n" });
				},
				(context) => {
					results.push(lastToolResult(context));
					return fauxAssistantMessage("child done");
				},
				fauxAssistantMessage("parent done"),
			]);

			await harness.session.prompt("delegate");

			expect(JSON.stringify(childRequest.slice(0, parentRequest.length))).toBe(JSON.stringify(parentRequest));
			expect(childRequest).toHaveLength(parentRequest.length + 1);
			expect(getCurrentSystemPrompt(childRequest)).toContain("Plan mode is on.");
			expect(getMessageText(childRequest[childRequest.length - 1])).toContain("you are read-only");
			expect(results).toEqual([
				{
					text: "Plan mode is on in the parent session, so this agent is read-only. This command is not read-only, so it did not run: rm notes.txt",
					isError: true,
				},
				// The parent's planning tools do not declare write, so neither does the child.
				{ text: "Tool write not found", isError: true },
			]);
			expect(readFileSync(file, "utf8")).toBe("foo\n");
			expect((toolResults(harness, "subagent")[0].details as unknown as SubagentDetails).readOnly).toBe(true);
		});
	});

	describe("background runs", () => {
		it("returns a run id at once and delivers the result as a follow-up after the parent's turn", async () => {
			const widget: Array<string[] | undefined> = [];
			const { harness } = await setup({ widget });
			const release = deferred();
			const order: string[] = [];
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Count the files", background: true }),
						(context) => {
							order.push("parent turn ended");
							expect(lastToolResult(context).text).toMatch(/^Started background run sub_[0-9a-f]{6} \(bg\)/);
							return fauxAssistantMessage("started it");
						},
						(context) => {
							order.push("parent saw follow-up");
							const last = context.messages[context.messages.length - 1];
							expect(getMessageText(last)).toContain("background result text");
							return fauxAssistantMessage("got the result");
						},
					],
					[
						async () => {
							await release.promise;
							order.push("child answered");
							return fauxAssistantMessage("background result text");
						},
					],
				),
			);

			await harness.session.prompt("start it");
			expect(order).toEqual(["parent turn ended"]);
			const started = toolResults(harness, "subagent")[0];
			const id = runIdIn(getMessageText(started));
			expect((started.details as unknown as SubagentDetails).background).toEqual({ id, status: "running" });
			await vi.waitFor(() => expect(widget.at(-1)?.[0]).toMatch(new RegExp(`^⏳ subagent ${id} bg · \\d+s`)));

			release.resolve();
			await settle(harness, () => order.length === 3);

			expect(order).toEqual(["parent turn ended", "child answered", "parent saw follow-up"]);
			const [followUp] = followUps(harness);
			expect(followUp.text).toBe(`Background subagent run ${id} done.\n\nbackground result text`);
			expect(followUp.details.background).toEqual({ id, status: "done" });
			expect(followUp.details.runs[0]).toMatchObject({ id, agent: "bg", status: "done" });
			expect(widget.at(-1)).toBeUndefined();
			// No tool result carries a background run's usage, so the session records it.
			const usage = harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");
			expect(usage).toHaveLength(1);
			expect(usage[0]).toMatchObject({ kind: "subagent" });
			expect(harness.getPendingResponseCount()).toBe(0);
		});

		it("reports status while running, and wait returns the result without a follow-up", async () => {
			const { harness } = await setup();
			const release = deferred();
			let status: { text: string; isError: boolean } | undefined;
			let waited: { text: string; isError: boolean } | undefined;
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Slow work", background: true }),
						control("status"),
						(context) => {
							status = lastToolResult(context);
							release.resolve();
							return call("subagent", { action: "wait", id: runIdIn(status.text) });
						},
						(context) => {
							waited = lastToolResult(context);
							return fauxAssistantMessage("parent done");
						},
					],
					[
						async () => {
							await release.promise;
							return fauxAssistantMessage("slow answer");
						},
					],
				),
			);

			await harness.session.prompt("start and wait");
			await harness.session.waitForIdle();

			const id = runIdIn(status?.text ?? "");
			expect(status?.text).toMatch(new RegExp(`^${id}: running, single \\(bg\\), \\d+s\\n- ${id} bg: running$`));
			expect(waited).toEqual({ text: `Background run ${id} done.\n\nslow answer`, isError: false });
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(followUps(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(0);
		});

		it("cancels a run, which ends aborted and sends no follow-up", async () => {
			const { harness } = await setup();
			let childAborted = false;
			let cancelled: { text: string; isError: boolean } | undefined;
			let statusAfter: { text: string; isError: boolean } | undefined;
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Never ends", background: true }),
						control("cancel"),
						(context) => {
							cancelled = lastToolResult(context);
							return call("subagent", { action: "status" });
						},
						(context) => {
							statusAfter = lastToolResult(context);
							return fauxAssistantMessage("parent done");
						},
					],
					[
						async (_context, options) => {
							childAborted = await new Promise<boolean>((resolve) => {
								if (options?.signal?.aborted) return resolve(true);
								options?.signal?.addEventListener("abort", () => resolve(true), { once: true });
								setTimeout(() => resolve(false), 3000);
							});
							return fauxAssistantMessage("too late");
						},
					],
				),
			);

			await harness.session.prompt("start and cancel");
			await harness.session.waitForIdle();

			const id = runIdIn(cancelled?.text ?? "");
			expect(cancelled).toEqual({ text: `Cancelled background run ${id}.`, isError: false });
			expect(childAborted).toBe(true);
			expect(statusAfter?.text).toMatch(new RegExp(`^Background runs:\\n- ${id}: aborted, single \\(bg\\)`));
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(followUps(harness)).toEqual([]);
		});

		it("errors on an unknown run id and on action fields that do not belong together", async () => {
			const { harness } = await setup();
			harness.setResponses([
				call("subagent", { action: "wait", id: "sub_ffffff" }),
				call("subagent", { action: "cancel" }),
				call("subagent", { agent: "bg", task: "x", action: "status" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("bad controls");

			expect(toolResults(harness, "subagent").map((result) => [getMessageText(result), result.isError])).toEqual([
				['No background run "sub_ffffff". There are no background runs.', true],
				['action "cancel" needs the id of a background run.', true],
				["action takes only id. Remove agent, task.", true],
			]);
		});

		it("maps each result to its run id when background and foreground runs overlap", async () => {
			const { harness } = await setup();
			const release = { a: deferred(), b: deferred() };
			const answers: Record<string, string> = {};
			const child: FauxResponseStep = async (context) => {
				const task = getMessageText(context.messages.findLast((message) => message.role === "user"));
				if (task === "task a") await release.a.promise;
				if (task === "task b") await release.b.promise;
				return fauxAssistantMessage(`answer to ${task}`);
			};
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "task a", background: true }),
						(context) => {
							answers.a = runIdIn(lastToolResult(context).text);
							return call("subagent", { agent: "bg", task: "task b", background: true });
						},
						(context) => {
							answers.b = runIdIn(lastToolResult(context).text);
							return call("subagent", { agent: "bg", task: "task c" });
						},
						(context) => {
							answers.c = lastToolResult(context).text;
							release.b.resolve();
							return fauxAssistantMessage("foreground done");
						},
						fauxAssistantMessage("first follow-up handled"),
						fauxAssistantMessage("second follow-up handled"),
					],
					[child, child, child],
				),
			);

			await harness.session.prompt("start three");
			await settle(harness, () => followUps(harness).length === 1);
			release.a.resolve();
			await settle(harness, () => followUps(harness).length === 2);

			expect(answers.c).toBe("answer to task c");
			expect(answers.a).not.toBe(answers.b);
			expect(followUps(harness).map((followUp) => [followUp.details.background?.id, followUp.text])).toEqual([
				[answers.b, `Background subagent run ${answers.b} done.\n\nanswer to task b`],
				[answers.a, `Background subagent run ${answers.a} done.\n\nanswer to task a`],
			]);
			expect(harness.getPendingResponseCount()).toBe(0);
		});

		it("cancels every background run on session shutdown and clears the widget", async () => {
			const widget: Array<string[] | undefined> = [];
			const { harness } = await setup({ widget });
			const aborted: boolean[] = [];
			let reached = 0;
			const waitForAbort: FauxResponseStep = async (_context, options) => {
				reached++;
				aborted.push(
					await new Promise<boolean>((resolve) => {
						if (options?.signal?.aborted) return resolve(true);
						options?.signal?.addEventListener("abort", () => resolve(true), { once: true });
						setTimeout(() => resolve(false), 3000);
					}),
				);
				return fauxAssistantMessage("too late");
			};
			harness.setResponses(
				routed(
					[
						call("subagent", {
							tasks: [
								{ agent: "bg", task: "one" },
								{ agent: "bg", task: "two" },
							],
							background: true,
						}),
						fauxAssistantMessage("started"),
					],
					[waitForAbort, waitForAbort],
				),
			);

			await harness.session.prompt("start two");
			await vi.waitFor(() => expect(widget.at(-1)).toHaveLength(2));
			// Both children are waiting on the provider, so the abort reaches their requests.
			await vi.waitFor(() => expect(reached).toBe(2), { timeout: 5000 });
			const id = runIdIn(getMessageText(toolResults(harness, "subagent")[0]));
			expect(widget.at(-1)?.map((line) => line.split(" · ")[0])).toEqual([
				`⏳ subagent ${id}.1 bg`,
				`⏳ subagent ${id}.2 bg`,
			]);

			const started = Date.now();
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });

			expect(Date.now() - started).toBeLessThan(1500);
			expect(aborted).toEqual([true, true]);
			expect(widget.at(-1)).toBeUndefined();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(followUps(harness)).toEqual([]);
		});

		it("in print mode, waits for background runs before the prompt settles and continues with their results", async () => {
			const harness = await createHarness({ extensionFactories: [builtinSubagent] });
			harnesses.push(harness);
			const agentDir = join(harness.tempDir, "agent");
			vi.stubEnv(ENV_AGENT_DIR, agentDir);
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(join(agentDir, "agents", "bg.md"), BG_AGENT);
			await harness.session.bindExtensions({ mode: "print" });
			const release = deferred();
			const order: string[] = [];
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Slow", background: true }),
						() => {
							order.push("parent turn ended");
							setTimeout(() => release.resolve(), 20);
							return fauxAssistantMessage("started");
						},
						(context) => {
							order.push(`parent saw: ${getMessageText(context.messages[context.messages.length - 1])}`);
							return fauxAssistantMessage("final answer");
						},
					],
					[
						async () => {
							await release.promise;
							return fauxAssistantMessage("slow result");
						},
					],
				),
			);

			await harness.session.prompt("start it");

			const id = runIdIn(getMessageText(toolResults(harness, "subagent")[0]));
			expect(order).toEqual(["parent turn ended", `parent saw: Background subagent run ${id} done.\n\nslow result`]);
			expect(followUps(harness)).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		});

		it("runs a background child read-only while planning", async () => {
			const { harness, file } = await setup({ plan: true });
			await harness.session.prompt("/plan");
			let bash: { text: string; isError: boolean } | undefined;
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Delete notes.txt", background: true }),
						fauxAssistantMessage("started"),
						fauxAssistantMessage("got it"),
					],
					[
						call("bash", { command: "rm notes.txt" }),
						(context) => {
							bash = lastToolResult(context);
							return fauxAssistantMessage("child done");
						},
					],
				),
			);

			await harness.session.prompt("delegate");
			await settle(harness, () => followUps(harness).length === 1);

			expect(bash).toEqual({
				text: "Plan mode is on in the parent session, so this agent is read-only. This command is not read-only, so it did not run: rm notes.txt",
				isError: true,
			});
			expect(readFileSync(file, "utf8")).toBe("foo\n");
			const [followUp] = followUps(harness);
			expect(followUp.details.readOnly).toBe(true);
			expect(followUp.text).toContain("Plan mode is on, so the subagents ran read-only");
		});

		it("holds a running background child to plan mode when planning starts", async () => {
			const { harness, file } = await setup({ plan: true });
			const release = deferred();
			let bash: { text: string; isError: boolean } | undefined;
			let write: { text: string; isError: boolean } | undefined;
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Delete notes.txt", background: true, context: "fork" }),
						fauxAssistantMessage("started"),
						fauxAssistantMessage("got it"),
					],
					[
						async () => {
							await release.promise;
							return call("bash", { command: "rm notes.txt" });
						},
						(context) => {
							bash = lastToolResult(context);
							return call("write", { path: "notes.txt", content: "changed\n" });
						},
						(context) => {
							write = lastToolResult(context);
							return fauxAssistantMessage("child done");
						},
					],
				),
			);

			await harness.session.prompt("delegate");
			await harness.session.prompt("/plan");
			release.resolve();
			await settle(harness, () => followUps(harness).length === 1);

			expect(bash?.isError).toBe(true);
			expect(bash?.text).toContain("This command is not read-only, so it did not run: rm notes.txt");
			expect(write?.isError).toBe(true);
			expect(readFileSync(file, "utf8")).toBe("foo\n");
			const [followUp] = followUps(harness);
			expect(followUp.details.readOnly).toBe(true);
			expect(followUp.text).toContain(
				"Plan mode turned on during this call, so from then on the subagents ran read-only",
			);
		});

		it("stops a running child that plan mode cannot hold read-only", async () => {
			// No plan extension in the child, so nothing could enforce the rules there.
			const { harness, file } = await setup({ extensions: [builtinPlan, builtinSubagent] });
			const release = deferred();
			let childAborted = false;
			harness.setResponses(
				routed(
					[
						call("subagent", { agent: "bg", task: "Delete notes.txt", background: true }),
						fauxAssistantMessage("started"),
						fauxAssistantMessage("got it"),
					],
					[
						async (_context, options) => {
							await release.promise;
							childAborted = options?.signal?.aborted === true;
							return call("bash", { command: "rm notes.txt" });
						},
					],
				),
			);

			await harness.session.prompt("delegate");
			await harness.session.prompt("/plan");
			release.resolve();
			await settle(harness, () => followUps(harness).length === 1);

			expect(childAborted).toBe(true);
			expect(existsSync(file)).toBe(true);
			const [followUp] = followUps(harness);
			expect(followUp.details.runs[0].status).toBe("failed");
			expect(followUp.text).toContain(
				"Plan mode turned on, and this subagent could not be held read-only, so it was stopped.",
			);
		});
	});
});

describe("subagent nesting, aborts, and late starts", () => {
	const harnesses: Harness[] = [];
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	afterEach(async () => {
		for (const harness of harnesses) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		}
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
		process.off("unhandledRejection", onUnhandled);
		unhandled.length = 0;
	});

	const agentFile = (name: string, tools: string) =>
		`---\nname: ${name}\ndescription: ${name}\ntools: ${tools}\n---\n\nYou are the ${name} agent.\n`;

	async function setup(options: {
		mode: "print" | "rpc";
		plan?: boolean;
		widget?: (content: unknown) => void;
		childExtensions?: InlineExtension[];
	}) {
		const harness = await createHarness({
			extensionFactories: options.plan ? [builtinPlan, builtinSubagent] : [builtinSubagent],
			childExtensions: [
				...(options.plan ? [childPlan, childSubagent] : [childSubagent]),
				...(options.childExtensions ?? []),
			],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "bg.md"), BG_AGENT);
		writeFileSync(join(agentDir, "agents", "nester.md"), agentFile("nester", "subagent, read"));
		writeFileSync(join(agentDir, "agents", "leaf.md"), agentFile("leaf", "read, bash"));
		writeFileSync(join(agentDir, "agents", "hanger.md"), agentFile("hanger", "hang"));
		const file = join(harness.tempDir, "notes.txt");
		writeFileSync(file, "foo\n");
		const widget = options.widget;
		await harness.session.bindExtensions(
			options.mode === "print"
				? { mode: "print" }
				: {
						mode: "rpc",
						uiContext: createTestUiContext({
							setWidget: ((key: string, content: unknown) => {
								if (key === FLEET_WIDGET_KEY) widget?.(content);
							}) as never,
						}),
					},
		);
		return { harness, file };
	}

	/** Answer each request from the script of the agent that sent it: nester, leaf, bg, or the parent. */
	function byAgent(
		queues: Record<"parent" | "nester" | "leaf" | "bg", FauxResponseStep[]> & { hanger?: FauxResponseStep[] },
	): FauxResponseStep[] {
		const who = (context: TranscriptContext) => {
			const text = [
				getCurrentSystemPrompt(context.messages),
				...context.messages.flatMap((message) => (message.role === "user" ? [getMessageText(message)] : [])),
			].join("\n");
			for (const name of ["nester", "leaf", "bg", "hanger"] as const)
				if (text.includes(`You are the ${name} agent.`)) return name;
			return "parent";
		};
		const total = Object.values(queues).reduce((sum, queue) => sum + queue.length, 0);
		const step: FauxResponseStep = (context, options, state, model) => {
			const name = who(context);
			const next = queues[name]?.shift();
			if (!next) throw new Error(`No scripted ${name} response left`);
			return typeof next === "function" ? next(context, options, state, model) : next;
		};
		return Array.from({ length: total }, () => step);
	}

	/** A response that waits until the request is aborted, then fails. Sets `state.aborted`. */
	function untilAborted(state: { reached: boolean; aborted: boolean }): FauxResponseStep {
		return (_context, options) =>
			new Promise((_resolve, reject) => {
				state.reached = true;
				const abort = () => {
					state.aborted = true;
					reject(new Error("aborted"));
				};
				if (options?.signal?.aborted) return abort();
				options?.signal?.addEventListener("abort", abort, { once: true });
			});
	}

	async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			promise.then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
		clearTimeout(timer);
		return result;
	}

	it("a subagent does not wait for its own background runs, which end with it", async () => {
		const { harness } = await setup({ mode: "print" });
		const leaf = { reached: false, aborted: false };
		let started: { text: string; isError: boolean } | undefined;
		harness.setResponses(
			byAgent({
				parent: [call("subagent", { agent: "nester", task: "nest" }), fauxAssistantMessage("parent done")],
				nester: [
					call("subagent", { agent: "leaf", task: "forever", background: true }),
					(context) => {
						started = lastToolResult(context);
						return fauxAssistantMessage("nester done");
					},
				],
				leaf: [untilAborted(leaf)],
				bg: [],
			}),
		);

		const prompt = harness.session.prompt("start");
		const settled = await settlesWithin(prompt, 4000);
		if (!settled) await harness.session.abort();

		expect(settled).toBe(true);
		expect(leaf).toEqual({ reached: true, aborted: true });
		expect(started?.text).toContain("You are a subagent, so the run is cancelled when you finish");
		expect(getMessageText(toolResults(harness, "subagent")[0])).toBe("nester done");
	});

	it("in print mode, aborting while the prompt waits for background runs settles at once", async () => {
		const { harness } = await setup({ mode: "print" });
		const child = { reached: false, aborted: false };
		let parentDone = false;
		harness.setResponses(
			byAgent({
				parent: [
					call("subagent", { agent: "bg", task: "forever", background: true }),
					() => {
						parentDone = true;
						return fauxAssistantMessage("started");
					},
				],
				nester: [],
				leaf: [],
				bg: [untilAborted(child)],
			}),
		);

		const prompt = harness.session.prompt("start");
		await vi.waitFor(() => expect(parentDone && child.reached).toBe(true), { timeout: 5000 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		void harness.session.abort();
		const settled = await settlesWithin(prompt, 2000);

		expect(settled).toBe(true);
		// Escape does not cancel background runs; the session's end does.
		expect(child.aborted).toBe(false);
		expect(followUps(harness)).toEqual([]);
	});

	it("does not start a queued child after the session ended, when its context is stale", async () => {
		process.on("unhandledRejection", onUnhandled);
		const release = deferred();
		let hanging = 0;
		// A tool that ignores aborts, so its run outlives the shutdown wait.
		const hang: InlineExtension = {
			name: "hang",
			builtin: true,
			factory: (pi) => {
				pi.registerTool({
					name: "hang",
					label: "hang",
					description: "Hangs",
					parameters: Type.Object({}),
					execute: async () => {
						hanging++;
						await release.promise;
						return { content: [{ type: "text", text: "done" }], details: {} };
					},
				});
			},
		};
		const { harness } = await setup({ mode: "rpc", childExtensions: [hang] });
		harness.setResponses(
			byAgent({
				parent: [
					call("subagent", {
						tasks: Array.from({ length: 5 }, (_, index) => ({ agent: "hanger", task: `task ${index}` })),
						background: true,
					}),
					fauxAssistantMessage("started"),
				],
				nester: [],
				leaf: [],
				bg: [],
				hanger: Array.from({ length: 5 }, () => call("hang", {})),
			}),
		);

		await harness.session.prompt("start five");
		await vi.waitFor(() => expect(hanging).toBe(4), { timeout: 5000 });
		// What a reload does: the session ends, then its extension contexts go stale.
		const runner = harness.session.extensionRunner;
		await emitSessionShutdownEvent(runner, { type: "session_shutdown", reason: "reload" });
		runner.invalidate();
		// Every use of a stale ctx goes through this check, which throws.
		const staleUses = vi.spyOn(runner as unknown as { assertActive(): void }, "assertActive");
		release.resolve();
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(hanging).toBe(4);
		expect(staleUses.mock.results.filter((result) => result.type === "throw")).toEqual([]);
		expect(unhandled).toEqual([]);
	});

	it("fails a queued fork child whose call is no longer on the branch instead of forking everything", async () => {
		const { harness } = await setup({ mode: "rpc" });
		const release = deferred();
		let followUp = "";
		harness.setResponses(
			routed(
				[
					call("subagent", {
						chain: [
							{ agent: "bg", task: "step one", context: "fork" },
							{ agent: "bg", task: "step two", context: "fork" },
						],
						background: true,
					}),
					fauxAssistantMessage("started"),
					(context) => {
						followUp = getMessageText(context.messages[context.messages.length - 1]);
						return fauxAssistantMessage("got it");
					},
				],
				[
					async () => {
						await release.promise;
						return fauxAssistantMessage("one");
					},
					fauxAssistantMessage("two"),
				],
			),
		);

		await harness.session.prompt("delegate");
		// As /tree does: move to the user message, before the assistant message that made the call.
		const user = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!user) throw new Error("No user entry");
		harness.sessionManager.branch(user.id);
		release.resolve();
		await vi.waitFor(() => expect(followUps(harness)).toHaveLength(1), { timeout: 5000 });
		await harness.session.waitForIdle();

		const [result] = followUps(harness);
		expect(result.details.runs.map((run) => run.status)).toEqual(["done", "failed"]);
		expect(result.text).toContain(
			"Chain stopped at step 2 of 2 (agent bg failed): Cannot fork: the message that made tool call",
		);
		expect(followUp).toContain("is no longer in this session's context");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("holds a running grandchild read-only when plan mode holds its parent subagent", async () => {
		const { harness, file } = await setup({ mode: "rpc", plan: true });
		const release = deferred();
		let leafRunning = false;
		let bash: { text: string; isError: boolean } | undefined;
		harness.setResponses(
			byAgent({
				parent: [
					call("subagent", { agent: "nester", task: "nest", background: true }),
					fauxAssistantMessage("started"),
					fauxAssistantMessage("got it"),
				],
				nester: [
					call("subagent", { agent: "leaf", task: "delete notes.txt" }),
					fauxAssistantMessage("nester done"),
				],
				leaf: [
					async () => {
						leafRunning = true;
						await release.promise;
						return call("bash", { command: "rm notes.txt" });
					},
					(context) => {
						bash = lastToolResult(context);
						return fauxAssistantMessage("leaf done");
					},
				],
				bg: [],
			}),
		);

		await harness.session.prompt("delegate");
		await vi.waitFor(() => expect(leafRunning).toBe(true), { timeout: 5000 });
		await harness.session.prompt("/plan");
		release.resolve();
		await vi.waitFor(() => expect(followUps(harness)).toHaveLength(1), { timeout: 5000 });
		await harness.session.waitForIdle();

		expect(bash?.isError).toBe(true);
		expect(bash?.text).toContain("This command is not read-only, so it did not run: rm notes.txt");
		expect(readFileSync(file, "utf8")).toBe("foo\n");
	});

	it("records the usage of a subagent's background run in the top-level session", async () => {
		const { harness } = await setup({ mode: "rpc" });
		harness.setResponses(
			byAgent({
				parent: [
					call("subagent", { agent: "nester", task: "nest", background: true }),
					fauxAssistantMessage("started"),
					fauxAssistantMessage("got it"),
				],
				nester: [
					call("subagent", { agent: "leaf", task: "work", background: true }),
					control("wait"),
					fauxAssistantMessage("nester done"),
				],
				leaf: [fauxAssistantMessage("leaf done")],
				bg: [],
			}),
		);

		await harness.session.prompt("delegate");
		await vi.waitFor(() => expect(followUps(harness)).toHaveLength(1), { timeout: 5000 });
		await harness.session.waitForIdle();

		expect(followUps(harness)[0].text).toContain("nester done");
		// Three nester responses and the leaf's one.
		const usage = harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");
		expect(usage).toHaveLength(4);
		const [nester] = followUps(harness)[0].details.runs;
		const total = usage.reduce((sum, entry) => sum + (entry.type === "usage" ? entry.usage.totalTokens : 0), 0);
		expect(nester.usage.totalTokens).toBe(total);
	});

	it("a wait call whose turn is aborted as the run ends returns the result once", async () => {
		let waiting = false;
		let cleared = 0;
		let aborted = false;
		let harnessRef: Harness | undefined;
		const { harness } = await setup({
			mode: "rpc",
			// The widget clears when the child ends, then again when the run's outcome is recorded. Then
			// abort the turn that waits for the run, before the wait call resumes.
			widget: (content) => {
				if (!waiting || aborted || content !== undefined || ++cleared < 2) return;
				aborted = true;
				void harnessRef?.session.abort();
			},
		});
		harnessRef = harness;
		const release = deferred();
		harness.setResponses(
			routed(
				[
					call("subagent", { agent: "bg", task: "Slow", background: true }),
					control("wait", () => {
						waiting = true;
						setTimeout(() => release.resolve(), 20);
					}),
				],
				[
					async () => {
						await release.promise;
						return fauxAssistantMessage("slow answer");
					},
				],
			),
		);

		await harness.session.prompt("start and wait");
		await harness.session.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(aborted).toBe(true);
		// The aborted turn keeps the wait call's result, so no follow-up repeats it.
		const id = runIdIn(getMessageText(toolResults(harness, "subagent")[0]));
		expect(getMessageText(toolResults(harness, "subagent")[1])).toBe(`Background run ${id} done.\n\nslow answer`);
		expect(followUps(harness)).toEqual([]);
	});
});

describe("isInsideDirectory", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
	});

	function tree() {
		const root = mkdtempSync(join(tmpdir(), "pi-subagent-cwd-"));
		dirs.push(root);
		const session = join(root, "project");
		mkdirSync(join(session, "..dots"), { recursive: true });
		mkdirSync(join(session, "sub"), { recursive: true });
		mkdirSync(join(root, "outside"));
		symlinkSync(join(root, "outside"), join(session, "link-out"));
		return { root, session };
	}

	it("accepts the directory itself and directories below it, including one named ..dots", () => {
		const { session } = tree();
		expect(isInsideDirectory(session, session)).toBe(true);
		expect(isInsideDirectory(session, join(session, "sub"))).toBe(true);
		expect(isInsideDirectory(session, join(session, "..dots"))).toBe(true);
	});

	it("rejects the parent directory and a symlink that points outside", () => {
		const { root, session } = tree();
		expect(isInsideDirectory(session, root)).toBe(false);
		expect(isInsideDirectory(session, join(session, ".."))).toBe(false);
		expect(isInsideDirectory(session, join(root, "outside"))).toBe(false);
		expect(isInsideDirectory(session, join(session, "link-out"))).toBe(false);
	});
});
