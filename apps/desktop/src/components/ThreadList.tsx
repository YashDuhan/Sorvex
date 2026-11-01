import { ChevronRight, Ellipsis, FolderPlus, Pencil, Plus, RefreshCw, SearchIcon, Split, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { relativeTime } from "../format.ts";
import type { SessionSummary } from "../rpc.ts";

export function sessionTitle(session: Pick<SessionSummary, "name" | "firstMessage">): string {
	return session.name || session.firstMessage?.split("\n")[0] || "New session";
}

/** Sessions shown per folder before "Show more". */
const PER_FOLDER = 8;
const COLLAPSED_KEY = "collapsedFolders";

function folderName(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() || path;
}

function loadCollapsed(): Record<string, boolean> {
	try {
		return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Record<string, boolean>;
	} catch {
		return {};
	}
}

/**
 * One session in the sidebar. The "..." button (shown on hover) opens Rename, Fork and Delete; Rename, or a double-click on
 * the title, turns the title into a field in place: Enter or clicking away saves, Escape cancels.
 */
function ThreadRow({
	session,
	active,
	running,
	onPick,
	onRename,
	onFork,
	onDelete,
}: {
	session: SessionSummary;
	active: boolean;
	running: boolean;
	onPick: () => void;
	onRename: (name: string) => void;
	onFork: () => void;
	onDelete: () => void;
}) {
	const title = sessionTitle(session);
	const [editing, setEditing] = useState(false);
	const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!menu) return;
		const close = (event: Event) => {
			if (event instanceof KeyboardEvent ? event.key === "Escape" : !menuRef.current?.contains(event.target as Node)) setMenu(null);
		};
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", close);
		window.addEventListener("resize", close);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", close);
			window.removeEventListener("resize", close);
		};
	}, [menu]);

	if (editing) {
		const finish = (input: HTMLInputElement, save: boolean) => {
			const name = input.value.trim();
			setEditing(false);
			if (save && name && name !== title) onRename(name);
		};
		return (
			<div className={`thread-row editing${active ? " active" : ""}`}>
				<span className={`thread-dot${running ? " running" : ""}`} />
				<input
					className="thread-rename"
					aria-label="Session name"
					defaultValue={title}
					autoFocus
					onFocus={(event) => event.currentTarget.select()}
					onBlur={(event) => finish(event.currentTarget, true)}
					onKeyDown={(event) => {
						if (event.key === "Enter") finish(event.currentTarget, true);
						else if (event.key === "Escape") finish(event.currentTarget, false);
					}}
				/>
			</div>
		);
	}

	return (
		<div className={`thread-row${active ? " active" : ""}${menu ? " menu-open" : ""}`}>
			<button type="button" className="thread-open" title={title} onClick={onPick} onDoubleClick={() => setEditing(true)}>
				<span className={`thread-dot${running ? " running" : ""}`} title={running ? "Running" : "Idle"} />
				<span className="title">{title}</span>
				<span className="time">{relativeTime(session.modified)}</span>
			</button>
			<button
				type="button"
				className="thread-more-btn"
				aria-label={`More actions for ${title}`}
				aria-haspopup="menu"
				aria-expanded={Boolean(menu)}
				onClick={(event) => {
					const rect = event.currentTarget.getBoundingClientRect();
					setMenu(menu ? null : { top: rect.bottom + 4, left: rect.right });
				}}
			>
				<Ellipsis size={14} />
			</button>
			{menu && (
				<div ref={menuRef} className="popover thread-menu" role="menu" style={{ top: menu.top, left: menu.left }}>
					<button
						type="button"
						role="menuitem"
						className="menu-item"
						onClick={() => {
							setMenu(null);
							setEditing(true);
						}}
					>
						<Pencil size={13} /> Rename
					</button>
					<button
						type="button"
						role="menuitem"
						className="menu-item"
						onClick={() => {
							setMenu(null);
							onFork();
						}}
					>
						<Split size={13} /> Fork
					</button>
					{!active && (
						<button
							type="button"
							role="menuitem"
							className="menu-item danger"
							onClick={() => {
								setMenu(null);
								if (window.confirm(`Delete "${title}"?`)) onDelete();
							}}
						>
							<Trash2 size={13} /> Delete
						</button>
					)}
				</div>
			)}
		</div>
	);
}

interface Group {
	cwd: string;
	sessions: SessionSummary[];
	latest: number;
}

/**
 * Every session from every folder, grouped by folder like Claude's sidebar, ordered by latest activity. Folders
 * collapse and each choice is remembered. "+" starts a new chat in that folder.
 */
