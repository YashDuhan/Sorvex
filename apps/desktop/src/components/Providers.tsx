import { Check, Copy, ExternalLink, KeyRound, Loader2, LogIn, LogOut, RefreshCw, Search, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { compactNumber } from "../format.ts";
import type { SorvexActions, State } from "../store.ts";
import { ProviderIcon } from "./ModelPicker.tsx";

interface Provider {
	id: string;
	name: string;
	apiKey: boolean;
	oauth: { name: string; subscription: boolean } | null;
	configured: boolean;
	source: string | null;
	label: string | null;
	usingOAuth: boolean;
}

type AuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: { id: string; label: string; description?: string }[] };

type AuthEvent =
	| { type: "info"; message: string }
	| { type: "progress"; message: string }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; verificationUriComplete?: string };

interface LoginState {
	loginId: string;
	provider: Provider;
	authType: "api_key" | "oauth";
	prompt?: { promptId: string; prompt: AuthPrompt };
	events: AuthEvent[];
	done?: { ok: boolean; error?: string };
}

const SOURCE_LABEL: Record<string, string> = {
	stored: "Saved",
	environment: "Environment",
	runtime: "Runtime",
	fallback: "Fallback",
	models_json_key: "models.json",
	models_json_command: "models.json",
};

function openExternal(url: string) {
	void api("POST", "/api/open", { url });
}

function LoginDialog({ login, onClose }: { login: LoginState; onClose: () => void }) {
	const [value, setValue] = useState("");
	useEffect(() => setValue(""), [login.prompt?.promptId]);
	const answer = (answerValue: string) => {
		if (!login.prompt) return;
		void api("POST", "/api/providers/answer", { promptId: login.prompt.promptId, value: answerValue });
	};
	const cancel = () => {
		if (!login.done) void api("POST", "/api/providers/cancel", { loginId: login.loginId });
		onClose();
	};
	const prompt = login.prompt?.prompt;
	const url = [...login.events].reverse().find((event) => event.type === "auth_url") as Extract<AuthEvent, { type: "auth_url" }> | undefined;
	const device = [...login.events].reverse().find((event) => event.type === "device_code") as Extract<AuthEvent, { type: "device_code" }> | undefined;
	const progress = [...login.events].reverse().find((event) => event.type === "progress" || event.type === "info") as { message: string } | undefined;

	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true" aria-label={`Sign in to ${login.provider.name}`}>
				<div className="modal-head">
					{login.authType === "oauth" ? login.provider.oauth?.name ?? login.provider.name : `${login.provider.name} API key`}
				</div>
				<div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
					{login.done ? (
						login.done.ok ? (
							<div className="banner info" style={{ margin: 0 }}>
								<Check size={15} /> <span className="text">Signed in. Models from {login.provider.name} are now available.</span>
							</div>
						) : (
							<div className="banner" style={{ margin: 0 }}>
								<span className="text">{login.done.error}</span>
							</div>
						)
					) : null}
					{!login.done && url && (
						<div className="auth-step">
							<div>{url.instructions ?? "Open this page in your browser and approve access."}</div>
							<div className="auth-url">
								<span className="mono">{url.url}</span>
							</div>
							<div style={{ display: "flex", gap: 8 }}>
								<button type="button" className="btn-accent" onClick={() => openExternal(url.url)}>
									<ExternalLink size={14} /> Open browser
								</button>
								<button type="button" className="btn-ghost" onClick={() => void navigator.clipboard.writeText(url.url)}>
									<Copy size={14} /> Copy link
								</button>
							</div>
						</div>
					)}
					{!login.done && device && (
						<div className="auth-step">
							<div>Enter this code at the verification page:</div>
							<div className="device-code">{device.userCode}</div>
							<button type="button" className="btn-accent" onClick={() => openExternal(device.verificationUriComplete ?? device.verificationUri)}>
								<ExternalLink size={14} /> {device.verificationUri}
							</button>
						</div>
					)}
					{!login.done && prompt && (
						<div className="auth-step">
							<div>{prompt.message}</div>
							{prompt.type === "select" ? (
								<div className="modal-options" style={{ padding: 0 }}>
									{prompt.options.map((option) => (
										<button key={option.id} type="button" className="modal-option" onClick={() => answer(option.id)}>
											{option.label}
											{option.description && <small style={{ display: "block", color: "var(--text-faint)" }}>{option.description}</small>}
										</button>
									))}
								</div>
							) : (
								<form
									style={{ display: "flex", gap: 8 }}
									onSubmit={(event) => {
										event.preventDefault();
										answer(value);
									}}
								>
									<input
										className="modal-input"
										autoFocus
										type={prompt.type === "secret" ? "password" : "text"}
										placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "Paste the code or redirect URL" : "")}
										value={value}
										onChange={(event) => setValue(event.target.value)}
									/>
									<button type="submit" className="btn-accent">
										Continue
									</button>
								</form>
							)}
						</div>
					)}
					{!login.done && !prompt && !url && !device && (
						<div className="auth-step">
							<span className="dots">{progress?.message ?? "Working"}</span>
						</div>
					)}
				</div>
				<div className="modal-foot">
					<button type="button" className="btn-ghost" onClick={cancel}>
						{login.done ? "Close" : "Cancel"}
					</button>
				</div>
			</div>
		</div>
	);
}

