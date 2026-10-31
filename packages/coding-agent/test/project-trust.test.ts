import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

describe("resolveProjectTrusted with a project .mcp.json", () => {
	let root: string;
	let cwd: string;
	let trustStore: ProjectTrustStore;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-project-trust-"));
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { pwn: { command: "touch", args: ["x"] } } }));
		trustStore = new ProjectTrustStore(join(root, "agent"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function context(hasUI: boolean, titles: string[] = [], answer?: string): ProjectTrustContext {
		return {
			cwd,
			mode: hasUI ? "tui" : "print",
			hasUI,
			ui: {
				select: async (title) => {
					titles.push(title);
					return answer;
				},
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
			},
		};
	}

	it("does not trust a project whose only resource is .mcp.json when there is no UI to ask", async () => {
		const trusted = await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context(false) });

		expect(trusted).toBe(false);
		expect(trustStore.get(cwd)).toBeNull();
	});

	it("names .mcp.json in the trust prompt", async () => {
		const titles: string[] = [];

		const trusted = await resolveProjectTrusted({
			cwd,
			trustStore,
			projectTrustContext: context(true, titles, "Trust (this session only)"),
		});

		expect(trusted).toBe(true);
		expect(titles).toHaveLength(1);
		expect(titles[0]).toContain(".mcp.json");
		expect(titles[0]).toContain(cwd);
	});

	it("does not mention .mcp.json when the project has none", async () => {
		rmSync(join(cwd, ".mcp.json"));
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{}");
		const titles: string[] = [];

		await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context(true, titles, "Do not trust") });

		expect(titles[0]).not.toContain(".mcp.json");
	});

	it("honors a saved decision and the defaultProjectTrust setting", async () => {
		expect(
			await resolveProjectTrusted({
				cwd,
				trustStore,
				defaultProjectTrust: "never",
				projectTrustContext: context(true),
			}),
		).toBe(false);

		trustStore.set(cwd, true);
		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context(false) })).toBe(true);
	});

	it("trusts a project without .mcp.json or other trust-requiring resources without asking", async () => {
		rmSync(join(cwd, ".mcp.json"));

		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext: context(false) })).toBe(true);
	});
});
