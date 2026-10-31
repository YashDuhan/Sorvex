import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KEEP_BEGIN, KEEP_END, KEEP_MARKER, KEPT, NEW_SCOPE, OLD_SCOPE, RENAMES } from "./rebrand-scope.mjs";

const script = fileURLToPath(new URL("./rebrand-scope.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "rebrand-scope-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), body);
	}
	return root;
}

function rebrand(root, ...args) {
	return spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
}

const read = (root, name) => readFileSync(join(root, name), "utf8");

test("the table maps every workspace package to the Sorvex scope and shares no name with KEPT", () => {
	const renamed = new Set(RENAMES.values());
	for (const dir of readdirSync(join(repoRoot, "packages"))) {
		let name;
		try {
			name = JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf8")).name;
		} catch {
			continue;
		}
		assert.ok(RENAMES.has(name) || renamed.has(name), `packages/${dir}: ${name} is not in RENAMES`);
	}
	for (const [oldName, newName] of RENAMES) {
		assert.ok(oldName.startsWith(OLD_SCOPE), oldName);
		assert.ok(newName.startsWith(NEW_SCOPE), newName);
		if (oldName.length > OLD_SCOPE.length + 1 && oldName !== `${OLD_SCOPE}/pi-`) {
			assert.match(newName, /^@sorvex\/(?:[a-z][a-z-]*|undeclared)$/, newName);
		}
		assert.ok(!KEPT.has(oldName), oldName);
	}
});

test("rewrites package names, dependency keys, and workspace script prefixes", (t) => {
	const root = fixture(t, {
		"package.json": `${JSON.stringify(
			{
				name: "pi-monorepo",
				scripts: { eval: "npm run eval --workspace=@earendil-works/pi-evals --" },
				dependencies: { "@earendil-works/pi-ai": "1.4.0", "@earendil-works/chord": "1.4.0" },
			},
			null,
			"\t",
		)}\n`,
	});
	const result = rebrand(root);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(read(root, "package.json")), {
		name: "sorvex-monorepo",
		scripts: { eval: "npm run eval --workspace=@sorvex/evals --" },
		dependencies: { "@sorvex/ai": "1.4.0", "@sorvex/chord": "1.4.0" },
	});
});

test("rewrites imports, subpaths, tsconfig paths, vitest aliases, and prefixes", (t) => {
	const root = fixture(t, {
		"src/a.ts": [
			'import { Type } from "@earendil-works/pi-ai";',
			'import { x } from "@earendil-works/pi-ai/utils/retry";',
			'export * from "@earendil-works/pi-coding-agent-install";',
			'if (name.startsWith("@earendil-works/pi-")) {}',
			'if (name.startsWith("@earendil-works/")) {}',
			"// @earendil-works/pi-* peers",
			"",
		].join("\n"),
		"tsconfig.json": '{ "paths": { "@earendil-works/pi-tui/*": ["./packages/tui/src/*"] } }\n',
		"vitest.config.ts": "alias: [{ find: /^@earendil-works\\/pi-ai\\/compat$/, replacement: x }],\n",
	});
	assert.equal(rebrand(root).status, 0);
	assert.equal(
		read(root, "src/a.ts"),
		[
			'import { Type } from "@sorvex/ai";',
			'import { x } from "@sorvex/ai/utils/retry";',
			'export * from "@sorvex/coding-agent-install";',
			'if (name.startsWith("@sorvex/")) {}',
			'if (name.startsWith("@sorvex/")) {}',
			"// @sorvex/* peers",
			"",
		].join("\n"),
	);
	assert.equal(read(root, "tsconfig.json"), '{ "paths": { "@sorvex/tui/*": ["./packages/tui/src/*"] } }\n');
	assert.equal(read(root, "vitest.config.ts"), "alias: [{ find: /^@sorvex\\/ai\\/compat$/, replacement: x }],\n");
});