interface Status {
	tone: "on" | "off";
	text: string;
}

/** One line on what a provider is using: the subscription, a saved key, or a key from the environment. */
function statusOf(provider: Provider): Status {
	if (!provider.configured) return { tone: "off", text: "Not connected" };
	if (provider.usingOAuth) return { tone: "on", text: `Signed in${provider.oauth?.subscription ? " · subscription" : ""}` };
	const source = SOURCE_LABEL[provider.source ?? ""] ?? "Configured";
	if (provider.source === "environment" && provider.label) return { tone: "on", text: `API key · ${provider.label}` };
	return { tone: "on", text: provider.source === "stored" ? "API key · saved" : `API key · ${source.toLowerCase()}` };
}

/** Where the credential lives, in plain words. */
function credentialDetail(provider: Provider): string {
	if (!provider.configured) return "Nothing saved. Add an API key or sign in to use this provider's models.";
	if (provider.usingOAuth) return "Your sign-in is saved in ~/.sorvex/agent/auth.json and refreshed automatically.";
	switch (provider.source) {
		case "stored":
			return "Your API key is saved in ~/.sorvex/agent/auth.json.";
		case "environment":
			return `Read from the ${provider.label ?? "provider's"} environment variable when Sorvex starts. Change it in your shell profile, or add a key here to override it.`;
		case "models_json_key":
		case "models_json_command":
			return "Set in ~/.sorvex/agent/models.json.";
		default:
			return provider.label ? `From ${provider.label}.` : "Configured outside this app.";
	}
}

