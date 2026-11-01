import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { settingsPath } from "./paths.ts";

/**
 * Desktop settings, shared with the bridge extension (which reads `permissions` and `rules` on every tool
 * call). Missing top-level keys fall back to the defaults below.
 */
export const DEFAULT_SETTINGS = {
	approvalMode: "supervised",
	permissions: {
		default: "ask",
		tools: { read: "allow", grep: "allow", find: "allow", ls: "allow", todo: "allow", bash: "ask", edit: "ask", write: "ask" },
	},
	rules: [
		{ id: "rm-root", name: "Recursive delete of root or home", enabled: true, target: "bash", pattern: "\\brm\\s+-[a-z]*r[a-z]*\\s+(-[a-z]+\\s+)*(/|~|\\$HOME)(\\s|/?$)", action: "block" },
		{ id: "disk", name: "Raw disk writes", enabled: true, target: "bash", pattern: "\\b(mkfs(\\.\\w+)?|dd\\s+[^|]*of=/dev/)", action: "block" },
		{ id: "sudo", name: "sudo", enabled: true, target: "bash", pattern: "(^|[;&|]\\s*)sudo\\b", action: "ask" },
		{ id: "pipe-shell", name: "Pipe download to shell", enabled: true, target: "bash", pattern: "\\b(curl|wget)\\b[^|]*\\|\\s*(ba|z)?sh\\b", action: "ask" },
		{ id: "force-push", name: "Force push", enabled: true, target: "bash", pattern: "\\bgit\\s+push\\b.*(--force\\b|-f\\b)", action: "ask" },
		{ id: "git-discard", name: "Discard git changes", enabled: true, target: "bash", pattern: "\\bgit\\s+(reset\\s+--hard|clean\\s+-[a-z]*f|checkout\\s+\\.)", action: "ask" },
		{ id: "chmod-777", name: "World-writable permissions", enabled: true, target: "bash", pattern: "\\bchmod\\s+(-R\\s+)?777\\b", action: "ask" },
		{ id: "env-files", name: ".env files", enabled: true, target: "path", pattern: "(^|/)\\.env(\\.[\\w-]+)?$", action: "ask" },
		{ id: "git-dir", name: "Inside .git", enabled: true, target: "path", pattern: "(^|/)\\.git/", action: "block" },
		{ id: "secrets", name: "SSH, AWS and GnuPG secrets", enabled: true, target: "path", pattern: "(^|/)\\.(ssh|aws|gnupg)(/|$)", action: "block" },
		// File tools are covered above; this catches the same secrets reached through shell commands.
		{ id: "sorvex-secrets", name: "Sorvex credentials", enabled: true, target: "path", pattern: "(^|/)\\.sorvex/agent/(auth\\.json|mcp-auth\\.json|desktop/ssh)", action: "block" },
		{ id: "sorvex-secrets-bash", name: "Sorvex credentials via shell", enabled: true, target: "bash", pattern: "\\.sorvex/agent/(auth|mcp-auth|desktop)|/proc/[0-9a-z$]+/(environ|mem|maps)", action: "block" },
		{ id: "desktop-api", name: "Sorvex Desktop control API", enabled: true, target: "bash", pattern: "(127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0)\\D{0,3}4517|:4517\\b", action: "block" },
		{ id: "secrets-print", name: "Print secrets (.env, env dumps, keys)", enabled: true, target: "bash", pattern: "(^|[\\s/'\"=:])\\.env(\\.[\\w.-]+)?($|[\\s'\";|&)])|(^|[;&|(]\\s*|\\bsudo\\s+(-\\S+\\s+)*)(env|printenv)\\s*($|[|;&>])|\\bprintenv\\s+\\w|\\bexport\\s+-p\\b|\\bdeclare\\s+-x\\b|\\bpm2\\s+(env|show|describe|prettylist|jlist)\\b|\\bdocker\\s+(inspect|container\\s+inspect)\\b|\\bdocker\\s+(compose\\s+)?config\\b|\\bkubectl\\s+(get|describe)\\s+secrets?\\b|/proc/[^/\\s]+/environ|\\bsystemctl\\s+show-environment\\b|\\b(id_rsa|id_ed25519|id_ecdsa|id_dsa)\\b|\\.(pem|p12|pfx|keystore|jks)\\b|\\.(npmrc|pgpass|netrc|git-credentials|my\\.cnf)\\b|\\.aws/credentials|\\.docker/config\\.json|\\.ssh/|\\bsecrets?\\.(json|ya?ml|env|toml)\\b", action: "block" },
		{ id: "secrets-bash", name: "Secrets via shell", enabled: true, target: "bash", pattern: "(~|\\$HOME|/home/[^/\\s]+|/root)/\\.(ssh|aws|gnupg)\\b", action: "block" },
	],
	reviewers: [
		{
			id: "default-reviewer",
			name: "Safety review",
			enabled: false,
			model: "",
			triggerOnTools: [],
			messagesCount: 2,
			prompt:
				"Flag destructive or irreversible commands, edits outside the task's scope, leaked secrets, disabled tests or checks, and claims the transcript does not support.",
		},
	],
	voice: {
		stt: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", keyProvider: "google", language: "" },
		tts: {
			engine: "api",
			kokoro: { voice: "af_heart", speed: 1, dtype: "q8" },
			api: {
				kind: "gemini",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				model: "gemini-2.5-flash-preview-tts",
				keyProvider: "google",
				voice: "Kore",
				speed: 1,
			},
		},
		autoSpeak: true,
		speakReplies: false,
		micThreshold: 0.02,
	},
	prompts: [] as { id: string; name: string; content: string }[],
	/** completions: a desktop notification when a response finishes while the window is not focused. */
	notifications: { completions: true },
};

export type DesktopSettings = typeof DEFAULT_SETTINGS & Record<string, unknown>;

export function readSettings(): DesktopSettings {
	try {
		const stored = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<DesktopSettings>;
		// Fill keys added after the file was written, one level into `voice` and `notifications`.
		return {
			...DEFAULT_SETTINGS,
			...stored,
			voice: { ...DEFAULT_SETTINGS.voice, ...stored.voice },
			notifications: { ...DEFAULT_SETTINGS.notifications, ...stored.notifications },
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** Writes through a temporary file and a rename, so the extension never reads a half-written file. */
export function writeSettings(settings: unknown): void {
	mkdirSync(dirname(settingsPath), { recursive: true });
	const temp = `${settingsPath}.tmp`;
	writeFileSync(temp, JSON.stringify(settings, null, 2));
	renameSync(temp, settingsPath);
}
