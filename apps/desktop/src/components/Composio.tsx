import { Check, ChevronLeft, ChevronRight, ExternalLink, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import type { SorvexActions } from "../store.ts";

interface ComposioApp {
	slug: string;
	name: string;
	description: string;
	logo: string;
	rank: number | null;
}

interface Account {
	id: string;
	status: string;
	isDefault: boolean;
	email?: string;
	handle?: string;
}

const KEY_HELP = "https://docs.composio.dev/mcp";
const PAGE = 50;

/** Page numbers to show: the first and last, the current one and its neighbours, with gaps between runs. */
function pageNumbers(current: number, total: number): (number | "gap")[] {
	const pages = new Set([0, total - 1, current - 1, current, current + 1]);
	// Near either end, show a full run so the bar keeps its width.
	if (current < 4) for (let page = 0; page < 5; page++) pages.add(page);
	if (current > total - 5) for (let page = total - 5; page < total; page++) pages.add(page);
	const sorted = [...pages].filter((page) => page >= 0 && page < total).sort((a, b) => a - b);
	return sorted.flatMap((page, index) => (index > 0 && page - sorted[index - 1]! > 1 ? ["gap" as const, page] : [page]));
}
/** How long a sign-in may take before the pane stops waiting for it. */
const SIGN_IN_TIMEOUT = 10 * 60 * 1000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isActive = (account: Account) => account.status.toLowerCase() === "active";

function AppLogo({ app }: { app: ComposioApp }) {
	const [failed, setFailed] = useState(false);
	return (
		<span className="cp-logo">
			{failed ? <span className="cp-logo-letter">{app.name.charAt(0)}</span> : <img src={app.logo} alt="" loading="lazy" onError={() => setFailed(true)} />}
		</span>
	);
}

/** Paste the Composio consumer key; it is checked against Composio before it is saved. */
function KeySetup({ onSaved, actions, replacing, onCancel }: { onSaved: () => void; actions: SorvexActions; replacing?: boolean; onCancel?: () => void }) {
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const save = async () => {
		setBusy(true);
		setError("");
		try {
			const result = await api<{ tools: number }>("POST", "/api/composio/key", { apiKey: key });
			actions.toast("info", `Composio added to your MCP servers (${result.tools} tools)`);
			setKey("");
			onSaved();
		} catch (failure) {
			setError(errorText(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="cp-setup">
			<h2>{replacing ? "Replace your Composio key" : "Connect apps through Composio"}</h2>
			<p>
				Composio links Gmail, Slack, GitHub, Notion, Linear, Google Drive and 1,600 more apps through one MCP server. Paste the API key from your Composio
				account (it starts with <code>ck_</code>); Sorvex adds the server and you connect apps here.
			</p>
			<form
				className="cp-key-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<input className="modal-input mono" type="password" autoComplete="off" spellCheck={false} placeholder="ck_…" value={key} onChange={(event) => setKey(event.target.value)} />
				<button type="submit" className="btn-accent" disabled={busy || key.trim().length < 8}>
					{busy ? <Loader2 size={14} className="spin" /> : <KeyRound size={14} />} {busy ? "Checking" : "Save key"}
				</button>
				{onCancel && (
					<button type="button" className="btn-ghost" onClick={onCancel}>
						Cancel
					</button>
				)}
			</form>
			{error && <div className="mcp-error">{error}</div>}
			<p className="cp-fine">
				The key is saved in your Sorvex data folder and in the <code>composio</code> entry of <code>~/.sorvex/agent/mcp.json</code> (readable only by you), so
				the sorvex CLI can use it too. Tool calls to connected apps run through Composio's servers.{" "}
				<button type="button" className="cp-link" onClick={() => void api("POST", "/api/open", { url: KEY_HELP })}>
					Where to find the key <ExternalLink size={11} />
				</button>
			</p>
		</div>
	);
}

/**
 * The MCP page's Composio tab: every app Composio Connect offers, with Connect, which opens the app's sign-in page in
 * the browser and waits until the account is active, and Disconnect. The agent reaches connected apps through the
 * single `composio` MCP server.
 */
export function ComposioView({ actions, onChanged }: { actions: SorvexActions; onChanged: () => void }) {
	const [status, setStatus] = useState<{ configured: boolean; keyHint: string | null } | null>(null);
	const [replacing, setReplacing] = useState(false);
	const [apps, setApps] = useState<ComposioApp[] | null>(null);
	const [connections, setConnections] = useState<Record<string, Account[]>>({});
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<"all" | "connected">("all");
	const [page, setPage] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	/** Apps with a sign-in open: when it started, and the pending account it created (removed on Cancel). */
	const [waiting, setWaiting] = useState<Record<string, { since: number; accountId: string | null }>>({});
	const [busy, setBusy] = useState<string | null>(null);
	const [loadingState, setLoadingState] = useState(false);
	const checked = useRef(new Set<string>());

	const loadStatus = useCallback(() => {
		void api<{ configured: boolean; keyHint: string | null }>("GET", "/api/composio").then(setStatus, (error: unknown) => actions.toast("error", errorText(error)));
	}, [actions]);
	useEffect(loadStatus, [loadStatus]);

	const configured = status?.configured ?? false;
	useEffect(() => {
		if (!configured || apps) return;
		void api<{ apps: ComposioApp[] }>("GET", "/api/composio/apps").then((result) => setApps(result.apps), (error: unknown) => actions.toast("error", errorText(error)));
	}, [configured, apps, actions]);

	const check = useCallback(
		async (slugs: string[], force = false) => {
			const todo = force ? slugs : slugs.filter((slug) => !checked.current.has(slug));
			if (todo.length === 0) return;
			for (const slug of todo) checked.current.add(slug);
			try {
				const result = await api<{ connections: Record<string, Account[]> }>("POST", "/api/composio/connections", { slugs: todo });
				setConnections((current) => ({ ...current, ...result.connections }));
			} catch (error) {
				for (const slug of todo) checked.current.delete(slug);
				actions.toast("error", errorText(error));
			}
		},
		[actions],
	);

	// Connection state for the popular apps up front; others are checked as they come into view.
	useEffect(() => {
		if (!apps) return;
		setLoadingState(true);
		void check(apps.filter((app) => app.rank !== null).map((app) => app.slug)).finally(() => setLoadingState(false));
	}, [apps, check]);

	const needle = query.trim().toLowerCase();
	const connectedSlugs = useMemo(() => new Set(Object.entries(connections).filter(([, accounts]) => accounts.some(isActive)).map(([slug]) => slug)), [connections]);
	const visible = useMemo(() => {
		if (!apps) return [];
		const matches = apps.filter(
			(app) => (filter === "all" || connectedSlugs.has(app.slug)) && (!needle || app.name.toLowerCase().includes(needle) || app.slug.includes(needle) || app.description.toLowerCase().includes(needle)),
		);
		// Connected apps lead; the rest keep Composio's order (popular first, then A to Z).
		return [...matches.filter((app) => connectedSlugs.has(app.slug)), ...matches.filter((app) => !connectedSlugs.has(app.slug))];
	}, [apps, filter, needle, connectedSlugs]);
	const pages = Math.max(1, Math.ceil(visible.length / PAGE));
	const current = Math.min(page, pages - 1);
	const shown = visible.slice(current * PAGE, (current + 1) * PAGE);
	useEffect(() => setPage(0), [needle, filter]);
	const goTo = (next: number) => {
		setPage(next);
		rootRef.current?.scrollIntoView({ block: "start" });
	};

	const shownKey = shown.map((app) => app.slug).join(",");
	useEffect(() => {
		if (!shownKey) return;
		const timer = setTimeout(() => void check(shownKey.split(",")), 400);
		return () => clearTimeout(timer);
	}, [shownKey, check]);

	// While a sign-in is open, re-check that app every few seconds until its account turns active.
	const waitingKey = Object.keys(waiting).join(",");
	useEffect(() => {
		if (!waitingKey) return;
		const timer = setInterval(() => {
			const slugs = waitingKey.split(",");
			void api<{ connections: Record<string, Account[]> }>("POST", "/api/composio/connections", { slugs })
				.then((result) => {
					setConnections((current) => ({ ...current, ...result.connections }));
					setWaiting((current) => {
						const next = { ...current };
						for (const slug of slugs) {
							if (result.connections[slug]?.some(isActive)) {
								delete next[slug];
								actions.toast("info", `${apps?.find((app) => app.slug === slug)?.name ?? slug} is connected`);
							} else if (Date.now() - (next[slug]?.since ?? 0) > SIGN_IN_TIMEOUT) delete next[slug];
						}
						return next;
					});
				})
				.catch(() => undefined);
		}, 3000);
		return () => clearInterval(timer);
	}, [waitingKey, actions, apps]);

	const connect = async (app: ComposioApp) => {
		setBusy(app.slug);
		try {
			const { url, accountId } = await api<{ url: string; accountId: string | null }>("POST", "/api/composio/connect", { slug: app.slug });
			setWaiting((current) => ({ ...current, [app.slug]: { since: Date.now(), accountId } }));
			await api("POST", "/api/open", { url });
		} catch (error) {
			actions.toast("error", errorText(error));
		} finally {
			setBusy(null);
		}
	};

	const stopWaiting = async (app: ComposioApp) => {
		const accountId = waiting[app.slug]?.accountId;
		setWaiting((current) => {
			const next = { ...current };
			delete next[app.slug];
			return next;
		});
		// Drop the pending link so it does not linger in the Composio account.
		if (accountId) await api("POST", "/api/composio/disconnect", { slug: app.slug, accountId }).catch((error: unknown) => actions.toast("error", errorText(error)));
		void check([app.slug], true);
	};

	const disconnect = async (app: ComposioApp, account: Account) => {
		if (!window.confirm(`Disconnect ${account.email ?? account.handle ?? account.id} from ${app.name}? The agent will lose access to it.`)) return;
		setBusy(app.slug);
		try {
			await api("POST", "/api/composio/disconnect", { slug: app.slug, accountId: account.id });
			await check([app.slug], true);
		} catch (error) {
			actions.toast("error", errorText(error));
		} finally {
			setBusy(null);
		}
	};

	if (!status) {
		return (
			<div className="empty-note">
				<Loader2 size={16} className="spin" />
			</div>
		);
	}
	if (!status.configured || replacing) {
		return (
			<KeySetup
				actions={actions}
				replacing={replacing}
				onCancel={replacing ? () => setReplacing(false) : undefined}
				onSaved={() => {
					setReplacing(false);
					loadStatus();
					onChanged();
				}}
			/>
		);
	}

	return (
		<div ref={rootRef} className="cp">
			<div className="cp-bar">
				<div className="cp-key">
					<span className="pv-dot on" aria-hidden="true" />
					Composio <code>{status.keyHint}</code>
					<span className="cp-key-note">· added as the composio MCP server</span>
				</div>
				<span className="grow" />
				<button type="button" className="btn-ghost" onClick={() => setReplacing(true)}>
					Replace key
				</button>
				<button
					type="button"
					className="icon-btn danger-icon"
					title="Remove the key and the composio server"
					aria-label="Remove the Composio key"
					onClick={() => {
						if (!window.confirm("Remove the Composio key and its MCP server? Apps stay connected in your Composio account.")) return;
						void api("POST", "/api/composio/remove-key").then(() => {
							setApps(null);
							setConnections({});
							checked.current.clear();
							loadStatus();
							onChanged();
						}, (error: unknown) => actions.toast("error", errorText(error)));
					}}
				>
					<Trash2 size={14} />
				</button>
			</div>
			<div className="cp-tools">
				<label className="search cp-search">
					<Search size={14} />
					<input placeholder={apps ? `Search ${apps.length.toLocaleString()} apps` : "Loading apps"} value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="segmented">
					<button type="button" className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
						All
					</button>
					<button type="button" className={filter === "connected" ? "on" : ""} onClick={() => setFilter("connected")}>
						Connected{connectedSlugs.size > 0 ? ` (${connectedSlugs.size})` : ""}
					</button>
				</div>
				<button
					type="button"
					className="icon-btn"
					title="Check connections again"
					aria-label="Check connections again"
					onClick={() => {
						setLoadingState(true);
						void check(Object.keys(connections), true).finally(() => setLoadingState(false));
					}}
				>
					{loadingState ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
				</button>
			</div>
			{!apps ? (
				<div className="empty-note">
					<Loader2 size={16} className="spin" /> Loading Composio's apps
				</div>
			) : (
				<div className="cp-list">
					{shown.map((app) => {
						const accounts = connections[app.slug];
						const active = (accounts ?? []).filter(isActive);
						const pending = waiting[app.slug] !== undefined;
						return (
							<div key={app.slug} className={`cp-row${active.length > 0 ? " on" : ""}`}>
								<AppLogo app={app} />
								<div className="cp-text">
									<div className="cp-name">
										{app.name}
										{active.length > 0 && (
											<span className="cp-connected">
												<Check size={11} /> Connected
											</span>
										)}
									</div>
									{active.length > 0 ? (
										<div className="cp-accounts">
											{active.map((account) => (
												<span key={account.id} className="cp-account">
													{account.email ?? account.handle ?? account.id}
													<button type="button" aria-label={`Disconnect ${account.email ?? account.id}`} title="Disconnect" onClick={() => void disconnect(app, account)}>
														<X size={11} />
													</button>
												</span>
											))}
										</div>
									) : (
										<div className="cp-desc">{pending ? "Finish signing in in your browser. This updates by itself." : app.description || app.slug}</div>
									)}
								</div>
								{pending ? (
									<span className="cp-waiting">
										<Loader2 size={13} className="spin" /> Waiting
										<button type="button" className="cp-link" onClick={() => void stopWaiting(app)}>
											Cancel
										</button>
									</span>
								) : (
									<button type="button" className="btn-ghost cp-connect" disabled={busy === app.slug || accounts === undefined} onClick={() => void connect(app)}>
										{busy === app.slug ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} {active.length > 0 ? "Add account" : "Connect"}
									</button>
								)}
							</div>
						);
					})}
					{visible.length === 0 && <div className="empty-note">{filter === "connected" ? "No connected apps yet" : "No apps match"}</div>}
					{pages > 1 && (
						<nav className="cp-pages" aria-label="Pages">
							<span className="cp-range">
								{(current * PAGE + 1).toLocaleString()}–{(current * PAGE + shown.length).toLocaleString()} of {visible.length.toLocaleString()}
							</span>
							<button type="button" className="icon-btn sm" aria-label="Previous page" disabled={current === 0} onClick={() => goTo(current - 1)}>
								<ChevronLeft size={15} />
							</button>
							{pageNumbers(current, pages).map((entry, index) =>
								entry === "gap" ? (
									<span key={`gap-${index}`} className="cp-gap">
										…
									</span>
								) : (
									<button
										key={entry}
										type="button"
										className={`cp-page${entry === current ? " on" : ""}`}
										aria-current={entry === current ? "page" : undefined}
										onClick={() => goTo(entry)}
									>
										{entry + 1}
									</button>
								),
							)}
							<button type="button" className="icon-btn sm" aria-label="Next page" disabled={current === pages - 1} onClick={() => goTo(current + 1)}>
								<ChevronRight size={15} />
							</button>
						</nav>
					)}
				</div>
			)}
		</div>
	);
}
