#!/usr/bin/env node
// Renames the runtime PI_* environment variables to SORVEX_*.
//
//   node scripts/rebrand-env.mjs           rewrite the tracked files in place (idempotent)
//   node scripts/rebrand-env.mjs --check   exit 1 and print file:line for every old name left
//
// Every PI_* token in a tracked text file must be classified: renamed through RENAMES or left alone
// through KEPT. An unclassified token fails both modes, so a new PI_ variable cannot appear unnoticed.
// A line containing the keep marker is never rewritten or checked. In a CHANGELOG.md only the
// [Unreleased] section is scanned, because released sections are immutable.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KEEP_MARKER = "rebrand-env:keep";

// "PI_" renames the bare prefix in `PI_*` globs and `startsWith("PI_")`; "PI_EVAL_" renames the prefix filter in the evals harness.
export const RENAMES = new Map([
	["PI_", "SORVEX_"],
	["PI_ALLOW_LOCKFILE_CHANGE", "SORVEX_ALLOW_LOCKFILE_CHANGE"],
	["PI_BASH_PREPARE_EXPLICIT", "SORVEX_BASH_PREPARE_EXPLICIT"],
	["PI_BASH_PREPARE_INHERITED", "SORVEX_BASH_PREPARE_INHERITED"],
	["PI_BUG_REPORT_URL", "SORVEX_BUG_REPORT_URL"],
	["PI_CACHE_RETENTION", "SORVEX_CACHE_RETENTION"],
	["PI_CLEAR_ON_SHRINK", "SORVEX_CLEAR_ON_SHRINK"],
	["PI_CLIPBOARD_OSC52", "SORVEX_CLIPBOARD_OSC52"],
	["PI_CODEMODE_MAX_WORKERS", "SORVEX_CODEMODE_MAX_WORKERS"],
	["PI_CODING_AGENT", "SORVEX_CODING_AGENT"],
	["PI_CODING_AGENT_DIR", "SORVEX_CODING_AGENT_DIR"],
	["PI_CODING_AGENT_SESSION_DIR", "SORVEX_CODING_AGENT_SESSION_DIR"],
	["PI_DURABLE_DOCUMENT_RETENTION_MS", "SORVEX_DURABLE_DOCUMENT_RETENTION_MS"],
	["PI_ENV_DAEMON", "SORVEX_ENV_DAEMON"],
	["PI_ENV_LOGIN", "SORVEX_ENV_LOGIN"],
	["PI_ENV_SSH_HOST", "SORVEX_ENV_SSH_HOST"],
	["PI_ENV_SSH_KEY", "SORVEX_ENV_SSH_KEY"],
	["PI_ENV_SSH_PORT", "SORVEX_ENV_SSH_PORT"],
	["PI_ENV_SSH_PROGRAM", "SORVEX_ENV_SSH_PROGRAM"],
	["PI_ENV_SSH_SHELL", "SORVEX_ENV_SSH_SHELL"],
	["PI_ENV_SSH_USER", "SORVEX_ENV_SSH_USER"],
	["PI_EVAL_", "SORVEX_EVAL_"],
	["PI_EVAL_ARTIFACT_DIR", "SORVEX_EVAL_ARTIFACT_DIR"],
	["PI_EVAL_ARTIFACT_GID", "SORVEX_EVAL_ARTIFACT_GID"],
	["PI_EVAL_ARTIFACT_UID", "SORVEX_EVAL_ARTIFACT_UID"],
	["PI_EVAL_CONTAINER", "SORVEX_EVAL_CONTAINER"],
	["PI_EVAL_RUNS_PER_VARIANT", "SORVEX_EVAL_RUNS_PER_VARIANT"],
	["PI_EVAL_SANDBOX_GID", "SORVEX_EVAL_SANDBOX_GID"],
	["PI_EVAL_SANDBOX_UID", "SORVEX_EVAL_SANDBOX_UID"],
	["PI_EVAL_VARIANT", "SORVEX_EVAL_VARIANT"],
	["PI_EXPERIMENTAL", "SORVEX_EXPERIMENTAL"],
	["PI_HARDWARE_CURSOR", "SORVEX_HARDWARE_CURSOR"],
	["PI_HYPERLINKS", "SORVEX_HYPERLINKS"],
	["PI_IMAGE_PROTOCOL", "SORVEX_IMAGE_PROTOCOL"],
	["PI_INSTALL_REPORT_URL", "SORVEX_INSTALL_REPORT_URL"],
	["PI_INSTALLER_API_BASE", "SORVEX_INSTALLER_API_BASE"],
	["PI_MANAGED_INSTALL_ROOT", "SORVEX_MANAGED_INSTALL_ROOT"],
	["PI_MCP_CONFORMANCE_REPORT", "SORVEX_MCP_CONFORMANCE_REPORT"],
	["PI_MODEL", "SORVEX_MODEL"],
	["PI_NO_LOCAL_LLM", "SORVEX_NO_LOCAL_LLM"],
	["PI_NODE_ENV_CONFIGURED_TEST", "SORVEX_NODE_ENV_CONFIGURED_TEST"],
	["PI_NODE_ENV_EXPLICIT_TEST", "SORVEX_NODE_ENV_EXPLICIT_TEST"],
	["PI_NODE_ENV_INHERITED_TEST", "SORVEX_NODE_ENV_INHERITED_TEST"],
	["PI_NODE_ENV_PRESERVED_TEST", "SORVEX_NODE_ENV_PRESERVED_TEST"],
	["PI_OAUTH_CALLBACK_HOST", "SORVEX_OAUTH_CALLBACK_HOST"],
	["PI_OFFLINE", "SORVEX_OFFLINE"],
	["PI_PACKAGE_DIR", "SORVEX_PACKAGE_DIR"],
	["PI_PROGRAM_STATUS", "SORVEX_PROGRAM_STATUS"],
	["PI_PROVIDER", "SORVEX_PROVIDER"],
	["PI_REASONING_LEVEL", "SORVEX_REASONING_LEVEL"],
	["PI_RELEASE_SKIP_TESTS", "SORVEX_RELEASE_SKIP_TESTS"],
	["PI_SCRIPT", "SORVEX_SCRIPT"],
	["PI_SCRIPT_REPORT", "SORVEX_SCRIPT_REPORT"],
	["PI_SCRIPT_REQUESTS", "SORVEX_SCRIPT_REQUESTS"],
	["PI_SESSION_FILE", "SORVEX_SESSION_FILE"],
	["PI_SESSION_ID", "SORVEX_SESSION_ID"],
	["PI_SHARE_VIEWER_URL", "SORVEX_SHARE_VIEWER_URL"],
	["PI_SKIP_VERSION_CHECK", "SORVEX_SKIP_VERSION_CHECK"],
	["PI_SPAWN_HOOK", "SORVEX_SPAWN_HOOK"],
	["PI_STARTUP_BENCHMARK", "SORVEX_STARTUP_BENCHMARK"],
	["PI_TELEMETRY", "SORVEX_TELEMETRY"],
	["PI_TEST_NATIVE_CLIPBOARD", "SORVEX_TEST_NATIVE_CLIPBOARD"],
	["PI_TIMING", "SORVEX_TIMING"],
	["PI_TRUE_COLOR", "SORVEX_TRUE_COLOR"],
	["PI_TUI_DEBUG", "SORVEX_TUI_DEBUG"],
	["PI_TUI_DEBUG_REDRAW", "SORVEX_TUI_DEBUG_REDRAW"],
	["PI_TUI_ESC_TIMEOUT", "SORVEX_TUI_ESC_TIMEOUT"],
	["PI_TUI_WIN32_TOOLCHAIN", "SORVEX_TUI_WIN32_TOOLCHAIN"],
	["PI_TUI_WRITE_LOG", "SORVEX_TUI_WRITE_LOG"],
	["PI_VERSION_CHECK_URL", "SORVEX_VERSION_CHECK_URL"],
	["PI_WSL_CLIPBOARD_IMAGE_PATH", "SORVEX_WSL_CLIPBOARD_IMAGE_PATH"],
]);

