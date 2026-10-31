import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub.ts";
import { redactSecrets } from "../extension/redact.ts";
import { desktopDir } from "./paths.ts";
import { readSettings } from "./settings.ts";

/**
 * SSH hosts the agent may run commands on, through the system `ssh` client.
 *
 * Credentials live in ~/.sorvex/agent/desktop/ssh (directory 0700, files 0600). They are never sent back to the UI
 * or to the model: the model only knows host aliases. Passwords and key passphrases reach `ssh` through a tiny
 * askpass script that reads them from an environment variable set for that one ssh process.
 *
 * Every remote command goes through `checkCommand` (block / ask / allow, per host policy) here on the server, and
 * only the bridge extension, which holds a per-launch token, can call `exec`. A model that tries to reach this API
 * from its local shell has no token.
 */

export type SshPolicy = "read-only" | "ask" | "auto";

export interface SshHost {
	id: string;
	alias: string;
	host: string;
	port: number;
	user: string;
	auth: "password" | "key" | "agent";
	policy: SshPolicy;
	/** Stored only on disk; never returned by `publicHosts`. */
	password?: string;
	passphrase?: string;
	hasKey?: boolean;
}

export interface SshRule {
	id: string;
	name: string;
	pattern: string;
	enabled: boolean;
}

export interface SshGuardrails {
	block: SshRule[];
	ask: SshRule[];
	/** Read-only hosts may run only commands whose first word is in this list (and no blocked/ask pattern). */
	readOnlyCommands: string[];
}

