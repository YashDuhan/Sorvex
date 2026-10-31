import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	hasTrustRequiringProjectResources,
	isChildProjectTrusted,
	ProjectTrustStore,
} from "../src/core/trust-manager.ts";

describe("ProjectTrustStore", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `trust-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores decisions and inherits from parent directories", () => {
		const store = new ProjectTrustStore(agentDir);
		const parentDir = join(tempDir, "trusted-parent");
		const childDir = join(parentDir, "project");
		mkdirSync(childDir, { recursive: true });

		expect(store.get(childDir)).toBeNull();
		store.set(parentDir, true);
		expect(store.get(childDir)).toBe(true);
		store.set(childDir, false);
		expect(store.get(childDir)).toBe(false);
		store.set(childDir, null);
		expect(store.get(childDir)).toBe(true);
	});

	it("detects trust-requiring project resources", () => {
		const originalHome = process.env.HOME;
		process.env.HOME = tempDir;
		try {
			mkdirSync(join(tempDir, CONFIG_DIR_NAME, "agent"), { recursive: true });
			mkdirSync(join(tempDir, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(false);
			expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

			writeFileSync(join(tempDir, CONFIG_DIR_NAME, "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, CONFIG_DIR_NAME, "settings.json"), { force: true });

			mkdirSync(join(tempDir, CONFIG_DIR_NAME, "agents"));
			expect(hasTrustRequiringProjectResources(tempDir)).toBe(true);
			rmSync(join(tempDir, CONFIG_DIR_NAME, "agents"), { recursive: true, force: true });

			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{}");
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

			rmSync(join(cwd, CONFIG_DIR_NAME), { recursive: true, force: true });
			mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
			expect(hasTrustRequiringProjectResources(cwd)).toBe(true);
		} finally {
			if (originalHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = originalHome;
			}
		}
	});

	it("gives a child directory only the trust running in that directory would give without asking (H1)", () => {
		const store = new ProjectTrustStore(agentDir);
		const configured = (dir: string) => {
			mkdirSync(join(dir, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(dir, CONFIG_DIR_NAME, "settings.json"), "{}");
			return dir;
		};
		const plain = join(cwd, "plain");
		mkdirSync(plain);
		const nested = configured(join(cwd, "nested"));
		const sibling = configured(join(tempDir, "project-other"));
		const lookalike = configured(join(tempDir, "project..x"));
		const parent = (trusted: boolean) => ({ cwd, trusted });

		expect(isChildProjectTrusted(cwd, parent(true), store, "ask")).toBe(true);
		expect(isChildProjectTrusted(cwd, parent(false), store, "always")).toBe(false);
		expect(isChildProjectTrusted(plain, parent(false), store, "ask")).toBe(true);
		expect(isChildProjectTrusted(nested, parent(true), store, "ask")).toBe(false);
		expect(isChildProjectTrusted(sibling, parent(true), store, "ask")).toBe(false);
		expect(isChildProjectTrusted(lookalike, parent(true), store, "ask")).toBe(false);
		expect(isChildProjectTrusted(nested, parent(false), store, "always")).toBe(true);

		store.set(cwd, true);
		expect(isChildProjectTrusted(nested, parent(false), store, "ask")).toBe(true);
		expect(isChildProjectTrusted(sibling, parent(true), store, "ask")).toBe(false);
		store.set(nested, false);
		expect(isChildProjectTrusted(nested, parent(true), store, "always")).toBe(false);
		store.set(sibling, true);
		expect(isChildProjectTrusted(sibling, parent(false), store, "ask")).toBe(true);
	});

	it("treats a root .mcp.json as a trust-requiring resource", () => {
		expect(hasTrustRequiringProjectResources(cwd)).toBe(false);

		writeFileSync(join(cwd, ".mcp.json"), "{}");
		expect(hasTrustRequiringProjectResources(cwd)).toBe(true);

		const nested = join(cwd, "nested");
		mkdirSync(nested);
		expect(hasTrustRequiringProjectResources(nested)).toBe(false);
	});
});
