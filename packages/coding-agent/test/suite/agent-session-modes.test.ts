import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@sorvex/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../../src/core/extensions/types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import modesExtension from "../../src/extensions/modes/index.ts";
import { MODE_ENTRY, MODE_EVENT } from "../../src/extensions/modes/state.ts";
import planExtension from "../../src/extensions/plan/index.ts";
import { BUILTIN_PLAN_PATH, BUILTIN_SUBAGENT_PATH } from "../../src/extensions/plan/state.ts";
import subagentExtension from "../../src/extensions/subagent/index.ts";
import todoExtension from "../../src/extensions/todo/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult, type Harness } from "./harness.ts";

const SECURITY_AGENTS = ["triage", "recon", "auditor", "redteam", "hardener"];

const PLANNING_TOOLS = ["bash", "exit_plan_mode", "read", "todo"];
const NORMAL_TOOLS = ["bash", "edit", "read", "todo", "write"];

describe("built-in modes", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.unstubAllEnvs();
	});

	async function setup(
		options: {
			ui?: Partial<ExtensionUIContext>;
			agentMode?: string;
			planFlag?: boolean;
			modesFirst?: boolean;
			plan?: boolean;
			subagent?: boolean;
			sessionManager?: SessionManager;
		} = {},
	) {
		const modeEvents: unknown[] = [];
		const probe: ExtensionFactory = (pi) => {
			pi.events.on(MODE_EVENT, (mode) => modeEvents.push(mode));
		};
		const extensionFactories: Array<ExtensionFactory | { path: string; factory: ExtensionFactory }> = [
			probe,
			todoExtension,
		];
		if (options.subagent) extensionFactories.push({ path: BUILTIN_SUBAGENT_PATH, factory: subagentExtension });
		if (options.modesFirst) extensionFactories.push(modesExtension);
		if (options.plan !== false) extensionFactories.push({ path: BUILTIN_PLAN_PATH, factory: planExtension });
		if (!options.modesFirst) extensionFactories.push(modesExtension);
		const harness = await createHarness({ extensionFactories, sessionManager: options.sessionManager });
		harnesses.push(harness);
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		if (options.agentMode) harness.session.extensionRunner.setFlagValue("agent-mode", options.agentMode);
		if (options.planFlag) harness.session.extensionRunner.setFlagValue("plan", true);
		const statuses = new Map<string, string | undefined>();
		const notices: string[] = [];
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				setStatus: (key, text) => statuses.set(key, text),
				notify: (message) => notices.push(message),
				...options.ui,
			}),
		});
		const footer = () => [statuses.get("plan"), statuses.get("mode")].filter(Boolean).join(",");
		return { harness, footer, notices, modeEvents };
	}

	const activeTools = (harness: Harness) => harness.session.getActiveToolNames().sort();

	async function sections(harness: Harness) {
		let captured: Record<string, string | null | undefined> = {};
		harness.setResponses([
			(context) => {
				captured = getCurrentSystemMessage(context.messages)?.sections ?? {};
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("go");
		return captured;
	}

	it("starts in build mode with an empty footer and no mode section", async () => {
		const { harness, footer } = await setup();
		expect(footer()).toBe("");
		const captured = await sections(harness);
		expect(captured.security_mode).toBeUndefined();
		expect(captured.plan_mode).toBeUndefined();
	});

	it("turns security mode on with /security, keeps every tool, and adds the security section", async () => {
		const { harness, footer } = await setup();
		await harness.session.prompt("/security");
		expect(footer()).toBe("security");
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
		expect((await sections(harness)).security_mode).toMatch(/^<security_mode>\nSecurity mode is on\./);

		await harness.session.prompt("/security");
		expect(footer()).toBe("");
		expect((await sections(harness)).security_mode).toBeUndefined();
	});

	it("switches between build, plan, and security with /mode, one mode at a time", async () => {
		const { harness, footer } = await setup();
		await harness.session.prompt("/mode security");
		expect(footer()).toBe("security");

		await harness.session.prompt("/mode plan");
		expect(footer()).toBe("plan");
		expect(activeTools(harness)).toEqual(PLANNING_TOOLS);
		const planning = await sections(harness);
		expect(planning.plan_mode).toBeDefined();
		expect(planning.security_mode).toBeUndefined();

		await harness.session.prompt("/mode security");
		expect(footer()).toBe("security");
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);

		await harness.session.prompt("/mode build");
		expect(footer()).toBe("");
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
	});

	it("ends security mode when /plan turns plan mode on", async () => {
		const { harness, footer } = await setup();
		await harness.session.prompt("/security");
		await harness.session.prompt("/plan");
		expect(footer()).toBe("plan");
		expect((await sections(harness)).security_mode).toBeUndefined();
	});

	it("cycles build, plan, security with app.mode.cycle", async () => {
		const { harness, footer } = await setup();
		const runner = harness.session.extensionRunner;
		const cycle = runner.getShortcuts({ "app.mode.cycle": "ctrl+alt+n" }).get("ctrl+alt+n");
		if (!cycle) throw new Error("Missing shortcut");
		const seen: string[] = [];
		for (let index = 0; index < 3; index++) {
			await cycle.handler(runner.createContext());
			seen.push(footer() || "build");
		}
		expect(seen).toEqual(["plan", "security", "build"]);
		expect(activeTools(harness)).toEqual(NORMAL_TOOLS);
	});

	it("reports plan mode as unavailable when the built-in plan extension is not loaded", async () => {
		const { harness, footer, notices } = await setup({ plan: false });
		await harness.session.prompt("/mode plan");
		expect(footer()).toBe("");
		expect(notices.at(-1)).toBe("Plan mode is not available: the built-in plan extension is not loaded.");
	});

	it("starts in the mode --agent-mode names and records it once", async () => {
		const { harness, footer } = await setup({ agentMode: "security" });
		expect(footer()).toBe("security");
		const entries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === MODE_ENTRY);
		expect(entries.map((entry) => entry.type === "custom" && entry.data)).toEqual([{ mode: "security" }]);
	});

	it("picks a mode from the /mode selector", async () => {
		const { harness, footer } = await setup({
			ui: { select: async (_title, options) => options.find((option) => option.startsWith("security")) },
		});
		await harness.session.prompt("/mode");
		expect(footer()).toBe("security");
	});

	it("restores security mode when the session is resumed", async () => {
		const first = await setup();
		await first.harness.session.prompt("/mode security");
		const resumed = await setup({ sessionManager: first.harness.sessionManager });
		expect(resumed.footer()).toBe("security");
		expect((await sections(resumed.harness)).security_mode).toBeDefined();
	});

	for (const modesFirst of [false, true]) {
		it(`starts in plan mode, not security, when a security session resumes with --plan${modesFirst ? " (modes loads first)" : ""}`, async () => {
			const first = await setup({ agentMode: "security", modesFirst });
			const resumed = await setup({ sessionManager: first.harness.sessionManager, planFlag: true, modesFirst });
			expect(resumed.footer()).toBe("plan");
			expect(resumed.modeEvents).toEqual(modesFirst ? ["security", "plan"] : ["plan"]);
			expect((await sections(resumed.harness)).security_mode).toBeUndefined();

			await resumed.harness.session.prompt("/plan");
			expect(resumed.footer()).toBe("");
			expect((await sections(resumed.harness)).security_mode).toBeUndefined();
			const again = await setup({ sessionManager: first.harness.sessionManager, modesFirst });
			expect(again.footer()).toBe("");
		});
	}

	it("emits mode:change once for the starting mode and once for each change", async () => {
		const { harness, modeEvents } = await setup({
			ui: { select: async (_title, options) => options.find((option) => option === "Approve and start") },
		});
		const runner = harness.session.extensionRunner;
		const cycle = runner.getShortcuts({ "app.mode.cycle": "ctrl+alt+n" }).get("ctrl+alt+n");
		if (!cycle) throw new Error("Missing shortcut");
		const steps: Array<[string, () => unknown]> = [
			["build->plan (cycle)", () => cycle.handler(runner.createContext())],
			["plan->security (cycle)", () => cycle.handler(runner.createContext())],
			["security->build (cycle)", () => cycle.handler(runner.createContext())],
			["build->plan (/mode)", () => harness.session.prompt("/mode plan")],
			["plan->build (/mode)", () => harness.session.prompt("/mode build")],
			["build->build (/mode)", () => harness.session.prompt("/mode build")],
			["build->security (/security)", () => harness.session.prompt("/security")],
			["security->plan (/plan)", () => harness.session.prompt("/plan")],
			["plan->build (/plan)", () => harness.session.prompt("/plan")],
			["build->plan (/plan)", () => harness.session.prompt("/plan")],
			["plan->security (/mode)", () => harness.session.prompt("/mode security")],
			["security->build (/security)", () => harness.session.prompt("/security")],
			[
				"plan->build (exit_plan_mode)",
				async () => {
					await harness.session.prompt("/plan");
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("exit_plan_mode", { plan: "1. Do it" }), { stopReason: "toolUse" }),
						fauxAssistantMessage("starting"),
					]);
					await harness.session.prompt("plan it");
				},
			],
		];
		const seen: Array<[string, unknown[]]> = [["startup", modeEvents.splice(0)]];
		for (const [name, step] of steps) {
			await step();
			seen.push([name, modeEvents.splice(0)]);
		}
		expect(seen).toEqual([
			["startup", ["build"]],
			["build->plan (cycle)", ["plan"]],
			["plan->security (cycle)", ["security"]],
			["security->build (cycle)", ["build"]],
			["build->plan (/mode)", ["plan"]],
			["plan->build (/mode)", ["build"]],
			["build->build (/mode)", []],
			["build->security (/security)", ["security"]],
			["security->plan (/plan)", ["plan"]],
			["plan->build (/plan)", ["build"]],
			["build->plan (/plan)", ["plan"]],
			["plan->security (/mode)", ["security"]],
			["security->build (/security)", ["build"]],
			["plan->build (exit_plan_mode)", ["plan", "build"]],
		]);
	});

	it("emits mode:change when the session tree changes the mode", async () => {
		const { harness, modeEvents } = await setup();
		await harness.session.prompt("/mode security");
		harness.setResponses([fauxAssistantMessage("auditing")]);
		await harness.session.prompt("first");
		const securityLeaf = harness.sessionManager.getLeafId();
		await harness.session.prompt("/mode plan");
		harness.setResponses([fauxAssistantMessage("planning")]);
		await harness.session.prompt("second");
		const planLeaf = harness.sessionManager.getLeafId();
		if (!securityLeaf || !planLeaf) throw new Error("Missing leaves");
		modeEvents.splice(0);

		await harness.session.navigateTree(securityLeaf);
		expect(modeEvents.splice(0)).toEqual(["security"]);
		await harness.session.navigateTree(planLeaf);
		expect(modeEvents.splice(0)).toEqual(["plan"]);
	});

	it("follows the branch when navigating the session tree", async () => {
		const { harness, footer } = await setup();
		await harness.session.prompt("/mode security");
		harness.setResponses([fauxAssistantMessage("auditing")]);
		await harness.session.prompt("first");
		const securityLeaf = harness.sessionManager.getLeafId();
		await harness.session.prompt("/mode build");
		harness.setResponses([fauxAssistantMessage("building")]);
		await harness.session.prompt("second");
		const buildLeaf = harness.sessionManager.getLeafId();
		if (!securityLeaf || !buildLeaf) throw new Error("Missing leaves");

		await harness.session.navigateTree(securityLeaf);
		expect(footer()).toBe("security");
		await harness.session.navigateTree(buildLeaf);
		expect(footer()).toBe("");
	});

	it("binds app.mode.cycle to its configured keys", async () => {
		const { harness, footer } = await setup();
		const runner = harness.session.extensionRunner;
		expect([...runner.getShortcuts({ "app.mode.cycle": "ctrl+alt+n" }).keys()]).toContain("ctrl+alt+n");
		const rebound = runner.getShortcuts({ "app.mode.cycle": "alt+m" });
		expect([...rebound.keys()]).toContain("alt+m");
		expect([...rebound.keys()]).not.toContain("ctrl+alt+n");
		expect(runner.getShortcutDiagnostics().filter((d) => d.message.includes("app.mode.cycle"))).toEqual([]);
		await rebound.get("alt+m")?.handler(runner.createContext());
		expect(footer()).toBe("plan");
	});

	it("lists the security agents in /agents and names them in the security section", async () => {
		const { harness, notices } = await setup({ subagent: true });
		await harness.session.prompt("/agents");
		for (const agent of SECURITY_AGENTS) expect(notices.at(-1)).toContain(agent);

		await harness.session.prompt("/mode security");
		expect((await sections(harness)).security_mode).toContain("redteam builds proofs of concept");
	});

	it("runs a security agent with its prompt and tools", async () => {
		const { harness } = await setup({ subagent: true });
		await harness.session.prompt("/mode security");
		let child: { prompt: string; tools: string[] } | undefined;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "auditor", task: "Audit src" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				child = {
					prompt: getCurrentSystemPrompt(context.messages),
					tools: getCurrentTools(context.messages)
						.map((tool) => tool.name)
						.sort(),
				};
				return fauxAssistantMessage("no findings");
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("audit");

		expect(child?.prompt).toContain("You are a code auditor.");
		expect(child?.tools).toEqual(["find", "grep", "ls", "read"]);
		const result = getToolResult(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("no findings");
	});
});
