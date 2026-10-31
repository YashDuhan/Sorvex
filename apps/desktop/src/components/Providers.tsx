import { Check, Copy, ExternalLink, KeyRound, Loader2, LogIn, LogOut, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, serverEvents } from "../api.ts";
import type { SorvexActions } from "../store.ts";

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

/**
 * Credentials without /login: runs the same provider flows as the CLI (API key prompt, browser OAuth, device
 * code) through the desktop server, which stores them in ~/.sorvex/agent/auth.json.
 */
export function ProvidersPage({ actions }: { actions: SorvexActions }) {
	const [providers, setProviders] = useState<Provider[] | null>(null);
	const [query, setQuery] = useState("");
	const [login, setLogin] = useState<LoginState | null>(null);

	const load = useCallback(() => {
		api<Provider[]>("GET", "/api/providers").then(setProviders, (error: unknown) => actions.toast("error", String(error)));
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
		try {
			await api("POST", "/api/providers/logout", { provider: provider.id });
			load();
		} catch (error) {
			actions.toast("error", String(error));
		}
	};

	const [configured, available] = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = (providers ?? []).filter((provider) => !needle || `${provider.name} ${provider.id}`.toLowerCase().includes(needle));
		return [list.filter((provider) => provider.configured), list.filter((provider) => !provider.configured)];
	}, [providers, query]);

	const row = (provider: Provider) => (
		<div key={provider.id} className="provider-row">
			<div className="provider-name">
				<span>{provider.name}</span>
				<small className="mono">{provider.id}</small>
			</div>
			{provider.configured && (
				<span className="badge ok" title={provider.label ?? undefined}>
					{provider.usingOAuth ? "Signed in" : SOURCE_LABEL[provider.source ?? ""] ?? "Configured"}
				</span>
			)}
			<span className="grow" />
			{provider.oauth && (
				<button type="button" className="btn-ghost" onClick={() => void start(provider, "oauth")} title={provider.oauth.name}>
					<LogIn size={14} /> {provider.oauth.subscription ? "Sign in (subscription)" : "Sign in"}
				</button>
			)}
			{provider.apiKey && (
				<button type="button" className="btn-ghost" onClick={() => void start(provider, "api_key")}>
					<KeyRound size={14} /> {provider.configured && provider.source === "stored" && !provider.usingOAuth ? "Replace key" : "Add key"}
				</button>
			)}
			{provider.source === "stored" && (
				<button type="button" className="icon-btn" aria-label={`Log out of ${provider.name}`} title="Remove saved credential" onClick={() => void logout(provider)}>
					<LogOut size={15} />
				</button>
			)}
		</div>
	);

	return (
		<div className="page">
			<div className="page-inner">
				<section className="card">
					<h2>Providers</h2>
					<p>Add API keys or sign in with a subscription. Credentials are saved where the CLI keeps them, so `sorvex` in a terminal uses them too.</p>
					<label className="search">
						<Search size={15} />
						<input placeholder="Search providers" value={query} onChange={(event) => setQuery(event.target.value)} />
					</label>
				</section>
				{providers === null ? (
					<div className="empty-note">
						<Loader2 size={16} className="spin" />
					</div>
				) : (
					<>
						{configured.length > 0 && (
							<section className="card">
								<h2>Connected</h2>
								{configured.map(row)}
							</section>
						)}
						<section className="card">
							<h2>Available</h2>
							{available.length === 0 ? <div className="empty-note">No providers match</div> : available.map(row)}
						</section>
					</>
				)}
			</div>
			{login && <LoginDialog login={login} onClose={() => setLogin(null)} />}
		</div>
	);
}
