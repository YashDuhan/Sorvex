import { Clock, Cpu, Loader2, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { compactNumber } from "../format.ts";
import { CHAT_ONLY_HINT, LOCAL_PROVIDER, type LocalModel, localModelName } from "../local.ts";
import type { Model } from "../rpc.ts";

const RECENT_KEY = "recentModels";
/** The tab for models on this device; it replaces the raw "llama.cpp" provider tab. */
const LOCAL_TAB = "Local";

export function readRecentModels(): string[] {
	try {
		return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
	} catch {
		return [];
	}
}

export function rememberModel(model: Model): void {
	const id = `${model.provider}/${model.id}`;
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecentModels().filter((entry) => entry !== id)].slice(0, 6)));
	} catch {
		// Recents just will not persist.
	}
}

function size(bytes?: number): string {
	return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : "";
}

/** What the Local tab needs from its host: switching to a local model, and opening the Local models page. */
export interface LocalPickerOptions {
	onUse: (id: string) => Promise<void>;
	onSetup?: () => void;
}

/**
 * Provider-first model list: a provider strip on top (with model counts), recently used models first, then
 * the chosen provider's models. Typing searches every provider. With `local`, a Local tab lists every model
 * downloaded to this device (not only the loaded one); picking one loads it and switches to it.
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
	const cloud = useMemo(() => (local ? models.filter((model) => model.provider !== LOCAL_PROVIDER) : models), [models, local]);
	const [engine, setEngine] = useState<{ installed: boolean; running: boolean } | null>(null);
	const [localModels, setLocalModels] = useState<LocalModel[]>([]);
	const [loading, setLoading] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

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
		const list = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		return local ? [...list, [LOCAL_TAB, ready.length] as [string, number]] : list;
	}, [cloud, local, ready.length]);
	const [provider, setProvider] = useState<string>(() => (current?.provider === LOCAL_PROVIDER && local ? LOCAL_TAB : (current?.provider ?? providers[0]?.[0] ?? "")));

	const recent = useMemo(
		() =>
			readRecentModels()
				.map((id) => models.find((model) => `${model.provider}/${model.id}` === id))
				.filter((model): model is Model => model !== undefined),
		[models],
	);

	const needle = query.trim().toLowerCase();
	const list = needle
		? cloud.filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle))
		: cloud.filter((model) => model.provider === provider);
	const localList = needle ? ready.filter((model) => model.id.toLowerCase().includes(needle)) : ready;
	const showLocal = Boolean(local) && (needle ? localList.length > 0 : provider === LOCAL_TAB);

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

	const row = (model: Model, showProvider: boolean) => {
		const active = current?.provider === model.provider && current.id === model.id;
		return (
			<button key={`${model.provider}/${model.id}`} type="button" className={`menu-item${active ? " selected" : ""}`} onClick={() => onPick(model)}>
				<span className="stack">
					<span>{model.name || model.id}</span>
					<small>
						{showProvider ? `${model.provider === LOCAL_PROVIDER ? "local" : model.provider} · ` : ""}
						{model.id} · {compactNumber(model.contextWindow)} ctx{model.reasoning ? " · reasoning" : ""}
						{model.input?.includes("image") ? " · images" : ""}
					</small>
				</span>
			</button>
		);
	};

	const localRow = (model: LocalModel) => {
		const active = current?.provider === LOCAL_PROVIDER && current.id === model.id;
		const busy = loading === model.id;
		return (
			<button
				key={`local/${model.id}`}
				type="button"
				className={`menu-item${active ? " selected" : ""}`}
				title={model.tools === false ? CHAT_ONLY_HINT : undefined}
				disabled={Boolean(loading)}
				onClick={() => void pickLocal(model.id)}
			>
				<span className="stack">
					<span>{localModelName(model.id)}</span>
					<small>
						{busy
							? "Loading on this device…"
							: ["On this device", size(model.meta?.size), model.status.value === "loaded" ? "loaded" : "loads when picked", model.tools === false ? "chat only, no tools" : undefined]
									.filter(Boolean)
									.join(" · ")}
					</small>
				</span>
				{busy && <Loader2 size={14} className="spin" />}
			</button>
		);
	};

	const localSection = () => {
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
					<button type="button" className="menu-item picker-local-manage" onClick={local.onSetup}>
						Download or manage local models…
					</button>
				)}
			</>
		);
	};

	if (models.length === 0 && !local) return <div className="empty-note">No models with credentials. Add a provider on the Providers page.</div>;

	return (
		<div className="model-picker">
			<div className="popover-search">
				<Search size={13} />
				<input autoFocus placeholder="Search all models" value={query} onChange={(event) => setQuery(event.target.value)} />
			</div>
			{!needle && (
				<div className="provider-tabs" role="tablist" aria-label="Providers">
					{providers.map(([name, count]) => (
						<button
							key={name}
							type="button"
							role="tab"
							aria-selected={name === provider}
							className={`provider-tab${name === provider ? " on" : ""}`}
							onClick={() => setProvider(name)}
						>
							{name === LOCAL_TAB && <Cpu size={11} />}
							{name}
							<span>{count}</span>
						</button>
					))}
				</div>
			)}
			<div className="model-picker-list">
				{error && <div className="picker-local-error">{error}</div>}
				{!needle && recent.length > 0 && (
					<>
						<div className="popover-group">
							<Clock size={11} /> Recent
						</div>
						{recent.map((model) => row(model, true))}
						<div className="menu-divider" />
						<div className="popover-group">{provider === LOCAL_TAB ? "On this device" : provider}</div>
					</>
				)}
				{(needle || provider !== LOCAL_TAB) && list.map((model) => row(model, Boolean(needle)))}
				{showLocal && (
					<>
						{needle && <div className="popover-group">On this device</div>}
						{needle ? localList.map(localRow) : localSection()}
					</>
				)}
				{needle && list.length === 0 && localList.length === 0 && <div className="empty-note">No models match</div>}
				{!needle && provider !== LOCAL_TAB && list.length === 0 && <div className="empty-note">No models match</div>}
			</div>
		</div>
	);
}
