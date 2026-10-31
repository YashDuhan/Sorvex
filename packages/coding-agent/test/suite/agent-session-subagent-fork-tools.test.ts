import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	type JsonObject,
	type TranscriptContext,
} from "@sorvex/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, InlineExtension } from "../../src/core/extensions/types.ts";
import { BUILTIN_SUBAGENT_PATH } from "../../src/extensions/plan/state.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

// A fork child declares every tool its parent declares. Only the tools its agent's `tools` list lets it
// activate may run, from the model and from other tools alike, as in a fresh child.

const NARROW_AGENT = `---
name: narrow
description: Narrow helper
tools: read, probe
---

You are the narrow agent.
`;

/** Tool names the `probe` tool was asked to call, and which of them ran. */
const ran: string[] = [];

/** Tools of an MCP server and a `probe` tool that calls another tool, as a codemode script does. */
function tools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "mcp__fake__mark",
		label: "mark",
		description: "Writes a marker",
		parameters: Type.Object({}),
		execute: async () => {
			ran.push("mcp__fake__mark");
			return { content: [{ type: "text", text: "marked" }], details: {} };
		},
	});
	pi.registerTool({
		name: "mcp__fake__lookup",
		label: "lookup",
		description: "Looks something up; only for scripts",
		parameters: Type.Object({}),
		exposure: "codemode",
		execute: async () => {
			ran.push("mcp__fake__lookup");
			return { content: [{ type: "text", text: "found" }], details: {} };
		},
	});
	pi.registerTool({
		name: "probe",
		label: "probe",
		description: "Calls another tool",
		parameters: Type.Object({ name: Type.String() }),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const callable = ctx.tools.map((tool) => tool.name).sort();
			const outcome = await ctx.executeTool(params.name, params.name === "write" ? { path: "x", content: "" } : {});
			const text = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			return {
				content: [{ type: "text", text: JSON.stringify({ isError: outcome.isError, text, callable }) }],
				details: {},
			};
		},
	});
}

const childTools: InlineExtension = { name: "fake", factory: tools, builtin: true };
const builtinSubagent = { path: BUILTIN_SUBAGENT_PATH, factory: subagentExtension };

function call(name: string, args: JsonObject) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function lastToolResult(context: TranscriptContext): { text: string; isError: boolean } {
	const result = context.messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("No tool result in the context");
	return { text: getMessageText(result), isError: result.isError };
}

describe("fork child tool limits", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		for (const harness of harnesses) {
			await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		}
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
		ran.length = 0;
	});

	async function setup() {
		const harness = await createHarness({
			extensionFactories: [builtinSubagent, tools],
			childExtensions: [childTools],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "narrow.md"), NARROW_AGENT);
		await harness.session.bindExtensions({ mode: "print" });
		return harness;
	}

	/** Run the `narrow` agent with `context` and have it call `step`; return what the child saw. */
	async function runChild(context: "fresh" | "fork", step: FauxResponseStep) {
		const harness = await setup();
		let result: { text: string; isError: boolean } | undefined;
		let declared: string[] = [];
		harness.setResponses([
			call("subagent", { agent: "narrow", task: "go", context }),
			(transcript, options, state, model) => {
				declared = getCurrentTools(transcript.messages).map((tool) => tool.name);
				return typeof step === "function" ? step(transcript, options, state, model) : step;
			},
			(transcript) => {
				result = lastToolResult(transcript);
				return fauxAssistantMessage("child done");
			},
			fauxAssistantMessage("parent done"),
		]);
		await harness.session.prompt("delegate");
		expect(harness.getPendingResponseCount()).toBe(0);
		return { result, declared };
	}

	async function probe(context: "fresh" | "fork", name: string) {
		const { result, declared } = await runChild(context, call("probe", { name }));
		if (!result) throw new Error("The child saw no tool result");
		return { ...(JSON.parse(result.text) as { isError: boolean; text: string; callable: string[] }), declared };
	}

	it("blocks a nested call to a declared direct MCP tool outside the agent's list, as a fresh child does", async () => {
		const fork = await probe("fork", "mcp__fake__mark");
		const forkRan = [...ran];
		ran.length = 0;
		const fresh = await probe("fresh", "mcp__fake__mark");

		expect(fork.declared).toContain("mcp__fake__mark");
		expect(fork.isError).toBe(true);
		expect(fork.text).toBe(fresh.text);
		expect(fork.text).toContain("mcp__fake__mark");
		expect(fork.callable).toEqual(fresh.callable);
		expect(fork.callable).not.toContain("mcp__fake__mark");
		expect(forkRan).toEqual([]);
		expect(ran).toEqual([]);
	});

	it("blocks a nested call to a declared built-in tool outside the agent's list, as a fresh child does", async () => {
		const fork = await probe("fork", "write");
		const fresh = await probe("fresh", "write");

		expect(fork.declared).toContain("write");
		expect(fork.isError).toBe(true);
		expect(fork.text).toBe(fresh.text);
		expect(fork.callable).not.toContain("write");
	});

	it("still runs a nested call to a codemode-only MCP tool, as a fresh child does", async () => {
		const fork = await probe("fork", "mcp__fake__lookup");
		const fresh = await probe("fresh", "mcp__fake__lookup");

		expect(fork).toMatchObject({ isError: false, text: "found" });
		expect(fresh).toMatchObject({ isError: false, text: "found" });
		expect(fork.callable).toEqual(fresh.callable);
		expect(ran).toEqual(["mcp__fake__lookup", "mcp__fake__lookup"]);
	});

	it("blocks a top-level call to a declared MCP tool outside the agent's list", async () => {
		const { result, declared } = await runChild("fork", call("mcp__fake__mark", {}));

		expect(declared).toContain("mcp__fake__mark");
		expect(result).toEqual({
			text: "mcp__fake__mark is not one of this agent's tools, so it did not run. Its tools: read, probe.",
			isError: true,
		});
		expect(ran).toEqual([]);
	});
});
