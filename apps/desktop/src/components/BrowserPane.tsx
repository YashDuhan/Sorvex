import { ArrowLeft, ArrowRight, Bot, Globe, History, Loader2, Maximize2, Minimize2, PenTool, Plus, RotateCw, ShieldCheck, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState, type WheelEvent } from "react";
import { api, serverEvents } from "../api.ts";
import { relativeTime } from "../format.ts";
import type { SorvexActions } from "../store.ts";
import { BrowserAnnotate } from "./BrowserAnnotate.tsx";
import { Switch } from "./Pages.tsx";
import { PaneFrame } from "./PaneFrame.tsx";
import { Select } from "./Select.tsx";

interface Guardrails {
	askOnSubmit: boolean;
	askNewDomains: boolean;
	blockedDomains: string[];
	allowedDomains: string[];
	searchEngine: SearchEngine;
}

type SearchEngine = "bing" | "google" | "duckduckgo";

const SEARCH_ENGINES: Record<SearchEngine, { label: string; url: string }> = {
	bing: { label: "Bing", url: "https://www.bing.com/search?q=" },
	google: { label: "Google", url: "https://www.google.com/search?q=" },
	duckduckgo: { label: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
};

interface Activity {
	at: number;
	action: string;
	detail: string;
	decision: string;
	reason?: string;
}

interface Tab {
	id: number;
	title: string;
	url: string;
	favicon: string | null;
	active: boolean;
}

interface Status {
	running: boolean;
	url: string;
	frame?: string;
	activity: Activity[];
	guardrails: Guardrails;
	tabs?: Tab[];
}

/** Keys forwarded by name; anything else that is one printable character is typed as text. */
const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** Address-bar text: a URL or bare domain opens directly, anything else is searched, as in a normal browser. */
function toUrl(text: string, engine: SearchEngine): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
	if (!/\s/.test(text) && (/^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text) || /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(text))) {
		return /^(localhost|127\.|\[::1\])/i.test(text) ? `http://${text}` : `https://${text}`;
	}
	return `${(SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.bing).url}${encodeURIComponent(text)}`;
}

/**
 * The shared browser, like Claude Code's or Cursor's built-in one. It shows the live tab the AI drives (streamed
 * from the desktop server), and you can use it yourself: click, scroll, type, and the address bar.
 */
