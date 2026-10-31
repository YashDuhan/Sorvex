import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@sorvex/ai";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../../src/config.ts";
import subagentExtension from "../../../src/extensions/subagent/index.ts";
import { createHarness, createTestUiContext, getMessageText } from "../harness.ts";

interface RunOptions {
	trusted: boolean;
	confirmResult?: boolean;
}

async function runProjectAgent(options: RunOptions): Promise<{ confirmCalls: number; toolResult: string }> {
	const harness = await createHarness({ extensionFactories: [subagentExtension] });
	const confirm = vi.fn(async () => options.confirmResult ?? false);

	try {
		vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
		const agentsDir = join(harness.tempDir, CONFIG_DIR_NAME, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "project-agent.md"),
			"---\nname: project-agent\ndescription: Project test agent\n---\n\nHandle the delegated task.\n",
		);
		harness.settingsManager.setProjectTrusted(options.trusted);

		await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui" });

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("subagent", {
					agent: "project-agent",
					task: "Test project trust",
					cwd: join(harness.tempDir, "missing-cwd"),
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delegate this task");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		return {
			confirmCalls: confirm.mock.calls.length,
			toolResult: getMessageText(toolResult),
		};
	} finally {
		harness.cleanup();
	}
}

describe("regression #8261: subagent project trust", () => {
	it("skips per-call confirmation for trusted projects", async () => {
		const result = await runProjectAgent({ trusted: true });

		expect(result.confirmCalls).toBe(0);
		expect(result.toolResult).not.toContain("Canceled:");
		expect(result.toolResult).toContain("Working directory does not exist");
	});

	it("never asks about or starts an untrusted project's agents in a parallel call", async () => {
		const harness = await createHarness({ extensionFactories: [subagentExtension] });
		const confirm = vi.fn(async (_title: string, _message: string) => true);
		try {
			vi.stubEnv(ENV_AGENT_DIR, join(harness.tempDir, "agent"));
			const agentsDir = join(harness.tempDir, CONFIG_DIR_NAME, "agents");
			mkdirSync(agentsDir, { recursive: true });
			for (const name of ["alpha", "beta"]) {
				writeFileSync(
					join(agentsDir, `${name}.md`),
					`---\nname: ${name}\ndescription: ${name} agent\n---\n\nPrompt.\n`,
				);
			}
			harness.settingsManager.setProjectTrusted(false);
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ confirm }), mode: "tui" });
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("subagent", {
						tasks: [
							{ agent: "scout", task: "one" },
							{ agent: "alpha", task: "two" },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("Delegate this task");

			expect(confirm).not.toHaveBeenCalled();
			const toolResult = getMessageText(harness.session.messages.find((message) => message.role === "toolResult"));
			expect(toolResult).toContain('Unknown agent "alpha"');
			expect(toolResult).not.toContain("beta");
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("does not offer an untrusted project's agents at all", async () => {
		const result = await runProjectAgent({ trusted: false, confirmResult: true });

		expect(result.confirmCalls).toBe(0);
		expect(result.toolResult).toContain('Unknown agent "project-agent"');
		expect(result.toolResult).not.toContain("Project test agent");
	});
});
