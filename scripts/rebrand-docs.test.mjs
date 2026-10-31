import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SKIP_LIST } from "./rebrand-docs.mjs";

const script = fileURLToPath(new URL("./rebrand-docs.mjs", import.meta.url));

function fixture(t, files, skips = []) {
	const root = mkdtempSync(join(tmpdir(), "rebrand-docs-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: root });
	for (const [name, body] of Object.entries({ ...files, [SKIP_LIST]: JSON.stringify(skips) })) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), body);
	}
	return root;
}

function rebrand(root, ...args) {
	return spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
}

const read = (root, name) => readFileSync(join(root, name), "utf8");

test("renames prose to Sorvex, commands to sorvex, and .pi dirs to .sorvex", (t) => {
	const root = fixture(t, {
		"README.md": [
			"# Pi",
			"Run `pi --continue` to resume. pi's tools read `~/.pi/agent/settings.json` and `.pi/settings.json`.",
			"Exit pi then run pi install npm:foo.",
			"```bash",
			"pi --mode json",
			"```",
			"",
		].join("\n"),
		"packages/x/docs/a.md": "Pi stores sessions. See [Pi docs](b.md). Restart Pi, then ask [pi](c.md).\n",
	});
	const result = rebrand(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(
		read(root, "README.md"),
		[
			"# Sorvex",
			"Run `sorvex --continue` to resume. Sorvex's tools read `~/.sorvex/agent/settings.json` and `.sorvex/settings.json`.",
			"Exit Sorvex then run sorvex install npm:foo.",
			"```bash",
			"sorvex --mode json",
			"```",
			"",
		].join("\n"),
	);
	assert.equal(read(root, "packages/x/docs/a.md"), "Sorvex stores sessions. See [Sorvex docs](b.md). Restart Sorvex, then ask [Sorvex](c.md).\n");
	assert.equal(rebrand(root, "--check").status, 0);
});

test("never rewrites the pi parameter, pi.dev, package names, or files out of scope", (t) => {
	const code = [
		"/** Start pi with: pi -e ./x.ts */",
		" * export default function (pi: ExtensionAPI) {}",
		"export default function (pi: ExtensionAPI) {",
		"\tpi.registerTool(tool);",
		'\tpi.on("session_start", () => ctx.ui.notify("Exit pi cleanly"));',
		"}",
		"",
	].join("\n");
	const doc = "See https://pi.dev and the pi-tui package, `@earendil-works/pi-ai`, `(pi: ExtensionAPI)`, and π.\n"; // rebrand-scope:keep
	const root = fixture(t, {
		"packages/coding-agent/examples/extensions/x.ts": code,
		"packages/x/docs/a.md": doc,
		"packages/x/src/a.ts": "// pi is the product\n",
	});
	const result = rebrand(root);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read(root, "packages/coding-agent/examples/extensions/x.ts"), code.replace("Start pi with: pi -e", "Start Sorvex with: sorvex -e").replace("Exit pi", "Exit Sorvex"));
	assert.equal(read(root, "packages/x/docs/a.md"), doc);
	assert.equal(read(root, "packages/x/src/a.ts"), "// pi is the product\n");
});

test("an identifier in code fails until the skip list names its line", (t) => {
	const files = { "README.md": "```ts\nconst api = pi ;\n```\n" };
	const failing = rebrand(fixture(t, files));
	assert.equal(failing.status, 1);
	assert.match(failing.stderr, /README\.md:2: const api = pi ;/);

	const root = fixture(t, files, [{ file: "README.md", line: "const api = pi ;", reason: "api: parameter" }]);
	assert.equal(rebrand(root).status, 0);
	assert.equal(read(root, "README.md"), files["README.md"]);
});

test("--check fails on a planted product name and on a stale skip entry", (t) => {
	const planted = rebrand(fixture(t, { "AGENTS.md": "Pi is back.\n" }), "--check");
	assert.equal(planted.status, 1);
	assert.match(planted.stderr, /AGENTS\.md:1: Pi is back\. \(use Sorvex/);

	const stale = rebrand(fixture(t, { "AGENTS.md": "Sorvex.\n" }, [{ file: "AGENTS.md", line: "Pi", reason: "old" }]), "--check");
	assert.equal(stale.status, 1);
	assert.match(stale.stderr, /matches no product-name line/);
});

test("a skip entry without a reason is rejected", (t) => {
	const result = rebrand(fixture(t, { "AGENTS.md": "Pi\n" }, [{ file: "AGENTS.md", reason: "" }]));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /needs a file and a reason/);
});

test("only the Unreleased section of a changelog is rewritten", (t) => {
	const body = "# Changelog\n\n## [Unreleased]\n\n- pi now warns.\n\n## [1.0.0]\n\n- pi now warns.\n";
	const root = fixture(t, { "packages/x/CHANGELOG.md": body });
	assert.equal(rebrand(root).status, 0);
	assert.equal(read(root, "packages/x/CHANGELOG.md"), body.replace("- pi now warns.\n\n## [1", "- Sorvex now warns.\n\n## [1"));
});
