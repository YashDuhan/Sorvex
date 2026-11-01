import { ChevronLeft, ChevronRight, Download, ExternalLink, Eye, Library, Loader2, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { SorvexActions, State } from "../store.ts";
import { PageHeader } from "./Chrome.tsx";
import { Markdown } from "./Markdown.tsx";
import { Modal } from "./Modals.tsx";
import { Select } from "./Select.tsx";

interface InstalledSkill {
	name: string;
	description: string;
	path: string;
	scope: string;
	source: string;
	registryId?: string;
	removable: boolean;
}

interface RegistryEntry {
	id: string;
	name: string;
	description: string;
	source: string;
	category: string;
	tags: string[];
	author: string;
	version: string;
	license: string;
	sourceUrl: string;
	installable: boolean;
}

interface RegistryPage {
	entries: RegistryEntry[];
	total: number;
	page: number;
	pageSize: number;
	totalPages: number;
	sources: { name: string; count: number }[];
	fetchedAt: number | null;
	refreshing: boolean;
	lastError: string | null;
}

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const openExternal = (url: string) => void api("POST", "/api/open", { url });
const skillSlug = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
	return (
		<label className="search skills-search">
			<Search size={14} />
			<input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
		</label>
	);
}

function InstalledDetail({ skill, cwd, onClose }: { skill: InstalledSkill; cwd: string; onClose: () => void }) {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		api<{ text: string }>("GET", `/api/skills/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(skill.path)}`).then(
			(result) => setText(result.text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")),
			(failure: unknown) => setError(errorText(failure)),
		);
	}, [cwd, skill.path]);
	return (
		<Modal
			wide
			title={
				<span className="skills-detail-title">
					{skill.name}
					<span className="mcp-badge">{skill.scope}</span>
				</span>
			}
			onClose={onClose}
		>
			<div className="skills-detail">
				{skill.description && <p className="skills-detail-desc">{skill.description}</p>}
				<div className="skills-detail-path mono">{skill.path}</div>
				{error && <div className="mcp-error">{error}</div>}
				{text === null && !error ? (
					<div className="empty-note">
						<Loader2 size={14} className="spin" />
					</div>
				) : (
					text && (
						<div className="skills-detail-body">
							<Markdown text={text} />
						</div>
					)
				)}
			</div>
		</Modal>
	);
}

function InstalledView({ state, actions, onBrowse, installed, loading, reload }: {
	state: State;
	actions: SorvexActions;
	onBrowse: () => void;
	installed: InstalledSkill[] | null;
	loading: boolean;
	reload: () => void;
}) {
	const [query, setQuery] = useState("");
	const [scope, setScope] = useState("all");
	const [detail, setDetail] = useState<InstalledSkill | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);

	const q = query.trim().toLowerCase();
	const scopes = [...new Set((installed ?? []).map((skill) => skill.scope))];
	const rows = (installed ?? []).filter(
		(skill) => (scope === "all" || skill.scope === scope) && (!q || skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q)),
	);

	const remove = async (skill: InstalledSkill) => {
		if (!window.confirm(`Remove skill "${skill.name}"? This deletes ${skill.path.endsWith("SKILL.md") ? "its folder" : "the file"}.`)) return;
		setRemoving(skill.path);
		try {
			await api("POST", "/api/skills/remove", { cwd: state.cwd, path: skill.path });
			actions.toast("info", `Removed ${skill.name}`);
			reload();
		} catch (error) {
			actions.toast("error", errorText(error));
		} finally {
			setRemoving(null);
		}
	};

	return (
		<>
			<div className="skills-section-head">
				<div>
					<div className="mcp-title">Installed skills</div>
					<div className="skills-intro">Skills the agent loaded for this folder. It reads a skill when a task matches its description, or when you run /skill:name.</div>
				</div>
			</div>
			<div className="skills-toolbar">
				<SearchField value={query} onChange={setQuery} placeholder="Search installed skills" />
				<Select
					width={150}
					ariaLabel="Scope"
					value={scope}
					options={[{ value: "all", label: "All scopes" }, ...scopes.map((value) => ({ value, label: value }))]}
					onChange={setScope}
				/>
			</div>
			<div className="skills-table" role="list">
				{rows.map((skill) => (
					<div key={skill.path} className="skills-row" role="listitem" tabIndex={0} onClick={() => setDetail(skill)} onKeyDown={(event) => event.key === "Enter" && setDetail(skill)}>
						<div className="skills-row-main">
							<div className="skills-row-name">
								{skill.name}
								<ChevronRight size={13} />
							</div>
							<div className="skills-row-desc" title={skill.description}>
								{skill.description || "No description"}
							</div>
						</div>
						<span className="skills-row-badges">
							{skill.registryId && <span className="mcp-badge">registry</span>}
							{skill.source !== "local" && skill.source !== "auto" && <span className="mcp-badge">{skill.source}</span>}
							<span className="mcp-badge">{skill.scope}</span>
						</span>
						<span className="skills-row-actions" onClick={(event) => event.stopPropagation()}>
							<button type="button" className="icon-btn sm" title="View SKILL.md" aria-label={`View ${skill.name}`} onClick={() => setDetail(skill)}>
								<Eye size={13} />
							</button>
							{skill.removable && (
								<button type="button" className="icon-btn sm danger-icon" title="Remove skill" aria-label={`Remove ${skill.name}`} disabled={removing === skill.path} onClick={() => void remove(skill)}>
									{removing === skill.path ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
								</button>
							)}
						</span>
					</div>
				))}
				{installed && rows.length === 0 && installed.length > 0 && <div className="empty-note">No skills match.</div>}
				{installed && installed.length === 0 && (
					<div className="mcp-empty">
						<div className="mcp-empty-icon">
							<Sparkles size={22} />
						</div>
						<h2>No skills yet</h2>
						<p>Skills are SKILL.md files that teach the agent a task. Install one from the registry, or add a folder under ~/.sorvex/agent/skills.</p>
						<button type="button" className="btn-accent" onClick={onBrowse}>
							<Library size={14} /> Browse registry
						</button>
					</div>
				)}
				{!installed && loading && (
					<div className="empty-note">
						<Loader2 size={16} className="spin" /> Loading skills...
					</div>
				)}
			</div>
			{detail && <InstalledDetail skill={detail} cwd={state.cwd} onClose={() => setDetail(null)} />}
		</>
	);
}