export const DEFAULT_SSH_GUARDRAILS: SshGuardrails = {
	block: [
		{ id: "rm-root", name: "Recursive delete of system paths", enabled: true, pattern: "\\brm\\s+(-[a-z]*\\s+)*-[a-z]*[rR][a-z]*\\s+(-[a-z]+\\s+)*(/|/\\*|~|\\$HOME|/(etc|usr|var|boot|bin|sbin|lib|lib64|opt|root|home|srv))(\\s|/?$)" },
		{ id: "disk", name: "Format or overwrite disks", enabled: true, pattern: "\\b(mkfs(\\.\\w+)?|wipefs|fdisk|parted|sgdisk)\\b|\\bdd\\b[^|]*\\bof=/dev/|>\\s*/dev/(sd|nvme|vd|xvd|hd)" },
		{ id: "power", name: "Shutdown or reboot", enabled: true, pattern: "\\b(shutdown|reboot|poweroff|halt)\\b|\\binit\\s+[06]\\b|\\bsystemctl\\s+(reboot|poweroff|halt|kexec)\\b" },
		{ id: "fork-bomb", name: "Fork bomb", enabled: true, pattern: ":\\(\\)\\s*\\{\\s*:\\|:&\\s*\\};:" },
		{ id: "lockout-ssh", name: "Stop or break SSH access", enabled: true, pattern: "\\b(systemctl|service)\\s+(stop|disable|mask)\\s+(ssh|sshd)\\b|\\bpkill\\b.*\\bsshd\\b|\\bkill\\s+-9\\s+1\\b|sshd_config|authorized_keys" },
		{ id: "firewall", name: "Flush or disable the firewall", enabled: true, pattern: "\\biptables\\s+(-F|--flush|-P\\s+INPUT\\s+DROP)|\\bnft\\s+flush\\b|\\bufw\\s+(disable|reset|default\\s+deny)" },
		{ id: "accounts", name: "Change users or passwords", enabled: true, pattern: "\\b(userdel|usermod|passwd|chpasswd|deluser|groupdel)\\b|/etc/(shadow|sudoers)" },
		{ id: "perms-root", name: "Recursive permission change on system paths", enabled: true, pattern: "\\bch(mod|own)\\s+(-[a-zA-Z]*R[a-zA-Z]*\\s+)\\S+\\s+(/|/(etc|usr|var|bin|sbin|lib|boot|root|home))(\\s|/?$)" },
		{ id: "pipe-shell", name: "Pipe a download into a shell", enabled: true, pattern: "\\b(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(ba|z|da)?sh\\b" },
		{ id: "cron-wipe", name: "Delete all cron jobs", enabled: true, pattern: "\\bcrontab\\s+-r\\b" },
		// Secrets would land in the model's context, the provider's logs, and the session file.
		{ id: "secrets", name: "Read secrets (.env, env dumps, keys, credentials)", enabled: true, pattern: "(^|[\\s/'\"=:])\\.env(\\.[\\w.-]+)?($|[\\s'\";|&)])|(^|[;&|(]\\s*|\\bsudo\\s+(-\\S+\\s+)*)(env|printenv)\\s*($|[|;&>])|\\bprintenv\\s+\\w|\\bexport\\s+-p\\b|\\bdeclare\\s+-x\\b|\\bpm2\\s+(env|show|describe|prettylist|jlist)\\b|\\bdocker\\s+(inspect|container\\s+inspect)\\b|\\bdocker\\s+(compose\\s+)?config\\b|\\bkubectl\\s+(get|describe)\\s+secrets?\\b|/proc/[^/\\s]+/environ|\\bsystemctl\\s+show-environment\\b|\\b(id_rsa|id_ed25519|id_ecdsa|id_dsa)\\b|\\.(pem|p12|pfx|keystore|jks)\\b|\\.(npmrc|pgpass|netrc|git-credentials|my\\.cnf)\\b|\\.aws/credentials|\\.docker/config\\.json|\\.ssh/|\\bsecrets?\\.(json|ya?ml|env|toml)\\b" },
	],
	ask: [
		{ id: "sudo", name: "sudo", enabled: true, pattern: "(^|[;&|(]\\s*)sudo\\b" },
		{ id: "packages", name: "Install or remove packages", enabled: true, pattern: "\\b(apt|apt-get|yum|dnf|pacman|zypper|apk|snap|pip3?|npm|pnpm|yarn)\\s+(install|remove|purge|uninstall|upgrade|update|-S|-R)\\b" },
		{ id: "services", name: "Start, stop or restart services", enabled: true, pattern: "\\b(systemctl|service)\\s+(start|stop|restart|reload|enable|disable)\\b" },
		{ id: "delete", name: "Delete files", enabled: true, pattern: "\\b(rm|rmdir|shred|unlink)\\b|\\bfind\\b.*\\s-delete\\b" },
		{ id: "containers", name: "Change containers or VMs", enabled: true, pattern: "\\b(docker|podman|kubectl|virsh|qm|pct|vagrant)\\s+(rm|rmi|kill|stop|restart|delete|destroy|down|prune|system\\s+prune|undefine|shutdown|reset)\\b" },
		{ id: "kill", name: "Kill processes", enabled: true, pattern: "\\b(kill|pkill|killall)\\b" },
		{ id: "write-etc", name: "Write under /etc", enabled: true, pattern: "(>|\\btee\\b|\\bsed\\s+-i\\b|\\bmv\\b|\\bcp\\b).*\\s/etc/" },
		{ id: "git-push", name: "git push", enabled: true, pattern: "\\bgit\\s+push\\b" },
	],
	readOnlyCommands: [
		"ls", "cat", "head", "tail", "less", "grep", "rg", "find", "du", "df", "free", "uptime", "uname", "hostname", "whoami", "id", "ps", "top",
		"pgrep", "ss", "netstat", "ip", "lsblk", "lscpu", "lsof", "date", "w", "who", "last", "journalctl", "dmesg", "stat", "wc", "file",
		"which", "echo", "pwd", "systemctl", "docker", "podman", "kubectl", "git", "nproc", "vmstat", "iostat", "virsh", "qm",
	],
};

/** Subcommands that change state; read-only hosts refuse them even for allowlisted programs. */
const READ_ONLY_DENY = /\b(systemctl\s+(start|stop|restart|reload|enable|disable|mask)|docker\s+(run|rm|rmi|kill|stop|start|restart|exec|build|pull|push|compose\s+up|compose\s+down)|kubectl\s+(apply|delete|create|edit|patch|scale|rollout|exec)|git\s+(push|commit|reset|checkout|clean|merge|rebase|pull)|virsh\s+(start|shutdown|destroy|undefine|reboot)|qm\s+(start|stop|shutdown|destroy|reset))\b|>|\btee\b|\bsed\s+-i\b|\s-delete\b|\s-exec\b/;

/** `rule` names what an "ask" came from, so "Allow for this session" can cover the same kind of command. */
export type SshDecision = { decision: "allow" | "ask" | "block"; reason?: string; rule?: string };

