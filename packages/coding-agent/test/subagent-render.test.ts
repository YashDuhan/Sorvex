import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentDiscovery } from "../src/extensions/subagent/agents.ts";
import { fleetLines } from "../src/extensions/subagent/fleet-widget.ts";
import { formatAgentList, renderSubagentCall, renderSubagentResult } from "../src/extensions/subagent/render.ts";
import type { SubagentKind } from "../src/extensions/subagent/request.ts";
import { type ChildRun, EMPTY_USAGE, type SubagentDetails } from "../src/extensions/subagent/run.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function run(overrides: Partial<ChildRun>): ChildRun {
	return {
		id: "sub_000001",
		startedAt: 0,
		context: "fresh",
		agent: "scout",
		source: "builtin",
		task: "Summarize fixture.txt",
		status: "done",
		output: "Line one\nLine two\nLine three\nLine four",
		usage: { ...EMPTY_USAGE, input: 1200, output: 300 },
		turns: 2,
		model: "faux/child",
		toolCalls: [{ name: "read", summary: "fixture.txt" }],
		...overrides,
	};
}

function renderRuns(kind: SubagentKind, runs: ChildRun[], expanded: boolean, readOnly = false): string {
	return renderSubagentResult({ kind, runs, readOnly }, "", expanded, theme).render(100).map(stripAnsi).join("\n");
}

function render(child: ChildRun, expanded: boolean): string {
	return renderRuns("single", [child], expanded);
}

describe("subagent result rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("collapses to tool calls, the first output lines, and usage", () => {
		const text = render(run({}), false);
		expect(text).toContain("✓ scout (builtin)");
		expect(text).toContain("→ read fixture.txt");
		expect(text).toContain("Line three");
		expect(text).not.toContain("Line four");
		expect(text).toContain("2 turns ↑1.2k ↓300 faux/child");
	});

	it("shows the task and the whole output when expanded", () => {
		const text = render(run({}), true);
		expect(text).toContain("Summarize fixture.txt");
		expect(text).toContain("Line four");
	});

	it("marks a failed run and shows its error", () => {
		const text = render(run({ status: "failed", output: "rate limited" }), false);
		expect(text).toContain("✗ scout (builtin) [failed]");
		expect(text).toContain("rate limited");
	});

	it("shows every parallel run, a done count, and the combined usage", () => {
		const runs = [
			run({ agent: "scout" }),
			run({ agent: "reviewer", status: "failed", output: "rate limited" }),
			run({ agent: "worker", status: "pending", output: "", turns: 0, usage: EMPTY_USAGE, toolCalls: [] }),
		];
		const text = renderRuns("parallel", runs, false);
		expect(text).toContain("parallel: 1/3 done, 1 failed");
		expect(text).toContain("✓ scout (builtin)");
		expect(text).toContain("✗ reviewer (builtin) [failed]");
		expect(text).toContain("· worker (builtin)");
		expect(text).toContain("(not started)");
		expect(text).toContain("Line one");
		expect(text).not.toContain("Line two");
		expect(text).toContain("Total: 4 turns ↑2.4k ↓600");
	});

	it("marks runs made while planning as read-only", () => {
		expect(render(run({}), false)).not.toContain("read-only");
		expect(
			renderRuns("single", [run({})], false, true)
				.split("\n")[0]
				.trimEnd(),
		).toBe("read-only (plan mode)");
		expect(
			renderRuns("parallel", [run({}), run({})], false, true)
				.split("\n")[0]
				.trimEnd(),
		).toBe("read-only (plan mode)");
	});

	it("numbers chain steps and shows the full output when expanded", () => {
		const text = renderRuns("chain", [run({ agent: "scout" }), run({ agent: "planner" })], true);
		expect(text).toContain("Step 1");
		expect(text).toContain("Step 2");
		expect(text).toContain("planner (builtin)");
		expect(text).toContain("Line four");
	});
});

describe("subagent call rendering", () => {
	beforeAll(() => initTheme("dark"));

	const renderCall = (args: Parameters<typeof renderSubagentCall>[0]) =>
		renderSubagentCall(args, theme).render(100).map(stripAnsi).join("\n");

	it("lists parallel tasks", () => {
		const text = renderCall({
			tasks: [
				{ agent: "scout", task: "Find auth" },
				{ agent: "reviewer", task: "Review" },
			],
		});
		expect(text).toContain("subagent parallel (2 tasks)");
		expect(text).toContain("scout Find auth");
		expect(text).toContain("reviewer Review");
	});

	it("numbers chain steps and hides the previous placeholder", () => {
		const text = renderCall({
			chain: [
				{ agent: "scout", task: "Find auth" },
				{ agent: "planner", task: "Plan from {previous}" },
			],
		});
		expect(text).toContain("subagent chain (2 steps)");
		expect(text).toContain("2. planner Plan from");
		expect(text).not.toContain("{previous}");
	});

	it("marks fork tasks and background calls, and shows actions with their run id", () => {
		const renderCall = (args: Parameters<typeof renderSubagentCall>[0]) =>
			renderSubagentCall(args, theme)
				.render(100)
				.map((line) => stripAnsi(line).trimEnd())
				.join("\n");
		expect(renderCall({ agent: "worker", task: "Fix it", context: "fork", background: true })).toBe(
			"subagent worker (fork) in background\n  Fix it",
		);
		expect(renderCall({ tasks: [{ agent: "scout", task: "Look", context: "fork" }], background: true })).toContain(
			"subagent parallel (1 tasks) in background\n  scout (fork) Look",
		);
		expect(renderCall({ action: "wait", id: "sub_abc123" })).toBe("subagent wait sub_abc123");
		expect(renderCall({ action: "status" })).toBe("subagent status");
	});
});

