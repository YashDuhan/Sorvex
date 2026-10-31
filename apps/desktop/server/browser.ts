import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type CDPSession, chromium, type Page } from "playwright-core";
import { redactSecrets } from "../extension/redact.ts";
import type { Hub } from "./hub.ts";
import { desktopDir } from "./paths.ts";
import { readSettings } from "./settings.ts";

/**
 * The shared browser for the user and the AI. Chromium runs headless with its own profile in
 * ~/.sorvex/agent/desktop/browser (never the user's personal profile), and its tab is streamed to the GUI's
 * Browser pane with CDP screencast frames. The AI drives it through the bridge extension's browser_* tools, which
 * call `act` with the per-launch token after the guardrail check.
 *
 * Page snapshots tag interactive elements with `data-sorvex-ref="N"`, so the AI can click or type by number.
 */

export interface BrowserGuardrails {
	/** Ask before clicks that submit a form, pressing Enter in a form, or `type` with submit. */
	askOnSubmit: boolean;
	/** Ask before the AI opens a domain it has not visited in this app session. */
	askNewDomains: boolean;
	/** Hostname patterns (`example.com`, `*.example.com`) the AI may never open. */
	blockedDomains: string[];
	/** When not empty, the AI may open only these hostnames. */
	allowedDomains: string[];
	/** Where address-bar text that is not a URL is searched. Google and DuckDuckGo often show this headless browser a bot check. */
	searchEngine: "bing" | "google" | "duckduckgo";
}

export const DEFAULT_BROWSER_GUARDRAILS: BrowserGuardrails = {
	askOnSubmit: true,
	askNewDomains: false,
	blockedDomains: [],
	allowedDomains: [],
	searchEngine: "bing",
};

export type BrowserAction =
	| { action: "navigate"; url: string }
	| { action: "back" | "forward" | "reload" | "snapshot" | "screenshot" | "read" | "console" }
	| { action: "click"; ref?: number; x?: number; y?: number }
	| { action: "type"; ref?: number; text: string; submit?: boolean; clear?: boolean }
	| { action: "press"; key: string }
	| { action: "scroll"; dy: number }
	| { action: "wait"; ms?: number; text?: string }
	| { action: "tabs"; op: "list" | "new" | "switch" | "close"; id?: number; url?: string };

export interface BrowserTab {
	id: number;
	title: string;
	url: string;
	favicon: string | null;
	active: boolean;
}

/** `key` groups "ask" decisions, so "Allow for this session" covers the same kind of action. */
export type BrowserDecision = { decision: "allow" | "ask" | "block"; reason?: string; key?: string };

const profileDir = join(desktopDir, "browser");
/** Screencast frames are capped at this size; the page itself follows the Browser pane's size (see resize()). */
const MAX_FRAME = { width: 3840, height: 2160 };