// PI_* tokens that are not environment variables we own.
export const KEPT = new Map([
	["PI_AGENT_DIR", "legacy ~/.pi session migration script input and a test path constant"],
	["PI_AI_PACKAGE", "constant naming the npm package"],
	["PI_AI_VERSION", "exported version constant"],
	["PI_ARTIFACTS_R2_ACCESS_KEY_ID", "GitHub Actions secret name, set outside the repository"],
	["PI_ARTIFACTS_R2_SECRET_ACCESS_KEY", "GitHub Actions secret name, set outside the repository"],
	["PI_ATTRIBUTION", "exported constant"],
	["PI_AUTH_JSON", "GitHub Actions secret name, set outside the repository"],
	["PI_AUTH_UPDATE_TOKEN", "GitHub Actions secret name, set outside the repository"],
	["PI_BUNDLED_NODE", "esbuild define identifier, not an environment variable"],
	["PI_CLIPBOARD", "X11 atom name"],
	["PI_CLIPBOARD_H", "C include guard"],
	["PI_CLIPBOARD_WRITE", "C macro"],
	["PI_CODEMODE_BINARY_SMOKE_FAILED", "stdout marker of the smoke test"],
	["PI_CODEMODE_BINARY_SMOKE_OK", "stdout marker of the smoke test"],
	["PI_CODEMODE_WORKER_OK", "stdout marker of the smoke test"],
	["PI_ENV_VERSION", "cargo build-time constant shared by build.rs and main.rs"],
	["PI_GIST_TOKEN", "GitHub Actions secret name, set outside the repository"],
	["PI_NAPI_CALL", "C macro"],
	["PI_NAPI_EXPORT", "C macro"],
	["PI_NAPI_H", "C include guard"],
	["PI_RADIUS_GATEWAY", "removed variable, named only in the changelog"],
	["PI_SESSION_SNAPSHOT_ARTIFACT", "exported artifact-key constant in the evals package"],
	["PI_USER_AGENT", "test constant"],
	["PI_USER_AGENT_RE", "constant"],
	["PI_VERSION_RE", "constant"],
]);

