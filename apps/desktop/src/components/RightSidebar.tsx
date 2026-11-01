import { Bookmark, ChevronRight, Circle, CircleCheck, CircleDot, KeyRound, ListChecks, Plus, Shield, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { type DesktopSettings, newId, type Permission, type Reviewer, type SafetyRule } from "../settings.ts";
import type { SorvexActions, State } from "../store.ts";
import { Switch } from "./Pages.tsx";
import { Select } from "./Select.tsx";

export type PanelTab = "guardrails" | "todos" | "prompts" | "agents" | "permissions";

/** A remembered panel, or null when it no longer exists (e.g. the removed Config panel). */
export const panelTab = (value: string): PanelTab | null => (TABS.some((entry) => entry.tab === value) ? (value as PanelTab) : null);

// One outline set, chosen for what each panel holds.
const TABS: { tab: PanelTab; label: string; icon: ReactNode }[] = [
	{ tab: "guardrails", label: "Guardrails", icon: <Shield size={18} /> },
	{ tab: "todos", label: "Todos", icon: <ListChecks size={18} /> },
	{ tab: "prompts", label: "Prompts", icon: <Bookmark size={18} /> },
	{ tab: "agents", label: "Agents", icon: <Workflow size={18} /> },
	{ tab: "permissions", label: "Permissions", icon: <KeyRound size={18} /> },
];


function RuleRow({ rule, onChange, onDelete }: { rule: SafetyRule; onChange: (rule: SafetyRule) => void; onDelete: () => void }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`panel-card${open ? " open" : ""}`}>
			<div className="panel-card-head">
				<button type="button" className="icon-btn sm" aria-label="Expand" onClick={() => setOpen(!open)}>
					<ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined }} />
				</button>
				<span className="panel-card-title">{rule.name}</span>
				<span className={`badge ${rule.action === "block" ? "danger" : "warn"}`}>{rule.action}</span>
				<Switch on={rule.enabled} label={`Enable ${rule.name}`} onChange={(enabled) => onChange({ ...rule, enabled })} />
			</div>
			{open && (
				<div className="panel-card-body">
					<label>
						Name
						<input className="modal-input" value={rule.name} onChange={(event) => onChange({ ...rule, name: event.target.value })} />
					</label>
					<label>
						Applies to
						<div className="segmented">
							{(["bash", "path"] as const).map((target) => (
								<button key={target} type="button" className={rule.target === target ? "on" : ""} onClick={() => onChange({ ...rule, target })}>
									{target === "bash" ? "Bash commands" : "File paths"}
								</button>
							))}
						</div>
					</label>
					<label>
						Pattern (regular expression)
						<input className="modal-input mono" value={rule.pattern} onChange={(event) => onChange({ ...rule, pattern: event.target.value })} />
					</label>
					<label>
						When it matches
						<div className="segmented">
							{(["ask", "block"] as const).map((action) => (
								<button key={action} type="button" className={rule.action === action ? "on" : ""} onClick={() => onChange({ ...rule, action })}>
									{action === "ask" ? "Ask me" : "Block"}
								</button>
							))}
						</div>
					</label>
					<button type="button" className="btn-ghost danger" onClick={onDelete}>
						<Trash2 size={13} /> Delete rule
					</button>
				</div>
			)}
		</div>
	);
}