function findChromium(): string {
	const candidates = [process.env.SORVEX_BROWSER_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"];
	const found = candidates.find((path) => path && existsSync(path));
	if (!found) throw new Error("No Chromium or Chrome found. Install one, or set SORVEX_BROWSER_PATH.");
	return found;
}

export function browserGuardrails(): BrowserGuardrails {
	return { ...DEFAULT_BROWSER_GUARDRAILS, ...((readSettings() as { browser?: Partial<BrowserGuardrails> }).browser ?? {}) };
}

function hostMatches(host: string, pattern: string): boolean {
	const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
	if (!p) return false;
	if (p.startsWith("*.")) return host === p.slice(2) || host.endsWith(p.slice(1));
	return host === p || host.endsWith(`.${p}`);
}

/** Collects interactive, visible elements and numbers them. Runs inside the page. */
/** What the Browser pane's "Select element" tool shows on hover, and sends to the chat on click. */
export interface InspectedElement {
	rect: { x: number; y: number; width: number; height: number };
	label: string;
	tag?: string;
	text?: string;
	path?: string;
	styles?: Record<string, string>;
	html?: string;
	siblings?: string;
	react?: string;
	url?: string;
	image?: string;
}

/** Finds the element at a viewport point (inside open shadow roots too). Runs inside the page as (x, y, full). */
const INSPECT_SCRIPT = `((x, y, full) => {
	let el = document.elementFromPoint(x, y);
	while (el && el.shadowRoot) {
		const inner = el.shadowRoot.elementFromPoint(x, y);
		if (!inner || inner === el) break;
		el = inner;
	}
	if (!el) return null;
	const classes = (node) => (typeof node.className === "string" ? node.className.trim().split(/\\s+/).filter(Boolean) : []);
	const name = (node, all) => {
		const c = classes(node);
		return node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (c.length ? "." + (all ? c.slice(0, 3) : c.slice(0, 1)).join(".") : "");
	};
	const r = el.getBoundingClientRect();
	const base = { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, label: name(el, true) };
	if (!full) return base;
	const path = [];
	for (let node = el.parentElement; node && node.nodeType === 1 && path.length < 4; node = node.parentElement) path.unshift(name(node, false));
	const computed = getComputedStyle(el);
	const styles = {};
	for (const key of ["display", "position", "flex-direction", "justify-content", "align-items", "gap", "width", "height", "padding", "margin", "background-color", "color", "font-family", "font-size", "font-weight", "line-height", "border-radius", "border-width", "border-style", "border-color", "box-shadow"]) {
		styles[key] = computed.getPropertyValue(key);
	}
	const fiberKey = Object.keys(el).find((key) => key.startsWith("__reactFiber$"));
	const components = [];
	for (let fiber = fiberKey ? el[fiberKey] : null; fiber && components.length < 5; fiber = fiber.return) {
		const type = fiber.type;
		const component = typeof type === "function" ? type.displayName || type.name : null;
		if (component && !components.includes(component)) components.push(component);
	}
	const html = el.outerHTML;
	const shallow = (node) => {
		const c = classes(node);
		return "<" + node.tagName.toLowerCase() + (node.id ? ' id="' + node.id + '"' : "") + (c.length ? ' class="' + c.join(" ") + '"' : "") + " />";
	};
	const all = el.parentElement ? Array.from(el.parentElement.children) : [el];
	const at = all.indexOf(el);
	const siblings = all
		.slice(Math.max(0, at - 5), at + 6)
		.map((node) => (node === el ? "<!-- SELECTED -->" + (html.length > 1500 ? html.slice(0, 1500) + "..." : html) : shallow(node)))
		.join("\\n");
	return {
		...base,
		tag: el.tagName.toLowerCase(),
		text: (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 500),
		path: path.join(" > "),
		styles,
		html: html.length > 4000 ? html.slice(0, 4000) + "..." : html,
		siblings,
		react: components.join(" < "),
		url: location.href,
	};
})`;

const SNAPSHOT_SCRIPT = `(() => {
	for (const el of document.querySelectorAll("[data-sorvex-ref]")) el.removeAttribute("data-sorvex-ref");
	const selector = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=option], [role=switch], [role=combobox], [contenteditable=""], [contenteditable=true], [onclick]';
	const out = [];
	let n = 0;
	for (const el of document.querySelectorAll(selector)) {
		const rect = el.getBoundingClientRect();
		const style = getComputedStyle(el);
		if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") continue;
		if (n >= 250) { out.push("... more elements not listed; scroll or narrow down"); break; }
		n++;
		el.setAttribute("data-sorvex-ref", String(n));
		const tag = el.tagName.toLowerCase();
		const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "select" ? "select" : tag === "textarea" ? "textbox" : tag === "input" ? ((el.type || "text") === "submit" || el.type === "button" ? "button" : (el.type || "text") + " input") : tag);
		const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || "").replace(/\\s+/g, " ").trim().slice(0, 80);
		const extra = [];
		if (el.disabled) extra.push("disabled");
		if (el.checked) extra.push("checked");
		if (tag === "a" && el.getAttribute("href")) extra.push("href=" + el.getAttribute("href").slice(0, 80));
		if (rect.bottom < 0 || rect.top > innerHeight) extra.push("offscreen");
		out.push("[" + n + "] " + role + ' "' + name + '"' + (extra.length ? " (" + extra.join(", ") + ")" : ""));
	}
	const headings = [...document.querySelectorAll("h1, h2")].slice(0, 8).map((h) => "# " + h.innerText.trim().slice(0, 80)).filter((h) => h.length > 2);
	return { title: document.title, url: location.href, headings, elements: out, scroll: Math.round(scrollY) + "/" + Math.max(0, document.documentElement.scrollHeight - innerHeight) };
})()`;

/** Facts about the element behind a ref, for the guardrails. Runs inside the page. */
const ELEMENT_INFO_SCRIPT = `(ref) => {
	const el = document.querySelector('[data-sorvex-ref="' + ref + '"]');
	if (!el) return null;
	const attrs = [el.type, el.name, el.id, el.autocomplete, el.getAttribute("aria-label"), el.placeholder].filter(Boolean).join(" ").toLowerCase();
	const form = el.form || el.closest("form");
	const submits = el.tagName === "BUTTON" ? (el.type || "submit") === "submit" && !!form : el.tagName === "INPUT" && (el.type === "submit" || el.type === "image");
	return { sensitive: el.type === "password" || /passw|cc-|card|cvv|cvc|csc|iban|ssn|one-time-code|otp|pin\\b/.test(attrs), inForm: !!form, submits };
}`;

interface ConsoleEntry {
	type: string;
	text: string;
}

interface ActivityEntry {
	at: number;
	action: string;
	detail: string;
	decision: string;
	reason?: string;
}

export class BrowserManager {
	readonly token: string;
	private context: BrowserContext | undefined;
	private page: Page | undefined;
	private cdp: CDPSession | undefined;
	private starting: Promise<Page> | undefined;
	private viewing = false;
	private lastFrame: string | undefined;
	/** Page viewport in CSS pixels. Follows the Browser pane, so pages reflow (down to their mobile layout) as it shrinks. */
	private size = { width: 1280, height: 800 };
	private readonly consoleLog: ConsoleEntry[] = [];
	private readonly visitedHosts = new Set<string>();
	private readonly activity: ActivityEntry[] = [];
	private readonly hub: Hub;
	private readonly tabIds = new WeakMap<Page, number>();
	private nextTabId = 1;
	private tabsTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(hub: Hub, token: string) {
		this.hub = hub;
		this.token = token;
	}

	status() {
		return { running: this.page !== undefined, url: this.page?.url() ?? "", frame: this.lastFrame, activity: [...this.activity].reverse(), guardrails: browserGuardrails() };
	}

	private log(entry: Omit<ActivityEntry, "at">): void {
		const full = { at: Date.now(), ...entry, detail: redactSecrets(entry.detail).text };
		this.activity.push(full);
		if (this.activity.length > 300) this.activity.shift();
		this.hub.broadcast("browser-activity", full);
	}

	private async ensure(): Promise<Page> {
		if (this.page && !this.page.isClosed()) return this.page;
		this.starting ??= (async () => {
			mkdirSync(profileDir, { recursive: true, mode: 0o700 });
			this.context = await chromium.launchPersistentContext(profileDir, {
				executablePath: findChromium(),
				headless: true,
				viewport: this.size,
				acceptDownloads: false,
				args: ["--no-first-run", "--no-default-browser-check", "--disable-features=Translate"],
			});
			this.context.on("page", (page) => void this.attach(page).catch(() => undefined));
			this.context.on("close", () => {
				this.context = undefined;
				this.page = undefined;
				this.cdp = undefined;
				this.lastFrame = undefined;
				this.hub.broadcast("browser-state", { running: false, url: "" });
				this.hub.broadcast("browser-tabs", []);
			});
			const page = this.context.pages()[0] ?? (await this.context.newPage());
			await this.attach(page);
			return page;
		})().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	/** Open tabs with title and favicon, for the tab strip and the AI's browser_tabs tool. */
	async tabs(): Promise<BrowserTab[]> {
		const pages = this.context?.pages() ?? [];
		return Promise.all(
			pages.map(async (page) => {
				const [title, favicon] = await Promise.all([
					page.title().catch(() => ""),
					page
						.evaluate(
							"(() => { const l = document.querySelector('link[rel~=\"icon\"], link[rel=\"shortcut icon\"]'); return l ? l.href : (location.protocol.startsWith('http') ? location.origin + '/favicon.ico' : null); })()",
						)
						.catch(() => null) as Promise<string | null>,
				]);
				return { id: this.tabIds.get(page) ?? 0, title: title || page.url(), url: page.url(), favicon, active: page === this.page };
			}),
		);
	}

	/** Coalesces tab changes (navigations, titles, opens and closes) into one `browser-tabs` event. */
	private announceTabs(): void {
		clearTimeout(this.tabsTimer);
		this.tabsTimer = setTimeout(() => void this.tabs().then((tabs) => this.hub.broadcast("browser-tabs", tabs)), 150);
	}

	private findTab(id: number | undefined): Page {
		const page = this.context?.pages().find((candidate) => this.tabIds.get(candidate) === id);
		if (!page) throw new Error(`No tab ${id}. Use browser_tabs to list them.`);
		return page;
	}

	async newTab(url?: string): Promise<Page> {
		await this.ensure();
		const page = await this.context!.newPage();
		// The context's "page" event attaches it and makes it active.
		if (url) await page.goto(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`, { waitUntil: "domcontentloaded", timeout: 30000 });
		return page;
	}

	async switchTab(id: number): Promise<void> {
		const page = this.findTab(id);
		this.page = page;
		await page.bringToFront().catch(() => undefined);
		await this.startScreencast();
		this.hub.broadcast("browser-state", { running: true, url: page.url() });
		this.announceTabs();
	}

	/** Closing the last tab closes the browser, like a real one; the next page the user or AI opens starts it again. */
	async closeTab(id: number): Promise<void> {
		const page = this.context?.pages().find((candidate) => this.tabIds.get(candidate) === id);
		// Already gone (e.g. a second click on a closing tab): just resend the real tab list.
		if (!page) return this.announceTabs();
		if ((this.context?.pages().length ?? 0) <= 1) return this.close();
		await page.close();
	}

	/** Makes `page` the shared tab: popups and new tabs take over, so the user always sees what the AI acts on. */
	private async attach(page: Page): Promise<void> {
		this.tabIds.set(page, this.nextTabId++);
		this.page = page;
		await page.setViewportSize(this.size).catch(() => undefined);
		page.on("console", (message) => {
			this.consoleLog.push({ type: message.type(), text: message.text().slice(0, 500) });
			if (this.consoleLog.length > 200) this.consoleLog.shift();
		});
		page.on("pageerror", (error) => this.consoleLog.push({ type: "pageerror", text: String(error).slice(0, 500) }));
		page.on("framenavigated", (frame) => {
			if (frame !== page.mainFrame()) return;
			if (page === this.page) this.hub.broadcast("browser-state", { running: true, url: page.url() });
			this.announceTabs();
		});
		page.on("load", () => this.announceTabs());
		page.on("close", () => {
			if (this.page === page) {
				this.page = this.context?.pages().at(-1);
				void this.startScreencast();
				if (this.page) this.hub.broadcast("browser-state", { running: true, url: this.page.url() });
			}
			this.announceTabs();
		});
		await this.startScreencast();
		this.hub.broadcast("browser-state", { running: true, url: page.url() });
		this.announceTabs();
	}

	/**
	 * Streams the active tab. A tab that was just opened may not accept CDP commands yet ("Not attached to an active
	 * page"), so this retries briefly instead of failing; a later tab switch or navigation starts it again anyway.
	 */
	private async startScreencast(attempt = 0): Promise<void> {
		const page = this.page;
		if (!page || !this.context || !this.viewing || page.isClosed()) return;
		await this.cdp?.detach().catch(() => undefined);
		this.cdp = undefined;
		try {
			const cdp = await this.context.newCDPSession(page);
			this.cdp = cdp;
			cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number }) => {
				if (this.page !== page) return;
				this.lastFrame = frame.data;
				this.hub.broadcast("browser-frame", { data: frame.data });
				void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
			});
			await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: MAX_FRAME.width, maxHeight: MAX_FRAME.height });
		} catch {
			if (attempt < 5 && this.page === page) {
				await new Promise((resolve) => setTimeout(resolve, 200));
				await this.startScreencast(attempt + 1);
			}
		}
	}

	/** Sets every tab's viewport to the Browser pane's size, so the page lays itself out for that width. */
	async resize(width: number, height: number): Promise<void> {
		const size = { width: Math.round(Math.min(Math.max(width, 320), MAX_FRAME.width)), height: Math.round(Math.min(Math.max(height, 240), MAX_FRAME.height)) };
		if (size.width === this.size.width && size.height === this.size.height) return;
		this.size = size;
		// Only the visible tab is waited for; background tabs follow without delaying the next resize.
		for (const page of this.context?.pages() ?? []) if (page !== this.page) void page.setViewportSize(size).catch(() => undefined);
		await this.page?.setViewportSize(size).catch(() => undefined);
	}

	/**
	 * The Browser pane registers while visible, so frames are only produced when someone is watching. Idempotent: the
	 * pane registers again after every event-stream reconnect.
	 */
	async view(on: boolean): Promise<void> {
		this.viewing = on;
		if (on) {
			await this.ensure();
			await this.startScreencast();
		} else {
			await this.cdp?.send("Page.stopScreencast").catch(() => undefined);
		}
	}

	/** Guardrails, checked by the extension before asking the user and again here before acting. */
	async check(input: BrowserAction): Promise<BrowserDecision> {
		if (input.action === "tabs") return input.op === "new" && input.url ? this.check({ action: "navigate", url: input.url }) : { decision: "allow" };
		const rules = browserGuardrails();
		if (input.action === "navigate") {
			let url: URL;
			try {
				url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`);
			} catch {
				return { decision: "block", reason: "Not a valid URL" };
			}
			if (url.protocol !== "http:" && url.protocol !== "https:") return { decision: "block", reason: `Only http and https pages may be opened, not ${url.protocol}` };
			const host = url.hostname.toLowerCase();
			if (rules.blockedDomains.some((pattern) => hostMatches(host, pattern))) return { decision: "block", reason: `${host} is on the blocked domains list` };
			if (rules.allowedDomains.length > 0 && !rules.allowedDomains.some((pattern) => hostMatches(host, pattern))) {
				return { decision: "block", reason: `${host} is not on the allowed domains list` };
			}
			if (rules.askNewDomains && !this.visitedHosts.has(host)) return { decision: "ask", reason: `First visit to ${host}`, key: `browser:domain:${host}` };
			return { decision: "allow" };
		}
		if ((input.action === "type" || input.action === "click") && input.ref !== undefined) {
			const page = await this.ensure();
			const info = (await page.evaluate(`(${ELEMENT_INFO_SCRIPT})(${Number(input.ref)})`)) as { sensitive: boolean; inForm: boolean; submits: boolean } | null;
			if (!info) return { decision: "block", reason: `No element [${input.ref}]. Take a new browser_snapshot; refs change when the page changes.` };
			if (input.action === "type" && info.sensitive) {
				return { decision: "block", reason: "Typing into password, payment or one-time-code fields is not allowed. Ask the user to fill it in the Browser pane." };
			}
			const submits = input.action === "click" ? info.submits : Boolean(input.submit) && info.inForm;
			if (submits && rules.askOnSubmit) return { decision: "ask", reason: "This submits a form", key: "browser:submit" };
		}
		if (input.action === "press" && /^enter$/i.test(input.key) && rules.askOnSubmit) {
			const page = await this.ensure();
			const inForm = (await page.evaluate("!!(document.activeElement && document.activeElement.closest && document.activeElement.closest('form'))")) as boolean;
			if (inForm) return { decision: "ask", reason: "Enter submits a form", key: "browser:submit" };
		}
		return { decision: "allow" };
	}

	/** Runs an AI action. Requires the token, re-checks the guardrails, and only runs "ask" actions when approved. */
	async agentAct(token: string, input: BrowserAction, approved: boolean) {
		if (token !== this.token) throw new Error("Not allowed");
		const decision = await this.check(input);
		const detail = JSON.stringify(input);
		if (decision.decision === "block") {
			this.log({ action: input.action, detail, decision: "block", reason: decision.reason });
			throw new Error(`${decision.reason}. Nothing was done.`);
		}
		if (decision.decision === "ask" && !approved) {
			this.log({ action: input.action, detail, decision: "denied", reason: decision.reason });
			throw new Error("The user did not approve this browser action. Nothing was done.");
		}
		const result = await this.act(input);
		this.log({ action: input.action, detail, decision: decision.decision === "ask" ? "approved" : "allow" });
		return result;
	}

	/** Shared by the AI (after checks) and the user's own toolbar and clicks in the Browser pane. */
	/** Playwright errors carry a colored multi-line call log; keep only the first line, e.g. "net::ERR_NAME_NOT_RESOLVED at https://abc/". */
	async act(input: BrowserAction): Promise<{ text: string; image?: string }> {
		try {
			return await this.perform(input);
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, "");
			throw new Error(message.split("\n")[0].replace(/^[\w.]+: /, ""));
		}
	}

	private async perform(input: BrowserAction): Promise<{ text: string; image?: string }> {
		// Closing a tab must not start a stopped browser just to close something that is already gone.
		if (input.action === "tabs" && input.op === "close" && !this.context) return { text: "No tabs." };
		const page = await this.ensure();
		const settle = () => page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
		switch (input.action) {
			case "navigate": {
				const url = /^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`;
				const before = page.url();
				// ERR_ABORTED also means "replaced by another navigation", e.g. a script redirect. That is a success if the page moved.
				const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(async (error: unknown) => {
					if (!/ERR_ABORTED/.test(String(error))) throw error;
					await settle();
					if (page.url() === before) throw error;
					return null;
				});
				this.visitedHosts.add(new URL(page.url()).hostname.toLowerCase());
				return { text: `Opened ${page.url()} (HTTP ${response?.status() ?? "?"}), title: ${await page.title()}. Use browser_snapshot to see the page.` };
			}
			case "back":
				await page.goBack({ timeout: 15000 }).catch(() => undefined);
				return { text: `Now at ${page.url()}` };
			case "forward":
				await page.goForward({ timeout: 15000 }).catch(() => undefined);
				return { text: `Now at ${page.url()}` };
			case "reload":
				await page.reload({ timeout: 30000 });
				return { text: `Reloaded ${page.url()}` };
			case "click":
				if (input.ref !== undefined) await page.locator(`[data-sorvex-ref="${Number(input.ref)}"]`).first().click({ timeout: 8000 });
				else if (input.x !== undefined && input.y !== undefined) await page.mouse.click(input.x, input.y);
				else throw new Error("Give a ref from browser_snapshot, or x and y");
				await settle();
				return { text: `Clicked. Now at ${page.url()}. Take a new snapshot before using refs again.` };
			case "type": {
				if (input.ref !== undefined) {
					const target = page.locator(`[data-sorvex-ref="${Number(input.ref)}"]`).first();
					if (input.clear !== false) await target.fill(input.text, { timeout: 8000 });
					else await target.pressSequentially(input.text, { timeout: 8000 });
				} else {
					await page.keyboard.type(input.text);
				}
				if (input.submit) {
					await page.keyboard.press("Enter");
					await settle();
				}
				return { text: `Typed ${input.text.length} characters${input.submit ? " and pressed Enter" : ""}. Now at ${page.url()}.` };
			}
			case "press":
				await page.keyboard.press(input.key);
				await settle();
				return { text: `Pressed ${input.key}. Now at ${page.url()}.` };
			case "scroll":
				await page.mouse.wheel(0, input.dy);
				return { text: `Scrolled by ${input.dy}px.` };
			case "wait":
				if (input.text) await page.getByText(input.text).first().waitFor({ timeout: Math.min(input.ms ?? 10000, 30000) });
				else await page.waitForTimeout(Math.min(input.ms ?? 1000, 10000));
				return { text: input.text ? `"${input.text}" is on the page.` : "Waited." };
			case "snapshot": {
				const snap = (await page.evaluate(SNAPSHOT_SCRIPT)) as { title: string; url: string; headings: string[]; elements: string[]; scroll: string };
				return {
					text: [`URL: ${snap.url}`, `Title: ${snap.title}`, `Scroll: ${snap.scroll}`, ...snap.headings, "Elements (use the number as ref):", ...snap.elements].join("\n"),
				};
			}
			case "read": {
				const text = (await page.evaluate("document.body ? document.body.innerText : ''")) as string;
				return { text: `${page.url()}\n\n${text.replace(/\n{3,}/g, "\n\n").slice(0, 20000)}` };
			}
			case "screenshot": {
				const image = (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64");
				return { text: `Screenshot of ${page.url()}`, image };
			}
			case "tabs": {
				if (input.op === "new") await this.newTab(input.url);
				else if (input.op === "switch") await this.switchTab(Number(input.id));
				else if (input.op === "close") await this.closeTab(Number(input.id));
				if (input.url) this.visitedHosts.add(new URL((await this.ensure()).url()).hostname.toLowerCase());
				const tabs = await this.tabs();
				return { text: tabs.map((tab) => `${tab.active ? "*" : " "} [${tab.id}] ${tab.title} - ${tab.url}`).join("\n") || "No tabs." };
			}
			case "console":
				return {
					text: this.consoleLog.length ? this.consoleLog.slice(-50).map((entry) => `[${entry.type}] ${entry.text}`).join("\n") : "No console messages.",
				};
		}
		return { text: "" };
	}

	/**
	 * The element at a point, for the Browser pane's "Select element" tool. `full` adds its text, path, styles, HTML,
	 * React component names and a screenshot of it, to send to the chat.
	 */
	async inspect(x: number, y: number, full: boolean): Promise<InspectedElement | null> {
		const page = await this.ensure();
		const found = (await page.evaluate(`${INSPECT_SCRIPT}(${Number(x)}, ${Number(y)}, ${full === true})`)) as InspectedElement | null;
		if (!found || !full) return found;
		const { rect } = found;
		const pad = 8;
		const left = Math.max(0, rect.x - pad);
		const top = Math.max(0, rect.y - pad);
		const clip = { x: left, y: top, width: Math.min(this.size.width, rect.x + rect.width + pad) - left, height: Math.min(this.size.height, rect.y + rect.height + pad) - top };
		if (clip.width >= 2 && clip.height >= 2) found.image = (await page.screenshot({ type: "jpeg", quality: 85, clip }).catch(() => undefined))?.toString("base64");
		return found;
	}

	/** The user's own input from the Browser pane, in page coordinates. Not subject to the AI's guardrails. */
	async userInput(input: { kind: "click" | "wheel" | "key" | "text"; x?: number; y?: number; dy?: number; key?: string; text?: string }): Promise<void> {
		const page = await this.ensure();
		if (input.kind === "click" && input.x !== undefined && input.y !== undefined) await page.mouse.click(input.x, input.y);
		else if (input.kind === "wheel") await page.mouse.wheel(0, input.dy ?? 0);
		else if (input.kind === "key" && input.key) await page.keyboard.press(input.key);
		else if (input.kind === "text" && input.text) await page.keyboard.type(input.text);
	}

	async close(): Promise<void> {
		await this.context?.close().catch(() => undefined);
	}
}
