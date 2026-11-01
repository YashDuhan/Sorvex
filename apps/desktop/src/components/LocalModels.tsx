import { Cpu, Download, HardDrive, Library, Loader2, MemoryStick, MonitorCog, Play, RotateCw, Search, Square, Terminal, ThumbsUp, Trash2, Wrench, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { CHAT_ONLY_HINT, LOCAL_PROVIDER, type LocalModel, switchToLocalModel } from "../local.ts";
import type { SorvexActions, State } from "../store.ts";
import { Setting, Switch } from "./Pages.tsx";
import { rememberSection, type Section, SectionLayout, storedSection } from "./SectionLayout.tsx";
import { Select } from "./Select.tsx";

interface Hardware {
	os: string;
	arch: string;
	cpu: string;
	cores: number;
	ramTotal: number;
	ramFree: number;
	gpus: { name: string; vram?: number; kind: string }[];
	recommended: string;
}

interface LocalStatus {
	url: string;
	modelsDir: string;
	hardware: Hardware;
	variants: { id: string; label: string }[];
	installed?: { tag: string; variant: string; binary: string };
	installing?: { message: string; ratio?: number };
	server: "stopped" | "starting" | "running" | "external" | "error";
	error?: string;
	settings: { contextSize: number; gpu: boolean; autoStart: boolean; variant?: string };
	recommended: { repo: string; quant: string; size: number; note: string }[];
}


const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072];

const LOCAL_SECTIONS = ["models", "recommended", "search", "engine", "device"] as const;
type LocalSection = (typeof LOCAL_SECTIONS)[number];
const SECTION_KEY = "localSection";