test("rewrites install paths: split segments, Windows separators, and pnpm store dirs", (t) => {
	const root = fixture(t, {
		"test/p.test.ts": [
			'const a = join(root, "node_modules", "@earendil-works", "pi-tui");',
			'const scopeDir = join(root, "@earendil-works");',
			'const packageDir = join(scopeDir, "pi-coding-agent");',
			'const w = "C:\\\\.pnpm\\\\@earendil-works+pi-coding-agent@0.1.0\\\\node_modules\\\\@earendil-works\\\\pi-coding-agent";',
			"",
		].join("\n"),
	});
	assert.equal(rebrand(root).status, 0);
	assert.equal(
		read(root, "test/p.test.ts"),
		[
			'const a = join(root, "node_modules", "@sorvex", "tui");',
			'const scopeDir = join(root, "@sorvex");',
			'const packageDir = join(scopeDir, "coding-agent");',
			'const w = "C:\\\\.pnpm\\\\@sorvex+coding-agent@0.1.0\\\\node_modules\\\\@sorvex\\\\coding-agent";',
			"",
		].join("\n"),
	);
});

test("leaves third-party names, @mariozechner names, and keep regions alone", (t) => {
	const body = [
		'import { VM } from "@earendil-works/gondolin";',
		'"@mariozechner/pi-ai": compat,',
		`// ${KEEP_BEGIN} aliases`,
		'"@earendil-works/pi-ai": compat,',
		`// ${KEEP_END}`,
		`const k = "@earendil-works/pi-tui"; // ${KEEP_MARKER}`,
		'"@earendil-works/pi-ai": compat,',
		"",
	].join("\n");
	const root = fixture(t, { "src/v.ts": body });
	assert.equal(rebrand(root).status, 0);
	assert.equal(read(root, "src/v.ts"), body.replace(/"@earendil-works\/pi-ai": compat,\n$/, '"@sorvex/ai": compat,\n'));
	assert.equal(rebrand(root, "--check").status, 0);
});

test("in a changelog only the Unreleased section is rewritten", (t) => {
	const root = fixture(t, {
		"CHANGELOG.md":
			"# Changelog\n\n## [Unreleased]\n\n- Uses `@earendil-works/pi-ai`.\n\n## [1.0.0] - 2026-01-01\n\n- Added `@earendil-works/pi-ai`.\n",
	});
	assert.equal(rebrand(root).status, 0);
	assert.equal(
		read(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n- Uses `@sorvex/ai`.\n\n## [1.0.0] - 2026-01-01\n\n- Added `@earendil-works/pi-ai`.\n",
	);
	assert.equal(rebrand(root, "--check").status, 0);
});

test("generated lockfiles are checked but not rewritten", (t) => {
	const body = '{ "name": "pi-monorepo", "packages": { "node_modules/@earendil-works/pi-ai": {} } }\n';
	const root = fixture(t, { "package-lock.json": body });
	assert.equal(rebrand(root).status, 0);
	assert.equal(read(root, "package-lock.json"), body);
	const result = rebrand(root, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /package-lock\.json:1: @earendil-works\/pi-ai \(use @sorvex\/ai; regenerate/);
});

test("--check fails on a planted old name and names file:line, and changes nothing", (t) => {
	const body = "ok\nok\nimport { Agent } from '@earendil-works/pi-agent-core';\n";
	const root = fixture(t, { "src/planted.ts": body });
	const result = rebrand(root, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src\/planted\.ts:3: @earendil-works\/pi-agent-core \(use @sorvex\/agent-core\)/);
	assert.equal(read(root, "src/planted.ts"), body);
});

test("an unclassified @earendil-works name fails both modes", (t) => {
	const root = fixture(t, { "a.ts": 'import "@earendil-works/brand-new";\n' });
	for (const args of [[], ["--check"]]) {
		const result = rebrand(root, ...args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /a\.ts:1: @earendil-works\/brand-new \(add it to RENAMES or KEPT/);
	}
});

test("a second run changes nothing and --check passes afterwards", (t) => {
	const root = fixture(t, {
		"a.ts": 'import "@earendil-works/pi-tui";\nconst d = join(root, "@earendil-works", "pi-ai");\n',
		"package.json": '{ "name": "@earendil-works/pi-durable", "dependencies": { "@earendil-works/pi-ai": "1.0.0" } }\n',
	});
	assert.equal(rebrand(root).status, 0);
	const once = [read(root, "a.ts"), read(root, "package.json")];
	const second = rebrand(root);
	assert.equal(second.status, 0);
	assert.match(second.stdout, /0 replacement\(s\) in 0 file\(s\)/);
	assert.deepEqual([read(root, "a.ts"), read(root, "package.json")], once);
	assert.equal(rebrand(root, "--check").status, 0);
});