function SettingRow({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
	return (
		<div className="pv-row">
			<div className="pv-row-text">
				<div className="pv-row-title">{title}</div>
				{hint && <div className="pv-row-hint">{hint}</div>}
			</div>
			{children && <div className="pv-row-control">{children}</div>}
		</div>
	);
}

/**
 * Credentials without /login: runs the same provider flows as the CLI (API key prompt, browser OAuth, device
 * code) through the desktop server, which stores them in ~/.sorvex/agent/auth.json. A list of providers on the left
 * (connected first), and the chosen provider's connection, credential and models on the right.
 */
export function ProvidersPage({ state, actions }: { state: State; actions: SorvexActions }) {
	const [providers, setProviders] = useState<Provider[] | null>(null);
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [login, setLogin] = useState<LoginState | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(() => {
		setLoading(true);
		api<Provider[]>("GET", "/api/providers")
			.then(setProviders, (error: unknown) => actions.toast("error", String(error)))
			.finally(() => setLoading(false));
	}, [actions]);

	useEffect(load, [load]);

	useEffect(
		() =>
			serverEvents.on<{ kind: string; loginId: string; promptId?: string; prompt?: AuthPrompt; event?: AuthEvent; ok?: boolean; error?: string }>(
				"auth",
				(message) =>
					setLogin((current) => {
						if (!current || current.loginId !== message.loginId) return current;
						if (message.kind === "prompt" && message.promptId && message.prompt) {
							return { ...current, prompt: { promptId: message.promptId, prompt: message.prompt } };
						}
						if (message.kind === "event" && message.event) return { ...current, prompt: undefined, events: [...current.events, message.event] };
						if (message.kind === "done") {
							load();
							return { ...current, prompt: undefined, done: { ok: Boolean(message.ok), error: message.error } };
						}
						return current;
					}),
			),
		[load],
	);

	const start = async (provider: Provider, authType: "api_key" | "oauth") => {
		// Prompts can arrive on the event stream before the response, so the dialog must exist first.
		const loginId = `login-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		setLogin({ loginId, provider, authType, events: [] });
		try {
			await api("POST", "/api/providers/login", { loginId, provider: provider.id, authType });
		} catch (error) {
			setLogin(null);
			actions.toast("error", String(error));
		}
	};

	const logout = async (provider: Provider) => {
		if (!window.confirm(`Remove the saved ${provider.usingOAuth ? "sign-in" : "API key"} for ${provider.name}?`)) return;
		try {
			await api("POST", "/api/providers/logout", { provider: provider.id });
			load();
		} catch (error) {
			actions.toast("error", String(error));
		}
	};

	const [connected, available] = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = (providers ?? []).filter((provider) => !needle || `${provider.name} ${provider.id}`.toLowerCase().includes(needle));
		return [list.filter((provider) => provider.configured), list.filter((provider) => !provider.configured)];
	}, [providers, query]);

	const selected = (providers ?? []).find((provider) => provider.id === selectedId) ?? connected[0] ?? available[0] ?? null;
	const models = useMemo(() => (selected ? state.models.filter((model) => model.provider === selected.id) : []), [state.models, selected]);
	const current = state.session?.model;

	const listRow = (provider: Provider) => {
		const status = statusOf(provider);
		return (
			<button
				key={provider.id}
				type="button"
				role="option"
				aria-selected={provider.id === selected?.id}
				className={`pv-item${provider.id === selected?.id ? " on" : ""}${provider.configured ? "" : " off"}`}
				onClick={() => setSelectedId(provider.id)}
			>
				<span className="pv-item-icon">
					<ProviderIcon provider={provider.id} size={16} />
				</span>
				<span className="pv-item-text">
					<span className="pv-item-name">{provider.name}</span>
					<small>{status.text}</small>
				</span>
				<span className={`pv-dot ${status.tone}`} aria-hidden="true" />
			</button>
		);
	};

	const detail = (provider: Provider) => {
		const status = statusOf(provider);
		const keyStored = provider.configured && provider.source === "stored" && !provider.usingOAuth;
		return (
			<div className="pv-detail" key={provider.id}>
				<div className="pv-detail-head">
					<span className="pv-detail-icon">
						<ProviderIcon provider={provider.id} size={20} />
					</span>
					<div className="pv-detail-title">
						<h2>{provider.name}</h2>
						<code>{provider.id}</code>
					</div>
					<span className={`pv-status ${status.tone}`}>
						<span className={`pv-dot ${status.tone}`} aria-hidden="true" />
						{provider.configured ? "Connected" : "Not connected"}
					</span>
				</div>

				<h3 className="pv-section">Connection</h3>
				<div className="pv-group">
					{provider.oauth && (
						<SettingRow
							title={provider.oauth.subscription ? "Sign in with your subscription" : "Sign in"}
							hint={
								provider.usingOAuth
									? `Signed in with ${provider.oauth.name}.`
									: `${provider.oauth.name}. Opens your browser, or shows a code to enter there.`
							}
						>
							{provider.usingOAuth ? (
								<button type="button" className="btn-ghost" onClick={() => void logout(provider)}>
									<LogOut size={14} /> Sign out
								</button>
							) : (
								<button type="button" className="btn-accent" onClick={() => void start(provider, "oauth")}>
									<LogIn size={14} /> Sign in
								</button>
							)}
						</SettingRow>
					)}
					{provider.apiKey && (
						<SettingRow
							title="API key"
							hint={
								keyStored
									? "A key is saved. Replacing it takes effect for new requests."
									: provider.configured && provider.source === "environment"
										? `Using ${provider.label ?? "an environment variable"}. A saved key takes precedence.`
										: "Paste a key from the provider's dashboard."
							}
						>
							<button type="button" className={provider.configured || provider.oauth ? "btn-ghost" : "btn-accent"} onClick={() => void start(provider, "api_key")}>
								<KeyRound size={14} /> {keyStored ? "Replace key" : "Add key"}
							</button>
							{keyStored && (
								<button type="button" className="icon-btn" aria-label={`Remove the saved key for ${provider.name}`} title="Remove the saved key" onClick={() => void logout(provider)}>
									<Trash2 size={14} />
								</button>
							)}
						</SettingRow>
					)}
				</div>

				<h3 className="pv-section">Credential</h3>
				<div className="pv-group">
					<SettingRow title={provider.configured ? (provider.usingOAuth ? "Subscription sign-in" : SOURCE_LABEL[provider.source ?? ""] ?? "Configured") : "None"} hint={credentialDetail(provider)} />
				</div>

				<h3 className="pv-section">
					Models
					{models.length > 0 && <span className="pv-count">{models.length}</span>}
				</h3>
				<div className="pv-group">
					{!provider.configured ? (
						<div className="pv-empty">Connect {provider.name} to see its models.</div>
					) : models.length === 0 ? (
						<div className="pv-empty">No models listed for this provider yet. They appear after the agent reloads its model list.</div>
					) : (
						models.map((model) => {
							const active = current?.provider === model.provider && current.id === model.id;
							return (
								<div key={model.id} className="pv-model">
									<div className="pv-row-text">
										<div className="pv-row-title">{model.name || model.id}</div>
										<div className="pv-row-hint">
											<code>{model.id}</code> · {compactNumber(model.contextWindow)} context{model.reasoning ? " · reasoning" : ""}
											{model.input?.includes("image") ? " · images" : ""}
										</div>
									</div>
									{active ? (
										<span className="pv-in-use">
											<Check size={13} /> In use
										</span>
									) : (
										<button type="button" className="btn-ghost pv-use" onClick={() => void actions.setModel(model)}>
											Use in chat
										</button>
									)}
								</div>
							);
						})
					)}
				</div>
			</div>
		);
	};

	return (
		<div className="pv-page">
			<div className="pv-intro">
				<p>Add API keys or sign in with a subscription. Credentials are shared with the sorvex CLI.</p>
				<button type="button" className="pv-refresh" onClick={load} disabled={loading} title="Check credentials again">
					<RefreshCw size={13} className={loading ? "spin" : undefined} /> {loading ? "Checking" : "Refresh"}
				</button>
			</div>
			{providers === null ? (
				<div className="empty-note">
					<Loader2 size={16} className="spin" />
				</div>
			) : (
				<div className="pv-shell">
					<aside className="pv-list">
						<label className="search pv-search">
							<Search size={14} />
							<input placeholder={`Search ${providers.length} providers`} value={query} onChange={(event) => setQuery(event.target.value)} />
						</label>
						<div className="pv-list-scroll" role="listbox" aria-label="Providers">
							{connected.length > 0 && <div className="pv-list-group">Connected</div>}
							{connected.map(listRow)}
							{available.length > 0 && <div className="pv-list-group">Available</div>}
							{available.map(listRow)}
							{connected.length + available.length === 0 && <div className="empty-note">No providers match</div>}
						</div>
					</aside>
					<section className="pv-panel">{selected ? detail(selected) : <div className="empty-note">Pick a provider</div>}</section>
				</div>
			)}
			{login && <LoginDialog login={login} onClose={() => setLogin(null)} />}
		</div>
	);
}