function ReviewerRow({ reviewer, state, onChange, onDelete }: { reviewer: Reviewer; state: State; onChange: (reviewer: Reviewer) => void; onDelete: () => void }) {
	const [open, setOpen] = useState(!reviewer.model);
	const currentModel = state.session?.model ? `${state.session.model.provider}/${state.session.model.id}` : "";
	return (
		<div className={`panel-card${open ? " open" : ""}`}>
			<div className="panel-card-head">
				<button type="button" className="icon-btn sm" aria-label="Expand" onClick={() => setOpen(!open)}>
					<ChevronRight size={13} style={{ transform: open ? "rotate(90deg)" : undefined }} />
				</button>
				<span className="panel-card-title">{reviewer.name}</span>
				<Switch on={reviewer.enabled} label={`Enable ${reviewer.name}`} onChange={(enabled) => onChange({ ...reviewer, enabled })} />
			</div>
			{open && (
				<div className="panel-card-body">
					<label>
						Name
						<input className="modal-input" value={reviewer.name} onChange={(event) => onChange({ ...reviewer, name: event.target.value })} />
					</label>
					<label>
						Reviewer model
						<Select
							ariaLabel="Reviewer model"
							width="100%"
							searchable
							placeholder="Choose a model"
							value={reviewer.model}
							options={state.models.map((model) => ({
								value: `${model.provider}/${model.id}`,
								label: model.name || model.id,
								hint: model.id,
								group: model.provider,
							}))}
							onChange={(model) => onChange({ ...reviewer, model })}
						/>
						{reviewer.model && reviewer.model === currentModel && (
							<small className="warn-text">Same model as the chat. A different model catches more.</small>
						)}
					</label>
					<label>
						Only on tool calls (comma separated, empty = every turn)
						<input
							className="modal-input"
							value={reviewer.triggerOnTools.join(", ")}
							placeholder="bash, edit, write"
							onChange={(event) =>
								onChange({ ...reviewer, triggerOnTools: event.target.value.split(",").map((name) => name.trim()).filter(Boolean) })
							}
						/>
					</label>
					<label>
						Include previous messages
						<input
							className="modal-input"
							type="number"
							min={0}
							max={20}
							value={reviewer.messagesCount}
							onChange={(event) => onChange({ ...reviewer, messagesCount: Number(event.target.value) })}
						/>
					</label>
					<label>
						Rules
						<textarea className="modal-input" rows={5} value={reviewer.prompt} onChange={(event) => onChange({ ...reviewer, prompt: event.target.value })} />
					</label>
					<button type="button" className="btn-ghost danger" onClick={onDelete}>
						<Trash2 size={13} /> Delete reviewer
					</button>
				</div>
			)}
		</div>
	);
}

function GuardrailsPanel({ state, settings, save }: { state: State; settings: DesktopSettings; save: (settings: DesktopSettings) => void }) {
	const setRules = (rules: SafetyRule[]) => save({ ...settings, rules });
	const setReviewers = (reviewers: Reviewer[]) => save({ ...settings, reviewers });
	return (
		<>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Safety rules</span>
					<button
						type="button"
						className="icon-btn sm"
						aria-label="Add rule"
						onClick={() => setRules([...settings.rules, { id: newId(), name: "New rule", enabled: true, target: "bash", pattern: "", action: "ask" }])}
					>
						<Plus size={14} />
					</button>
				</div>
				<p className="panel-note">Checked before every tool call. "Block" stops the call; "Ask" waits for your approval.</p>
				{settings.rules.map((rule) => (
					<RuleRow
						key={rule.id}
						rule={rule}
						onChange={(next) => setRules(settings.rules.map((r) => (r.id === rule.id ? next : r)))}
						onDelete={() => setRules(settings.rules.filter((r) => r.id !== rule.id))}
					/>
				))}
			</div>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>LLM reviewers</span>
					<button
						type="button"
						className="icon-btn sm"
						aria-label="Add reviewer"
						onClick={() =>
							setReviewers([
								...settings.reviewers,
								{ id: newId(), name: "Reviewer", enabled: true, model: "", triggerOnTools: [], messagesCount: 2, prompt: "" },
							])
						}
					>
						<Plus size={14} />
					</button>
				</div>
				<p className="panel-note">A second model reviews each finished turn and flags violations and warnings under the reply.</p>
				{settings.reviewers.map((reviewer) => (
					<ReviewerRow
						key={reviewer.id}
						reviewer={reviewer}
						state={state}
						onChange={(next) => setReviewers(settings.reviewers.map((r) => (r.id === reviewer.id ? next : r)))}
						onDelete={() => setReviewers(settings.reviewers.filter((r) => r.id !== reviewer.id))}
					/>
				))}
			</div>
		</>
	);
}

const PERMISSIONS: Permission[] = ["ask", "allow", "deny"];

