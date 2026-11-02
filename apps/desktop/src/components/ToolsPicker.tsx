import { Bot, FileText, Globe, Layers, Search, Server, Shield, ShieldOff, ShieldQuestion, Smartphone, SquareTerminal } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { Permission } from "../settings.ts";
import { ProviderIcon } from "./ModelPicker.tsx";

interface Tool {
	name: string;
	description?: string;
}

interface Category {
	id: string;
	label: string;
	icon: ReactNode;
	tools: Tool[];
}

const ALL = "all";
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);

const PERMISSIONS: { value: Permission; label: string; icon: ReactNode }[] = [
	{ value: "ask", label: "Ask", icon: <ShieldQuestion size={12} /> },
	{ value: "allow", label: "Allow", icon: <Shield size={12} /> },
	{ value: "deny", label: "Deny", icon: <ShieldOff size={12} /> },
];

/** Built-in groups first, then one per MCP server (mcp__<server>__<tool>), then everything else as Agent. */
function categorize(tools: Tool[]): Category[] {
	const fixed: Category[] = [
		{ id: "files", label: "Files", icon: <FileText size={16} />, tools: [] },
		{ id: "shell", label: "Shell", icon: <SquareTerminal size={16} />, tools: [] },
		{ id: "browser", label: "Browser", icon: <Globe size={16} />, tools: [] },
		{ id: "device", label: "Device", icon: <Smartphone size={16} />, tools: [] },
		{ id: "ssh", label: "SSH", icon: <Server size={16} />, tools: [] },
	];
	const servers = new Map<string, Category>();
	const agent: Category = { id: "agent", label: "Agent", icon: <Bot size={16} />, tools: [] };
	const byId = new Map(fixed.map((category) => [category.id, category]));
	for (const tool of tools) {
		const server = /^mcp__(.+?)__/.exec(tool.name)?.[1];
		if (server) {
			let category = servers.get(server);
			if (!category) {
				category = { id: `mcp:${server}`, label: server, icon: <ProviderIcon provider={server} size={16} />, tools: [] };
				servers.set(server, category);
			}
			category.tools.push(tool);
		} else if (FILE_TOOLS.has(tool.name)) byId.get("files")!.tools.push(tool);
		// Background tasks run shell commands too.
		else if (SHELL_TOOLS.has(tool.name) || tool.name.startsWith("task_")) byId.get("shell")!.tools.push(tool);
		else if (tool.name.startsWith("browser_")) byId.get("browser")!.tools.push(tool);
		else if (tool.name.startsWith("device_")) byId.get("device")!.tools.push(tool);
		else if (tool.name.startsWith("ssh_")) byId.get("ssh")!.tools.push(tool);
		else agent.tools.push(tool);
	}
	return [...fixed, ...[...servers.values()].sort((a, b) => a.label.localeCompare(b.label)), agent].filter((category) => category.tools.length > 0);
}

const shortName = (name: string) => name.replace(/^mcp__.+?__/, "");
/** The first sentence of a tool description, for one line under its name. */
const summary = (description?: string) => (description ?? "").replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0]?.slice(0, 160) ?? "";

/**
 * The composer's Tools menu, laid out like the model picker: categories on the left (built-in groups, then each MCP
 * server), the chosen category's tools on the right with Ask / Allow / Deny, and a row that sets the whole category.
 * Typing searches every tool.
 */
export function ToolsPicker({
	tools,
	permissions,
	onSet,
}: {
	tools: Tool[];
	permissions: { default: Permission; tools: Record<string, Permission> };
	onSet: (changes: Record<string, Permission>) => void;
}) {
	const [query, setQuery] = useState("");
	const categories = useMemo(() => categorize(tools), [tools]);
	const [tab, setTab] = useState(ALL);
	const needle = query.trim().toLowerCase();
	const current = categories.find((category) => category.id === tab);
	const list = useMemo(() => {
		const source = needle || tab === ALL ? tools : (current?.tools ?? []);
		return needle ? source.filter((tool) => `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(needle)) : source;
	}, [tools, current, tab, needle]);

	const effective = (name: string) => permissions.tools[name] ?? permissions.default;
	// The category's shared permission when every tool in view has the same one.
	const shared = list.length > 0 && list.every((tool) => effective(tool.name) === effective(list[0]!.name)) ? effective(list[0]!.name) : null;
	const scope = needle ? "matching tools" : tab === ALL ? "all tools" : (current?.label ?? "");

	const rail = (id: string, label: string, count: number, icon: ReactNode) => (
		<button
			key={id}
			type="button"
			role="tab"
			aria-selected={!needle && tab === id}
			aria-label={`${label}, ${count} tools`}
			title={`${label} · ${count}`}
			className={`mp-rail-item${!needle && tab === id ? " on" : ""}`}
			onClick={() => {
				setTab(id);
				setQuery("");
			}}
		>
			{icon}
		</button>
	);

	const chips = (value: Permission | null, onPick: (permission: Permission) => void, name: string) => (
		<div className="perm-chips">
			{PERMISSIONS.map((permission) => (
				<button
					key={permission.value}
					type="button"
					title={permission.label}
					aria-label={`${permission.label} ${name}`}
					aria-pressed={value === permission.value}
					className={`perm-chip ${permission.value}${value === permission.value ? " on" : ""}`}
					onClick={() => onPick(permission.value)}
				>
					{permission.icon}
				</button>
			))}
		</div>
	);

	return (
		<div className="model-picker tools-picker">
			<nav className="mp-rail" role="tablist" aria-label="Tool categories" aria-orientation="vertical">
				{rail(ALL, "All tools", tools.length, <Layers size={16} />)}
				<div className="mp-rail-sep" />
				{categories.map((category) => rail(category.id, category.label, category.tools.length, category.icon))}
			</nav>
			<div className="mp-main">
				<label className="mp-search">
					<Search size={13} />
					<input autoFocus placeholder={`Search ${tools.length} tools`} value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="tp-head">
					<span className="tp-title">
						{needle ? "Results" : tab === ALL ? "All tools" : current?.label}
						<span className="tp-count">{list.length}</span>
					</span>
					{list.length > 1 && (
						<span className="tp-all">
							<span>Set {scope}</span>
							{chips(shared, (permission) => onSet(Object.fromEntries(list.map((tool) => [tool.name, permission]))), scope)}
						</span>
					)}
				</div>
				<div className="mp-list" role="list">
					{list.map((tool) => (
						<div key={tool.name} className="tp-row" role="listitem">
							<div className="tp-text">
								<div className="tp-name" title={tool.name}>
									{shortName(tool.name)}
								</div>
								{summary(tool.description) && <div className="tp-desc">{summary(tool.description)}</div>}
							</div>
							{chips(effective(tool.name), (permission) => onSet({ [tool.name]: permission }), shortName(tool.name))}
						</div>
					))}
					{list.length === 0 && <div className="empty-note">{needle ? "No tools match" : "No tools"}</div>}
				</div>
			</div>
		</div>
	);
}
