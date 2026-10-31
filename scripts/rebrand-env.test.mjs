import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KEEP_MARKER, KEPT, RENAMES } from "./rebrand-env.mjs";

const script = fileURLToPath(new URL("./rebrand-env.mjs", import.meta.url));

function fixture(t, files) {
	const root = mkdtempSync(join(tmpdir(), "rebrand-env-test-"));
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

test("the table maps every PI_X to SORVEX_X and shares no name with KEPT", () => {
	for (const [oldName, newName] of RENAMES) {
		assert.equal(newName, `SORVEX_${oldName.slice(3)}`);
		assert.ok(!KEPT.has(oldName), oldName);
	}
});

test("rewrites reads, writes, shell expansions, globs, and prefix filters", (t) => {
	const root = fixture(t, {
		"src/a.ts": 'const a = process.env.PI_OFFLINE;\nenv.PI_SESSION_FILE = x;\nif (n.startsWith("PI_")) {}\n',
		"docs/e.md": "Set `PI_CACHE_RETENTION=long`. All `PI_*` variables. $PI_MODEL ${PI_PROVIDER:-x}\n",
	});
	const result = rebrand(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		read(root, "src/a.ts"),
		'const a = process.env.SORVEX_OFFLINE;\nenv.SORVEX_SESSION_FILE = x;\nif (n.startsWith("SORVEX_")) {}\n',
	);
	assert.equal(read(root, "docs/e.md"), "Set `SORVEX_CACHE_RETENTION=long`. All `SORVEX_*` variables. $SORVEX_MODEL ${SORVEX_PROVIDER:-x}\n");
});

test("leaves constants, lookalikes, and kept identifiers alone", (t) => {
	const body = "export const PI_ATTRIBUTION = 1;\nPI_NAPI_CALL(x);\nMINIMUM_PI_VERSION API_runtime PI_Mixed\nsecrets.PI_AUTH_JSON\n";
	const root = fixture(t, { "src/c.ts": body });
	const result = rebrand(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read(root, "src/c.ts"), body);
});

test("a line with the keep marker is not rewritten or checked", (t) => {
	const body = `PI_OFFLINE is ignored // ${KEEP_MARKER}\nPI_OFFLINE\n`;
	const root = fixture(t, { "a.txt": body });
	assert.equal(rebrand(root).status, 0);
	assert.equal(read(root, "a.txt"), `PI_OFFLINE is ignored // ${KEEP_MARKER}\nSORVEX_OFFLINE\n`);
	assert.equal(rebrand(root, "--check").status, 0);
});

test("in a changelog only the Unreleased section is rewritten", (t) => {
	const root = fixture(t, {
		"CHANGELOG.md": "# Changelog\n\n## [Unreleased]\n\n- Uses `PI_OFFLINE`.\n\n## [1.0.0] - 2026-01-01\n\n- Added `PI_OFFLINE`.\n",
	});
	assert.equal(rebrand(root).status, 0);
	assert.equal(
		read(root, "CHANGELOG.md"),
		"# Changelog\n\n## [Unreleased]\n\n- Uses `SORVEX_OFFLINE`.\n\n## [1.0.0] - 2026-01-01\n\n- Added `PI_OFFLINE`.\n",
	);
	assert.equal(rebrand(root, "--check").status, 0);
});

test("--check fails on a planted old name and names file:line, and changes nothing", (t) => {
	const body = "ok\nok\nconst x = process.env.PI_OFFLINE;\n";
	const root = fixture(t, { "src/planted.ts": body });
	const result = rebrand(root, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src\/planted\.ts:3: PI_OFFLINE \(use SORVEX_OFFLINE\)/);
	assert.equal(read(root, "src/planted.ts"), body);
});

test("an unclassified PI_ token fails both modes", (t) => {
	const root = fixture(t, { "a.ts": "process.env.PI_BRAND_NEW;\n" });
	for (const args of [[], ["--check"]]) {
		const result = rebrand(root, ...args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /a\.ts:1: PI_BRAND_NEW \(add it to RENAMES or KEPT/);
	}
});

test("a second run changes nothing and --check passes afterwards", (t) => {
	const root = fixture(t, { "a.ts": "PI_OFFLINE PI_MODEL PI_*\n", "b.sh": "export PI_TIMING=1\n" });
	assert.equal(rebrand(root).status, 0);
	const once = [read(root, "a.ts"), read(root, "b.sh")];
	const second = rebrand(root);
	assert.equal(second.status, 0);
	assert.match(second.stdout, /0 replacement\(s\) in 0 file\(s\)/);
	assert.deepEqual([read(root, "a.ts"), read(root, "b.sh")], once);
	assert.equal(rebrand(root, "--check").status, 0);
});
