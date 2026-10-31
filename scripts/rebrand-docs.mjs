#!/usr/bin/env node
// Renames the product name pi to Sorvex, and the .pi config dirs to .sorvex, in docs, examples, and changelogs.
//
//   node scripts/rebrand-docs.mjs           rewrite the files in scope in place (idempotent)
//   node scripts/rebrand-docs.mjs --check   exit 1 and print file:line for every product-name pi left
//
// A match of PRODUCT_NAME is renamed by where it sits: `Pi` becomes `Sorvex`; a lowercase `pi` that
// names the command (in a code span, a shell block, a command line, or a quoted name) becomes
// `sorvex`, and one in prose becomes `Sorvex`. A `.pi` dir name (CONFIG_DIR) becomes `.sorvex`. A match in code outside a comment or string is the
// `pi` ExtensionAPI parameter or another identifier, so it is never rewritten: it must be listed in
// the skip list, which names each line or file the pass leaves alone and why. A skip entry that no
// longer matches a line fails both modes. In a CHANGELOG.md only the [Unreleased] section is in scope,
// because released sections are immutable.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRODUCT_NAME = /(?<![\w./@$-])(?:pi|Pi)(?![\w-]|\.[A-Za-z_]|[:),=[\]?])/g;
export const CONFIG_DIR = /(?<![\w-])\.pi(?![\w-])/g;
// PRODUCT_NAME skips a name before `,`, `)`, `:`, `]`, or `?` so that code such as `(pi: ExtensionAPI)` never
// matches. In Markdown prose those are sentence punctuation ("Restart Pi, then"), so prose also matches PROSE_NAME.
const PROSE_NAME = /(?<![\w./@$-])(?:pi|Pi)(?=[,):\]?])/g;
const ANY_NAME = new RegExp(`${CONFIG_DIR.source}|${PRODUCT_NAME.source}|${PROSE_NAME.source}`, "g");
export const SKIP_LIST = "scripts/rebrand-docs-skip.json";

const SCOPE = [
	/^README\.md$/,
	/^CONTRIBUTING\.md$/,
	/^AGENTS\.md$/,
	/^packages\/[^/]+\/README\.md$/,
	/^packages\/[^/]+\/CHANGELOG\.md$/,
	/^packages\/[^/]+\/docs\//,
	/^packages\/coding-agent\/examples\//,
	/^\.sorvex\//,
];
const TEXT_EXTENSIONS = new Set([".md", ".ts", ".js", ".mjs", ".json", ".sh"]);
const CODE_EXTENSIONS = new Set([".ts", ".js", ".mjs"]);
const CODE_FENCES = new Set(["ts", "typescript", "js", "javascript", "tsx", "jsx", "mjs"]);
// Words after a lowercase `pi` in prose that make it the command, as in "run pi install npm:foo".
const COMMAND_WORDS =
	/^ (?:-|"|'|<|\[|\/|\.\/|~|@|install|remove|uninstall|update|list|config|mcp|auth|doctor|package|packages)/;

export function inScope(file) {
	return TEXT_EXTENSIONS.has(extname(file)) && SCOPE.some((pattern) => pattern.test(file));
}

export function readSkipList(root) {
	const entries = JSON.parse(readFileSync(join(root, SKIP_LIST), "utf8"));
	for (const [index, entry] of entries.entries()) {
		if (typeof entry.file !== "string" || typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error(`${SKIP_LIST}[${index}] needs a file and a reason`);
		}
		if (entry.line !== undefined && (typeof entry.line !== "string" || entry.line === "")) {
			throw new Error(`${SKIP_LIST}[${index}].line must be a nonempty string`);
		}
	}
	return entries;
}

function quoteState(text) {
	let quote;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === "\\") index++;
			else if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'" || char === "`") {
			quote = char;
		} else if (char === "/" && text[index + 1] === "/") {
			return "comment";
		}
	}
	return quote ? "string" : "code";
}

// Where a match sits in a code line: "comment", "string", or "code".
function codeContext(line, offset, inBlockComment) {
	if (inBlockComment) return "comment";
	const trimmed = line.trimStart();
	if (trimmed.startsWith("*") || trimmed.startsWith("/*") || trimmed.startsWith("//") || trimmed.startsWith("#")) {
		return "comment";
	}
	return quoteState(line.slice(0, offset));
}