function PermissionsPanel({ state, settings, save }: { state: State; settings: DesktopSettings; save: (settings: DesktopSettings) => void }) {
	const { permissions } = settings;
	const names = [...new Set([...state.tools.map((tool) => tool.name), ...Object.keys(permissions.tools)])].sort();
	const setTool = (name: string, permission: Permission | undefined) => {
		const tools = { ...permissions.tools };
		if (permission) tools[name] = permission;
		else delete tools[name];
		save({ ...settings, permissions: { ...permissions, tools } });
	};
	return (
		<>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Default for other tools</span>
				</div>
				<div className="segmented">
					{PERMISSIONS.map((permission) => (
						<button
							key={permission}
							type="button"
							className={permissions.default === permission ? "on" : ""}
							onClick={() => save({ ...settings, permissions: { ...permissions, default: permission } })}
						>
							{permission}
						</button>
					))}
				</div>
			</div>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Tools</span>
				</div>
				{names.map((name) => {
					const explicit = permissions.tools[name];
					const effective = explicit ?? permissions.default;
					const description = state.tools.find((tool) => tool.name === name)?.description;
					return (
						<div key={name} className="perm-row" title={description}>
							<div className="perm-name">
								{effective === "allow" ? <ShieldCheck size={14} className="ok-icon" /> : effective === "deny" ? <Circle size={14} className="deny-icon" /> : <CircleDot size={14} className="ask-icon" />}
								<span>{name}</span>
								{!explicit && <small>default</small>}
							</div>
							<div className="segmented sm">
								<button type="button" className={!explicit ? "on" : ""} onClick={() => setTool(name, undefined)}>
									Default
								</button>
								{PERMISSIONS.map((permission) => (
									<button key={permission} type="button" className={explicit === permission ? "on" : ""} onClick={() => setTool(name, permission)}>
										{permission}
									</button>
								))}
							</div>
						</div>
					);
				})}
				{names.length === 0 && <div className="empty-note">Tools appear once the agent starts.</div>}
			</div>
		</>
	);
}

interface Todo {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
}

function TodosPanel({ state }: { state: State }) {
	const todos = useMemo(() => {
		for (let i = state.messages.length - 1; i >= 0; i--) {
			const message = state.messages[i]!;
			if (message.role === "toolResult" && message.toolName === "todo" && message.details && typeof message.details === "object") {
				return ((message.details as { todos?: Todo[] }).todos ?? []).filter((todo) => todo.status !== "deleted");
			}
		}
		return [];
	}, [state.messages]);
	if (todos.length === 0) return <div className="empty-note">No todos yet. The agent creates them with its todo tool on multi-step tasks.</div>;
	const done = todos.filter((todo) => todo.status === "completed").length;
	return (
		<>
			<div className="panel-note">
				{done} of {todos.length} done
			</div>
			{todos.map((todo) => (
				<div key={todo.id} className={`todo-row ${todo.status}`}>
					{todo.status === "completed" ? <CircleCheck size={15} /> : todo.status === "in_progress" ? <CircleDot size={15} /> : <Circle size={15} />}
					<div>
						<div>{todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.subject}</div>
						{todo.description && <small>{todo.description}</small>}
					</div>
				</div>
			))}
		</>
	);
}

function PromptsPanel({ state, actions, settings, save }: { state: State; actions: SorvexActions; settings: DesktopSettings; save: (settings: DesktopSettings) => void }) {
	const [name, setName] = useState("");
	const [content, setContent] = useState("");
	const templates = state.commands.filter((command) => command.source === "prompt" || command.source === "skill");
	return (
		<>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Saved prompts</span>
				</div>
				{settings.prompts.map((prompt) => (
					<div key={prompt.id} className="panel-card">
						<div className="panel-card-head">
							<button type="button" className="panel-card-title link" title="Insert into composer" onClick={() => actions.setComposerText(prompt.content, true)}>
								{prompt.name}
							</button>
							<button
								type="button"
								className="icon-btn sm"
								aria-label={`Delete ${prompt.name}`}
								onClick={() => save({ ...settings, prompts: settings.prompts.filter((p) => p.id !== prompt.id) })}
							>
								<Trash2 size={12} />
							</button>
						</div>
					</div>
				))}
				<div className="panel-card-body" style={{ padding: 0 }}>
					<input className="modal-input" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
					<textarea className="modal-input" rows={3} placeholder="Prompt text" value={content} onChange={(event) => setContent(event.target.value)} />
					<button
						type="button"
						className="btn-ghost"
						disabled={!name.trim() || !content.trim()}
						onClick={() => {
							save({ ...settings, prompts: [...settings.prompts, { id: newId(), name: name.trim(), content }] });
							setName("");
							setContent("");
						}}
					>
						<Plus size={13} /> Save prompt
					</button>
				</div>
			</div>
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Sorvex templates and skills</span>
				</div>
				{templates.length === 0 && <div className="empty-note">None installed</div>}
				{templates.map((command) => (
					<button key={command.name} type="button" className="panel-row" onClick={() => actions.setComposerText(`/${command.name} `)}>
						<span>/{command.name}</span>
						{command.description && <small>{command.description}</small>}
					</button>
				))}
			</div>
		</>
	);
}