describe("background run rendering", () => {
	beforeAll(() => initTheme("dark"));

	const renderDetails = (details: SubagentDetails) =>
		renderSubagentResult(details, "fallback", false, theme)
			.render(100)
			.map((line) => stripAnsi(line).trimEnd())
			.join("\n");

	it("shows only the run id for the call that starts a run", () => {
		const text = renderDetails({
			kind: "single",
			runs: [run({ status: "pending", context: "fork" })],
			readOnly: false,
			background: { id: "sub_abc123", status: "running" },
		});
		expect(text).toBe("background run sub_abc123 started");
	});

	it("shows a follow-up's status and runs", () => {
		const text = renderDetails({
			kind: "single",
			runs: [run({ output: "worker result" })],
			readOnly: false,
			background: { id: "sub_abc123", status: "done" },
		});
		expect(text).toContain("background run sub_abc123 done");
		expect(text).toContain("✓ scout (builtin)");
		expect(text).toContain("worker result");
	});

	it("shows the runs under the action for a wait", () => {
		const text = renderDetails({
			kind: "single",
			runs: [run({ context: "fork" })],
			readOnly: false,
			background: { id: "sub_abc123", status: "done", action: "wait" },
		});
		expect(text).toContain("background run sub_abc123 wait: done");
		expect(text).toContain("✓ scout (builtin, fork)");
	});
});

describe("fleetLines", () => {
	it("lists only running children with their id, agent, elapsed time, and tokens", () => {
		const now = 200_000;
		const lines = fleetLines(
			[
				run({
					id: "sub_a",
					status: "running",
					startedAt: now - 12_400,
					usage: { ...EMPTY_USAGE, totalTokens: 1500 },
				}),
				run({ id: "sub_b.1", status: "running", startedAt: now - 75_000, context: "fork", usage: EMPTY_USAGE }),
				run({ id: "sub_b.2", status: "done" }),
				run({ id: "sub_b.3", status: "pending" }),
			],
			now,
		);
		expect(lines).toEqual([
			"⏳ subagent sub_a scout · 12s · 1.5k tokens",
			"⏳ subagent sub_b.1 scout (fork) · 1m15s",
		]);
	});
});

describe("formatAgentList", () => {
	const discovery: AgentDiscovery = {
		agents: [
			{ name: "scout", description: "Recon", systemPrompt: "", source: "builtin" },
			{ name: "helper", description: "Helps", systemPrompt: "", source: "user", filePath: "/u/agents/helper.md" },
			{
				name: "local",
				description: "Local",
				systemPrompt: "",
				source: "project",
				filePath: "/p/.sorvex/agents/local.md",
			},
		],
		diagnostics: [],
		userAgentsDir: "/u/agents",
		projectAgentsDir: "/p/.sorvex/agents",
	};

	it("groups agents by source with descriptions and file paths", () => {
		expect(formatAgentList(discovery, true)).toBe(
			[
				"Built-in agents",
				"  scout: Recon",
				"",
				"User agents (/u/agents)",
				"  helper: Helps",
				"    /u/agents/helper.md",
				"",
				"Project agents (/p/.sorvex/agents)",
				"  local: Local",
				"    /p/.sorvex/agents/local.md",
			].join("\n"),
		);
	});

	it("notes empty sources, and omits a missing project directory", () => {
		const text = formatAgentList({ ...discovery, agents: [], projectAgentsDir: undefined }, true);
		expect(text).toContain("User agents (/u/agents)\n  (none)");
		expect(text).not.toContain("Project agents");
	});

	it("says an untrusted project's agents were not read, without listing any", () => {
		const untrusted: AgentDiscovery = {
			...discovery,
			agents: discovery.agents.filter((agent) => agent.source !== "project"),
			projectAgentsDir: undefined,
		};
		const text = formatAgentList(untrusted, false);
		expect(text).toContain("Project agents: not read, because the project is not trusted.");
		expect(text).not.toContain("local");
	});

	it("lists skipped agent files with the reason", () => {
		const text = formatAgentList(
			{ ...discovery, diagnostics: [{ path: "/u/agents/bad.md", message: "frontmatter has no name" }] },
			true,
		);
		expect(text).toContain("Skipped agent files\n  /u/agents/bad.md: frontmatter has no name");
	});

	it("shortens only paths inside the home directory to ~ (L6)", () => {
		vi.stubEnv("HOME", "/home/u");
		try {
			const text = formatAgentList(
				{
					...discovery,
					agents: [],
					userAgentsDir: "/home/u/.sorvex/agent/agents",
					projectAgentsDir: "/home/user2/p/.sorvex/agents",
				},
				true,
			);
			expect(text).toContain("User agents (~/.sorvex/agent/agents)");
			expect(text).toContain("Project agents (/home/user2/p/.sorvex/agents)");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
