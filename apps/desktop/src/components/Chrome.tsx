import { getCurrentWindow } from "@tauri-apps/api/window";
import { Blocks, BookOpen, Cable, Cloud, Copy, HardDrive, Info, MessageSquare, Minus, Settings, Square, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Connection } from "../store.ts";
import { inTauri, useWindowControls } from "../window.ts";

export type Page = "chat" | "mcp" | "skills" | "ssh" | "providers" | "local" | "settings" | "about";

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
	{ page: "chat", label: "Chat", icon: <MessageSquare size={18} /> },
	{ page: "mcp", label: "MCP", icon: <Blocks size={18} /> },
	{ page: "skills", label: "Skills", icon: <BookOpen size={18} /> },
	{ page: "ssh", label: "SSH", icon: <Cable size={18} /> },
	{ page: "providers", label: "Providers", icon: <Cloud size={18} /> },
	{ page: "local", label: "Local models", icon: <HardDrive size={18} /> },
];
const NAV_BOTTOM: { page: Page; label: string; icon: ReactNode }[] = [
	{ page: "settings", label: "Settings", icon: <Settings size={18} /> },
	{ page: "about", label: "About", icon: <Info size={18} /> },
];

const DOT: Record<Connection, string> = {
	starting: "#f59e0b",
	ready: "#22c55e",
	exited: "#ef4444",
	error: "#ef4444",
};

export function Rail({
	page,
	onPage,
	connection,
	busy,
}: {
	page: Page;
	onPage: (page: Page) => void;
	connection: Connection;
	busy: boolean;
}) {
	const item = ({ page: target, label, icon }: (typeof NAV)[number]) => (
		<button
			key={target}
			type="button"
			className={`rail-item${page === target ? " active" : ""}`}
			title={label}
			aria-label={label}
			onClick={() => onPage(target)}
		>
			{icon}
			{target === "chat" && (
				<span
					className="rail-dot"
					style={{ background: busy ? "#3381ff" : DOT[connection], boxShadow: `0 0 6px ${busy ? "#3381ff" : DOT[connection]}` }}
				/>
			)}
		</button>
	);

	return (
		<nav className={`rail${connection === "exited" || connection === "error" ? " disconnected" : ""}`} data-tauri-drag-region>
			<img className="rail-logo" src="/logo.svg" alt="Sorvex" data-tauri-drag-region />
			{NAV.map(item)}
			<div className="rail-spacer" data-tauri-drag-region />
			<div className="rail-sep" />
			{NAV_BOTTOM.map(item)}
		</nav>
	);
}

export function PageHeader({ title, left, right }: { title: ReactNode; left?: ReactNode; right?: ReactNode }) {
	const { maximized, minimize, toggleMaximize, close } = useWindowControls();
	return (
		<header className="page-header" data-tauri-drag-region>
			<div className="header-side left" data-tauri-drag-region>
				{left}
			</div>
			<div className="page-title" data-tauri-drag-region>
				{title}
			</div>
			<div className="header-side right" data-tauri-drag-region>
				{right}
				{inTauri && (
					<div className="window-controls">
						<button type="button" className="icon-btn" aria-label="Minimize" onClick={minimize}>
							<Minus size={14} />
						</button>
						<button type="button" className="icon-btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={toggleMaximize}>
							{maximized ? <Copy size={12} /> : <Square size={12} />}
						</button>
						<button type="button" className="icon-btn close" aria-label="Close" onClick={close}>
							<X size={14} />
						</button>
					</div>
				)}
			</div>
		</header>
	);
}

type Direction = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const HANDLES: [string, Direction][] = [
	["n", "North"],
	["s", "South"],
	["e", "East"],
	["w", "West"],
	["ne", "NorthEast"],
	["nw", "NorthWest"],
	["se", "SouthEast"],
	["sw", "SouthWest"],
];

/** Edge and corner zones that resize the frameless window. */
export function ResizeHandles() {
	const { maximized } = useWindowControls();
	if (!inTauri || maximized) return null;
	return (
		<>
			{HANDLES.map(([cls, direction]) => (
				<div
					key={cls}
					className={`resize ${cls}`}
					onMouseDown={(event) => {
						if (event.button !== 0) return;
						event.preventDefault();
						void getCurrentWindow().startResizeDragging(direction);
					}}
				/>
			))}
		</>
	);
}