function replacement(match, line, offset, context) {
	if (match === "Pi") return "Sorvex";
	const before = line.slice(0, offset);
	const after = line.slice(offset + match.length);
	if (context === "command" || context === "inline-code") return "sorvex";
	if (before.endsWith('"') && after.startsWith('"')) return "sorvex";
	if (before.endsWith("'") && after.startsWith("'")) return "sorvex";
	if (/(?:^|\s)(?:\$|Usage:|\*|#|\|\|)\s*$/.test(before) && COMMAND_WORDS.test(after)) return "sorvex";
	if (/^\s*$/.test(before) && COMMAND_WORDS.test(after)) return "sorvex";
	if (COMMAND_WORDS.test(after) && /[-"'<]/.test(after[1] ?? "")) return "sorvex";
	if (/\b(?:run|start|launch|invoke|restart)\s+$/i.test(before) && COMMAND_WORDS.test(after)) return "sorvex";
	return "Sorvex";
}

function lineSkipped(skips, file, line) {
	for (const entry of skips) {
		if (entry.file !== file) continue;
		if (entry.line === undefined || line.includes(entry.line)) return entry;
	}
	return undefined;
}

// Returns the rewritten text, the renamed matches, and the matches in code no skip entry covers.
export function transform(file, text, skips = []) {
	const extension = extname(file);
	const isChangelog = basename(file) === "CHANGELOG.md";
	const isMarkdown = extension === ".md";
	const usedSkips = new Set();
	const findings = [];
	let inUnreleased = !isChangelog;
	let fence;
	let inBlockComment = false;

	const lines = text.split("\n").map((line, index) => {
		if (isChangelog && line.startsWith("## [")) inUnreleased = /^## \[Unreleased\]/i.test(line);
		const fenceMatch = isMarkdown ? /^\s*(```+|~~~+)\s*([\w-]*)/.exec(line) : null;
		if (fenceMatch) {
			if (fence === undefined) fence = fenceMatch[2].toLowerCase();
			else fence = undefined;
			return line;
		}
		const isCode = CODE_EXTENSIONS.has(extension) || (fence !== undefined && CODE_FENCES.has(fence));
		const startsInBlockComment = inBlockComment;
		if (isCode) {
			const open = line.lastIndexOf("/*");
			const close = line.lastIndexOf("*/");
			if (open > close) inBlockComment = true;
			else if (close > open) inBlockComment = false;
		}
		if (!inUnreleased) return line;
		if (!line.match(ANY_NAME)) return line;
		const skip = lineSkipped(skips, file, line);
		if (skip) {
			usedSkips.add(skip);
			return line;
		}
		return line.replace(ANY_NAME, (match, offset) => {
			let context;
			if (isCode) context = codeContext(line, offset, startsInBlockComment);
			else if (fence !== undefined) context = "command";
			else if (isMarkdown && (line.slice(0, offset).split("`").length - 1) % 2 === 1) context = "inline-code";
			else context = "prose";
			if (match !== ".pi" && context !== "prose" && /^[,):\]?]/.test(line.slice(offset + match.length))) return match;
			if (context === "code") {
				findings.push({ line: index + 1, text: line, kind: "unclassified" });
				return match;
			}
			const renamed = match === ".pi" ? ".sorvex" : replacement(match, line, offset, context);
			findings.push({ line: index + 1, text: line, kind: "renamed", from: match, to: renamed, context });
			return renamed;
		});
	});
	return { text: lines.join("\n"), findings, usedSkips };
}

function listFiles(root) {
	const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
		cwd: root,
		maxBuffer: 1 << 28,
	});
	return output
		.toString("utf8")
		.split("\0")
		.filter((file) => file && inScope(file));
}

export function run(root, { check }) {
	const skips = readSkipList(root);
	const usedSkips = new Set();
	const rewritten = [];
	const problems = [];
	let replacements = 0;
	for (const file of listFiles(root)) {
		let text;
		try {
			text = readFileSync(join(root, file), "utf8");
		} catch {
			continue;
		}
		const result = transform(file, text, skips);
		for (const skip of result.usedSkips) usedSkips.add(skip);
		for (const finding of result.findings) {
			if (finding.kind === "unclassified" || check) problems.push({ file, ...finding });
		}
		const renamed = result.findings.filter((finding) => finding.kind === "renamed").length;
		if (renamed > 0 && !check) {
			writeFileSync(join(root, file), result.text);
			rewritten.push(file);
			replacements += renamed;
		}
	}
	const staleSkips = skips.filter((skip) => !usedSkips.has(skip));
	return { rewritten, replacements, problems, staleSkips };
}

function main(argv) {
	const check = argv.includes("--check");
	const rootIndex = argv.indexOf("--root");
	const root = resolve(rootIndex === -1 ? join(fileURLToPath(import.meta.url), "../..") : argv[rootIndex + 1]);
	const { rewritten, replacements, problems, staleSkips } = run(root, { check });
	for (const problem of problems) {
		const hint =
			problem.kind === "renamed"
				? `use ${problem.to}, or list the line in ${SKIP_LIST}`
				: `identifier in code; rename it or list the line in ${SKIP_LIST}`;
		console.error(`${problem.file}:${problem.line}: ${problem.text.trim()} (${hint})`);
	}
	for (const skip of staleSkips) {
		console.error(`${SKIP_LIST}: ${skip.file}${skip.line ? `: ${skip.line}` : ""} matches no product-name line; remove it`);
	}
	if (problems.length > 0 || staleSkips.length > 0) {
		console.error(`rebrand-docs: ${problems.length} product-name pi left, ${staleSkips.length} stale skip entr(ies)`);
		return 1;
	}
	if (!check) console.log(`rebrand-docs: ${replacements} replacement(s) in ${rewritten.length} file(s)`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