function RegistryDetail({
	entry,
	installed,
	installing,
	onInstall,
	onClose,
}: {
	entry: RegistryEntry;
	installed: boolean;
	installing: boolean;
	onInstall: (scope: "user" | "project") => void;
	onClose: () => void;
}) {
	const [overview, setOverview] = useState("");
	const [scope, setScope] = useState<"user" | "project">("user");
	useEffect(() => {
		api<{ overview: string }>("GET", `/api/skills/registry/detail?id=${encodeURIComponent(entry.id)}`).then(
			(result) => setOverview(result.overview.trim()),
			() => undefined,
		);
	}, [entry.id]);
	const meta = [
		["Version", entry.version && `v${entry.version}`],
		["Author", entry.author],
		["License", entry.license],
		["Category", entry.category],
	].filter(([, value]) => value);
	return (
		<Modal
			title={
				<span className="skills-detail-title">
					{entry.name}
					<span className="mcp-badge">{entry.source}</span>
					{installed && <span className="mcp-badge skills-badge-ok">Installed</span>}
				</span>
			}
			onClose={onClose}
			footer={
				installed ? undefined : entry.installable ? (
					<>
						<div className="segmented sm">
							<button type="button" className={scope === "user" ? "on" : ""} onClick={() => setScope("user")}>
								Global
							</button>
							<button type="button" className={scope === "project" ? "on" : ""} onClick={() => setScope("project")}>
								This project
							</button>
						</div>
						<span className="grow" />
						<button type="button" className="btn-accent" disabled={installing} onClick={() => onInstall(scope)}>
							{installing ? <Loader2 size={14} className="spin" /> : <Download size={14} />} {installing ? "Installing" : "Install"}
						</button>
					</>
				) : (
					<span className="skills-intro">This entry has no SKILL.md to download.</span>
				)
			}
		>
			<div className="skills-detail">
				{entry.description && (
					<div>
						<div className="skills-detail-label">Description</div>
						<p className="skills-detail-desc">{entry.description}</p>
					</div>
				)}
				{overview && overview !== entry.description && (
					<div>
						<div className="skills-detail-label">Overview</div>
						<p className="skills-detail-desc">{overview}</p>
					</div>
				)}
				{meta.length > 0 && (
					<div className="skills-detail-meta">
						{meta.map(([label, value]) => (
							<div key={label}>
								<div className="skills-detail-label">{label}</div>
								<div>{value}</div>
							</div>
						))}
					</div>
				)}
				{entry.tags.length > 0 && (
					<div>
						<div className="skills-detail-label">Tags</div>
						<div className="skills-tags">
							{entry.tags.map((tag) => (
								<span key={tag} className="mcp-badge">
									{tag}
								</span>
							))}
						</div>
					</div>
				)}
				{entry.sourceUrl && (
					<button type="button" className="skills-link" onClick={() => openExternal(entry.sourceUrl)}>
						<ExternalLink size={12} /> {entry.sourceUrl}
					</button>
				)}
			</div>
		</Modal>
	);
}

