import { ArrowLeft, ArrowRight, Bot, Globe, History, Loader2, Maximize2, Minimize2, MonitorSmartphone, PenTool, PictureInPicture2, Plus, RotateCcwSquare, RotateCw, ShieldCheck, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, useEffect, useRef, useState, type WheelEvent } from "react";
import { api, serverEvents } from "../api.ts";
import { relativeTime } from "../format.ts";
import type { SorvexActions } from "../store.ts";
import { BrowserAnnotate } from "./BrowserAnnotate.tsx";
import { FloatingPreview } from "./FloatingPreview.tsx";
import { Switch } from "./Pages.tsx";
import { PaneFrame } from "./PaneFrame.tsx";
import { Select } from "./Select.tsx";
import { Tooltip } from "./Tooltip.tsx";

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

/** From server/browser.ts. */
type Viewport = { mode: "responsive" } | { mode: "fixed"; presetId: string | null; width: number; height: number };
interface ViewportPreset {
	id: string;
	label: string;
	category: string;
	width: number;
	height: number;
}

interface Status {
	running: boolean;
	url: string;
	frame?: string;
	activity: Activity[];
	guardrails: Guardrails;
	tabs?: Tab[];
	viewport: Viewport;
	presets: ViewportPreset[];
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

/** The page size while floating and responsive before the side pane was ever shown: a laptop-sized window. */
const FLOAT_VIEWPORT = { width: 1280, height: 800 };
const PANE_SIZE_KEY = "browserPaneSize";

/** The side pane's last page size, so floating can keep it even when the pane was not opened this session. */
function storedPaneSize(): { width: number; height: number } | null {
	try {
		const size = JSON.parse(localStorage.getItem(PANE_SIZE_KEY) ?? "null") as { width: number; height: number } | null;
		return size && size.width > 0 && size.height > 0 ? size : null;
	} catch {
		return null;
	}
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
	floating,
	floatHost,
	onFloat,
}: {
	actions: SorvexActions;
	onClose: () => void;
	expanded: boolean;
	onToggleExpand: () => void;
	width: number;
	onResize: (width: number) => void;
	/** Shown as a floating preview over the chat (just the page) instead of the side pane. */
	floating: boolean;
	floatHost: HTMLElement | null;
	onFloat: () => void;
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
	const [viewport, setViewport] = useState<Viewport>({ mode: "responsive" });
	const [viewportBar, setViewportBar] = useState(false);
	// The pane's own size, shown in the viewport bar while responsive.
	const [paneSize, setPaneSize] = useState<{ width: number; height: number } | null>(storedPaneSize);
	// Floating, the page keeps the size it had in the side pane (responsive) or its fixed size, drawn scaled down into a
	// window of the same shape, so the floating preview shows what the pane showed.
	const floatSize = viewport.mode === "fixed" ? viewport : (paneSize ?? FLOAT_VIEWPORT);
	const floatSizeRef = useRef(floatSize);
	floatSizeRef.current = floatSize;
	const floatingRef = useRef(floating);
	floatingRef.current = floating;

	useEffect(() => {
		// Registers as the viewer and re-syncs. Runs again whenever the event stream (re)connects, because the pane can
		// open before the server is up, and a restarted server forgets the viewer and the viewport size.
		const register = () =>
			void api<Status>("POST", "/api/browser/view", { on: true }).then(
				(next) => {
					setStatus(next);
					setTabs(next.tabs ?? []);
					setViewport(next.viewport);
					if (next.viewport.mode === "fixed") setViewportBar(true);
					setFrame(next.frame);
					setUrl(next.url);
					setAddress(next.url === "about:blank" ? "" : next.url);
					const rect = viewportRef.current?.getBoundingClientRect();
					const size = floatingRef.current ? floatSizeRef.current : rect && { width: Math.round(rect.width), height: Math.round(rect.height) };
					if (size) void api("POST", "/api/browser/viewport", size).catch(() => undefined);
				},
				() => undefined,
			);
		register();
		const offOpen = serverEvents.onOpen(register);
		const offFrame = serverEvents.on<{ data: string }>("browser-frame", ({ data }) => setFrame(data));
		const offTabs = serverEvents.on<Tab[]>("browser-tabs", setTabs);
		// Set from here or by the AI's browser_viewport; a fixed size opens the bar so the user can see and undo it.
		const offViewport = serverEvents.on<Viewport>("browser-viewport", (next) => {
			setViewport(next);
			if (next.mode === "fixed") setViewportBar(true);
		});
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
			offViewport();
			offState();
			offActivity();
			void api("POST", "/api/browser/view", { on: false }).catch(() => undefined);
		};
	}, [actions]);

