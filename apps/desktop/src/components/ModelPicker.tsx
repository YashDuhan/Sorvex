import { Check, Clock, Cpu, Loader2, Play, Search, Star } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { IconType } from "react-icons";
import { RiAmazonFill, RiCopilotFill, RiMicrosoftFill, RiOpenaiFill } from "react-icons/ri";
import {
	SiAlibabacloud,
	SiAnthropic,
	SiCloudflare,
	SiDeepseek,
	SiGithub,
	SiGooglegemini,
	SiHuggingface,
	SiMeta,
	SiMinimax,
	SiMistralai,
	SiNvidia,
	SiOllama,
	SiOpencode,
	SiOpenrouter,
	SiPerplexity,
	SiQwen,
	SiVercel,
	SiX,
} from "react-icons/si";
import { api } from "../api.ts";
import { compactNumber } from "../format.ts";
import { CHAT_ONLY_HINT, LOCAL_PROVIDER, type LocalModel, localModelName } from "../local.ts";
import type { Model } from "../rpc.ts";

const RECENT_KEY = "recentModels";
const FAVORITES_KEY = "favoriteModels";
/** Rail entries that are not providers. */
const FAVORITES_TAB = "★";
const LOCAL_TAB = "Local";

const modelKey = (model: Pick<Model, "provider" | "id">) => `${model.provider}/${model.id}`;

function readList(key: string): string[] {
	try {
		return JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
	} catch {
		return [];
	}
}

function writeList(key: string, list: string[]): void {
	try {
		localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// Not persisted; the list still works for this session.
	}
}

export function readRecentModels(): string[] {
	return readList(RECENT_KEY);
}

export function rememberModel(model: Model): void {
	const id = modelKey(model);
	writeList(RECENT_KEY, [id, ...readRecentModels().filter((entry) => entry !== id)].slice(0, 6));
}

/** Brand marks by provider id prefix; anything else gets its initial. */
const PROVIDER_ICONS: [RegExp, IconType][] = [
	[/^anthropic/, SiAnthropic],
	[/^azure/, RiMicrosoftFill],
	[/^openai/, RiOpenaiFill],
	[/^(google|gemini)/, SiGooglegemini],
	[/^github-copilot/, RiCopilotFill],
	[/^github$/, SiGithub],
	[/^amazon/, RiAmazonFill],
	[/^mistral/, SiMistralai],
	[/^deepseek/, SiDeepseek],
	[/^huggingface/, SiHuggingface],
	[/^meta/, SiMeta],
	[/^nvidia/, SiNvidia],
	[/^openrouter/, SiOpenrouter],
	[/^minimax/, SiMinimax],
	[/^qwen/, SiQwen],
	[/^alibaba/, SiAlibabacloud],
	[/^cloudflare/, SiCloudflare],
	[/^vercel/, SiVercel],
	[/^xai/, SiX],
	[/^opencode/, SiOpencode],
	[/^perplexity/, SiPerplexity],
	[/^ollama/, SiOllama],
];

export function ProviderIcon({ provider, size = 16 }: { provider: string; size?: number }) {
	if (provider === LOCAL_PROVIDER || provider === LOCAL_TAB) return <Cpu size={size} />;
	const Icon = PROVIDER_ICONS.find(([pattern]) => pattern.test(provider))?.[1];
	if (Icon) return <Icon size={size} />;
	return (
		<span className="mp-monogram" style={{ width: size, height: size, fontSize: Math.round(size * 0.62) }}>
			{provider.charAt(0).toUpperCase()}
		</span>
	);
}