export function ThreadList({
	cwd,
	sessions,
	activePath,
	runningPath,
	onPick,
	onNewChat,
	onChangeCwd,
	onRefresh,
	onRename,
	onFork,
	onDelete,
}: {
	cwd: string;
	sessions: SessionSummary[];
	activePath?: string;
	/** The session the agent is working in right now, if any. */
	runningPath?: string;
	onPick: (path: string, cwd?: string) => void;
	onNewChat: (cwd: string) => void;
	onChangeCwd: () => void;
	onRefresh: () => void;
	onRename: (path: string, name: string) => void;
	onFork: (path: string) => void;
	onDelete: (path: string) => void;
}) {
	const [query, setQuery] = useState("");
	const [collapsed, setCollapsed] = useState(loadCollapsed);
	const [showAll, setShowAll] = useState<Set<string>>(new Set());

	const groups = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const byFolder = new Map<string, Group>();
		// The current folder is always listed, even before it has a session.
		if (cwd && !needle) byFolder.set(cwd, { cwd, sessions: [], latest: 0 });
		for (const session of sessions) {
			const folder = session.cwd || cwd;
			if (needle && !`${session.name ?? ""} ${session.firstMessage ?? ""} ${folder}`.toLowerCase().includes(needle)) continue;
			const group = byFolder.get(folder) ?? { cwd: folder, sessions: [], latest: 0 };
			group.sessions.push(session);
			group.latest = Math.max(group.latest, session.modified);
			byFolder.set(folder, group);
		}
		// By latest activity, so opening a chat never reorders the list; a new folder with no sessions yet goes first.
		return [...byFolder.values()].sort((a, b) => (a.sessions.length === 0 ? -1 : b.sessions.length === 0 ? 1 : b.latest - a.latest));
	}, [sessions, cwd, query]);

	// Until the user toggles a folder, recently active folders start open. This does not depend on the current folder,
	// so opening a chat elsewhere never opens or closes groups.
	const recent = Date.now() - 7 * 24 * 60 * 60 * 1000;
	const isOpen = (group: Group) => (query ? true : collapsed[group.cwd] === undefined ? group.sessions.length === 0 || group.latest > recent : !collapsed[group.cwd]);
	const toggle = (group: Group) => {
		const next = { ...collapsed, [group.cwd]: isOpen(group) };
		setCollapsed(next);
		try {
			localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
		} catch {}
	};

	return (
		<aside className="threads">
			<label className="search">
				<SearchIcon size={15} />
				<input placeholder="Search sessions" value={query} onChange={(event) => setQuery(event.target.value)} />
			</label>
			<div className="threads-label">
				<span>Sessions</span>
				<span className="threads-label-actions">
					<button type="button" className="icon-btn sm" aria-label="Open a folder" title="Open a folder" onClick={onChangeCwd}>
						<FolderPlus size={13} />
					</button>
					<button type="button" className="icon-btn sm" aria-label="Refresh sessions" title="Refresh" onClick={onRefresh}>
						<RefreshCw size={12} />
					</button>
				</span>
			</div>
			<div className="thread-list">
				{groups.length === 0 && <div className="empty-note">{query ? "No matching sessions" : "No sessions yet"}</div>}
				{groups.map((group) => {
					const open = isOpen(group);
					const visible = showAll.has(group.cwd) ? group.sessions : group.sessions.slice(0, PER_FOLDER);
					return (
						<div key={group.cwd} className={`thread-group${group.cwd === cwd ? " current" : ""}`}>
							<div className="thread-group-head">
								<button type="button" className="thread-group-toggle" title={group.cwd} aria-expanded={open} onClick={() => toggle(group)}>
									<span className="thread-group-name">{folderName(group.cwd)}</span>
									<ChevronRight size={12} className={`chev${open ? " open" : ""}`} />
								</button>
								<button type="button" className="icon-btn sm" aria-label={`New chat in ${folderName(group.cwd)}`} title={`New chat in ${group.cwd}`} onClick={() => onNewChat(group.cwd)}>
									<Plus size={14} />
								</button>
							</div>
							{open && (
								<>
									{group.sessions.length === 0 && <div className="thread-empty">No sessions yet</div>}
									{visible.map((session) => (
										<ThreadRow
											key={session.path}
											session={session}
											active={session.path === activePath}
											running={session.path === runningPath}
											onPick={() => session.path !== activePath && onPick(session.path, session.cwd)}
											onRename={(name) => onRename(session.path, name)}
											onFork={() => onFork(session.path)}
											onDelete={() => onDelete(session.path)}
										/>
									))}
									{group.sessions.length > PER_FOLDER && (
										<button
											type="button"
											className="thread-more"
											onClick={() =>
												setShowAll((current) => {
													const next = new Set(current);
													if (next.has(group.cwd)) next.delete(group.cwd);
													else next.add(group.cwd);
													return next;
												})
											}
										>
											{showAll.has(group.cwd) ? "Show less" : `Show ${group.sessions.length - PER_FOLDER} more`}
										</button>
									)}
								</>
							)}
						</div>
					);
				})}
			</div>
		</aside>
	);
}