/** Subagent runs in this session: Sorvex's subagent tool calls, with their nested tool activity. */
function AgentsPanel({ state }: { state: State }) {
	const runs = useMemo(() => {
		const results = new Map<string, boolean>();
		for (const message of state.messages) if (message.role === "toolResult") results.set(message.toolCallId, message.isError);
		return state.messages.flatMap((message) =>
			message.role === "assistant"
				? message.content
						.filter((block) => block.type === "toolCall" && /agent/i.test(block.name))
						.map((block) => {
							const call = block as { id: string; name: string; arguments: Record<string, unknown> };
							const task = ["description", "task", "prompt"].map((key) => call.arguments[key]).find((value) => typeof value === "string") as string | undefined;
							return {
								id: call.id,
								name: (call.arguments.agent ?? call.arguments.subagent_type ?? call.name) as string,
								task: task ?? "",
								status: state.running[call.id] ? "running" : results.has(call.id) ? (results.get(call.id) ? "failed" : "done") : "pending",
								children: state.children[call.id]?.length ?? 0,
							};
						})
				: [],
		);
	}, [state.messages, state.running, state.children]);
	const agentCommands = state.commands.filter((command) => /agent/i.test(command.name));
	const [builtin, setBuiltin] = useState<{ name: string; description: string; tools: string[] | null }[]>([]);
	useEffect(() => {
		void api<{ name: string; description: string; tools: string[] | null }[]>("GET", "/api/agents").then(setBuiltin);
	}, []);
	return (
		<>
			<div className="panel-note">Subagents the model started in this session. Security mode adds the security subagents.</div>
			{runs.length === 0 && <div className="empty-note">No subagent runs yet</div>}
			{[...runs].reverse().map((run) => (
				<div key={run.id} className="panel-card">
					<div className="panel-card-head">
						<Workflow size={14} />
						<span className="panel-card-title">{run.name}</span>
						<span className={`badge ${run.status === "done" ? "ok" : run.status === "failed" ? "danger" : "warn"}`}>{run.status}</span>
					</div>
					{run.task && <div className="panel-card-body panel-note">{run.task.slice(0, 220)}</div>}
					{run.children > 0 && <div className="panel-card-body panel-note">{run.children} tool calls</div>}
				</div>
			))}
			<div className="panel-section">
				<div className="panel-section-head">
					<span>Available agents</span>
				</div>
				{builtin.map((agent) => (
					<div key={agent.name} className="panel-row" title={agent.tools?.join(", ")}>
						<span>{agent.name}</span>
						<small>{agent.description}</small>
					</div>
				))}
			</div>
			{agentCommands.length > 0 && (
				<div className="panel-section">
					<div className="panel-section-head">
						<span>Commands</span>
					</div>
					{agentCommands.map((command) => (
						<div key={command.name} className="panel-row">
							<span>/{command.name}</span>
							{command.description && <small>{command.description}</small>}
						</div>
					))}
				</div>
			)}
		</>
	);
}

/** Right-hand tool strip with a 300px panel, like warpdrv's chat sidebar. Clicking the open tab closes it. */
export function RightSidebar({ state, actions, tab, onTab }: { state: State; actions: SorvexActions; tab: PanelTab | null; onTab: (tab: PanelTab | null) => void }) {
	const settings = state.settings;
	const save = (next: DesktopSettings) => void actions.saveSettings(next);
	const title = TABS.find((entry) => entry.tab === tab)?.label;
	return (
		<>
			{tab && (
				<aside className="side-panel">
					<div className="side-panel-head">{title}</div>
					<div className="side-panel-body">
						{tab === "guardrails" && settings && <GuardrailsPanel state={state} settings={settings} save={save} />}
						{tab === "permissions" && settings && <PermissionsPanel state={state} settings={settings} save={save} />}
						{tab === "todos" && <TodosPanel state={state} />}
						{tab === "prompts" && settings && <PromptsPanel state={state} actions={actions} settings={settings} save={save} />}
						{tab === "agents" && <AgentsPanel state={state} />}
					</div>
				</aside>
			)}
			<nav className="side-strip">
				{TABS.map((entry) => (
					<button
						key={entry.tab}
						type="button"
						className={`rail-item${tab === entry.tab ? " active" : ""}`}
						title={entry.label}
						aria-label={entry.label}
						onClick={() => onTab(tab === entry.tab ? null : entry.tab)}
					>
						{entry.icon}
						{entry.tab === "guardrails" && state.approvals.length > 0 && <span className="rail-dot" style={{ background: "#f59e0b" }} />}
					</button>
				))}
				{tab && (
					<button type="button" className="rail-item strip-collapse" title="Collapse panel" aria-label="Collapse panel" onClick={() => onTab(null)}>
						<ChevronRight size={18} color="var(--text-muted)" />
					</button>
				)}
			</nav>
		</>
	);
}