function size(bytes?: number): string {
	return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : "";
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/** What the Local tab needs from its host: switching to a local model, and opening the Local models page. */
export interface LocalPickerOptions {
	onUse: (id: string) => Promise<void>;
	onSetup?: () => void;
}

/**
 * Provider rail on the left (favorites first, then each provider with credentials, then models on this device),
 * a search box, and the chosen provider's models. Typing searches every provider. Star a model to pin it to
 * favorites; Ctrl+1 to Ctrl+9 pick the first nine rows, the arrow keys and Enter move through the list.
 */
export function ModelPicker({
	models,
	current,
	onPick,
	initialQuery = "",
	local,
}: {
	models: Model[];
	current?: Model;
	onPick: (model: Model) => void;
	initialQuery?: string;
	local?: LocalPickerOptions;
}) {
	const [query, setQuery] = useState(initialQuery);
	const [favorites, setFavorites] = useState<string[]>(() => readList(FAVORITES_KEY));
	const cloud = useMemo(() => (local ? models.filter((model) => model.provider !== LOCAL_PROVIDER) : models), [models, local]);
	const [engine, setEngine] = useState<{ installed: boolean; running: boolean } | null>(null);
	const [localModels, setLocalModels] = useState<LocalModel[]>([]);
	const [loading, setLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [highlight, setHighlight] = useState(0);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!local) return;
		void api<{ installed?: unknown; server: string }>("GET", "/api/local").then(
			(status) => setEngine({ installed: Boolean(status.installed) || status.server === "external", running: status.server === "running" || status.server === "external" }),
			() => setEngine({ installed: false, running: false }),
		);
		void api<{ models: LocalModel[] }>("GET", "/api/local/models").then((result) => setLocalModels(result.models), () => setLocalModels([]));
	}, [local]);

	const ready = localModels.filter((model) => model.status.value !== "incomplete");
	const providers = useMemo(() => {
		const counts = new Map<string, number>();
		for (const model of cloud) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [cloud]);
	const favoriteModels = useMemo(() => favorites.map((id) => models.find((model) => modelKey(model) === id)).filter((model): model is Model => model !== undefined), [favorites, models]);
	const recent = useMemo(() => readRecentModels().map((id) => models.find((model) => modelKey(model) === id)).filter((model): model is Model => model !== undefined), [models]);
	const [tab, setTab] = useState<string>(() => {
		if (favoriteModels.length > 0) return FAVORITES_TAB;
		if (current?.provider === LOCAL_PROVIDER && local) return LOCAL_TAB;
		return current?.provider ?? providers[0]?.[0] ?? FAVORITES_TAB;
	});

	const needle = query.trim().toLowerCase();
	const showRecent = !needle && tab === FAVORITES_TAB && favoriteModels.length === 0;
	const list: Model[] = needle
		? cloud.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))
		: tab === FAVORITES_TAB
			? favoriteModels.length > 0
				? favoriteModels
				: recent
			: tab === LOCAL_TAB
				? []
				: cloud.filter((model) => model.provider === tab);
	const localList = needle ? ready.filter((model) => model.id.toLowerCase().includes(needle)) : ready;
	const showLocal = Boolean(local) && (needle ? localList.length > 0 : tab === LOCAL_TAB);

	useEffect(() => setHighlight(0), [needle, tab]);
	useEffect(() => {
		listRef.current?.querySelector(`[data-row="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
	}, [highlight]);

	const toggleFavorite = (model: Model) => {
		const id = modelKey(model);
		const next = favorites.includes(id) ? favorites.filter((entry) => entry !== id) : [...favorites, id];
		setFavorites(next);
		writeList(FAVORITES_KEY, next);
	};

	const pickLocal = async (id: string) => {
		if (!local || loading) return;
		setLoading(id);
		setError(null);
		try {
			await local.onUse(id);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(null);
		}
	};

	const onKeyDown = (event: KeyboardEvent) => {
		const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
		if (digit && (isMac ? event.metaKey : event.ctrlKey)) {
			const model = list[Number(digit) - 1];
			if (model) {
				event.preventDefault();
				onPick(model);
			}
			return;
		}
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (list.length === 0) return;
			setHighlight((index) => (index + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
		} else if (event.key === "Enter" && list[highlight]) {
			event.preventDefault();
			onPick(list[highlight]);
		}
	};

	const row = (model: Model, index: number) => {
		const active = current?.provider === model.provider && current.id === model.id;
		const favorite = favorites.includes(modelKey(model));
		const providerName = model.provider === LOCAL_PROVIDER ? "local" : model.provider;
		const detail = [providerName, `${compactNumber(model.contextWindow)} ctx`, model.reasoning ? "reasoning" : "", model.input?.includes("image") ? "images" : ""].filter(Boolean).join(" · ");
		return (
			// biome-ignore lint/a11y/useSemanticElements: a row that holds its own favorite button cannot be a <button>.
			<div
				key={modelKey(model)}
				data-row={index}
				role="option"
				tabIndex={-1}
				aria-selected={active}
				className={`mp-row${index === highlight ? " highlight" : ""}${active ? " active" : ""}`}
				onMouseEnter={() => setHighlight(index)}
				onClick={() => onPick(model)}
				onKeyDown={(event) => event.key === "Enter" && onPick(model)}
			>
				<span className="mp-row-icon">
					<ProviderIcon provider={model.provider} size={14} />
				</span>
				<span className="mp-row-text">
					<span className="mp-row-name">{model.name || model.id}</span>
					<small>{detail}</small>
				</span>
				{active && <Check size={13} className="mp-row-check" />}
				{index < 9 && <kbd className="mp-kbd">{isMac ? "⌘" : "Ctrl+"}{index + 1}</kbd>}
				<button
					type="button"
					className={`mp-star${favorite ? " on" : ""}`}
					aria-label={favorite ? `Remove ${model.name || model.id} from favorites` : `Add ${model.name || model.id} to favorites`}
					title={favorite ? "Remove from favorites" : "Add to favorites"}
					onClick={(event) => {
						event.stopPropagation();
						toggleFavorite(model);
						searchRef.current?.focus();
					}}
				>
					<Star size={12} fill={favorite ? "currentColor" : "none"} />
				</button>
			</div>
		);
	};

	const localRow = (model: LocalModel) => {
		const active = current?.provider === LOCAL_PROVIDER && current.id === model.id;
		const busy = loading === model.id;
		return (
			<button
				key={`local/${model.id}`}
				type="button"
				className={`mp-row${active ? " active" : ""}`}
				title={model.tools === false ? CHAT_ONLY_HINT : undefined}
				disabled={Boolean(loading)}
				onClick={() => void pickLocal(model.id)}
			>
				<span className="mp-row-icon">
					<Cpu size={14} />
				</span>
				<span className="mp-row-text">
					<span className="mp-row-name">{localModelName(model.id)}</span>
					<small>
						{busy
							? "Loading on this device…"
							: ["On this device", size(model.meta?.size), model.status.value === "loaded" ? "loaded" : "loads when picked", model.tools === false ? "chat only, no tools" : undefined]
									.filter(Boolean)
									.join(" · ")}
					</small>
				</span>
				{busy ? <Loader2 size={13} className="spin" /> : active ? <Check size={13} className="mp-row-check" /> : null}
			</button>
		);
	};

	const localSection = (): ReactNode => {
		if (!engine) {
			return (
				<div className="empty-note">
					<Loader2 size={13} className="spin" />
				</div>
			);
		}
		if (!engine.installed) {
			return (
				<div className="picker-local-empty">
					<Cpu size={18} />
					<span>Run models on this device. Nothing leaves your machine.</span>
					{local?.onSetup && (
						<button type="button" className="btn-accent" onClick={local.onSetup}>
							Set up local models
						</button>
					)}
				</div>
			);
		}
		if (!engine.running) {
			return (
				<div className="picker-local-empty">
					<Cpu size={18} />
					<span>The local engine is stopped.</span>
					<button
						type="button"
						className="btn-accent"
						onClick={() =>
							void api("POST", "/api/local/start").then(
								() => {
									setEngine({ installed: true, running: true });
									void api<{ models: LocalModel[] }>("GET", "/api/local/models").then((result) => setLocalModels(result.models), () => undefined);
								},
								(reason: unknown) => setError(String(reason)),
							)
						}
					>
						<Play size={13} />
						Start engine
					</button>
				</div>
			);
		}
		return (
			<>
				{localList.map(localRow)}
				{localList.length === 0 && <div className="empty-note">No models downloaded yet.</div>}
				{local?.onSetup && (
					<button type="button" className="mp-row mp-manage" onClick={local.onSetup}>
						Download or manage local models…
					</button>
				)}
			</>
		);
	};

	if (models.length === 0 && !local) return <div className="empty-note">No models with credentials. Add a provider on the Providers page.</div>;

	const railItem = (id: string, label: string, icon: ReactNode) => (
		<button
			key={id}
			type="button"
			role="tab"
			aria-selected={!needle && tab === id}
			aria-label={label}
			title={label}
			className={`mp-rail-item${!needle && tab === id ? " on" : ""}`}
			onClick={() => {
				setTab(id);
				setQuery("");
				searchRef.current?.focus();
			}}
		>
			{icon}
		</button>
	);
	const scope = needle ? "all providers" : tab === FAVORITES_TAB ? "favorites" : tab === LOCAL_TAB ? "this device" : tab;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the whole picker; the search box keeps focus.
		<div className="model-picker" onKeyDown={onKeyDown}>
			<nav className="mp-rail" role="tablist" aria-label="Providers" aria-orientation="vertical">
				{railItem(FAVORITES_TAB, "Favorites", <Star size={16} fill="currentColor" />)}
				<div className="mp-rail-sep" />
				{providers.map(([name, count]) => railItem(name, `${name} · ${count} model${count === 1 ? "" : "s"}`, <ProviderIcon provider={name} />))}
				{local && railItem(LOCAL_TAB, `On this device · ${ready.length}`, <Cpu size={16} />)}
			</nav>
			<div className="mp-main">
				<label className="mp-search">
					<Search size={13} />
					<input ref={searchRef} autoFocus placeholder="Search models" value={query} onChange={(event) => setQuery(event.target.value)} />
				</label>
				<div className="mp-list" ref={listRef} role="listbox" aria-label={`Models in ${scope}`}>
					{error && <div className="picker-local-error">{error}</div>}
					{showRecent && list.length > 0 && (
						<div className="mp-group">
							<Clock size={11} /> Recent. Star a model to keep it here.
						</div>
					)}
					{list.map(row)}
					{showLocal && (
						<>
							{needle && <div className="mp-group">On this device</div>}
							{needle ? localList.map(localRow) : localSection()}
						</>
					)}
					{list.length === 0 && !showLocal && (
						<div className="empty-note">{needle ? "No models match" : tab === FAVORITES_TAB ? "Star models to pin them here" : "No models"}</div>
					)}
				</div>
			</div>
		</div>
	);
}
