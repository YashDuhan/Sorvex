import { Check, GitBranch, Search, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { BsFillChatLeftFill } from "react-icons/bs";
import { api } from "../api.ts";
import { HOTKEYS } from "../commands.ts";
import { compactNumber, relativeTime } from "../format.ts";
import { switchToLocalModel } from "../local.ts";
import type { SessionSummary, ThinkingLevel } from "../rpc.ts";
import type { SorvexActions, State } from "../store.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { sessionTitle } from "./ThreadList.tsx";

export type ModalKind =
	| { kind: "model"; query?: string }
	| { kind: "scoped-models" }
	| { kind: "thinking" }
	| { kind: "resume" }
	| { kind: "fork" }
	| { kind: "tree" }
	| { kind: "session" }
	| { kind: "hotkeys" }
	| { kind: "changelog" }
	| { kind: "local-first-reply" };

const LOCAL_NOTICE_KEY = "localFirstReplyNoticeHidden";

/** Whether to show the "first local reply takes a while" notice when a local model starts working on a reply. */
export function shouldShowLocalNotice(): boolean {
	try {
		return localStorage.getItem(LOCAL_NOTICE_KEY) !== "1";
	} catch {
		return true;
	}
}

/**
 * Shown when a local model starts working on a reply, once per chat: before its first word, a local model reads the agent's whole
 * instructions and tool list (several thousand tokens), which takes a minute or more on a laptop. Later replies reuse
 * what it already read, so they start much sooner.
 */
function LocalFirstReplyModal({ onClose }: { onClose: () => void }) {
	const [hide, setHide] = useState(false);
	const close = () => {
		if (hide) {
			try {
				localStorage.setItem(LOCAL_NOTICE_KEY, "1");
			} catch {}
		}
		onClose();
	};
	return (
		<Modal
			title="The first reply takes a while"
			onClose={close}
			footer={
				<>
					<label className="local-notice-check">
						<input type="checkbox" checked={hide} onChange={(event) => setHide(event.target.checked)} />
						Don't show this again
					</label>
					<button type="button" className="btn-accent" onClick={close}>
						Got it
					</button>
				</>
			}
		>
			<div className="local-notice">
				<p>
					This reply comes from a model running on this device. Before its first word, it reads Sorvex's instructions and tool list, several
					thousand tokens. On a laptop that can take <strong>a minute or more</strong>; the chat shows how far it has read.
				</p>
				<p>
					<strong>Later replies start much sooner</strong>: the model keeps what it has already read and only reads what's new.
				</p>
			</div>
		</Modal>
	);
}

function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
				<div className="modal-head modal-head-row">
					<span>{title}</span>
					<button type="button" className="icon-btn sm" aria-label="Close" onClick={onClose}>
						<X size={14} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
				{footer && <div className="modal-foot">{footer}</div>}
			</div>
		</div>
	);
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
	return (
		<label className="search" style={{ marginBottom: 8 }}>
			<Search size={14} />
			<input autoFocus placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

function ModelModal({ state, actions, initial, onClose }: { state: State; actions: SorvexActions; initial?: string; onClose: () => void }) {
	return (
		<Modal title="Select model" onClose={onClose}>
			<ModelPicker
				models={state.models}
				current={state.session?.model}
				initialQuery={initial}
				onPick={(model) => {
					void actions.setModel(model);
					onClose();
				}}
				local={{
					onUse: async (id) => {
						await switchToLocalModel(actions, id);
						onClose();
					},
				}}
			/>
		</Modal>
	);
}

/** /scoped-models: the models Ctrl+P cycles through, saved to `enabledModels` in Sorvex's settings. */
function ScopedModelsModal({ state, onClose }: { state: State; onClose: () => void }) {
	const [scoped, setScoped] = useState<string[] | null>(null);
	const [query, setQuery] = useState("");
	useEffect(() => {
		void api<{ enabledModels: string[] }>("GET", `/api/sorvex-settings?cwd=${encodeURIComponent(state.cwd)}`).then((s) => setScoped(s.enabledModels));
	}, [state.cwd]);
	const save = (next: string[]) => {
		setScoped(next);
		void api("PUT", "/api/sorvex-settings", { cwd: state.cwd, key: "enabledModels", value: next });
	};
	const list = state.models.filter((model) => !query || `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()));
	return (
		<Modal
			title="Scoped models (Ctrl+P cycling)"
			onClose={onClose}
			footer={
				<>
					<button type="button" className="btn-ghost" onClick={() => save(state.models.map((m) => `${m.provider}/${m.id}`))}>
						Enable all
					</button>
					<button type="button" className="btn-ghost" onClick={() => save([])}>
						Clear
					</button>
				</>
			}
		>
			<SearchBox value={query} onChange={setQuery} placeholder="Search models" />
			<div className="modal-list">
				{scoped &&
					list.map((model) => {
						const id = `${model.provider}/${model.id}`;
						const on = scoped.includes(id);
						return (
							<button key={id} type="button" className="menu-item" onClick={() => save(on ? scoped.filter((s) => s !== id) : [...scoped, id])}>
								<span className="stack">
									<span>{model.name || model.id}</span>
									<small>{id}</small>
								</span>
								{on && <Check size={14} className="check" />}
							</button>
						);
					})}
			</div>
		</Modal>
	);
}

function ThinkingModal({ state, actions, onClose }: { state: State; actions: SorvexActions; onClose: () => void }) {
	return (
		<Modal title="Thinking level" onClose={onClose}>
			<div className="modal-list">
				{state.thinkingLevels.map((level: ThinkingLevel) => (
					<button
						key={level}
						type="button"
						className={`menu-item${state.session?.thinkingLevel === level ? " selected" : ""}`}
						onClick={() => {
							void actions.setThinking(level);
							onClose();
						}}
					>
						{level}
					</button>
				))}
				{state.thinkingLevels.length === 0 && <div className="empty-note">This model has no thinking levels</div>}
			</div>
		</Modal>
	);
}

/** /resume: sessions in this folder or all folders, with search, open and delete, like the TUI picker. */
function ResumeModal({ state, actions, onClose }: { state: State; actions: SorvexActions; onClose: () => void }) {
	const [all, setAll] = useState(false);
	const [query, setQuery] = useState("");
	const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
	const load = () => {
		setSessions(null);
		void api<SessionSummary[]>("GET", `/api/sessions?cwd=${encodeURIComponent(state.cwd)}${all ? "&all=1" : ""}`).then(setSessions);
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reload when the scope changes.
	useEffect(load, [all]);
	const list = useMemo(() => {
		const needle = query.trim().toLowerCase();
		return (sessions ?? []).filter((s) => !needle || `${s.name ?? ""} ${s.firstMessage ?? ""} ${s.cwd ?? ""}`.toLowerCase().includes(needle));
	}, [sessions, query]);
	return (
		<Modal
			title="Resume session"
			wide
			onClose={onClose}
			footer={
				<div className="segmented">
					<button type="button" className={!all ? "on" : ""} onClick={() => setAll(false)}>
						This folder
					</button>
					<button type="button" className={all ? "on" : ""} onClick={() => setAll(true)}>
						All folders
					</button>
				</div>
			}
		>
			<SearchBox value={query} onChange={setQuery} placeholder="Search sessions" />
			<div className="modal-list">
				{sessions === null && <div className="empty-note dots">Loading</div>}
				{list.map((session) => (
					<div key={session.path} className={`resume-row${session.path === state.session?.sessionFile ? " active" : ""}`}>
						<button
							type="button"
							className="resume-open"
							onClick={() => {
								void actions.switchSession(session.path);
								onClose();
							}}
						>
							<BsFillChatLeftFill size={13} />
							<span className="stack">
								<span>{sessionTitle(session)}</span>
								<small>
									{relativeTime(session.modified)} · {session.messageCount} messages{all && session.cwd ? ` · ${session.cwd}` : ""}
								</small>
							</span>
						</button>
						<button
							type="button"
							className="icon-btn sm danger-icon"
							aria-label="Delete session"
							title="Delete session"
							onClick={() => window.confirm(`Delete "${sessionTitle(session)}"?`) && void actions.deleteSession(session.path).then(load)}
						>
							<Trash2 size={13} />
						</button>
					</div>
				))}
				{sessions && list.length === 0 && <div className="empty-note">No sessions</div>}
			</div>
		</Modal>
	);
}

function ForkModal({ actions, onClose }: { actions: SorvexActions; onClose: () => void }) {
	const [messages, setMessages] = useState<{ entryId: string; text: string }[] | null>(null);
	useEffect(() => {
		void actions.forkMessages().then((result) => setMessages(result.messages));
	}, [actions]);
	return (
		<Modal title="Fork from a message" onClose={onClose}>
			<p className="panel-note" style={{ marginBottom: 8 }}>
				Starts a new session that branches before the chosen message and puts its text back in the editor.
			</p>
			<div className="modal-list">
				{messages === null && <div className="empty-note dots">Loading</div>}
				{[...(messages ?? [])].reverse().map((message) => (
					<button
						key={message.entryId}
						type="button"
						className="menu-item"
						onClick={() => {
							void actions.fork(message.entryId);
							onClose();
						}}
					>
						<span className="fork-text">{message.text}</span>
					</button>
				))}
				{messages?.length === 0 && <div className="empty-note">No user messages yet</div>}
			</div>
		</Modal>
	);
}

interface TreeNode {
	entry: { id: string; type: string; message?: { role: string; content: unknown }; summary?: string; timestamp: string };
	children: TreeNode[];
	label?: string;
}

function entryText(node: TreeNode): string {
	const message = node.entry.message;
	if (node.entry.type === "branch_summary" || node.entry.type === "compaction") return node.entry.summary ?? node.entry.type;
	if (!message) return node.entry.type;
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content.map((block: { type?: string; text?: string; name?: string }) => (block.type === "text" ? block.text : block.type === "toolCall" ? `[${block.name}]` : "")).join(" ");
		return text.trim() || `[${message.role}]`;
	}
	return message.role;
}

/** /tree: the session's branches. Forking from a user message starts a new session at that point. */
function TreeModal({ actions, onClose }: { actions: SorvexActions; onClose: () => void }) {
	const [tree, setTree] = useState<{ tree: TreeNode[]; leafId: string | null } | null>(null);
	const [filter, setFilter] = useState<"user" | "all">("user");
	const [forkIds, setForkIds] = useState<Map<string, string>>(new Map());
	useEffect(() => {
		void actions.tree().then((result) => setTree(result as { tree: TreeNode[]; leafId: string | null }));
		void actions.forkMessages().then((result) => setForkIds(new Map(result.messages.map((m) => [m.entryId, m.text]))));
	}, [actions]);

	const rows: { node: TreeNode; depth: number; branch: boolean }[] = [];
	const walk = (nodes: TreeNode[], depth: number) => {
		for (const node of nodes) {
			const role = node.entry.message?.role;
			const visible = filter === "all" ? node.entry.type === "message" || node.entry.type === "branch_summary" || node.entry.type === "compaction" : role === "user";
			if (visible && role !== "system" && role !== "toolResult") rows.push({ node, depth, branch: nodes.length > 1 });
			walk(node.children, nodes.length > 1 ? depth + 1 : depth);
		}
	};
	if (tree) walk(tree.tree, 0);

	return (
		<Modal
			title="Session tree"
			wide
			onClose={onClose}
			footer={
				<div className="segmented">
					<button type="button" className={filter === "user" ? "on" : ""} onClick={() => setFilter("user")}>
						User messages
					</button>
					<button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
						All
					</button>
				</div>
			}
		>
			<div className="modal-list tree-list">
				{!tree && <div className="empty-note dots">Loading</div>}
				{rows.map(({ node, depth, branch }) => {
					const forkable = forkIds.has(node.entry.id);
					const onLeaf = node.entry.id === tree?.leafId;
					return (
						<button
							key={node.entry.id}
							type="button"
							className={`tree-row${onLeaf ? " active" : ""}`}
							style={{ paddingLeft: 10 + depth * 18 }}
							disabled={!forkable}
							title={forkable ? "Fork a new session from here" : undefined}
							onClick={() => {
								void actions.fork(node.entry.id);
								onClose();
							}}
						>
							{branch && <GitBranch size={12} className="tree-branch" />}
							<span className={`tree-role ${node.entry.message?.role ?? node.entry.type}`}>{node.entry.message?.role ?? node.entry.type}</span>
							<span className="tree-text">{entryText(node).slice(0, 160)}</span>
							{node.label && <span className="mcp-badge">{node.label}</span>}
						</button>
					);
				})}
			</div>
		</Modal>
	);
}

function SessionModal({ state, onClose }: { state: State; onClose: () => void }) {
	const session = state.session;
	const stats = state.stats;
	const rows: [string, ReactNode][] = [
		["File", <span className="mono">{session?.sessionFile ?? "not saved yet"}</span>],
		["ID", <span className="mono">{session?.sessionId}</span>],
		["Name", session?.sessionName ?? "—"],
		["Model", session?.model ? `${session.model.provider}/${session.model.id}` : "—"],
		["Thinking", session?.thinkingLevel ?? "—"],
		["Messages", String(session?.messageCount ?? 0)],
		["Tokens", stats ? `${compactNumber(stats.tokens.input)} in · ${compactNumber(stats.tokens.output)} out · ${compactNumber(stats.tokens.cacheRead)} cache read · ${compactNumber(stats.tokens.cacheWrite)} cache write` : "—"],
		["Cost", stats ? `$${stats.cost.toFixed(4)}` : "—"],
		[
			"Context",
			stats?.contextUsage
				? `${compactNumber(stats.contextUsage.tokens ?? 0)} / ${compactNumber(stats.contextUsage.contextWindow)} (${Math.round(stats.contextUsage.percent ?? 0)}%)`
				: "—",
		],
		["Auto-compaction", session?.autoCompactionEnabled ? "on" : "off"],
		["Working directory", <span className="mono">{state.cwd}</span>],
	];
	return (
		<Modal title="Session" onClose={onClose}>
			<table className="info-table">
				<tbody>
					{rows.map(([label, value]) => (
						<tr key={label}>
							<th>{label}</th>
							<td>{value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</Modal>
	);
}

function HotkeysModal({ onClose }: { onClose: () => void }) {
	return (
		<Modal title="Keyboard shortcuts" onClose={onClose} wide>
			{HOTKEYS.map((group) => (
				<div key={group.group} style={{ marginBottom: 12 }}>
					<div className="panel-section-head" style={{ marginBottom: 6 }}>
						<span>{group.group}</span>
					</div>
					<table className="info-table">
						<tbody>
							{group.keys.map(([key, description]) => (
								<tr key={key}>
									<th>
										<kbd>{key}</kbd>
									</th>
									<td>{description}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			))}
		</Modal>
	);
}

function ChangelogModal({ onClose }: { onClose: () => void }) {
	const [text, setText] = useState<string | null>(null);
	useEffect(() => {
		void api<{ text: string }>("GET", "/api/changelog").then((result) => setText(result.text));
	}, []);
	return (
		<Modal title="What's new" onClose={onClose} wide>
			{text === null ? <div className="empty-note dots">Loading</div> : <Markdown text={text.slice(0, 40000)} />}
		</Modal>
	);
}

export function Modals({ modal, state, actions, onClose }: { modal: ModalKind | null; state: State; actions: SorvexActions; onClose: () => void }) {
	if (!modal) return null;
	switch (modal.kind) {
		case "model":
			return <ModelModal state={state} actions={actions} initial={modal.query} onClose={onClose} />;
		case "scoped-models":
			return <ScopedModelsModal state={state} onClose={onClose} />;
		case "local-first-reply":
			return <LocalFirstReplyModal onClose={onClose} />;
		case "thinking":
			return <ThinkingModal state={state} actions={actions} onClose={onClose} />;
		case "resume":
			return <ResumeModal state={state} actions={actions} onClose={onClose} />;
		case "fork":
			return <ForkModal actions={actions} onClose={onClose} />;
		case "tree":
			return <TreeModal actions={actions} onClose={onClose} />;
		case "session":
			return <SessionModal state={state} onClose={onClose} />;
		case "hotkeys":
			return <HotkeysModal onClose={onClose} />;
		case "changelog":
			return <ChangelogModal onClose={onClose} />;
	}
}
