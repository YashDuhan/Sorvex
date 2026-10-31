import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type JsonObject,
} from "@sorvex/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../src/config.ts";
import { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/types.ts";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";
import { MAX_CONCURRENCY } from "../../src/extensions/subagent/request.ts";
import type { SubagentDetails } from "../../src/extensions/subagent/run.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const HELPER_AGENT = `---
name: helper
description: Answers delegated questions
tools: read, subagent
model: child-model
unknownField: ignored
---

You are the helper agent.
`;

interface ChildRequest {
	systemPrompt: string;
	tools: string[];
	model: string;
}

function delegate(agent: string, task: string) {
	return fauxAssistantMessage(fauxToolCall("subagent", { agent, task }), { stopReason: "toolUse" });
}

describe("built-in subagent extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: { childExtensions?: InlineExtension[]; extensionFactories?: InlineExtension[] } = {},
	): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: options.extensionFactories ?? [subagentExtension],
			childExtensions: options.childExtensions,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "helper.md"), HELPER_AGENT);
		await harness.session.bindExtensions({ uiContext: createTestUiContext() });
		return harness;
	}

	const childSubagent: InlineExtension = { name: "subagent", factory: subagentExtension, builtin: true };

	function toolResultText(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
	}

	function subagentDetails(harness: Harness): SubagentDetails {
		return getToolResult(harness, "subagent").details as unknown as SubagentDetails;
	}

	it("runs the child with the agent's prompt, tools, and model, and returns its answer to the parent", async () => {
		const harness = await setup();
		const childRequests: ChildRequest[] = [];
		const childAnswer: FauxResponseStep = (context, _options, _state, model) => {
			childRequests.push({
				systemPrompt: getCurrentSystemPrompt(context.messages),
				tools: getCurrentTools(context.messages).map((tool) => tool.name),
				model: model.id,
			});
			return fauxAssistantMessage("The answer is 42.");
		};
		harness.setResponses([delegate("helper", "What is the answer?"), childAnswer, fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask the helper");

		expect(childRequests).toHaveLength(1);
		expect(childRequests[0].systemPrompt).toContain("You are the helper agent.");
		expect(childRequests[0].tools).toEqual(["read"]);
		expect(childRequests[0].model).toBe("child-model");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "The answer is 42." }]);
		const [run] = subagentDetails(harness).runs;
		expect(run).toMatchObject({ agent: "helper", source: "user", status: "done", turns: 1 });
		expect(run.model).toBe(`${harness.getModel().provider}/child-model`);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("aborts the child when the parent tool call is aborted", async () => {
		const harness = await setup();
		let childSignalAborted = false;
		const childWaitsForAbort: FauxResponseStep = async (_context, options) => {
			void harness.session.abort();
			childSignalAborted = await new Promise<boolean>((resolve) => {
				if (options?.signal?.aborted) return resolve(true);
				options?.signal?.addEventListener("abort", () => resolve(true), { once: true });
				setTimeout(() => resolve(false), 2000);
			});
			return fauxAssistantMessage("too late");
		};
		harness.setResponses([delegate("helper", "Wait forever"), childWaitsForAbort]);

		await harness.session.prompt("Ask the helper");

		expect(childSignalAborted).toBe(true);
		const end = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "subagent");
		expect((end?.result.details as SubagentDetails).runs[0].status).toBe("aborted");
	});

	it("errors on an unknown agent and lists the available agents", async () => {
		const harness = await setup();
		harness.setResponses([delegate("nobody", "Anything"), fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask nobody");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		expect(text).toContain('Unknown agent "nobody"');
		expect(text).toContain("helper (user): Answers delegated questions");
		expect(text).toContain("scout (builtin)");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	/** A child step that answers with the task it was given, after an optional delay. */
	function echoTask(onTask: (task: string) => void = () => {}, delayMs = 0): FauxResponseStep {
		return async (context) => {
			const task = getMessageText(context.messages.findLast((message) => message.role === "user"));
			onTask(task);
			if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
			return fauxAssistantMessage(`Answer to ${task}`);
		};
	}

	function resultText(harness: Harness): string {
		return getMessageText(getToolResult(harness, "subagent"));
	}

	function callWith(args: JsonObject) {
		return fauxAssistantMessage(fauxToolCall("subagent", args), { stopReason: "toolUse" });
	}

	it("runs parallel tasks and returns every answer with the combined usage", async () => {
		const harness = await setup();
		const tasks = [
			{ agent: "helper", task: "alpha" },
			{ agent: "worker", task: "beta" },
		];
		harness.setResponses([callWith({ tasks }), echoTask(), echoTask(), fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask two agents");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(false);
		const text = resultText(harness);
		expect(text).toContain("Parallel: 2/2 succeeded");
		expect(text).toContain("### [helper] done\n\nAnswer to alpha");
		expect(text).toContain("### [worker] done\n\nAnswer to beta");
		const { kind, runs } = subagentDetails(harness);
		expect(kind).toBe("parallel");
		expect(runs.map((run) => [run.agent, run.status, run.output])).toEqual([
			["helper", "done", "Answer to alpha"],
			["worker", "done", "Answer to beta"],
		]);
		expect(runs[0].usage.totalTokens).toBeGreaterThan(0);
		expect(result.usage?.totalTokens).toBe(runs[0].usage.totalTokens + runs[1].usage.totalTokens);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("runs at most MAX_CONCURRENCY parallel children at a time", async () => {
		const harness = await setup();
		let active = 0;
		let peak = 0;
		const child: FauxResponseStep = async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 30));
			active--;
			return fauxAssistantMessage("ok");
		};
		const count = MAX_CONCURRENCY + 2;
		const tasks = Array.from({ length: count }, (_, index) => ({ agent: "helper", task: `task ${index}` }));
		harness.setResponses([callWith({ tasks }), ...tasks.map(() => child), fauxAssistantMessage("done")]);

		await harness.session.prompt("Fan out");

		expect(peak).toBe(MAX_CONCURRENCY);
		expect(subagentDetails(harness).runs.every((run) => run.status === "done")).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("aborts every parallel child when the parent is aborted", async () => {
		const harness = await setup();
		const waitForAbort: FauxResponseStep = async (_context, options) => {
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) return resolve();
				options?.signal?.addEventListener("abort", () => resolve(), { once: true });
				setTimeout(resolve, 2000);
			});
			return fauxAssistantMessage("too late");
		};
		let started = 0;
		const abortWhenBothStarted: FauxResponseStep = async (context, options, state, model) => {
			if (++started === 2) void harness.session.abort();
			return (waitForAbort as FauxResponseFactory)(context, options, state, model);
		};
		const tasks = [
			{ agent: "helper", task: "one" },
			{ agent: "helper", task: "two" },
		];
		harness.setResponses([callWith({ tasks }), abortWhenBothStarted, abortWhenBothStarted]);

		await harness.session.prompt("Fan out");

		const end = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "subagent");
		expect(end?.isError).toBe(true);
		const runs = (end?.result.details as SubagentDetails).runs;
		expect(runs.map((run) => run.status)).toEqual(["aborted", "aborted"]);
	});

	it("runs a chain in order and threads each answer into the next task", async () => {
		const harness = await setup();
		const seen: string[] = [];
		const chain = [
			{ agent: "helper", task: "first" },
			{ agent: "helper", task: "second, given {previous}" },
		];
		harness.setResponses([
			callWith({ chain }),
			echoTask((task) => seen.push(task)),
			echoTask((task) => seen.push(task)),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Chain two agents");

		expect(seen).toEqual(["first", "second, given Answer to first"]);
		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(resultText(harness)).toBe("Answer to second, given Answer to first");
		expect(subagentDetails(harness).runs.map((run) => run.task)).toEqual(["first", "second, given Answer to first"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("stops a chain at the first failed step", async () => {
		const harness = await setup();
		const chain = [
			{ agent: "helper", task: "first" },
			{ agent: "helper", task: "second {previous}" },
		];
		harness.setResponses([
			callWith({ chain }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "child exploded" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Chain two agents");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		expect(resultText(harness)).toBe("Chain stopped at step 1 of 2 (agent helper failed): child exploded");
		expect(subagentDetails(harness).runs.map((run) => run.status)).toEqual(["failed", "pending"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("rejects a call that gives two modes before running any child", async () => {
		const harness = await setup();
		harness.setResponses([
			callWith({ agent: "helper", task: "x", tasks: [{ agent: "helper", task: "y" }] }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Confuse the tool");

		expect(getToolResult(harness, "subagent").isError).toBe(true);
		expect(resultText(harness)).toContain("Provide exactly one mode");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("errors when the agent names a model that does not exist", async () => {
		const harness = await setup();
		writeFileSync(
			join(harness.tempDir, "agent", "agents", "lost.md"),
			"---\nname: lost\ndescription: Lost\nmodel: missing-model\n---\n\nPrompt.\n",
		);
		harness.setResponses([delegate("lost", "Anything"), fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask lost");

		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: 'Agent "lost" model "missing-model" was not found.' }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
	it("gives a depth-1 child the subagent tool and a depth-2 child none", async () => {
		const harness = await setup({ childExtensions: [childSubagent] });
		const toolsByDepth: string[][] = [];
		const record =
			(next: FauxResponseStep): FauxResponseStep =>
			(context, options, state, model) => {
				toolsByDepth.push(getCurrentTools(context.messages).map((tool) => tool.name));
				return typeof next === "function" ? next(context, options, state, model) : next;
			};
		harness.setResponses([
			delegate("helper", "Delegate again"),
			record(delegate("helper", "Answer")),
			record(fauxAssistantMessage("grandchild answer")),
			fauxAssistantMessage("child answer"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Nest");

		expect(toolsByDepth).toEqual([["read", "subagent"], ["read"]]);
		expect(toolResultText(getToolResult(harness, "subagent"))).toBe("child answer");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps only the subagent call and result in the parent transcript", async () => {
		const harness = await setup();
		let parentContext = "";
		harness.setResponses([
			delegate("helper", "Look around"),
			fauxAssistantMessage(fauxToolCall("read", { path: "child-only.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("child answer"),
			(context) => {
				parentContext = JSON.stringify(context.messages.map((message) => message.content));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("Ask the helper");

		const shape = harness.session.messages.map((message) =>
			message.role === "toolResult" ? `toolResult:${message.toolName}` : message.role,
		);
		expect(shape).toEqual(["system", "user", "assistant", "toolResult:subagent", "assistant"]);
		expect(getToolResult(harness, "subagent").content).toEqual([{ type: "text", text: "child answer" }]);
		expect(parentContext).toContain("child answer");
		expect(parentContext).not.toContain("child-only.txt");
	});

	it("keeps parent and child extension actions in their own sessions", async () => {
		let parentPi: ExtensionAPI | undefined;
		const parentProbe: InlineExtension = (pi) => {
			parentPi = pi;
		};
		const childEntries: string[][] = [];
		const childProbe: InlineExtension = (pi) => {
			pi.on("session_start", () => {
				pi.appendEntry("child-probe", {});
			});
			pi.on("session_shutdown", (_event, ctx) => {
				childEntries.push(
					ctx.sessionManager
						.getEntries()
						.map((entry) => (entry.type === "custom" ? entry.customType : entry.type)),
				);
			});
		};
		const harness = await setup({
			extensionFactories: [subagentExtension, parentProbe],
			childExtensions: [childProbe],
		});
		const childStep: FauxResponseStep = () => {
			parentPi?.appendEntry("parent-probe", {});
			parentPi?.sendMessage({ customType: "parent-message", content: "for the parent", display: false });
			return fauxAssistantMessage("child answer");
		};
		harness.setResponses([delegate("helper", "Probe"), childStep, fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask the helper");

		const parentTypes = harness.sessionManager
			.getEntries()
			.map((entry) => (entry.type === "custom" ? entry.customType : entry.type));
		expect(parentTypes).toContain("parent-probe");
		expect(parentTypes).not.toContain("child-probe");
		expect(JSON.stringify(harness.sessionManager.getEntries())).toContain("parent-message");
		expect(childEntries).toHaveLength(1);
		expect(childEntries[0]).toContain("child-probe");
		expect(childEntries[0]).not.toContain("parent-probe");
		expect(childEntries[0]).not.toContain("custom_message");
	});

	describe("child working directory trust", () => {
		const outsideDirs: string[] = [];
		afterEach(() => {
			while (outsideDirs.length > 0) rmSync(outsideDirs.pop() as string, { recursive: true, force: true });
		});

		async function childTrust(harness: Harness, cwd: string): Promise<boolean | undefined> {
			let trusted: boolean | undefined;
			trustProbeTarget = (value) => {
				trusted = value;
			};
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { agent: "helper", task: "t", cwd }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("child answer"),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Run elsewhere");
			return trusted;
		}

		let trustProbeTarget: (trusted: boolean) => void = () => {};
		const trustProbe: InlineExtension = (pi) => {
			pi.on("session_start", (_event, ctx) => trustProbeTarget(ctx.isProjectTrusted()));
		};

		function outsideDir(): string {
			const dir = mkdtempSync(join(tmpdir(), "pi-subagent-outside-"));
			outsideDirs.push(dir);
			return dir;
		}

		function writePrefixSettings(dir: string): void {
			mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(
				join(dir, CONFIG_DIR_NAME, "settings.json"),
				JSON.stringify({ shellCommandPrefix: "echo PREFIX-RAN" }),
			);
		}

		/** The output of a `bash` call by a child in `cwd`, which shows whether the child read cwd's settings. */
		async function childBashOutput(harness: Harness, cwd: string): Promise<string> {
			writeFileSync(
				join(harness.tempDir, "agent", "agents", "runner.md"),
				"---\nname: runner\ndescription: Runs commands\ntools: bash\n---\n\nRun it.\n",
			);
			let bashOutput = "";
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("subagent", { agent: "runner", task: "t", cwd }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo child-ran" }), { stopReason: "toolUse" }),
				(context) => {
					const last = context.messages[context.messages.length - 1];
					bashOutput = last.role === "toolResult" ? JSON.stringify(last.content) : "";
					return fauxAssistantMessage("child answer");
				},
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("Run elsewhere");
			return bashOutput;
		}

		it("does not extend a trusted parent's trust to an unrelated directory", async () => {
			const harness = await setup({ childExtensions: [trustProbe] });
			harness.settingsManager.setProjectTrusted(true);
			const inside = join(harness.tempDir, "sub");
			mkdirSync(inside);
			const outside = outsideDir();
			writePrefixSettings(outside);

			expect(await childTrust(harness, harness.tempDir)).toBe(true);
			expect(await childTrust(harness, inside)).toBe(true);
			expect(await childTrust(harness, outside)).toBe(false);
			new ProjectTrustStore(join(harness.tempDir, "agent")).set(outside, true);
			expect(await childTrust(harness, outside)).toBe(true);
		});

		it("gives an untrusted parent's directory no trust", async () => {
			const harness = await setup({ childExtensions: [trustProbe] });
			harness.settingsManager.setProjectTrusted(false);
			expect(await childTrust(harness, harness.tempDir)).toBe(false);
		});

		it("ignores an unrelated directory's project settings", async () => {
			const harness = await setup();
			harness.settingsManager.setProjectTrusted(true);
			const outside = outsideDir();
			writePrefixSettings(outside);

			const bashOutput = await childBashOutput(harness, outside);

			expect(bashOutput).toContain("child-ran");
			expect(bashOutput).not.toContain("PREFIX-RAN");
		});

		it("ignores a nested project's settings when the parent's trust was not a saved decision (H1)", async () => {
			const harness = await setup();
			// Trust without a saved decision, as for a directory without trust-requiring resources.
			harness.settingsManager.setProjectTrusted(true);
			const nested = join(harness.tempDir, "sub");
			writePrefixSettings(nested);

			const bashOutput = await childBashOutput(harness, nested);

			expect(bashOutput).toContain("child-ran");
			expect(bashOutput).not.toContain("PREFIX-RAN");
		});

		it("reads a nested project's settings under a saved trust decision for the parent, as the CLI does (H1)", async () => {
			const harness = await setup();
			harness.settingsManager.setProjectTrusted(true);
			new ProjectTrustStore(join(harness.tempDir, "agent")).set(harness.tempDir, true);
			const nested = join(harness.tempDir, "sub");
			writePrefixSettings(nested);

			const bashOutput = await childBashOutput(harness, nested);

			expect(bashOutput).toContain("PREFIX-RAN");
		});
	});

	it("loads the built-in extensions in a child, so it can call an MCP tool", async () => {
		const harness = await setup({ childExtensions: builtInExtensions });
		const agentDir = join(harness.tempDir, "agent");
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
		writeFileSync(
			join(agentDir, "agents", "echoer.md"),
			"---\nname: echoer\ndescription: Calls MCP\ntools: mcp__echo__echo_upper\n---\n\nEcho.\n",
		);
		let childToolResult = "";
		harness.setResponses([
			delegate("echoer", "Echo hello"),
			fauxAssistantMessage(fauxToolCall("mcp__echo__echo_upper", { text: "hello child" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				const last = context.messages[context.messages.length - 1];
				childToolResult = last.role === "toolResult" ? JSON.stringify(last.content) : "";
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Echo through a child");

		expect(childToolResult).toContain("HELLO CHILD");
		expect(subagentDetails(harness).runs[0].status).toBe("done");
	});

	it("declines MCP elicitation in a child and does not run a task that names an MCP prompt command", async () => {
		const harness = await setup({ childExtensions: builtInExtensions });
		const agentDir = join(harness.tempDir, "agent");
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
		writeFileSync(
			join(agentDir, "agents", "asker.md"),
			"---\nname: asker\ndescription: Asks through MCP\ntools: mcp__echo__ask\n---\n\nAsk.\n",
		);
		let childTask = "";
		let childToolResult = "";
		harness.setResponses([
			delegate("asker", "/mcp__echo__greet"),
			(context) => {
				childTask = getMessageText(context.messages.findLast((message) => message.role === "user"));
				return fauxAssistantMessage(fauxToolCall("mcp__echo__ask", {}), { stopReason: "toolUse" });
			},
			(context) => {
				const last = context.messages[context.messages.length - 1];
				childToolResult = last.role === "toolResult" ? JSON.stringify(last.content) : "";
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Ask through a child");

		expect(childTask).toBe("/mcp__echo__greet");
		expect(childToolResult).toContain('\\"action\\":\\"decline\\"');
		expect(subagentDetails(harness).runs[0].status).toBe("done");
	});
	it("keeps the parent's provider when a child's extension registers the same one", async () => {
		const parentProvider = fauxProvider({ provider: "shared-provider", models: [{ id: "shared-model" }] }).provider;
		const childProviders: unknown[] = [];
		const harness = await setup({
			extensionFactories: [subagentExtension, (pi) => pi.registerProvider(parentProvider)],
			childExtensions: [
				(pi) => {
					const provider = fauxProvider({
						provider: "shared-provider",
						models: [{ id: "shared-model" }],
					}).provider;
					childProviders.push(provider);
					pi.registerProvider(provider);
				},
			],
		});
		harness.setResponses([
			delegate("helper", "Anything"),
			fauxAssistantMessage("child answer"),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Ask the helper");

		expect(childProviders).toHaveLength(1);
		expect(harness.session.extensionRunner.getModelRegistry().getRegisteredNativeProvider("shared-provider")).toBe(
			parentProvider,
		);
	});

	it("does not start the child's turn when the parent aborts while the child's prompt is being prepared (M1)", async () => {
		let parent: Harness | undefined;
		const slowInput: InlineExtension = (pi) => {
			pi.on("input", async () => {
				void parent?.session.abort();
				await new Promise((resolve) => setTimeout(resolve, 50));
				return { action: "continue" };
			});
		};
		const harness = await setup({ childExtensions: [slowInput] });
		parent = harness;
		let childCalled = false;
		harness.setResponses([
			delegate("helper", "Anything"),
			(context) => {
				childCalled = getCurrentSystemPrompt(context.messages).includes("You are the helper agent.");
				return fauxAssistantMessage("child ran");
			},
		]);

		await harness.session.prompt("Ask the helper");

		expect(childCalled).toBe(false);
		const end = harness.eventsOfType("tool_execution_end").find((event) => event.toolName === "subagent");
		expect((end?.result.details as SubagentDetails).runs[0].status).toBe("aborted");
	});

	it("gives an agent without a tools list only read, grep, find, and ls (M3)", async () => {
		const harness = await setup({ childExtensions: [childSubagent] });
		writeFileSync(
			join(harness.tempDir, "agent", "agents", "plain.md"),
			"---\nname: plain\ndescription: No tools list\n---\n\nPlain.\n",
		);
		let childTools: string[] = [];
		harness.setResponses([
			delegate("plain", "Anything"),
			(context) => {
				childTools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Ask plain");

		expect(childTools.sort()).toEqual(["find", "grep", "ls", "read"]);
	});

	it("appends the agent's prompt to the default system prompt (L1)", async () => {
		const harness = await setup();
		let childPrompt = "";
		harness.setResponses([
			delegate("helper", "Anything"),
			(context) => {
				childPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("child answer");
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Ask the helper");

		expect(childPrompt).toContain("You are an expert coding assistant operating inside Sorvex");
		expect(childPrompt).toContain("You are the helper agent.");
		expect(childPrompt).toContain("<cwd>");
	});

	it("shuts a child down when its setup fails (L2)", async () => {
		let childShutdowns = 0;
		const childProbe: InlineExtension = (pi) => {
			pi.on("session_shutdown", () => {
				childShutdowns++;
			});
		};
		const harness = await setup({ childExtensions: [childProbe] });
		const bind = AgentSession.prototype.bindExtensions;
		vi.spyOn(AgentSession.prototype, "bindExtensions").mockImplementation(async function (
			this: AgentSession,
			bindings,
		) {
			if (this === harness.session) return bind.call(this, bindings);
			throw new Error("child setup failed");
		});
		harness.setResponses([delegate("helper", "Anything"), fauxAssistantMessage("done")]);

		await harness.session.prompt("Ask the helper");

		expect(toolResultText(getToolResult(harness, "subagent"))).toContain("child setup failed");
		expect(childShutdowns).toBe(1);
	});

	it("does not leave a rejected child abort unhandled (L3)", async () => {
		const harness = await setup();
		const abort = AgentSession.prototype.abort;
		// Not vi.spyOn: the spy observes the returned promise, which marks its rejection handled.
		AgentSession.prototype.abort = async function (this: AgentSession) {
			await abort.call(this);
			if (this !== harness.session) throw new Error("child abort failed");
		};
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			harness.setResponses([
				delegate("helper", "Wait"),
				async (_context, options) => {
					void harness.session.abort();
					await new Promise<void>((resolve) => {
						if (options?.signal?.aborted) return resolve();
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("too late");
				},
			]);

			await harness.session.prompt("Ask the helper");
			await new Promise((resolve) => setTimeout(resolve, 20));
		} finally {
			AgentSession.prototype.abort = abort;
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});
});
