import { describe, expect, it } from "vitest";
import {
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	parseSubagentCall,
	parseSubagentParams,
	substitutePrevious,
	type TaskSpec,
} from "../src/extensions/subagent/request.ts";
import { mapWithConcurrencyLimit } from "../src/extensions/subagent/run.ts";

const spec = (agent: string): TaskSpec => ({ agent, task: `task for ${agent}` });

describe("parseSubagentParams", () => {
	it("parses single mode", () => {
		expect(parseSubagentParams({ agent: "scout", task: "Look", cwd: "sub" })).toEqual({
			kind: "single",
			agent: "scout",
			task: "Look",
			cwd: "sub",
		});
	});

	it("parses parallel mode", () => {
		expect(parseSubagentParams({ tasks: [spec("a"), spec("b")] })).toEqual({
			kind: "parallel",
			tasks: [spec("a"), spec("b")],
		});
	});

	it("parses chain mode", () => {
		expect(parseSubagentParams({ chain: [spec("a"), spec("b")] })).toEqual({
			kind: "chain",
			steps: [spec("a"), spec("b")],
		});
	});

	it("rejects no mode", () => {
		expect(() => parseSubagentParams({})).toThrow("Provide exactly one mode");
	});

	it("rejects two modes, counting any single-mode field", () => {
		expect(() => parseSubagentParams({ tasks: [spec("a")], chain: [spec("b")] })).toThrow("more than one");
		expect(() => parseSubagentParams({ agent: "scout", tasks: [spec("a")] })).toThrow("more than one");
		expect(() => parseSubagentParams({ cwd: "sub", chain: [spec("a")] })).toThrow("more than one");
	});

	it("rejects single mode without a task", () => {
		expect(() => parseSubagentParams({ agent: "scout" })).toThrow("Single mode needs both agent and task.");
	});

	it("rejects empty tasks and chain", () => {
		expect(() => parseSubagentParams({ tasks: [] })).toThrow("tasks is empty");
		expect(() => parseSubagentParams({ chain: [] })).toThrow("chain is empty");
	});

	it("rejects more than the maximum number of parallel tasks", () => {
		const tasks = Array.from({ length: MAX_PARALLEL_TASKS }, (_, index) => spec(`a${index}`));
		expect(parseSubagentParams({ tasks }).kind).toBe("parallel");
		expect(() => parseSubagentParams({ tasks: [...tasks, spec("extra")] })).toThrow(
			`Too many parallel tasks (${MAX_PARALLEL_TASKS + 1}). Max is ${MAX_PARALLEL_TASKS}.`,
		);
	});

	it("rejects a chain longer than 8 steps (L5)", () => {
		const chain = Array.from({ length: 8 }, (_, index) => spec(`a${index}`));
		expect(MAX_CHAIN_STEPS).toBe(8);
		expect(parseSubagentParams({ chain }).kind).toBe("chain");
		expect(() => parseSubagentParams({ chain: [...chain, spec("extra")] })).toThrow(
			"Too many chain steps (9). Max is 8.",
		);
	});
});

describe("parseSubagentCall", () => {
	it("parses a run, in the background only when asked, with each task's context", () => {
		expect(parseSubagentCall({ agent: "scout", task: "Look", context: "fork" })).toEqual({
			type: "run",
			request: { kind: "single", agent: "scout", task: "Look", context: "fork" },
			background: false,
		});
		const tasks: TaskSpec[] = [{ ...spec("a"), context: "fork" }, spec("b")];
		expect(parseSubagentCall({ tasks, background: true })).toEqual({
			type: "run",
			request: { kind: "parallel", tasks },
			background: true,
		});
	});

	it("counts context as a single-mode field", () => {
		expect(() => parseSubagentCall({ context: "fork", tasks: [spec("a")] })).toThrow("more than one");
	});

	it("parses actions, with status listing every run when it has no id", () => {
		expect(parseSubagentCall({ action: "status" })).toEqual({ type: "control", action: "status", id: undefined });
		expect(parseSubagentCall({ action: "wait", id: "sub_1" })).toEqual({
			type: "control",
			action: "wait",
			id: "sub_1",
		});
		expect(parseSubagentCall({ action: "cancel", id: "sub_1" })).toEqual({
			type: "control",
			action: "cancel",
			id: "sub_1",
		});
	});

	it("rejects wait and cancel without an id, an action with run fields, and an id without an action", () => {
		expect(() => parseSubagentCall({ action: "wait" })).toThrow('action "wait" needs the id of a background run.');
		expect(() => parseSubagentCall({ action: "status", tasks: [spec("a")], background: true })).toThrow(
			"action takes only id. Remove tasks, background.",
		);
		expect(() => parseSubagentCall({ agent: "scout", task: "Look", id: "sub_1" })).toThrow("id goes with action");
	});
});

describe("substitutePrevious", () => {
	it("replaces every placeholder", () => {
		expect(substitutePrevious("Review {previous}, then fix {previous}", "the diff")).toBe(
			"Review the diff, then fix the diff",
		);
	});

	it("keeps replacement patterns in the previous output literal", () => {
		expect(substitutePrevious("Got: {previous}", "cost $& and $1")).toBe("Got: cost $& and $1");
	});

	it("leaves a task without the placeholder unchanged", () => {
		expect(substitutePrevious("Plain task", "ignored")).toBe("Plain task");
	});
});

describe("mapWithConcurrencyLimit", () => {
	it("keeps at most limit calls in flight and returns results in input order", async () => {
		let active = 0;
		let peak = 0;
		const results = await mapWithConcurrencyLimit([30, 10, 20, 5, 15], 2, async (delay, index) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, delay));
			active--;
			return index;
		});
		expect(peak).toBe(2);
		expect(results).toEqual([0, 1, 2, 3, 4]);
	});
});
