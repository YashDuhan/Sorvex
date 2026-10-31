import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";

interface TerminalInfo {
	id: number;
	title: string;
	cwd: string;
	exited: boolean;
}

function cssVar(name: string, fallback: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * One shell. Keystrokes go to the server one request at a time (parallel requests could arrive out of order), and
 * output streams back as `terminal-output` events. On mount it replays the server's scrollback, skipping any event
 * that the scrollback already contains.
 */
function TerminalView({ info, active, visible }: { info: TerminalInfo; active: boolean; visible: boolean }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const term = new Terminal({
			fontFamily: cssVar("--font-mono", "monospace"),
			fontSize: 13,
			lineHeight: 1.2,
			cursorBlink: true,
			scrollback: 5000,
			allowProposedApi: false,
			theme: { background: cssVar("--bg-root", "#141414"), foreground: cssVar("--text-primary", "#e5e5e5"), cursor: cssVar("--accent-blue", "#3b82f6") },
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);
		termRef.current = { term, fit };

		let shown = -1;
		const pending: { data: string; end: number }[] = [];
		const write = ({ data, end }: { data: string; end: number }) => {
			if (end <= shown) return;
			term.write(data.slice(Math.max(0, data.length - (end - shown))));
			shown = end;
		};
		const offOutput = serverEvents.on<{ id: number; data: string; end: number }>("terminal-output", (event) => {
			if (event.id !== info.id) return;
			if (shown < 0) pending.push(event);
			else write(event);
		});
		void api<{ data: string; end: number }>("POST", "/api/terminals/buffer", { id: info.id }).then(
			(buffer) => {
				term.write(buffer.data);
				shown = buffer.end;
				for (const event of pending.splice(0)) write(event);
			},
			() => {
				shown = 0;
				for (const event of pending.splice(0)) write(event);
			},
		);

		let queue = "";
		let sending = false;
		const flush = () => {
			if (sending || !queue) return;
			const data = queue;
			queue = "";
			sending = true;
			void api("POST", "/api/terminals/input", { id: info.id, data })
				.catch(() => undefined)
				.finally(() => {
					sending = false;
					flush();
				});
		};
		const onData = term.onData((data) => {
			queue += data;
			flush();
		});
		const onResize = term.onResize(({ rows, cols }) => void api("POST", "/api/terminals/resize", { id: info.id, rows, cols }).catch(() => undefined));
		// Refit when the pane is resized; a hidden pane has no size, so skip it until it is shown.
		const observer = new ResizeObserver(() => {
			if (host.offsetParent) fit.fit();
		});
		observer.observe(host);
		return () => {
			observer.disconnect();
			offOutput();
			onData.dispose();
			onResize.dispose();
			term.dispose();
			termRef.current = null;
		};
	}, [info.id]);

	useEffect(() => {
		if (!active || !visible) return;
		const frame = requestAnimationFrame(() => {
			termRef.current?.fit.fit();
			termRef.current?.term.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [active, visible]);

	return <div ref={hostRef} className="terminal-host" hidden={!active} />;
}

/** The Terminal pane: shells in the working directory, as tabs. They keep running while the pane is closed. */
export function TerminalPane({
	hidden,
	expanded,
	width,
	onResize,
	onToggleExpand,
	onClose,
	toast,
}: {
	hidden: boolean;
	expanded: boolean;
	width: number;
	onResize: (width: number) => void;
	onToggleExpand: () => void;
	onClose: () => void;
	toast: (kind: "error", text: string) => void;
}) {
	const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
	const [active, setActive] = useState<number | undefined>();

	const create = async () => {
		try {
			const info = await api<TerminalInfo>("POST", "/api/terminals/create", { rows: 24, cols: 80 });
			setTerminals((current) => [...current, info]);
			setActive(info.id);
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	};

	// Reattach to shells that are still running (after a window reload), or start the first one.
	useEffect(() => {
		void api<{ terminals: TerminalInfo[] }>("GET", "/api/terminals").then(({ terminals: existing }) => {
			if (existing.length > 0) {
				setTerminals(existing);
				setActive(existing[0]!.id);
			} else void create();
		});
		const offExit = serverEvents.on<{ id: number }>("terminal-exit", ({ id }) =>
			setTerminals((current) => current.map((terminal) => (terminal.id === id ? { ...terminal, exited: true } : terminal))),
		);
		return offExit;
		// Runs once; `create` only reads stable setters.
	}, []);

	const close = (id: number) => {
		void api("POST", "/api/terminals/close", { id }).catch(() => undefined);
		const index = terminals.findIndex((terminal) => terminal.id === id);
		const next = terminals.filter((terminal) => terminal.id !== id);
		setTerminals(next);
		if (active === id) setActive(next[Math.min(index, next.length - 1)]?.id);
	};

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize} hidden={hidden}>
			<PaneHeader expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose}>
				<div className="file-tabs">
					{terminals.map((terminal, index) => (
						<div key={terminal.id} className={`file-tab${terminal.id === active ? " active" : ""}${terminal.exited ? " exited" : ""}`} title={terminal.cwd}>
							<button type="button" className="file-tab-main" onClick={() => setActive(terminal.id)}>
								{index === 0 ? "Terminal" : `Terminal ${index + 1}`}
							</button>
							<button type="button" className="file-tab-close" aria-label="Close terminal" onClick={() => close(terminal.id)}>
								<X size={12} />
							</button>
						</div>
					))}
					<button type="button" className="icon-btn sm" aria-label="New terminal" title="New terminal" onClick={() => void create()}>
						<Plus size={15} />
					</button>
				</div>
			</PaneHeader>
			<div className="pane-body terminal-body">
				{terminals.map((terminal) => (
					<TerminalView key={terminal.id} info={terminal} active={terminal.id === active} visible={!hidden} />
				))}
				{terminals.length === 0 && <div className="empty-note">No terminals. Use + to open one.</div>}
			</div>
		</PaneFrame>
	);
}
