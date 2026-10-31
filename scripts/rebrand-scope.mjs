#!/usr/bin/env node
// Renames the npm packages from the @earendil-works scope to @sorvex/<name>.
//
//   node scripts/rebrand-scope.mjs           rewrite the tracked files in place (idempotent)
//   node scripts/rebrand-scope.mjs --check   exit 1 and print file:line for every old name left
//
// Every @earendil-works name in a tracked text file must be classified: renamed through RENAMES or
// left alone through KEPT. An unclassified name fails both modes. Lines carrying the keep marker,
// and lines between the keep-begin and keep-end markers, are never rewritten or checked; they hold
// the extension alias tables that keep pi extensions loading. In a CHANGELOG.md only the
// [Unreleased] section is scanned, because released sections are immutable. Generated lockfiles are
// checked but not rewritten: regenerate them after a rewrite.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KEEP_MARKER = "rebrand-scope:keep";
export const KEEP_BEGIN = "rebrand-scope:keep-begin";
export const KEEP_END = "rebrand-scope:keep-end";

export const OLD_SCOPE = "@earendil-works";
export const NEW_SCOPE = "@sorvex";

// Old name to Sorvex name (decision D2). Keys are matched as whole names, so a subpath such as
// `@earendil-works/pi-ai/models` renames through its package entry.
export const RENAMES = new Map([
	// The workspace packages, one per packages/*/package.json.
	["@earendil-works/pi-agent-core", "@sorvex/agent-core"],
	["@earendil-works/pi-ai", "@sorvex/ai"],
	["@earendil-works/chord", "@sorvex/chord"],
	["@earendil-works/pi-codemode", "@sorvex/codemode"],
	["@earendil-works/pi-coding-agent", "@sorvex/coding-agent"],
	["@earendil-works/pi-durable", "@sorvex/durable"],
	["@earendil-works/pi-env", "@sorvex/env"],
	["@earendil-works/pi-evals", "@sorvex/evals"],
	["@earendil-works/pi-mcp", "@sorvex/mcp"],
	["@earendil-works/pi-telemetry", "@sorvex/telemetry"],
	["@earendil-works/pi-tui", "@sorvex/tui"],
	// The generated installer package in packages/coding-agent/install-lock/.
	["@earendil-works/pi-coding-agent-install", "@sorvex/coding-agent-install"],
	// Names that are not packages here: a stale tsconfig path for the removed agent-old package and test fixtures.
	["@earendil-works/pi-agent-old", "@sorvex/agent-old"],
	["@earendil-works/pi-server", "@sorvex/server"],
	["@earendil-works/undeclared", "@sorvex/undeclared"],
	// Prefixes: `@earendil-works/pi-*` globs and `startsWith("@earendil-works/pi-")`, then the bare scope
	// in `startsWith("@earendil-works/")` and in split path segments such as `join(root, "@earendil-works")`.
	["@earendil-works/pi-", "@sorvex/"],
	["@earendil-works/", "@sorvex/"],
	["@earendil-works", "@sorvex"],
]);

// The private root workspace name. Nothing outside this repository reads it; scripts/local-release.mjs checks it.
export const ROOT_RENAME = ['"pi-monorepo"', '"sorvex-monorepo"'];

// @earendil-works names that are not ours to rename.
export const KEPT = new Map([
	["@earendil-works/gondolin", "third-party VM package used by the gondolin example extension"],
	["@earendil-works/gondolin-krun-runner-darwin-arm64", "third-party optional dependency of @earendil-works/gondolin"],
	["@earendil-works/gondolin-krun-runner-linux-x64", "third-party optional dependency of @earendil-works/gondolin"],
]);

const EXCLUDED_FILES = new Set(["scripts/rebrand-scope.mjs", "scripts/rebrand-scope.test.mjs"]);
const GENERATED_FILES = new Set([
	"package-lock.json",
	"packages/coding-agent/install-lock/package.json",
	"packages/coding-agent/install-lock/package-lock.json",
]);
// The scope, then an optional separator (`/`, `\/` in a regex, `\\` in a Windows path string, `+` in a pnpm
// store dir) and name. The name stops at `/`, so subpaths keep their suffix.
const TOKEN = /@earendil-works(?:(\\\/|\/|\\\\|\+)([a-z0-9][a-z0-9-]*)?)?(?![A-Za-z0-9_-])/g;
// A scope and package name split into path segments: `"@earendil-works", "pi-tui"`, or across a scopeDir join.
const SPLIT = /"@earendil-works"(\s*,\s*|\);\s*const \w+ = join\(\w+, )"([a-z0-9][a-z0-9-]*)"/g;