const sshDir = join(desktopDir, "ssh");
const hostsPath = join(sshDir, "hosts.json");
const keysDir = join(sshDir, "keys");
const controlDir = join(sshDir, "cm");
const knownHosts = join(sshDir, "known_hosts");
const askpass = join(sshDir, "askpass.sh");

function ensureDirs(): void {
	for (const dir of [sshDir, keysDir, controlDir]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}
	if (!existsSync(askpass)) {
		writeFileSync(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$SORVEX_SSH_SECRET"\n', { mode: 0o700 });
	}
}

function compile(pattern: string): RegExp | undefined {
	try {
		return new RegExp(pattern, "i");
	} catch {
		return undefined;
	}
}

export function sshGuardrails(): SshGuardrails {
	const stored = (readSettings() as { ssh?: Partial<SshGuardrails> & { addedRules?: string[] } }).ssh;
	if (!stored) return DEFAULT_SSH_GUARDRAILS;
	// Default rules added after the user saved their own list are included, unless the user deleted them since.
	const known = new Set(stored.addedRules ?? [...(stored.block ?? []), ...(stored.ask ?? [])].map((rule) => rule.id));
	const merge = (list: SshRule[] | undefined, defaults: SshRule[]) => [
		...(list ?? []),
		...defaults.filter((rule) => !known.has(rule.id) && !(list ?? []).some((r) => r.id === rule.id)),
	];
	return {
		block: merge(stored.block, DEFAULT_SSH_GUARDRAILS.block),
		ask: merge(stored.ask, DEFAULT_SSH_GUARDRAILS.ask),
		readOnlyCommands: stored.readOnlyCommands ?? DEFAULT_SSH_GUARDRAILS.readOnlyCommands,
	};
}

/** Block rules always win; then read-only hosts allow only inspection commands; then ask rules; then the policy. */
export function checkCommand(policy: SshPolicy, command: string): SshDecision {
	const rules = sshGuardrails();
	for (const rule of rules.block) {
		if (rule.enabled && compile(rule.pattern)?.test(command)) return { decision: "block", reason: `Blocked by SSH guardrail "${rule.name}"` };
	}
	if (policy === "read-only") {
		// Every command in a pipeline or list must be an allowlisted program, used without a state-changing subcommand.
		const segments = command.split(/\|\||&&|[|;&\n]/).map((part) => part.trim()).filter(Boolean);
		for (const segment of segments) {
			const program = segment.replace(/^(\w+=\S*\s+)*/, "").split(/\s+/)[0] ?? "";
			if (!rules.readOnlyCommands.includes(program.replace(/^.*\//, ""))) {
				return { decision: "block", reason: `This host is read-only and "${program}" is not an allowed inspection command` };
			}
		}
		if (READ_ONLY_DENY.test(command)) return { decision: "block", reason: "This host is read-only and the command changes state" };
		if (/\$\(|`/.test(command)) return { decision: "block", reason: "This host is read-only; command substitution is not allowed" };
	}
	for (const rule of rules.ask) {
		if (rule.enabled && compile(rule.pattern)?.test(command)) return { decision: "ask", reason: `SSH guardrail "${rule.name}" requires approval`, rule: rule.id };
	}
	if (policy === "ask") return { decision: "ask", reason: "This host asks before every command", rule: "host" };
	return { decision: "allow" };
}

function loadHosts(): SshHost[] {
	try {
		return JSON.parse(readFileSync(hostsPath, "utf8")) as SshHost[];
	} catch {
		return [];
	}
}

function saveHosts(hosts: SshHost[]): void {
	ensureDirs();
	writeFileSync(hostsPath, JSON.stringify(hosts, null, 2), { mode: 0o600 });
	chmodSync(hostsPath, 0o600);
}

interface AuditEntry {
	at: number;
	alias: string;
	command: string;
	decision: SshDecision["decision"] | "approved" | "denied";
	exitCode?: number | null;
	reason?: string;
}

export class SshManager {
	/** Only the bridge extension receives this, through the agent's environment, and removes it from there. */
	readonly token = randomBytes(24).toString("hex");
	private readonly hub: Hub;
	private readonly audit: AuditEntry[] = [];

	constructor(hub: Hub) {
		this.hub = hub;
		ensureDirs();
	}

	/** Hosts without secrets, for the UI and the model. */
	publicHosts(): Omit<SshHost, "password" | "passphrase">[] {
		return loadHosts().map(({ password: _p, passphrase: _pp, ...host }) => ({ ...host, hasKey: existsSync(join(keysDir, host.id)) }));
	}

	auditLog(): AuditEntry[] {
		return [...this.audit].reverse();
	}

	private record(entry: AuditEntry): void {
		entry.command = redactSecrets(entry.command).text;
		this.audit.push(entry);
		if (this.audit.length > 300) this.audit.shift();
		this.hub.broadcast("ssh-audit", entry);
	}

	/** Adds or updates a host. Empty secret fields keep the stored ones, so editing never needs re-entering them. */
	save(input: Partial<SshHost> & { key?: string }): { id: string } {
		const hosts = loadHosts();
		const alias = String(input.alias ?? "").trim();
		if (!/^[A-Za-z0-9_.-]+$/.test(alias)) throw new Error("Alias may only use letters, digits, '.', '-' and '_'");
		const host = String(input.host ?? "").trim();
		const user = String(input.user ?? "").trim();
		if (!/^[A-Za-z0-9_.:-]+$/.test(host)) throw new Error("Host must be a hostname or IP address");
		if (!/^[A-Za-z0-9_.-]+$/.test(user)) throw new Error("User name is not valid");
		const port = Number(input.port ?? 22);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1-65535");
		const existing = hosts.find((entry) => entry.id === input.id);
		if (hosts.some((entry) => entry.alias === alias && entry.id !== input.id)) throw new Error(`Alias "${alias}" is already used`);
		const id = existing?.id ?? randomUUID();
		const next: SshHost = {
			id,
			alias,
			host,
			port,
			user,
			auth: input.auth === "key" ? "key" : input.auth === "agent" ? "agent" : "password",
			policy: input.policy === "read-only" || input.policy === "auto" ? input.policy : "ask",
			password: input.password ? String(input.password) : existing?.password,
			passphrase: input.passphrase ? String(input.passphrase) : existing?.passphrase,
		};
		if (input.key) {
			const key = String(input.key).trim();
			if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new Error("That does not look like a private key (PEM or OpenSSH format)");
			writeFileSync(join(keysDir, id), `${key}\n`, { mode: 0o600 });
			chmodSync(join(keysDir, id), 0o600);
		}
		if (next.auth === "key" && !existsSync(join(keysDir, id))) throw new Error("Paste a private key for key authentication");
		if (next.auth === "password" && !next.password) throw new Error("Enter a password for password authentication");
		saveHosts(existing ? hosts.map((entry) => (entry.id === id ? next : entry)) : [...hosts, next]);
		return { id };
	}

	async remove(id: string): Promise<void> {
		const host = loadHosts().find((entry) => entry.id === id);
		if (host) await this.disconnect(host.alias).catch(() => undefined);
		saveHosts(loadHosts().filter((entry) => entry.id !== id));
		rmSync(join(keysDir, id), { force: true });
	}

	setPolicy(id: string, policy: SshPolicy): void {
		saveHosts(loadHosts().map((entry) => (entry.id === id ? { ...entry, policy } : entry)));
	}

	private find(alias: string): SshHost {
		const host = loadHosts().find((entry) => entry.alias === alias);
		if (!host) throw new Error(`No SSH host named "${alias}". Known hosts: ${loadHosts().map((entry) => entry.alias).join(", ") || "none"}`);
		return host;
	}

	/** ssh arguments and environment for a host. Host keys are pinned on first use in our own known_hosts. */
	private sshArgs(host: SshHost): { args: string[]; env: NodeJS.ProcessEnv } {
		const args = [
			"-p", String(host.port),
			"-o", `ControlPath=${join(controlDir, "%C")}`,
			"-o", "ControlMaster=auto",
			"-o", "ControlPersist=30m",
			"-o", "StrictHostKeyChecking=accept-new",
			"-o", `UserKnownHostsFile=${knownHosts}`,
			"-o", "ConnectTimeout=15",
			"-o", "ServerAliveInterval=30",
			"-o", "NumberOfPasswordPrompts=1",
		];
		const env: NodeJS.ProcessEnv = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" };
		if (host.auth === "key") {
			args.push("-i", join(keysDir, host.id), "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey");
			if (host.passphrase) env.SORVEX_SSH_SECRET = host.passphrase;
		} else if (host.auth === "password") {
			args.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
			env.SORVEX_SSH_SECRET = host.password ?? "";
		} else {
			env.SSH_ASKPASS_REQUIRE = "never";
		}
		args.push(`${host.user}@${host.host}`);
		return { args, env };
	}

	private run(host: SshHost, extra: string[], command: string | undefined, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; truncated: boolean }> {
		const { args, env } = this.sshArgs(host);
		const target = args.pop()!;
		const finalArgs = [...args, ...extra, target, ...(command !== undefined ? ["--", command] : [])];
		return new Promise((resolve) => {
			// setsid: no controlling terminal, so ssh always uses the askpass helper instead of prompting.
			const child = spawn("setsid", ["-w", "ssh", ...finalArgs], { env, stdio: ["ignore", "pipe", "pipe"] });
			const limit = 60_000;
			let stdout = "";
			let stderr = "";
			let truncated = false;
			child.stdout.on("data", (chunk: Buffer) => {
				if (stdout.length < limit) stdout += chunk.toString("utf8");
				else truncated = true;
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < limit) stderr += chunk.toString("utf8");
			});
			const timer = setTimeout(() => {
				truncated = true;
				stderr += `\n[timed out after ${Math.round(timeoutMs / 1000)}s]`;
				child.kill("SIGTERM");
			}, timeoutMs);
			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout: stdout.slice(0, limit), stderr: stderr.slice(0, limit), code, truncated });
			});
		});
	}

	async status(alias: string): Promise<"connected" | "disconnected"> {
		const host = this.find(alias);
		const result = await this.run(host, ["-O", "check"], undefined, 5000);
		return result.code === 0 ? "connected" : "disconnected";
	}

	async statuses(): Promise<Record<string, string>> {
		const entries = await Promise.all(loadHosts().map(async (host) => [host.alias, await this.status(host.alias).catch(() => "disconnected")] as const));
		return Object.fromEntries(entries);
	}

	/** Opens the shared connection and runs a harmless command to prove it works. */
	async connect(alias: string): Promise<{ ok: boolean; output: string }> {
		const host = this.find(alias);
		const result = await this.run(host, [], "echo connected: $(hostname) $(uname -sr)", 20_000);
		const ok = result.code === 0;
		this.hub.broadcast("ssh-status", { alias, status: ok ? "connected" : "disconnected" });
		return { ok, output: ok ? result.stdout.trim() : (result.stderr || result.stdout).trim() };
	}

	async disconnect(alias: string): Promise<void> {
		const host = this.find(alias);
		await this.run(host, ["-O", "exit"], undefined, 5000);
		this.hub.broadcast("ssh-status", { alias, status: "disconnected" });
	}

	check(alias: string, command: string): SshDecision & { policy: SshPolicy; key?: string } {
		const host = this.find(alias);
		const decision = checkCommand(host.policy, command);
		// Blocked attempts never reach `exec`, so record them here to keep the activity log complete.
		if (decision.decision === "block") this.record({ at: Date.now(), alias, command, decision: "block", reason: decision.reason });
		return { ...decision, policy: host.policy, key: decision.rule ? `ssh:${alias}:${decision.rule}` : undefined };
	}

	/**
	 * Runs a command for the agent. The decision is made again here, so a caller cannot skip it: blocked commands
	 * never run, and "ask" commands run only with `approved` from the extension after the user approved them.
	 */
	async exec(token: string, alias: string, command: string, approved: boolean, timeoutSeconds = 120) {
		if (token !== this.token) throw new Error("Not allowed");
		const host = this.find(alias);
		const decision = checkCommand(host.policy, command);
		if (decision.decision === "block") {
			this.record({ at: Date.now(), alias, command, decision: "block", reason: decision.reason });
			throw new Error(`${decision.reason}. The command was not run. Do not retry it; ask the user.`);
		}
		if (decision.decision === "ask" && !approved) {
			this.record({ at: Date.now(), alias, command, decision: "denied", reason: decision.reason });
			throw new Error("The user did not approve this command. It was not run.");
		}
		const result = await this.run(host, [], command, Math.min(Math.max(timeoutSeconds, 5), 900) * 1000);
		this.record({ at: Date.now(), alias, command, decision: decision.decision === "ask" || approved ? "approved" : "allow", exitCode: result.code });
		// Mask credentials here as well, so nothing downstream (extension, logs) ever holds them.
		return { ...result, stdout: redactSecrets(result.stdout).text, stderr: redactSecrets(result.stderr).text };
	}

}
