/**
 * Masks credentials in tool output before the model sees it. Used by the bridge extension for every tool result
 * (local shell, file reads, MCP, SSH) and by the desktop server for SSH output.
 *
 * Example: `git remote -v` on a repo cloned with a token prints
 *   https://ghp_abc...xyz@github.com/org/repo.git  ->  https://[REDACTED github-token]@github.com/org/repo.git
 *
 * Patterns are specific token formats first, then credentials embedded in URLs, then `NAME=value` pairs whose
 * name says secret. The last group only masks values that look like opaque strings, so code such as
 * `token = getToken()` is left alone.
 */

const PATTERNS: [string, RegExp, (match: string, ...groups: string[]) => string][] = [
	["private-key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, () => "[REDACTED private-key]"],
	["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, () => "[REDACTED github-token]"],
	["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g, () => "[REDACTED gitlab-token]"],
	["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g, () => "[REDACTED anthropic-key]"],
	["openai-key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, () => "[REDACTED openai-key]"],
	["stripe-key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, () => "[REDACTED stripe-key]"],
	["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g, () => "[REDACTED google-key]"],
	["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, () => "[REDACTED slack-token]"],
	["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, () => "[REDACTED aws-key]"],
	["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => "[REDACTED jwt]"],
	["bearer", /\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)[^\s"'`]+/gi, (_m, prefix) => `${prefix}[REDACTED]`],
	// scheme://user:password@host and scheme://<long token>@host
	["url-credentials", /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+:[^\s/@]+|[A-Za-z0-9_-]{16,})@/gi, (_m, scheme) => `${scheme}[REDACTED]@`],
	// NAME=value / "name": "value" where the name says secret and the value looks opaque.
	[
		"secret-value",
		/((?:^|[\s"'{,(])["']?[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|dsn|database_url|connection_string)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?)([^\s"'`,;(){}]{8,})(?![(\w])/gi,
		(_m, prefix) => `${prefix}[REDACTED]`,
	],
];

export function redactSecrets(text: string): { text: string; count: number } {
	let count = 0;
	let result = text;
	for (const [, pattern, replace] of PATTERNS) {
		result = result.replace(pattern, (...args: unknown[]) => {
			const match = String(args[0]);
			if (match.includes("[REDACTED")) return match;
			count++;
			return replace(match, ...(args.slice(1, -2) as string[]));
		});
	}
	return { text: result, count };
}
