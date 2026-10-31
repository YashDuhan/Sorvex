import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function installPackage(agentDir: string, name: string, manifest: Record<string, unknown>): string {
	const packageDir = join(agentDir, "npm", "node_modules", name);
	for (const dir of ["sorvex-prompts", "pi-prompts"]) {
		mkdirSync(join(packageDir, dir), { recursive: true });
		writeFileSync(join(packageDir, dir, `${dir}.md`), `${dir}\n`);
	}
	writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
	return packageDir;
}

async function resolvePrompts(manifest: Record<string, unknown>): Promise<string[]> {
	const tempDir = mkdtempSync(join(tmpdir(), "sorvex-package-manifest-"));
	tempDirs.push(tempDir);
	const agentDir = join(tempDir, "agent");
	const packageDir = installPackage(agentDir, "manifest-package", manifest);
	const packageManager = new DefaultPackageManager({
		cwd: tempDir,
		agentDir,
		settingsManager: SettingsManager.inMemory({ packages: ["npm:manifest-package"] }),
	});
	const resources = await packageManager.resolve();
	return resources.prompts.map((prompt) => prompt.path.slice(packageDir.length + 1).replaceAll("\\", "/")).sort();
}

describe("package manifest key", () => {
	it("loads resources declared under the sorvex key", async () => {
		expect(await resolvePrompts({ sorvex: { prompts: ["./sorvex-prompts"] } })).toEqual([
			"sorvex-prompts/sorvex-prompts.md",
		]);
	});

	it("keeps loading packages that declare resources under the pi key", async () => {
		expect(await resolvePrompts({ pi: { prompts: ["./pi-prompts"] } })).toEqual(["pi-prompts/pi-prompts.md"]);
	});

	it("uses the sorvex key instead of the pi key when a package has both", async () => {
		expect(
			await resolvePrompts({ sorvex: { prompts: ["./sorvex-prompts"] }, pi: { prompts: ["./pi-prompts"] } }),
		).toEqual(["sorvex-prompts/sorvex-prompts.md"]);
	});
});