function RegistryView({ state, actions, installed, onInstalled }: { state: State; actions: SorvexActions; installed: InstalledSkill[]; onInstalled: () => void }) {
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [source, setSource] = useState("all");
	const [pageNum, setPageNum] = useState(1);
	const [page, setPage] = useState<RegistryPage | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [installing, setInstalling] = useState<string | null>(null);
	const [justInstalled, setJustInstalled] = useState<Set<string>>(new Set());
	const [detail, setDetail] = useState<RegistryEntry | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query]);
	useEffect(() => setPageNum(1), [debounced, source]);

	const fetchPage = useCallback(
		(refresh: boolean) => {
			setLoading(true);
			setError("");
			const params = new URLSearchParams({ q: debounced, page: String(pageNum), pageSize: String(PAGE_SIZE) });
			if (source !== "all") params.append("source", source);
			if (refresh) params.set("refresh", "1");
			let cancelled = false;
			api<RegistryPage>("GET", `/api/skills/registry?${params}`)
				.then(
					(result) => !cancelled && setPage(result),
					(failure: unknown) => !cancelled && setError(errorText(failure)),
				)
				.finally(() => !cancelled && setLoading(false));
			return () => {
				cancelled = true;
			};
		},
		[debounced, source, pageNum],
	);
	useEffect(() => fetchPage(false), [fetchPage]);

	const installedIds = new Set(installed.map((skill) => skill.registryId).filter(Boolean));
	const installedNames = new Set(installed.map((skill) => skill.name));
	const isInstalled = (entry: RegistryEntry) => justInstalled.has(entry.id) || installedIds.has(entry.id) || installedNames.has(skillSlug(entry.name));

	const install = async (entry: RegistryEntry, scope: "user" | "project" = "user") => {
		setInstalling(entry.id);
		try {
			const result = await api<{ name: string; path: string }>("POST", "/api/skills/registry/install", { id: entry.id, cwd: state.cwd, scope });
			setJustInstalled((current) => new Set(current).add(entry.id));
			actions.toast("info", `Installed ${result.name}`);
			onInstalled();
		} catch (failure) {
			actions.toast("error", errorText(failure));
		} finally {
			setInstalling(null);
		}
	};

	const entries = page?.entries ?? [];
	const first = page && page.total > 0 ? (page.page - 1) * page.pageSize + 1 : 0;
	const last = page ? Math.min(page.page * page.pageSize, page.total) : 0;

	return (
		<>
			<div className="skills-section-head">
				<div>
					<div className="mcp-title">Skill registry</div>
					<div className="skills-intro">
						The Hermes skills index: Hermes, Anthropic, OpenAI, HuggingFace, NVIDIA, GitHub collections, skills.sh and ClawHub. Installing downloads the
						entry's SKILL.md into your skills folder.
					</div>
				</div>
				<button type="button" className="btn-ghost" disabled={loading} onClick={() => fetchPage(true)}>
					<RefreshCw size={13} className={loading ? "spin" : undefined} /> Refresh
				</button>
			</div>
			<div className="skills-toolbar">
				<SearchField value={query} onChange={setQuery} placeholder="Search the registry" />
				<Select
					width={190}
					ariaLabel="Source"
					searchable
					value={source}
					options={[
						{ value: "all", label: "All sources" },
						...(page?.sources ?? []).map(({ name, count }) => ({ value: name, label: name, hint: count.toLocaleString() })),
					]}
					onChange={setSource}
				/>
			</div>
			{error && (
				<div className="mcp-error skills-notice">
					{error}
					<button type="button" className="btn-ghost" onClick={() => fetchPage(true)}>
						Retry
					</button>
				</div>
			)}
			{page?.lastError && !error && <div className="panel-note">Showing the cached index; the last refresh failed: {page.lastError}</div>}
			<div className="skills-table" role="list">
				{entries.map((entry) => {
					const done = isInstalled(entry);
					return (
						<div key={entry.id} className="skills-row" role="listitem" tabIndex={0} onClick={() => setDetail(entry)} onKeyDown={(event) => event.key === "Enter" && setDetail(entry)}>
							<div className="skills-row-main">
								<div className="skills-row-name">
									{entry.name}
									<ChevronRight size={13} />
								</div>
								<div className="skills-row-desc" title={entry.description}>
									{entry.description}
								</div>
							</div>
							<span className="skills-row-badges">
								<span className="mcp-badge">{entry.source}</span>
							</span>
							<span className="skills-row-actions" onClick={(event) => event.stopPropagation()}>
								{done ? (
									<span className="mcp-badge skills-badge-ok">Installed</span>
								) : entry.installable ? (
									<button type="button" className="btn-ghost skills-install" disabled={installing === entry.id} onClick={() => void install(entry)}>
										{installing === entry.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {installing === entry.id ? "Installing" : "Install"}
									</button>
								) : (
									<>
										<span className="mcp-badge" title="This entry has no SKILL.md to download">
											Not installable
										</span>
										{entry.sourceUrl && (
											<button type="button" className="icon-btn sm" title="View source" aria-label={`View source of ${entry.name}`} onClick={() => openExternal(entry.sourceUrl)}>
												<ExternalLink size={13} />
											</button>
										)}
									</>
								)}
							</span>
						</div>
					);
				})}
				{page && entries.length === 0 && !loading && <div className="empty-note">{debounced ? "No skills match." : "The registry is empty."}</div>}
				{!page && loading && (
					<div className="empty-note">
						<Loader2 size={16} className="spin" /> Loading the skill index (first load downloads about 60 MB)...
					</div>
				)}
			</div>
			{page && page.total > 0 && (
				<div className="skills-pager">
					<span>
						{first.toLocaleString()}-{last.toLocaleString()} of {page.total.toLocaleString()}
					</span>
					<span className="grow" />
					<button type="button" className="icon-btn sm" aria-label="Previous page" disabled={page.page <= 1 || loading} onClick={() => setPageNum(page.page - 1)}>
						<ChevronLeft size={14} />
					</button>
					<span>
						Page {page.page} of {page.totalPages.toLocaleString()}
					</span>
					<button type="button" className="icon-btn sm" aria-label="Next page" disabled={page.page >= page.totalPages || loading} onClick={() => setPageNum(page.page + 1)}>
						<ChevronRight size={14} />
					</button>
				</div>
			)}
			{detail && (
				<RegistryDetail
					entry={detail}
					installed={isInstalled(detail)}
					installing={installing === detail.id}
					onClose={() => setDetail(null)}
					onInstall={(scope) => {
						void install(detail, scope);
						setDetail(null);
					}}
				/>
			)}
		</>
	);
}

