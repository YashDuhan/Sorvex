import { ChevronDown, ChevronRight, Loader2, LogIn, Plug, Plus, RefreshCw, RotateCcw, Shield, ShieldOff, ShieldQuestion, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Permission } from "../settings.ts";
import type { SorvexActions, State } from "../store.ts";
import { PageHeader } from "./Chrome.tsx";
import { Switch } from "./Pages.tsx";
import { Select } from "./Select.tsx";

interface McpServer {
	name: string;
	scope: string;
	source: string;
	enabled: boolean;
	exposure?: string;
	transport: string;
	state: string;
	tools: string[];
	error?: string;
	target?: string;
	kind?: "stdio" | "http";
}

interface McpReport {
	servers: McpServer[];
	errors: string[];
	notices: string[];
	note?: string;
	globalPath: string;
	projectPath: string;
	projectTrusted: boolean;
}

const STATE_COLOR: Record<string, string> = {
	connected: "var(--accent-green-icon)",
	connecting: "var(--accent-yellow-strong)",
	idle: "var(--accent-yellow-strong)",
	"needs-auth": "var(--accent-red)",
	failed: "var(--accent-red)",
};

/** The name Sorvex's MCP extension registers a server tool under (extensions/mcp/tools.ts). */
const toolKey = (server: string, tool: string) => `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

/** Splits "a 'b c' d" into ["a", "b c", "d"]. */
function splitArgs(input: string): string[] {
	return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

function parsePairs(input: string, separator: "=" | ":"): Record<string, string> | undefined {
	const entries = input
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const at = line.indexOf(separator);
			return at === -1 ? undefined : ([line.slice(0, at).trim(), line.slice(at + 1).trim()] as const);
		})
		.filter((entry): entry is readonly [string, string] => entry !== undefined);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

interface Template {
	name: string;
	description: string;
	transport: "stdio" | "http";
	command?: string;
	args?: string;
	url?: string;
	headers?: string;
}

/** Common servers. Picking one only fills the form; nothing runs until you add it. */
const TEMPLATES: Template[] = [
	{ name: "filesystem", description: "Read and write files in a folder", transport: "stdio", command: "npx", args: "-y @modelcontextprotocol/server-filesystem ." },
	{ name: "fetch", description: "Fetch web pages as markdown", transport: "stdio", command: "uvx", args: "mcp-server-fetch" },
	{ name: "playwright", description: "Drive a browser", transport: "stdio", command: "npx", args: "-y @playwright/mcp@latest" },
	{ name: "github", description: "GitHub issues, PRs and code", transport: "http", url: "https://api.githubcopilot.com/mcp/", headers: "Authorization: Bearer ${GITHUB_TOKEN}" },
	{ name: "context7", description: "Up-to-date library docs", transport: "http", url: "https://mcp.context7.com/mcp" },
];

function AddServerForm({
	onDone,
	onCancel,
	cwd,
	trusted,
	template,
}: {
	onDone: () => void;
	onCancel: () => void;
	cwd: string;
	trusted: boolean;
	template?: Template;
}) {
	const [name, setName] = useState(template?.name ?? "");
	const [transport, setTransport] = useState<"stdio" | "http">(template?.transport ?? "stdio");
	const [scope, setScope] = useState<"global" | "project">("global");
	const [command, setCommand] = useState(template?.command ?? "");
	const [args, setArgs] = useState(template?.args ?? "");
	const [env, setEnv] = useState("");
	const [url, setUrl] = useState(template?.url ?? "");
	const [headers, setHeaders] = useState(template?.headers ?? "");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		setBusy(true);
		setError("");
		const config =
			transport === "stdio"
				? { command: command.trim(), args: splitArgs(args), env: parsePairs(env, "=") }
				: { url: url.trim(), headers: parsePairs(headers, ":") };
		try {
			await api("POST", "/api/mcp/add", { cwd, scope, name: name.trim(), config });
			onDone();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mcp-card mcp-form">
			<div className="mcp-form-title">Add MCP server</div>
			<input className="modal-input" placeholder="Server name" value={name} onChange={(event) => setName(event.target.value)} />
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
				<div className="segmented">
					{(["stdio", "http"] as const).map((value) => (
						<button key={value} type="button" className={transport === value ? "on" : ""} onClick={() => setTransport(value)}>
							{value.toUpperCase()}
						</button>
					))}
				</div>
				<div className="segmented">
					<button type="button" className={scope === "global" ? "on" : ""} onClick={() => setScope("global")}>
						Global
					</button>
					<button type="button" className={scope === "project" ? "on" : ""} title={trusted ? undefined : "This folder is not trusted, so Sorvex will not load project servers"} onClick={() => setScope("project")}>
						This project
					</button>
				</div>
			</div>
			{transport === "stdio" ? (
				<>
					<input className="modal-input mono" placeholder="Command (e.g. npx, uvx, node)" value={command} onChange={(event) => setCommand(event.target.value)} />
					<input className="modal-input mono" placeholder="Arguments (space-separated)" value={args} onChange={(event) => setArgs(event.target.value)} />
					<textarea className="modal-input mono" rows={2} placeholder={"Environment, one per line: KEY=value or KEY=${ENV_VAR}"} value={env} onChange={(event) => setEnv(event.target.value)} />
				</>
			) : (
				<>
					<input className="modal-input mono" placeholder="URL (e.g. https://example.com/mcp)" value={url} onChange={(event) => setUrl(event.target.value)} />
					<textarea className="modal-input mono" rows={2} placeholder={"Headers, one per line: Authorization: Bearer ${TOKEN}"} value={headers} onChange={(event) => setHeaders(event.target.value)} />
				</>
			)}
			{error && <div className="warn-text" style={{ color: "var(--accent-red)" }}>{error}</div>}
			<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
				<button type="button" className="btn-ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="btn-accent" disabled={busy || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())} onClick={() => void submit()}>
					{busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Add
				</button>
			</div>
		</div>
	);
}

function ServerCard({ server, report, onChanged, actions }: { server: McpServer; report: McpReport; onChanged: () => void; actions: SorvexActions }) {
	const [busy, setBusy] = useState(false);
	const run = async (task: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await task();
			onChanged();
		} catch (error) {
			actions.toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy(false);
		}
	};
	const state = server.enabled ? server.state : "disabled";
	const removable = server.source === report.globalPath || server.source === report.projectPath;
	return (
		<div className={`mcp-card${server.enabled ? "" : " disabled"}`}>
			<div className="mcp-card-head">
				<span className="status-dot" style={{ background: STATE_COLOR[state] ?? "var(--text-disabled)" }} title={state} />
				<span className="mcp-name">{server.name}</span>
				<span className="mcp-badge">{server.kind === "http" ? "HTTP" : "STDIO"}</span>
				<span className="mcp-badge">{server.tools.length} tools</span>
				<span className="mcp-badge">{server.scope}</span>
				<span className="grow" />
				<Switch on={server.enabled} label={`Enable ${server.name}`} onChange={(enabled) => void run(() => api("POST", "/api/mcp/enabled", { source: server.source, name: server.name, enabled }))} />
			</div>
			{server.target && <div className="mcp-target mono">{server.target}</div>}
			<div className="mcp-state">{state}</div>
			{server.error && <div className="mcp-error">{server.error}</div>}
			<div className="mcp-actions">
				<span className="mcp-exposure-label">Exposure</span>
				<Select
					width={130}
					ariaLabel={`Exposure for ${server.name}`}
					value={server.exposure ?? "codemode"}
					options={[
						{ value: "codemode", label: "codemode", hint: "Called from code" },
						{ value: "deferred", label: "deferred", hint: "Found via tool search" },
						{ value: "direct", label: "direct", hint: "Listed as tools" },
						{ value: "hidden", label: "hidden", hint: "Not offered" },
					]}
					onChange={(exposure) => void run(() => api("POST", "/api/mcp/exposure", { source: server.source, name: server.name, exposure }))}
				/>
				<span className="grow" />
				{busy && <Loader2 size={13} className="spin" />}
				{server.state === "needs-auth" && (
					<button type="button" className="btn-ghost" onClick={() => void run(() => api("POST", "/api/mcp/command", { action: "login", name: server.name }))}>
						<LogIn size={13} /> Sign in
					</button>
				)}
				<button type="button" className="icon-btn sm" title="Refresh status" aria-label={`Refresh ${server.name}`} onClick={onChanged}>
					<RefreshCw size={13} />
				</button>
				<button
					type="button"
					className="icon-btn sm"
					title="Reconnect in the agent"
					aria-label={`Reconnect ${server.name}`}
					onClick={() => void run(() => api("POST", "/api/mcp/command", { action: "reconnect", name: server.name }))}
				>
					<RotateCcw size={13} />
				</button>
				{removable && (
					<button
						type="button"
						className="icon-btn sm danger-icon"
						title="Delete server"
						aria-label={`Delete ${server.name}`}
						onClick={() =>
							window.confirm(`Remove MCP server "${server.name}"?`) &&
							void run(() => api("POST", "/api/mcp/remove", { scope: server.source === report.projectPath ? "project" : "global", name: server.name }))
						}
					>
						<Trash2 size={13} />
					</button>
				)}
			</div>
		</div>
	);
}

/** Tools per server with Ask / Allow / Deny, stored in the same permissions the bridge extension enforces. */
function ToolListSidebar({ servers, state, actions }: { servers: McpServer[]; state: State; actions: SorvexActions }) {
	const [open, setOpen] = useState<Record<string, boolean>>({});
	const settings = state.settings;
	if (!settings) return null;
	const { permissions } = settings;
	const set = (key: string, permission: Permission) =>
		void actions.saveSettings({ ...settings, permissions: { ...permissions, tools: { ...permissions.tools, [key]: permission } } });
	const chips: [Permission, string, ReactNode][] = [
		["ask", "Ask", <ShieldQuestion key="ask" size={12} />],
		["allow", "Allow", <Shield key="allow" size={12} />],
		["deny", "Deny", <ShieldOff key="deny" size={12} />],
	];
	return (
		<aside className="mcp-tools">
			<div className="mcp-tools-head">Tools</div>
			{servers.length === 0 && <div className="empty-note">No servers</div>}
			{servers.map((server) => (
				<div key={server.name} style={{ opacity: server.enabled ? 1 : 0.4 }}>
					<button type="button" className="mcp-tools-server" onClick={() => setOpen({ ...open, [server.name]: !open[server.name] })}>
						{open[server.name] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
						<span className="status-dot" style={{ background: STATE_COLOR[server.enabled ? server.state : "disabled"] ?? "var(--text-disabled)" }} />
						<span className="mcp-name">{server.name}</span>
						<span className="mcp-badge">{server.tools.length}</span>
					</button>
					{open[server.name] &&
						server.tools.map((tool) => {
							const key = toolKey(server.name, tool);
							const effective = permissions.tools[key] ?? permissions.default;
							return (
								<div key={tool} className="mcp-tool">
									<div className="mcp-tool-name" title={key}>
										{tool}
									</div>
									<div className="perm-chips">
										{chips.map(([permission, label, icon]) => (
											<button
												key={permission}
												type="button"
												className={`perm-chip wide ${permission}${effective === permission ? " on" : ""}`}
												onClick={() => set(key, permission)}
											>
												{icon} {label}
											</button>
										))}
									</div>
								</div>
							);
						})}
				</div>
			))}
		</aside>
	);
}

export function McpPage({ state, actions }: { state: State; actions: SorvexActions }) {
	const [report, setReport] = useState<McpReport | null>(null);
	const [loading, setLoading] = useState(false);
	const [view, setView] = useState<"servers" | "json">("servers");
	const [adding, setAdding] = useState<{ template?: Template } | null>(null);
	const [json, setJson] = useState<{ path: string; text: string } | null>(null);

	const load = useCallback(() => {
		setLoading(true);
		api<McpReport>("GET", `/api/mcp?cwd=${encodeURIComponent(state.cwd)}`)
			.then(setReport, (error: unknown) => actions.toast("error", String(error)))
			.finally(() => setLoading(false));
	}, [state.cwd, actions]);

	useEffect(load, [load]);
	useEffect(() => {
		if (view === "json") void api<{ path: string; text: string }>("GET", "/api/mcp/raw").then(setJson);
	}, [view]);

	const connected = report?.servers.filter((server) => server.enabled && server.state === "connected").length ?? 0;
	const toolCount = report?.servers.reduce((total, server) => total + server.tools.length, 0) ?? 0;

	return (
		<>
			<PageHeader
				title="MCP"
				left={
					<div className="segmented">
						<button type="button" className={view === "servers" ? "on" : ""} onClick={() => setView("servers")}>
							Servers
						</button>
						<button type="button" className={view === "json" ? "on" : ""} onClick={() => setView("json")}>
							JSON
						</button>
					</div>
				}
				right={
					<>
						<button type="button" className="icon-btn" title="Reload all" aria-label="Reload all" onClick={load}>
							{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
						</button>
						<button type="button" className="btn-accent" onClick={() => {
							setView("servers");
							setAdding({});
						}}>
							<Plus size={14} /> Add server
						</button>
					</>
				}
			/>
			<div className="mcp-page">
				<div className="mcp-main">
					{report && report.servers.length > 0 && (
						<div className="mcp-summary">
							<span>
								<b>{report.servers.length}</b> server{report.servers.length === 1 ? "" : "s"}
							</span>
							<span>
								<b>{connected}</b> connected
							</span>
							<span>
								<b>{toolCount}</b> tools
							</span>
							<span className="mono mcp-path">{report.globalPath}</span>
						</div>
					)}
					{view === "servers" ? (
						<div className="mcp-list">
							{adding && report && (
								<AddServerForm
									key={adding.template?.name ?? "blank"}
									cwd={state.cwd}
									trusted={report.projectTrusted}
									template={adding.template}
									onCancel={() => setAdding(null)}
									onDone={() => {
										setAdding(null);
										load();
									}}
								/>
							)}
							{report?.servers.map((server) => (
								<ServerCard key={`${server.source}-${server.name}`} server={server} report={report} onChanged={load} actions={actions} />
							))}
							{report && report.servers.length === 0 && !adding && (
								<div className="mcp-empty">
									<div className="mcp-empty-icon">
										<Plug size={22} />
									</div>
									<h2>No MCP servers yet</h2>
									<p>
										MCP servers give Sorvex extra tools: browsers, issue trackers, databases, docs. Servers added here are shared with
										<span className="mono"> sorvex </span>in the terminal.
									</p>
									<button type="button" className="btn-accent" onClick={() => setAdding({})}>
										<Plus size={14} /> Add server
									</button>
									<div className="mcp-templates-head">Or start from a template</div>
									<div className="mcp-templates">
										{TEMPLATES.map((template) => (
											<button key={template.name} type="button" className="mcp-template" onClick={() => setAdding({ template })}>
												<span className="mcp-template-name">
													{template.name}
													<span className="mcp-badge">{template.transport.toUpperCase()}</span>
												</span>
												<small>{template.description}</small>
											</button>
										))}
									</div>
								</div>
							)}
							{!report && loading && (
								<div className="empty-note">
									<Loader2 size={16} className="spin" /> Connecting to servers...
								</div>
							)}
							{report?.errors.map((error) => (
								<div key={error} className="mcp-error">
									{error}
								</div>
							))}
							{report && !report.projectTrusted && (
								<div className="panel-note">Project servers in {report.projectPath} are ignored until this folder is trusted.</div>
							)}
						</div>
					) : (
						<div className="mcp-list">
							{json && (
								<>
									<div className="panel-note mono">{json.path}</div>
									<textarea className="modal-input mono mcp-json" value={json.text} spellCheck={false} onChange={(event) => setJson({ ...json, text: event.target.value })} />
									<div style={{ display: "flex", justifyContent: "flex-end" }}>
										<button
											type="button"
											className="btn-accent"
											onClick={() =>
												void api("PUT", "/api/mcp/raw", { text: json.text }).then(
													() => {
														actions.toast("info", "Saved. The agent reloaded its MCP servers.");
														load();
													},
													(error: unknown) => actions.toast("error", `Not saved: ${String(error)}`),
												)
											}
										>
											Save
										</button>
									</div>
								</>
							)}
						</div>
					)}
				</div>
				<ToolListSidebar servers={report?.servers ?? []} state={state} actions={actions} />
			</div>
		</>
	);
}