function listFiles(root) {
	const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		maxBuffer: 1 << 28,
	});
	return output
		.toString("utf8")
		.split("\0")
		.filter((file) => file && !EXCLUDED_FILES.has(file));
}

// Lines the transform must leave alone: kept lines, kept regions, and released changelog sections.
function frozenLines(file, lines) {
	const isChangelog = basename(file) === "CHANGELOG.md";
	let inUnreleased = false;
	let inKeepRegion = false;
	return lines.map((line) => {
		if (isChangelog && line.startsWith("## [")) inUnreleased = /^## \[Unreleased\]/i.test(line);
		if (line.includes(KEEP_BEGIN)) inKeepRegion = true;
		const frozen = inKeepRegion || line.includes(KEEP_MARKER) || (isChangelog && !inUnreleased);
		if (line.includes(KEEP_END)) inKeepRegion = false;
		return frozen;
	});
}

function lineAt(text, offset) {
	let line = 1;
	for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) line++;
	return line;
}

// Returns the text with every renamed name replaced, and one finding per renamed or unclassified name.
export function transform(file, text) {
	const findings = [];
	const frozen = frozenLines(file, text.split("\n"));

	const joined = text.replace(SPLIT, (match, between, name, offset) => {
		const line = lineAt(text, offset);
		const renamed = RENAMES.get(`${OLD_SCOPE}/${name}`);
		if (frozen[line - 1] || !renamed || KEPT.has(`${OLD_SCOPE}/${name}`)) return match;
		findings.push({ line, name: `${OLD_SCOPE}/${name}`, kind: "renamed" });
		const [scope, newName] = renamed.split("/");
		return `"${scope}"${between}"${newName}"`;
	});

	const lines = joined.split("\n").map((line, index) => {
		if (frozen[index]) return line;
		let next = line.replace(TOKEN, (match, separator, name) => {
			const oldName = separator === undefined ? OLD_SCOPE : `${OLD_SCOPE}/${name ?? ""}`;
			if (KEPT.has(oldName)) return match;
			const renamed = RENAMES.get(oldName);
			if (!renamed) {
				findings.push({ line: index + 1, name: oldName, kind: "unclassified" });
				return match;
			}
			findings.push({ line: index + 1, name: oldName, kind: "renamed" });
			return separator === undefined ? renamed : `${NEW_SCOPE}${separator}${renamed.slice(NEW_SCOPE.length + 1)}`;
		});
		if (next.includes(ROOT_RENAME[0])) {
			findings.push({ line: index + 1, name: ROOT_RENAME[0], kind: "renamed" });
			next = next.replaceAll(ROOT_RENAME[0], ROOT_RENAME[1]);
		}
		return next;
	});
	return { text: lines.join("\n"), findings };
}

export function run(root, { check }) {
	const rewritten = [];
	const problems = [];
	let replacements = 0;
	for (const file of listFiles(root)) {
		let buffer;
		try {
			buffer = readFileSync(join(root, file));
		} catch {
			continue;
		}
		if (buffer.includes(0)) continue;
		const result = transform(file, buffer.toString("utf8"));
		const generated = GENERATED_FILES.has(file);
		for (const finding of result.findings) {
			if (finding.kind === "unclassified" || check) problems.push({ file, ...finding, generated });
		}
		const renamed = result.findings.filter((finding) => finding.kind === "renamed").length;
		if (renamed > 0 && !check && !generated) {
			writeFileSync(join(root, file), result.text);
			rewritten.push(file);
			replacements += renamed;
		}
	}
	return { rewritten, replacements, problems };
}

function hint(problem) {
	if (problem.kind === "unclassified") return "add it to RENAMES or KEPT in scripts/rebrand-scope.mjs";
	const target = problem.name === ROOT_RENAME[0] ? ROOT_RENAME[1] : RENAMES.get(problem.name);
	if (problem.generated) return `use ${target}; regenerate this file after running scripts/rebrand-scope.mjs`;
	return `use ${target}`;
}

function main(argv) {
	const check = argv.includes("--check");
	const rootIndex = argv.indexOf("--root");
	const root = resolve(rootIndex === -1 ? join(fileURLToPath(import.meta.url), "../..") : argv[rootIndex + 1]);
	const { rewritten, replacements, problems } = run(root, { check });
	for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.name} (${hint(problem)})`);
	if (problems.length > 0) {
		console.error(
			check ? `rebrand-scope: ${problems.length} old or unclassified name(s)` : "rebrand-scope: unclassified name(s) above",
		);
		return 1;
	}
	if (!check) console.log(`rebrand-scope: ${replacements} replacement(s) in ${rewritten.length} file(s)`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