export function SkillsPage({ state, actions }: { state: State; actions: SorvexActions }) {
	const [view, setView] = useState<"installed" | "registry">("installed");
	const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(() => {
		setLoading(true);
		api<{ skills: InstalledSkill[] }>("GET", `/api/skills?cwd=${encodeURIComponent(state.cwd)}`)
			.then((result) => setInstalled(result.skills), (error: unknown) => actions.toast("error", errorText(error)))
			.finally(() => setLoading(false));
	}, [state.cwd, actions]);
	useEffect(load, [load]);

	return (
		<>
			<PageHeader
				title="Skills"
				left={
					<div className="segmented">
						<button type="button" className={view === "installed" ? "on" : ""} onClick={() => setView("installed")}>
							Installed{installed ? ` (${installed.length})` : ""}
						</button>
						<button type="button" className={view === "registry" ? "on" : ""} onClick={() => setView("registry")}>
							Registry
						</button>
					</div>
				}
				right={
					view === "installed" && (
						<button type="button" className="icon-btn" title="Reload" aria-label="Reload skills" onClick={load}>
							{loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
						</button>
					)
				}
			/>
			<div className="skills-page">
				{view === "installed" ? (
					<InstalledView state={state} actions={actions} installed={installed} loading={loading} reload={load} onBrowse={() => setView("registry")} />
				) : (
					<RegistryView state={state} actions={actions} installed={installed ?? []} onInstalled={load} />
				)}
			</div>
		</>
	);
}