const EXCLUDED_FILES = new Set(["scripts/rebrand-env.mjs", "scripts/rebrand-env.test.mjs", "package-lock.json"]);
const TOKEN = /(?<![A-Za-z0-9_])PI_[A-Z0-9_]*(?![A-Za-z0-9_])/g;

function listFiles(root) {
	const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, maxBuffer: 1 << 28 });
	return output.toString("utf8").split("\0").filter((file) => file && !EXCLUDED_FILES.has(file));
}

// Returns the text with every renamed token replaced, and one finding per classified or unclassified token.
export function transform(file, text) {
	const isChangelog = basename(file) === "CHANGELOG.md";
	let inUnreleased = false;
	const findings = [];
	const lines = text.split("\n").map((line, index) => {
		if (isChangelog && line.startsWith("## [")) inUnreleased = /^## \[Unreleased\]/i.test(line);
		if ((isChangelog && !inUnreleased) || line.includes(KEEP_MARKER)) return line;
		return line.replace(TOKEN, (name) => {
			const renamed = RENAMES.get(name);
			if (renamed) {
				findings.push({ line: index + 1, name, kind: "renamed" });
				return renamed;
			}
			if (!KEPT.has(name)) findings.push({ line: index + 1, name, kind: "unclassified" });
			return name;
		});
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
	return { rewritten, replacements, problems };
}

function main(argv) {
	const check = argv.includes("--check");
	const rootIndex = argv.indexOf("--root");
	const root = resolve(rootIndex === -1 ? join(fileURLToPath(import.meta.url), "../..") : argv[rootIndex + 1]);
	const { rewritten, replacements, problems } = run(root, { check });
	for (const problem of problems) {
		const hint =
			problem.kind === "renamed"
				? `use ${RENAMES.get(problem.name)}`
				: "add it to RENAMES or KEPT in scripts/rebrand-env.mjs";
		console.error(`${problem.file}:${problem.line}: ${problem.name} (${hint})`);
	}
	if (problems.length > 0) {
		console.error(check ? `rebrand-env: ${problems.length} old or unclassified name(s)` : "rebrand-env: unclassified name(s) above");
		return 1;
	}
	if (!check) console.log(`rebrand-env: ${replacements} replacement(s) in ${rewritten.length} file(s)`);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