function bytes(value?: number): string {
	if (!value) return "?";
	return value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB` : `${Math.round(value / 1e6)} MB`;
}

/**
 * Whether a model of `size` bytes fits: weights plus about 30% for the context cache and runtime. GPUs with their own
 * memory (NVIDIA) use VRAM; integrated GPUs and Apple Silicon share system RAM, of which about 75% is usable.
 */
function fit(size: number, hardware: Hardware): { label: string; tone: "ok" | "warn" | "danger" } {
	const vram = hardware.gpus.reduce((sum, gpu) => sum + (gpu.vram ?? 0), 0);
	const budget = vram > 0 ? vram + hardware.ramTotal * 0.5 : hardware.ramTotal * 0.75;
	const need = size * 1.3;
	if (need <= budget * 0.8) return { label: "Runs well", tone: "ok" };
	if (need <= budget) return { label: "Tight fit", tone: "warn" };
	return { label: "Too big for this device", tone: "danger" };
}

function ProgressBar({ ratio }: { ratio?: number }) {
	return (
		<div className="local-progress">
			<div style={{ width: ratio === undefined ? "35%" : `${Math.round(ratio * 100)}%` }} className={ratio === undefined ? "indeterminate" : undefined} />
		</div>
	);
}

/**
 * Local models: install a llama.cpp engine matched to this machine, download GGUF models from Hugging
 * Face, and use them in chat through Sorvex's built-in llama.cpp provider. Nothing leaves the device.
 */
export function LocalModelsPage({ state, actions, onUseInChat }: { state: State; actions: SorvexActions; onUseInChat: () => void }) {
	const [status, setStatus] = useState<LocalStatus | null>(null);
	const [models, setModels] = useState<LocalModel[]>([]);
	const [progress, setProgress] = useState<Record<string, { message: string; ratio?: number }>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [logsOpen, setLogsOpen] = useState(false);
	const [logs, setLogs] = useState<string[]>([]);
	const [variant, setVariant] = useState<string | undefined>();
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<{ id: string; downloads: number }[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [details, setDetails] = useState<Record<string, { quantizations: { name: string; size?: number }[]; gated: false | string } | "loading">>({});
	const running = status?.server === "running" || status?.server === "external";
	const [section, setSection] = useState<LocalSection>(() => storedSection(SECTION_KEY, LOCAL_SECTIONS, "models"));
	const pick = (id: LocalSection) => {
		setSection(id);
		rememberSection(SECTION_KEY, id);
	};

	const loadModels = useCallback(async () => {
		try {
			setModels((await api<{ models: LocalModel[] }>("GET", "/api/local/models")).models);
		} catch {
			setModels([]);
		}
	}, []);

	useEffect(() => {
		void api<LocalStatus>("GET", "/api/local").then(setStatus, () => undefined);
		const offStatus = serverEvents.on<LocalStatus>("local-status", setStatus);
		const offProgress = serverEvents.on<{ task: string; message: string; ratio?: number }>("local-progress", (event) =>
			setProgress((current) => ({ ...current, [event.task]: { message: event.message, ratio: event.ratio } })),
		);
		const offLog = serverEvents.on<{ line: string }>("local-log", (event) => setLogs((current) => [...current.slice(-399), event.line]));
		return () => {
			offStatus();
			offProgress();
			offLog();
		};
	}, [actions]);

	// When the engine comes up, list its models and let the agent's model picker see them.
	useEffect(() => {
		if (!running) return setModels([]);
		void loadModels();
		void actions.refreshModelCatalog();
	}, [running, loadModels, actions]);

	useEffect(() => {
		if (logsOpen) void api<{ lines: string[] }>("GET", "/api/local/logs").then((result) => setLogs(result.lines), () => undefined);
	}, [logsOpen]);

	/** Runs an engine or model action with a busy flag and an error toast. */
	const task = async (key: string, action: () => Promise<unknown>) => {
		setBusy((current) => ({ ...current, [key]: true }));
		try {
			await action();
		} catch (error) {
			actions.toast("error", error instanceof Error ? error.message : String(error));
		} finally {
			setBusy((current) => ({ ...current, [key]: false }));
			setProgress((current) => {
				const { [key]: _done, ...rest } = current;
				return rest;
			});
		}
	};

	const download = (model: string, size?: number) =>
		task(`download:${model}`, async () => {
			await api("POST", "/api/local/download", { model, size });
			actions.toast("info", `Downloaded ${model}`);
			await loadModels();
		});

	const useInChat = (model: string) =>
		task(`load:${model}`, async () => {
			await switchToLocalModel(actions, model);
			await loadModels();
			onUseInChat();
		});

	const unload = (model: string) =>
		task(`unload:${model}`, async () => {
			await api("POST", "/api/local/unload", { model });
			await loadModels();
			void actions.refreshModelCatalog();
		});

	const saveSettings = (next: Partial<LocalStatus["settings"]>) => void api<LocalStatus["settings"]>("PUT", "/api/local/settings", next).catch((error: unknown) => actions.toast("error", String(error)));

	const runSearch = () => {
		if (!query.trim()) return;
		setSearching(true);
		void api<{ results: { id: string; downloads: number }[] }>("POST", "/api/local/search", { query })
			.then(
				(result) => setResults(result.results),
				(error: unknown) => {
					setResults([]);
					actions.toast("error", String(error));
				},
			)
			.finally(() => setSearching(false));
	};

	const openDetails = (repo: string) => {
		if (details[repo]) {
			setDetails(({ [repo]: _open, ...rest }) => rest);
			return;
		}
		setDetails((current) => ({ ...current, [repo]: "loading" }));
		void api<{ quantizations: { name: string; size?: number }[]; gated: false | string }>("POST", "/api/local/details", { repo }).then(
			(result) => setDetails((current) => ({ ...current, [repo]: result })),
			(error: unknown) => {
				setDetails(({ [repo]: _failed, ...rest }) => rest);
				actions.toast("error", String(error));
			},
		);
	};

	// Downloaded models by id, with whether the download finished. An interrupted one offers Resume, not "Downloaded".
	const have = useMemo(() => new Map(models.map((model) => [model.id.toLowerCase(), model.status.value !== "incomplete"])), [models]);

	const remove = (model: LocalModel) => {
		const what = model.status.value === "incomplete" ? `the partial download of ${model.id}` : model.id;
		if (!window.confirm(`Delete ${what}? This frees its disk space; you can download it again later.`)) return;
		void task(`remove:${model.id}`, async () => {
			await api("POST", "/api/local/remove", { model: model.id });
			await loadModels();
			void actions.refreshModelCatalog();
		});
	};
	const activeModel = state.session?.model?.provider === LOCAL_PROVIDER ? state.session.model.id : undefined;

	if (!status) {
		return (
			<div className="page">
				<div className="page-inner">
					<div className="empty-note">
						<Loader2 size={14} className="spin" /> Checking this device
					</div>
				</div>
			</div>
		);
	}

	const { hardware } = status;
	const installing = status.installing;
	const downloadButton = (model: string, size?: number) => {
		const key = `download:${model}`;
		const live = progress[key];
		const tooBig = size !== undefined && fit(size, hardware).tone === "danger";
		if (have.get(model.toLowerCase()) === true) return <span className="badge ok">Downloaded</span>;
		if (busy[key]) {
			// Before the download itself, the engine may be installing: show that progress instead.
			const step = installing ?? live;
			return (
				<div className="local-inline-progress" title={step?.message}>
					<ProgressBar ratio={step?.ratio} />
					<button type="button" className="icon-btn sm" aria-label="Cancel download" title="Cancel" onClick={() => void api("POST", "/api/local/cancel", { task: key })}>
						<X size={13} />
					</button>
				</div>
			);
		}
		return (
			<button
				type="button"
				className="btn-ghost"
				title={tooBig ? "Probably too big for this device" : running ? "Download" : "Download (installs and starts the engine first)"}
				onClick={() => void download(model, size)}
			>
				<Download size={14} />
				{have.get(model.toLowerCase()) === false ? "Resume" : "Download"}
			</button>
		);
	};

	const engineState = installing ? "installing" : !status.installed ? "not installed" : status.server === "external" ? "running" : status.server;
	const sections: Section<LocalSection>[] = [
		{ id: "models", group: "Models", label: "Your models", icon: <Library size={16} />, meta: running ? models.length : undefined },
		{ id: "recommended", group: "Models", label: "Recommended", icon: <ThumbsUp size={16} />, meta: status.recommended.length },
		{ id: "search", group: "Models", label: "Hugging Face", icon: <Search size={16} /> },
		{ id: "engine", group: "Setup", label: "Engine", icon: <Wrench size={16} />, meta: <span className={`local-state ${engineState.replace(" ", "-")}`}>{engineState}</span> },
		{ id: "device", group: "Setup", label: "This device", icon: <Cpu size={16} /> },
	];
	const about: Record<LocalSection, ReactNode> = {
		models: (
			<>
				Downloaded models, plus GGUF files you put in <span className="mono">{status.modelsDir}</span>. One model is loaded at a time.
			</>
		),
		recommended: "Small models with good tool calling, which coding agents need. Larger models are smarter but slower.",
		search: "Search GGUF models, then pick a quantization: Q4_K_M is a good balance of size and quality.",
		engine: "llama.cpp, the engine most local AI apps use. It runs GGUF models from Hugging Face on CPU or GPU.",
		device: "Local models run entirely on this machine. Nothing is sent to a cloud provider.",
	};
	const titles: Record<LocalSection, string> = {
		models: "Your models",
		recommended: "Recommended for this device",
		search: "Find any model on Hugging Face",
		engine: "Engine",
		device: "This device",
	};

	let content: ReactNode = null;
	switch (section) {
		case "models":
			content = (
				<section className="card">
					{!status.installed && !installing && (
						<div className="local-empty">
							<span>Install the engine first to run models on this device.</span>
							<button type="button" className="btn-accent" onClick={() => pick("engine")}>
								<Wrench size={14} />
								Set up the engine
							</button>
						</div>
					)}
					{(status.installed || installing) && !running && (
						<div className="local-empty">
							<span>{status.server === "starting" ? "The engine is starting." : "Start the engine to see and use your models."}</span>
							<button type="button" className="btn-accent" disabled={busy.engine || status.server === "starting"} onClick={() => void task("engine", () => api("POST", "/api/local/start"))}>
								{busy.engine || status.server === "starting" ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
								Start the engine
							</button>
						</div>
					)}
					{running && models.length === 0 && (
						<div className="local-empty">
							<span>No models yet.</span>
							<button type="button" className="btn-ghost" onClick={() => pick("recommended")}>
								<ThumbsUp size={14} />
								See recommended
							</button>
							<button type="button" className="btn-ghost" onClick={() => pick("search")}>
								<Search size={14} />
								Search Hugging Face
							</button>
						</div>
					)}
					{models.map((model) => {
						const loaded = model.status.value === "loaded";
						const incomplete = model.status.value === "incomplete";
						const loading = model.status.value === "loading" || busy[`load:${model.id}`];
						const live = progress[`load:${model.id}`];
						const downloading = busy[`download:${model.id}`];
						return (
							<div key={model.id} className="local-model">
								<HardDrive size={16} />
								<div className="local-model-name">
									<span>{model.id}</span>
									<small>
										{incomplete
											? "The download stopped part-way. Resume it, or delete the partial files."
											: [model.meta?.size ? bytes(model.meta.size) : undefined, model.meta?.n_ctx ? `${Math.round(model.meta.n_ctx / 1024)}K context` : undefined, activeModel === model.id ? "in use in chat" : undefined]
													.filter(Boolean)
													.join(" · ")}
									</small>
									{loading && live && <ProgressBar ratio={live.ratio} />}
									{downloading && <ProgressBar ratio={progress[`download:${model.id}`]?.ratio} />}
								</div>
								{model.tools === false && (
									<span className="badge warn" title={CHAT_ONLY_HINT}>
										chat only
									</span>
								)}
								<span className={`badge ${loaded ? "ok" : incomplete || model.status.failed ? "warn" : "muted"}`}>
									{loading ? "loading" : incomplete ? "download interrupted" : model.status.failed ? "failed to load" : model.status.value}
								</span>
								{loaded && (
									<button type="button" className="btn-ghost" disabled={busy[`unload:${model.id}`]} onClick={() => void unload(model.id)}>
										Unload
									</button>
								)}
								{model.can_remove !== false && (
									<button type="button" className="icon-btn sm" aria-label={`Delete ${model.id}`} title={incomplete ? "Delete the partial download" : "Delete this model"} disabled={busy[`remove:${model.id}`] || downloading} onClick={() => remove(model)}>
										{busy[`remove:${model.id}`] ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
									</button>
								)}
								{incomplete ? (
									<button type="button" className="btn-accent" disabled={downloading} onClick={() => void download(model.id)}>
										{downloading ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
										Resume
									</button>
								) : (
									<button type="button" className="btn-accent" disabled={Boolean(loading)} onClick={() => void useInChat(model.id)}>
										{loading ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
										Use in chat
									</button>
								)}
							</div>
						);
					})}
				</section>
			);
			break;
		case "recommended":
			content = <section className="card">{status.recommended.map((model) => {
						const id = `${model.repo}:${model.quant}`;
						const verdict = fit(model.size, hardware);
						return (
							<div key={id} className="local-model">
								<Download size={16} />
								<div className="local-model-name">
									<span>{model.repo.split("/")[1]?.replace(/-GGUF$/i, "")}</span>
									<small>
										{model.repo} · {model.quant} · {bytes(model.size)} — {model.note}
									</small>
								</div>
								<span className={`badge ${verdict.tone}`}>{verdict.label}</span>
								{downloadButton(id, model.size)}
							</div>
						);
					})}</section>;
			break;
		case "search":
			content = (
				<section className="card">
					<form
						className="local-search"
						onSubmit={(event) => {
							event.preventDefault();
							runSearch();
						}}
					>
						<Search size={15} />
						<input value={query} placeholder="e.g. qwen coder, gemma, llama 3.2" onChange={(event) => setQuery(event.target.value)} />
						<button type="submit" className="btn-ghost" disabled={!query.trim()}>
							Search
						</button>
					</form>
					{searching && (
						<div className="empty-note">
							<Loader2 size={13} className="spin" /> Searching Hugging Face
						</div>
					)}
					{results?.length === 0 && <div className="empty-note">No GGUF models found</div>}
					{results?.map((result) => {
						const info = details[result.id];
						return (
							<div key={result.id} className="local-result">
								<button type="button" className="local-result-head" onClick={() => openDetails(result.id)}>
									<span>{result.id}</span>
									<small>{result.downloads.toLocaleString()} downloads</small>
								</button>
								{info === "loading" && (
									<div className="empty-note">
										<Loader2 size={13} className="spin" />
									</div>
								)}
								{info && info !== "loading" && (
									<div className="local-quants">
										{info.gated && <div className="panel-note">This model is gated: accept its terms on Hugging Face and set HF_TOKEN first.</div>}
										{info.quantizations.length === 0 && <div className="empty-note">No GGUF files</div>}
										{info.quantizations.map((quant) => {
											const id = `${result.id}:${quant.name}`;
											const verdict = quant.size ? fit(quant.size, hardware) : undefined;
											return (
												<div key={quant.name} className="local-quant">
													<span className="mono">{quant.name}</span>
													<small>{bytes(quant.size)}</small>
													{verdict && <span className={`badge ${verdict.tone}`}>{verdict.label}</span>}
													<span className="grow" />
													{downloadButton(id, quant.size)}
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</section>
			);
			break;
		case "engine":
			content = (
				<>
					{(!status.installed || installing) && (
						<section className="card">
							{!status.installed && !installing && (
						<Setting label="Install llama.cpp" hint="About 30–200 MB, depending on the build. Updates are a reinstall.">
							<Select
								ariaLabel="Engine build"
								width={190}
								value={variant ?? status.hardware.recommended}
								options={status.variants.map((option) => ({ value: option.id, label: option.label, hint: option.id === status.hardware.recommended ? "recommended" : undefined }))}
								onChange={setVariant}
							/>
							<button type="button" className="btn-accent" onClick={() => void api("POST", "/api/local/install", { variant: variant ?? status.hardware.recommended })}>
								<Download size={14} />
								Install
							</button>
						</Setting>
					)}
							{installing && (
						<div className="local-install">
							<span>{installing.message}</span>
							<ProgressBar ratio={installing.ratio} />
						</div>
					)}
						</section>
					)}
					{status.installed && !installing && (
						<>
							<section className="card">
								<Setting
								label={`llama.cpp ${status.installed.tag}`}
								hint={
									<>
										{status.variants.find((option) => option.id === status.installed?.variant)?.label ?? status.installed.variant} ·{" "}
										<span className={`local-state ${status.server}`}>
											{status.server === "external" ? "using a server you started" : status.server}
										</span>
										{status.error && <span className="local-error"> {status.error}</span>}
									</>
								}
							>
								{running || status.server === "starting" ? (
									<>
										<button type="button" className="btn-ghost" disabled={busy.engine} onClick={() => void task("engine", () => api("POST", "/api/local/restart"))}>
											<RotateCw size={14} />
											Restart
										</button>
										<button type="button" className="btn-ghost" onClick={() => void api("POST", "/api/local/stop")}>
											<Square size={13} />
											Stop
										</button>
									</>
								) : (
									<button type="button" className="btn-accent" disabled={busy.engine} onClick={() => void task("engine", () => api("POST", "/api/local/start"))}>
										{busy.engine ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
										Start
									</button>
								)}
								<button type="button" className={`btn-ghost${logsOpen ? " active" : ""}`} onClick={() => setLogsOpen(!logsOpen)}>
									<Terminal size={14} />
									Logs
								</button>
							</Setting>
								{logsOpen && <pre className="local-logs">{logs.join("\n") || "No output yet."}</pre>}
							</section>
							<section className="card">
								<h2>Options</h2>
								<Setting label="Context window" hint="How much text a model sees at once. Coding agents need 32K or more; larger uses more memory. Restart to apply.">
								<Select
									ariaLabel="Context window"
									width={130}
									value={String(status.settings.contextSize)}
									options={CONTEXT_SIZES.map((size) => ({ value: String(size), label: `${size / 1024}K tokens` }))}
									onChange={(value) => saveSettings({ contextSize: Number(value) })}
								/>
							</Setting>
							<Setting label="Use the GPU" hint="Off runs on the CPU only: slower, but avoids GPU driver problems. Restart to apply.">
								<Switch on={status.settings.gpu} label="Use the GPU" onChange={(gpu) => saveSettings({ gpu })} />
							</Setting>
							<Setting label="Start with Sorvex" hint="Start the engine when the app opens, so local models are ready.">
								<Switch on={status.settings.autoStart} label="Start with Sorvex" onChange={(autoStart) => saveSettings({ autoStart })} />
							</Setting>
							</section>
							<section className="card">
								<h2>Build</h2>
								<Setting label="Update or switch build" hint="Downloads the newest llama.cpp release for the chosen build.">
								<Select
									ariaLabel="Engine build"
									width={190}
									value={variant ?? status.installed.variant}
									options={status.variants.map((option) => ({ value: option.id, label: option.label, hint: option.id === status.hardware.recommended ? "recommended" : undefined }))}
									onChange={setVariant}
								/>
								<button type="button" className="btn-ghost" onClick={() => void api("POST", "/api/local/install", { variant: variant ?? status.installed?.variant })}>
									<Download size={14} />
									Reinstall
								</button>
							</Setting>
							</section>
						</>
					)}
				</>
			);
			break;
		case "device":
			content = <section className="card"><div className="local-hw">
						<div>
							<Cpu size={16} />
							<span>
								{hardware.cpu}
								<small>{hardware.cores} threads</small>
							</span>
						</div>
						<div>
							<MemoryStick size={16} />
							<span>
								{bytes(hardware.ramTotal)} RAM
								<small>{bytes(hardware.ramFree)} free now</small>
							</span>
						</div>
						{hardware.gpus.map((gpu) => (
							<div key={gpu.name}>
								<MonitorCog size={16} />
								<span>
									{gpu.name}
									<small>{gpu.vram ? `${bytes(gpu.vram)} VRAM` : "Shares system memory"}</small>
								</span>
							</div>
						))}
					</div></section>;
			break;
	}

	return (
		<SectionLayout sections={sections} current={section} onPick={pick} title={titles[section]} about={about[section]}>
			{content}
		</SectionLayout>
	);
}
