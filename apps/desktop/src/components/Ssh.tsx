import { Ban, Check, KeyRound, Link2, Link2Off, Loader2, Lock, Pencil, Plus, Server, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { relativeTime } from "../format.ts";
import { newId } from "../settings.ts";
import type { SorvexActions } from "../store.ts";
import { PageHeader } from "./Chrome.tsx";
import { Switch } from "./Pages.tsx";
import { Select } from "./Select.tsx";

type Policy = "read-only" | "ask" | "auto";

interface Host {
	id: string;
	alias: string;
	host: string;
	port: number;
	user: string;
	auth: "password" | "key" | "agent";
	policy: Policy;
	hasKey?: boolean;
}

interface Rule {
	id: string;
	name: string;
	pattern: string;
	enabled: boolean;
}

interface Guardrails {
	block: Rule[];
	ask: Rule[];
	readOnlyCommands: string[];
}

interface AuditEntry {
	at: number;
	alias: string;
	command: string;
	decision: string;
	exitCode?: number | null;
	reason?: string;
}

interface SshState {
	hosts: Host[];
	statuses: Record<string, string>;
	guardrails: Guardrails;
	audit: AuditEntry[];
}

const POLICIES: { value: Policy; label: string; hint: string }[] = [
	{ value: "read-only", label: "Read-only", hint: "Only inspection commands; anything else is blocked" },
	{ value: "ask", label: "Ask every time", hint: "You approve each command" },
	{ value: "auto", label: "Auto", hint: "Runs commands, but risky ones still ask and dangerous ones are blocked" },
];

function HostForm({ initial, onDone, onCancel }: { initial?: Host; onDone: () => void; onCancel: () => void }) {
	const [alias, setAlias] = useState(initial?.alias ?? "");
	const [host, setHost] = useState(initial?.host ?? "");
	const [port, setPort] = useState(String(initial?.port ?? 22));
	const [user, setUser] = useState(initial?.user ?? "");
	const [auth, setAuth] = useState<Host["auth"]>(initial?.auth ?? "password");
	const [password, setPassword] = useState("");
	const [key, setKey] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const [policy, setPolicy] = useState<Policy>(initial?.policy ?? "ask");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		setError("");
		try {
			await api("POST", "/api/ssh/hosts", {
				id: initial?.id,
				alias: alias.trim(),
				host: host.trim(),
				port: Number(port),
				user: user.trim(),
				auth,
				policy,
				// Empty secret fields keep what is stored, so editing a host never shows or needs the old secret.
				password: auth === "password" ? password : undefined,
				key: auth === "key" && key.trim() ? key : undefined,
				passphrase: auth === "key" ? passphrase : undefined,
			});
			onDone();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mcp-card mcp-form">
			<div className="mcp-form-title">{initial ? `Edit ${initial.alias}` : "Add SSH server"}</div>
			<div className="ssh-grid">
				<label>
					Alias (what the AI calls it)
					<input className="modal-input" placeholder="prod-web" value={alias} onChange={(event) => setAlias(event.target.value)} />
				</label>
				<label>
					Host or IP
					<input className="modal-input mono" placeholder="203.0.113.10" value={host} onChange={(event) => setHost(event.target.value)} />
				</label>
				<label>
					Port
					<input className="modal-input mono" value={port} onChange={(event) => setPort(event.target.value)} />
				</label>
				<label>
					User
					<input className="modal-input mono" placeholder="ubuntu" value={user} onChange={(event) => setUser(event.target.value)} />
				</label>
			</div>
			<div className="segmented">
				{(["password", "key", "agent"] as const).map((value) => (
					<button key={value} type="button" className={auth === value ? "on" : ""} onClick={() => setAuth(value)}>
						{value === "password" ? "Password" : value === "key" ? "Private key" : "SSH agent"}
					</button>
				))}
			</div>
			{auth === "password" && (
				<input
					className="modal-input"
					type="password"
					autoComplete="off"
					placeholder={initial ? "Leave empty to keep the saved password" : "Password"}
					value={password}
					onChange={(event) => setPassword(event.target.value)}
				/>
			)}
			{auth === "key" && (
				<>
					<textarea
						className="modal-input mono"
						rows={5}
						spellCheck={false}
						placeholder={initial?.hasKey ? "Leave empty to keep the saved key" : "-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
						value={key}
						onChange={(event) => setKey(event.target.value)}
					/>
					<input
						className="modal-input"
						type="password"
						autoComplete="off"
						placeholder="Key passphrase (if any)"
						value={passphrase}
						onChange={(event) => setPassphrase(event.target.value)}
					/>
				</>
			)}
			{auth === "agent" && <div className="panel-note">Uses the keys already loaded in your ssh-agent.</div>}
			<label className="panel-label">
				What the AI may do on this server
				<Select width="100%" value={policy} options={POLICIES} onChange={(value) => setPolicy(value as Policy)} />
			</label>
			<div className="panel-note">
				<Lock size={11} /> Credentials are stored on this computer only (owner-only file permissions) and are never shown to the AI or sent back to
				this window.
			</div>
			{error && <div className="mcp-error">{error}</div>}
			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
				<button type="button" className="btn-ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="btn-accent" disabled={busy || !alias || !host || !user} onClick={() => void submit()}>
					{busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Save
				</button>
			</div>
		</div>
	);
}

function RuleList({ title, rules, onChange, tone }: { title: string; rules: Rule[]; onChange: (rules: Rule[]) => void; tone: "block" | "ask" }) {
	return (
		<div className="panel-section">
			<div className="panel-section-head">
				<span>{title}</span>
				<button type="button" className="icon-btn sm" aria-label={`Add ${title} rule`} onClick={() => onChange([...rules, { id: newId(), name: "New rule", pattern: "", enabled: true }])}>
					<Plus size={13} />
				</button>
			</div>
			{rules.map((rule) => (
				<div key={rule.id} className="ssh-rule">
					{tone === "block" ? <Ban size={13} className="deny-icon" /> : <ShieldAlert size={13} className="ask-icon" />}
					<input className="modal-input ssh-rule-name" value={rule.name} onChange={(event) => onChange(rules.map((r) => (r.id === rule.id ? { ...r, name: event.target.value } : r)))} />
					<input
						className="modal-input mono ssh-rule-pattern"
						value={rule.pattern}
						placeholder="regular expression"
						onChange={(event) => onChange(rules.map((r) => (r.id === rule.id ? { ...r, pattern: event.target.value } : r)))}
					/>
					<Switch on={rule.enabled} label={`Enable ${rule.name}`} onChange={(enabled) => onChange(rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))} />
					<button type="button" className="icon-btn sm danger-icon" aria-label={`Delete ${rule.name}`} onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}>
						<Trash2 size={12} />
					</button>
				</div>
			))}
		</div>
	);
}

/**
 * SSH servers the AI can work on through the `ssh_hosts` and `ssh_exec` tools, each with a policy, plus SSH-only
 * guardrails and an audit log of every remote command.
 */
export function SshPage({ actions }: { actions: SorvexActions }) {
	const [state, setState] = useState<SshState | null>(null);
	const [editing, setEditing] = useState<Host | "new" | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [tab, setTab] = useState<"servers" | "guardrails" | "activity">("servers");
	const [rules, setRules] = useState<Guardrails | null>(null);

	const load = useCallback(() => {
		api<SshState>("GET", "/api/ssh").then(
			(next) => {
				setState(next);
				setRules((current) => current ?? next.guardrails);
			},
			(error: unknown) => actions.toast("error", String(error)),
		);
	}, [actions]);

	useEffect(load, [load]);
	useEffect(() => {
		const offAudit = serverEvents.on<AuditEntry>("ssh-audit", (entry) => setState((current) => (current ? { ...current, audit: [entry, ...current.audit] } : current)));
		const offStatus = serverEvents.on<{ alias: string; status: string }>("ssh-status", ({ alias, status }) =>
			setState((current) => (current ? { ...current, statuses: { ...current.statuses, [alias]: status } } : current)),
		);
		return () => {
			offAudit();
			offStatus();
		};
	}, []);

	const run = async (label: string, task: () => Promise<unknown>) => {
		setBusy(label);
		try {
			await task();
		} catch (error) {
			actions.toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(null);
			load();
		}
	};

	const saveRules = (next: Guardrails) => {
		setRules(next);
		void api("PUT", "/api/ssh/guardrails", next).catch((error: unknown) => actions.toast("error", String(error)));
	};

	return (
		<>
			<PageHeader
				title="SSH"
				left={
					<div className="segmented">
						{(["servers", "guardrails", "activity"] as const).map((value) => (
							<button key={value} type="button" className={tab === value ? "on" : ""} onClick={() => setTab(value)}>
								{value === "servers" ? "Servers" : value === "guardrails" ? "SSH guardrails" : "Activity"}
							</button>
						))}
					</div>
				}
				right={
					<button type="button" className="btn-accent" onClick={() => {
						setTab("servers");
						setEditing("new");
					}}>
						<Plus size={14} /> Add server
					</button>
				}
			/>
			<div className="page">
				<div className="page-inner" style={{ maxWidth: "52rem" }}>
					{tab === "servers" && (
						<>
							{editing && <HostForm initial={editing === "new" ? undefined : editing} onCancel={() => setEditing(null)} onDone={() => {
								setEditing(null);
								load();
							}} />}
							{state?.hosts.map((host) => {
								const status = state.statuses[host.alias] ?? "disconnected";
								const connected = status === "connected";
								return (
									<div key={host.id} className="mcp-card">
										<div className="mcp-card-head">
											<span className="status-dot" style={{ background: connected ? "var(--accent-green-icon)" : "var(--text-disabled)" }} title={status} />
											<Server size={14} />
											<span className="mcp-name">{host.alias}</span>
											<span className="mcp-badge">{host.auth === "key" ? "KEY" : host.auth === "agent" ? "AGENT" : "PASSWORD"}</span>
											<span className="grow" />
											<Select
												width={170}
												ariaLabel={`Policy for ${host.alias}`}
												value={host.policy}
												options={POLICIES}
												onChange={(policy) => void run(host.alias, () => api("POST", "/api/ssh/policy", { id: host.id, policy }))}
											/>
										</div>
										<div className="mcp-target mono">
											{host.user}@{host.host}:{host.port}
										</div>
										<div className="mcp-state">{connected ? "connected (shared connection open for 30 min)" : "not connected; the first command connects"}</div>
										<div className="mcp-actions">
											{busy === host.alias && <Loader2 size={13} className="spin" />}
											{connected ? (
												<button type="button" className="btn-ghost" onClick={() => void run(host.alias, () => api("POST", "/api/ssh/disconnect", { alias: host.alias }))}>
													<Link2Off size={13} /> Disconnect
												</button>
											) : (
												<button
													type="button"
													className="btn-ghost"
													onClick={() =>
														void run(host.alias, async () => {
															const result = await api<{ ok: boolean; output: string }>("POST", "/api/ssh/connect", { alias: host.alias });
															actions.toast(result.ok ? "info" : "error", result.ok ? result.output : `Could not connect: ${result.output}`);
														})
													}
												>
													<Link2 size={13} /> Connect
												</button>
											)}
											<button type="button" className="icon-btn sm" aria-label={`Edit ${host.alias}`} title="Edit" onClick={() => setEditing(host)}>
												<Pencil size={13} />
											</button>
											<button
												type="button"
												className="icon-btn sm danger-icon"
												aria-label={`Delete ${host.alias}`}
												title="Delete server and its stored credentials"
												onClick={() => window.confirm(`Delete ${host.alias} and its stored credentials?`) && void run(host.alias, () => api("POST", "/api/ssh/remove", { id: host.id }))}
											>
												<Trash2 size={13} />
											</button>
										</div>
									</div>
								);
							})}
							{state && state.hosts.length === 0 && !editing && (
								<div className="mcp-empty">
									<div className="mcp-empty-icon">
										<KeyRound size={22} />
									</div>
									<h2>No SSH servers yet</h2>
									<p>
										Add a server and the AI can inspect and operate it with the <span className="mono">ssh_exec</span> tool. Every remote command passes
										the SSH guardrails: dangerous commands are blocked, risky ones wait for your approval.
									</p>
									<button type="button" className="btn-accent" onClick={() => setEditing("new")}>
										<Plus size={14} /> Add server
									</button>
								</div>
							)}
							{!state && <div className="empty-note dots">Loading</div>}
						</>
					)}
					{tab === "guardrails" && rules && (
						<section className="card">
							<h2>SSH guardrails</h2>
							<p>
								Checked on every remote command, separately from the local guardrails. Block rules always win. Then read-only servers allow only the
								commands below, ask rules wait for your approval, and each server's policy decides the rest.
							</p>
							<RuleList title="Always block" tone="block" rules={rules.block} onChange={(block) => saveRules({ ...rules, block })} />
							<RuleList title="Always ask" tone="ask" rules={rules.ask} onChange={(ask) => saveRules({ ...rules, ask })} />
							<div className="panel-section">
								<div className="panel-section-head">
									<span>Read-only servers may run</span>
								</div>
								<textarea
									className="modal-input mono"
									rows={3}
									value={rules.readOnlyCommands.join(" ")}
									onChange={(event) => saveRules({ ...rules, readOnlyCommands: event.target.value.split(/\s+/).filter(Boolean) })}
								/>
								<div className="panel-note">State-changing subcommands (docker run, systemctl restart, git push, redirects, -delete ...) stay blocked on read-only servers.</div>
							</div>
						</section>
					)}
					{tab === "activity" && (
						<section className="card">
							<h2>Remote command activity</h2>
							<p>Every command the AI tried on your servers since the app started.</p>
							{state?.audit.length === 0 && <div className="empty-note">No remote commands yet</div>}
							{state?.audit.map((entry, index) => (
								<div key={`${entry.at}-${index}`} className="ssh-audit">
									{entry.decision === "block" || entry.decision === "denied" ? (
										<X size={13} className="deny-icon" />
									) : entry.decision === "approved" ? (
										<ShieldCheck size={13} className="ask-icon" />
									) : (
										<Check size={13} className="ok-icon" />
									)}
									<span className="mcp-badge">{entry.alias}</span>
									<span className="mono ssh-audit-command">{entry.command}</span>
									<span className="ssh-audit-meta">
										{entry.decision}
										{entry.exitCode !== undefined && entry.exitCode !== null ? ` · exit ${entry.exitCode}` : ""} · {relativeTime(entry.at)}
									</span>
									{entry.reason && <div className="panel-note ssh-audit-reason">{entry.reason}</div>}
								</div>
							))}
						</section>
					)}
				</div>
			</div>
		</>
	);
}