export function BrowserPane({
	actions,
	onClose,
	expanded,
	onToggleExpand,
	width,
	onResize,
}: {
	actions: SorvexActions;
	onClose: () => void;
	expanded: boolean;
	onToggleExpand: () => void;
	width: number;
	onResize: (width: number) => void;
}) {
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [status, setStatus] = useState<Status | null>(null);
	const [frame, setFrame] = useState<string | undefined>();
	const [url, setUrl] = useState("");
	const [address, setAddress] = useState("");
	const [view, setView] = useState<"page" | "settings" | "activity">("page");
	const [loading, setLoading] = useState(false);
	const [aiActive, setAiActive] = useState(false);
	const imageRef = useRef<HTMLImageElement>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const aiTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [annotateBar, setAnnotateBar] = useState(true);
	// While an annotation tool is active, clicks and keys go to it instead of the page.
	const [annotating, setAnnotating] = useState(false);

	useEffect(() => {
		// Registers as the viewer and re-syncs. Runs again whenever the event stream (re)connects, because the pane can
		// open before the server is up, and a restarted server forgets the viewer and the viewport size.
		const register = () =>
			void api<Status>("POST", "/api/browser/view", { on: true }).then(
				(next) => {
					setStatus(next);
					setTabs(next.tabs ?? []);
					setFrame(next.frame);
					setUrl(next.url);
					setAddress(next.url === "about:blank" ? "" : next.url);
					const rect = viewportRef.current?.getBoundingClientRect();
					if (rect) void api("POST", "/api/browser/viewport", { width: Math.round(rect.width), height: Math.round(rect.height) }).catch(() => undefined);
				},
				() => undefined,
			);
		register();
		const offOpen = serverEvents.onOpen(register);
		const offFrame = serverEvents.on<{ data: string }>("browser-frame", ({ data }) => setFrame(data));
		const offTabs = serverEvents.on<Tab[]>("browser-tabs", setTabs);
		const offState = serverEvents.on<{ running: boolean; url: string }>("browser-state", (state) => {
			if (!state.running) setFrame(undefined);
			setUrl(state.url);
			if (document.activeElement?.className !== "browser-address") setAddress(state.url === "about:blank" ? "" : state.url);
		});
		const offActivity = serverEvents.on<Activity>("browser-activity", (entry) => {
			setStatus((current) => (current ? { ...current, activity: [entry, ...current.activity] } : current));
			setAiActive(true);
			clearTimeout(aiTimer.current);
			aiTimer.current = setTimeout(() => setAiActive(false), 4000);
		});
		return () => {
			offOpen();
			offFrame();
			offTabs();
			offState();
			offActivity();
			void api("POST", "/api/browser/view", { on: false }).catch(() => undefined);
		};
	}, [actions]);

	// The remote page takes the viewport's size, so it reflows like a real window as the pane is resized or expanded.
	// Sizes are sent while dragging, one request at a time: when one finishes, the latest size (if it changed) goes next.
	useEffect(() => {
		const element = viewportRef.current;
		if (!element) return;
		let latest: { width: number; height: number } | undefined;
		let sending = false;
		const send = () => {
			if (sending || !latest) return;
			const size = latest;
			latest = undefined;
			sending = true;
			void api("POST", "/api/browser/viewport", size)
				.catch(() => undefined)
				.finally(() => {
					sending = false;
					send();
				});
		};
		const observer = new ResizeObserver(([entry]) => {
			latest = { width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) };
			send();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [view]);

	const act = async (body: Record<string, unknown>) => {
		setLoading(true);
		try {
			await api("POST", "/api/browser/act", body);
		} catch (error) {
			actions.toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	};

	const input = (body: Record<string, unknown>) => void api("POST", "/api/browser/input", body).catch(() => undefined);

	/** Maps a point on the image to page coordinates. A frame is the viewport at 1:1, but may be scaled down mid-resize. */
	const toPage = (event: MouseEvent | WheelEvent) => {
		const image = imageRef.current;
		const rect = image?.getBoundingClientRect();
		if (!image || !rect || !image.naturalWidth) return undefined;
		return {
			x: Math.round(((event.clientX - rect.left) / rect.width) * image.naturalWidth),
			y: Math.round(((event.clientY - rect.top) / rect.height) * image.naturalHeight),
		};
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (annotating) return;
		const modifier = event.ctrlKey || event.metaKey || event.altKey;
		if (NAMED_KEYS.has(event.key) || (modifier && event.key.length === 1)) {
			event.preventDefault();
			const prefix = `${event.ctrlKey || event.metaKey ? "Control+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey && !NAMED_KEYS.has(event.key) ? "" : event.shiftKey ? "Shift+" : ""}`;
			input({ kind: "key", key: `${prefix}${event.key}` });
		} else if (event.key.length === 1) {
			event.preventDefault();
			input({ kind: "text", text: event.key });
		}
	};

	const guardrails = status?.guardrails;
	const saveGuardrails = (next: Guardrails) => {
		setStatus((current) => (current ? { ...current, guardrails: next } : current));
		void api("PUT", "/api/browser/guardrails", next).catch((error: unknown) => actions.toast("error", String(error)));
	};

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize}>
			<div className="browser-tabs">
				{tabs.map((tab) => (
					<div key={tab.id} className={`browser-tab${tab.active ? " active" : ""}`} title={`${tab.title}\n${tab.url}`}>
						<button type="button" className="browser-tab-main" onClick={() => !tab.active && void act({ action: "tabs", op: "switch", id: tab.id })}>
							{tab.favicon ? (
								<img src={tab.favicon} alt="" width={14} height={14} onError={(event) => (event.currentTarget.style.visibility = "hidden")} />
							) : (
								<Globe size={13} />
							)}
							<span>{tab.title === "about:blank" ? "New tab" : tab.title}</span>
						</button>
						<button type="button" className="browser-tab-close" aria-label={`Close ${tab.title}`} onClick={() => {
								void act({ action: "tabs", op: "close", id: tab.id });
								// Closing the last tab closes the browser, so close the pane with it.
								if (tabs.length <= 1) onClose();
							}}
						>
							<X size={12} />
						</button>
					</div>
				))}
				<button type="button" className="icon-btn sm" aria-label="New tab" title="New tab" onClick={() => void act({ action: "tabs", op: "new" })}>
					<Plus size={15} />
				</button>
				<span className="grow" />
				{aiActive && (
					<span className="browser-ai" title="The AI is using the browser">
						<Bot size={12} /> AI
					</span>
				)}
				<button type="button" className="icon-btn sm" aria-label={expanded ? "Collapse browser" : "Expand browser"} title={expanded ? "Collapse" : "Expand"} onClick={onToggleExpand}>
					{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				</button>
				<button type="button" className="icon-btn sm" aria-label="Close browser" title="Close" onClick={onClose}>
					<X size={15} />
				</button>
			</div>
			<div className="browser-toolbar">
				<button type="button" className="icon-btn sm" aria-label="Back" onClick={() => void act({ action: "back" })}>
					<ArrowLeft size={15} />
				</button>
				<button type="button" className="icon-btn sm" aria-label="Forward" onClick={() => void act({ action: "forward" })}>
					<ArrowRight size={15} />
				</button>
				<button type="button" className="icon-btn sm" aria-label="Reload" onClick={() => void act({ action: "reload" })}>
					{loading ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
				</button>
				<form
					className="browser-address-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!address.trim()) return;
						// Leave the settings or activity view, so the page being opened is visible.
						setView("page");
						void act({ action: "navigate", url: toUrl(address.trim(), status?.guardrails.searchEngine ?? "bing") });
					}}
				>
					<input className="browser-address" value={address} placeholder="Search or enter a URL" spellCheck={false} onChange={(event) => setAddress(event.target.value)} />
				</form>
				<button
					type="button"
					className={`icon-btn sm${annotateBar ? " active" : ""}`}
					aria-label="Annotation toolbar"
					title="Select elements or draw on the page, and send them to the chat"
					onClick={() => {
						setView("page");
						setAnnotateBar(!annotateBar);
					}}
				>
					<PenTool size={14} />
				</button>
				<button
					type="button"
					className={`icon-btn sm${view === "settings" ? " active" : ""}`}
					aria-label="Browser settings"
					title="Search engine and guardrails"
					onClick={() => setView(view === "settings" ? "page" : "settings")}
				>
					<ShieldCheck size={15} />
				</button>
				<button
					type="button"
					className={`icon-btn sm${view === "activity" ? " active" : ""}`}
					aria-label="Browser activity"
					title="What the AI did in the browser"
					onClick={() => setView(view === "activity" ? "page" : "activity")}
				>
					<History size={15} />
				</button>
			</div>
			{view === "page" && (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: the viewport forwards keyboard input to the remote page.
				<div ref={viewportRef} className="browser-viewport" tabIndex={0} onKeyDown={onKeyDown}>
					{frame ? (
						<img
							ref={imageRef}
							src={`data:image/jpeg;base64,${frame}`}
							alt={`Browser showing ${url}`}
							draggable={false}
							onClick={(event) => {
								event.currentTarget.parentElement?.focus();
								const point = toPage(event);
								if (point) input({ kind: "click", ...point });
							}}
							onWheel={(event) => input({ kind: "wheel", dy: Math.round(event.deltaY) })}
						/>
					) : (
						<div className="browser-empty">
							<Globe size={28} />
							<div>Type a URL above, or ask the AI to open a page.</div>
							<small>Separate profile: your personal browser logins are not available here.</small>
						</div>
					)}
					{frame && annotateBar && (
						<BrowserAnnotate
							frame={frame}
							imageRef={imageRef}
							onClose={() => setAnnotateBar(false)}
							onActiveChange={setAnnotating}
							onAttached={() => {
								// The full-window browser hides the composer; go back so the user can write the prompt.
								if (expanded) onToggleExpand();
								actions.toast("info", "Added to the chat");
							}}
							toast={actions.toast}
						/>
					)}
				</div>
			)}
			{view === "settings" && guardrails && (
				<div className="browser-panel">
					<h3>Search</h3>
					<div className="setting">
						<div className="label">
							Search engine
							<small>For address-bar text that is not a URL. Google and DuckDuckGo often show this browser a bot check.</small>
						</div>
						<Select
							ariaLabel="Search engine"
							width={150}
							value={guardrails.searchEngine}
							options={Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({ value, label: engine.label }))}
							onChange={(value) => saveGuardrails({ ...guardrails, searchEngine: value as SearchEngine })}
						/>
					</div>
					<h3>Browser guardrails</h3>
					<p className="panel-note">Typing into password, payment and one-time-code fields, and opening non-http(s) URLs, are always blocked for the AI.</p>
					<div className="setting">
						<div className="label">
							Ask before form submits
							<small>Submit buttons, and Enter inside a form</small>
						</div>
						<Switch on={guardrails.askOnSubmit} label="Ask before form submits" onChange={(on) => saveGuardrails({ ...guardrails, askOnSubmit: on })} />
					</div>
					<div className="setting">
						<div className="label">
							Ask before new domains
							<small>The first time the AI opens a site in this app session</small>
						</div>
						<Switch on={guardrails.askNewDomains} label="Ask before new domains" onChange={(on) => saveGuardrails({ ...guardrails, askNewDomains: on })} />
					</div>
					<label className="panel-label">
						Blocked domains (one per line, *.example.com for subdomains)
						<textarea
							className="modal-input mono"
							rows={3}
							value={guardrails.blockedDomains.join("\n")}
							onChange={(event) => saveGuardrails({ ...guardrails, blockedDomains: event.target.value.split("\n").map((d) => d.trim()).filter(Boolean) })}
						/>
					</label>
					<label className="panel-label">
						Allowed domains only (empty = any not blocked)
						<textarea
							className="modal-input mono"
							rows={3}
							value={guardrails.allowedDomains.join("\n")}
							onChange={(event) => saveGuardrails({ ...guardrails, allowedDomains: event.target.value.split("\n").map((d) => d.trim()).filter(Boolean) })}
						/>
					</label>
				</div>
			)}
			{view === "activity" && (
				<div className="browser-panel">
					<h3>AI browser activity</h3>
					{status?.activity.length === 0 && <div className="empty-note">Nothing yet</div>}
					{status?.activity.map((entry, index) => (
						<div key={`${entry.at}-${index}`} className="ssh-audit">
							<span className={`badge ${entry.decision === "block" || entry.decision === "denied" ? "danger" : entry.decision === "approved" ? "warn" : "ok"}`}>{entry.decision}</span>
							<span className="mcp-badge">{entry.action}</span>
							<span className="mono ssh-audit-command">{entry.detail}</span>
							<span className="ssh-audit-meta">{relativeTime(entry.at)}</span>
							{entry.reason && <div className="panel-note ssh-audit-reason">{entry.reason}</div>}
						</div>
					))}
				</div>
			)}
		</PaneFrame>
	);
}