	// The remote page takes the viewport's size, so it reflows like a real window as the pane is resized or expanded.
	// Sizes are sent while dragging, one request at a time: when one finishes, the latest size (if it changed) goes next.
	// Floating, the page keeps the pane's last size and is scaled down into the window instead of reflowing to its
	// small size (which would switch most sites to a cramped phone layout).
	useEffect(() => {
		if (floating) {
			// Only matters while responsive: a fixed viewport ignores the pane's size.
			void api("POST", "/api/browser/viewport", floatSizeRef.current).catch(() => undefined);
			return;
		}
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
			setPaneSize(latest);
			try {
				localStorage.setItem(PANE_SIZE_KEY, JSON.stringify(latest));
			} catch {
				// Not remembered.
			}
			send();
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [view, floating]);

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

	/**
	 * Maps a point on the image to page coordinates. Docked, a frame is the viewport at 1:1 (scaled down mid-resize);
	 * floating, it is scaled to fit the window (object-fit: contain), so the painted picture may be inset in the element.
	 */
	const toPage = (event: MouseEvent | WheelEvent) => {
		const image = imageRef.current;
		const rect = image?.getBoundingClientRect();
		if (!image || !rect || !image.naturalWidth) return undefined;
		const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
		const left = rect.left + (rect.width - image.naturalWidth * scale) / 2;
		const top = rect.top + (rect.height - image.naturalHeight * scale) / 2;
		const x = Math.round((event.clientX - left) / scale);
		const y = Math.round((event.clientY - top) / scale);
		return x < 0 || y < 0 || x > image.naturalWidth || y > image.naturalHeight ? undefined : { x, y };
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

	/** The live page; `annotate` adds the annotation bar (the side pane only). */
	const page = (annotate: boolean) => (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the viewport forwards keyboard input to the remote page.
		<div ref={viewportRef} className={`browser-viewport${viewport.mode === "fixed" && !floating ? " fixed" : ""}`} tabIndex={0} onKeyDown={onKeyDown}>
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
			{frame && annotate && annotateBar && (
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
	);

	// The annotation bar is not shown floating, so no tool can stay active and swallow the page's input.
	if (floating && annotating) setAnnotating(false);

	if (floating && floatHost) {
		return (
			<FloatingPreview
				host={floatHost}
				storageKey="floatingBrowser"
				label="Floating browser preview"
				defaultSize={{ width: 400, height: 250 }}
				minSize={{ width: 240, height: 150 }}
				aspect={floatSize.width / floatSize.height}
			>
				{page(false)}
			</FloatingPreview>
		);
	}

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
					className={`icon-btn sm${viewportBar ? " active" : ""}`}
					aria-label="Viewport"
					aria-pressed={viewportBar}
					title={viewport.mode === "fixed" ? `Viewport: ${viewport.width} x ${viewport.height}` : "Viewport: responsive"}
					onClick={() => setViewportBar(!viewportBar)}
				>
					<MonitorSmartphone size={14} />
				</button>
				<Tooltip label="Float preview over chat">
					<button type="button" className="icon-btn sm" aria-label="Float preview over chat" onClick={onFloat}>
						<PictureInPicture2 size={14} />
					</button>
				</Tooltip>
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
			{viewportBar && status && (
				<ViewportBar
					viewport={viewport}
					presets={status.presets}
					paneSize={paneSize}
					onSet={(next) => {
						setView("page");
						void act({ action: "viewport", ...next });
					}}
				/>
			)}
			{view === "page" && page(true)}
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

/**
 * The viewport bar under the toolbar, like DevTools' device toolbar: a preset, or a custom width x height (typing a
 * size switches to custom), and a button to swap them for landscape. "Responsive" follows the pane again.
 */
function ViewportBar({
	viewport,
	presets,
	paneSize,
	onSet,
}: {
	viewport: Viewport;
	presets: ViewportPreset[];
	paneSize: { width: number; height: number } | null;
	onSet: (next: { preset?: string; width?: number; height?: number }) => void;
}) {
	const shown = viewport.mode === "fixed" ? viewport : paneSize;
	const [width, setWidth] = useState("");
	const [height, setHeight] = useState("");
	const shownWidth = shown?.width;
	const shownHeight = shown?.height;
	useEffect(() => {
		setWidth(shownWidth ? String(shownWidth) : "");
		setHeight(shownHeight ? String(shownHeight) : "");
	}, [shownWidth, shownHeight]);
	const value = viewport.mode === "responsive" ? "responsive" : (viewport.presetId ?? "custom");
	const options = [
		{ value: "responsive", label: "Responsive", hint: "Follows the pane", text: "Responsive" },
		...(value === "custom" && viewport.mode === "fixed" ? [{ value: "custom", label: "Custom", hint: `${viewport.width} x ${viewport.height}`, text: "Custom" }] : []),
		...presets.map((preset) => ({ value: preset.id, label: preset.label, hint: `${preset.width} x ${preset.height}`, group: preset.category })),
	];
	const apply = () => {
		const w = Number(width);
		const h = Number(height);
		if (!shown || (w === shown.width && h === shown.height)) return;
		if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) onSet({ width: w, height: h });
	};
	const field = (label: string, text: string, setText: (text: string) => void) => (
		<input
			className="viewport-size"
			aria-label={label}
			inputMode="numeric"
			value={text}
			onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ""))}
			onBlur={apply}
			onKeyDown={(event) => event.key === "Enter" && apply()}
		/>
	);
	return (
		<div className="viewport-bar">
			<Select ariaLabel="Viewport" width={180} searchable value={value} options={options} onChange={(next) => next !== "custom" && onSet({ preset: next })} />
			{field("Viewport width", width, setWidth)}
			<span className="viewport-x">x</span>
			{field("Viewport height", height, setHeight)}
			<button
				type="button"
				className="icon-btn sm"
				aria-label="Rotate viewport"
				title="Rotate (swap width and height)"
				disabled={viewport.mode !== "fixed"}
				onClick={() => viewport.mode === "fixed" && onSet({ width: viewport.height, height: viewport.width })}
			>
				<RotateCcwSquare size={14} />
			</button>
		</div>
	);
}
