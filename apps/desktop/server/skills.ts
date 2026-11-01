import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, loadSkills, parseFrontmatter } from "@sorvex/coding-agent";
import { desktopDir } from "./paths.ts";

/**
 * The Skills page: skills the agent has loaded, and the public skill registry to install more from.
 *
 * The registry is the Hermes skills index (the one openhuman's Skills page reads): one JSON array of about 100k
 * entries aggregating Hermes' own skills, ClawHub, skills.sh, GitHub collections, Anthropic, OpenAI and others.
 * It is cached on disk and refreshed with a conditional request. Installing fetches the entry's SKILL.md into
 *   ~/.sorvex/agent/skills/<name>/SKILL.md
 * with a `.registry.json` beside it naming the entry, so the registry can show it as installed.
 */

const INDEX_URL = "https://hermes-agent.nousresearch.com/docs/api/skills.json";
const CACHE_DIR = join(desktopDir, "skill-registry");
const CACHE_FILE = join(CACHE_DIR, "index.json");
const META_FILE = join(CACHE_DIR, "meta.json");
/** A cached index older than this is refreshed in the background while the cached one answers. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_DOCUMENT_BYTES = 1024 * 1024;
const REGISTRY_SIDECAR = ".registry.json";

const userSkillsDir = () => join(getAgentDir(), "skills");
const projectSkillsDir = (cwd: string) => resolve(cwd, CONFIG_DIR_NAME, "skills");

// ---------- Installed ----------

export interface InstalledSkill {
	name: string;
	description: string;
	path: string;
	scope: string;
	/** Package or extension that provided it, or "local". */
	source: string;
	/** Registry entry id when it was installed from the registry. */
	registryId?: string;
	/** Only skills in the user or project skills folder can be removed here. */
	removable: boolean;
}

export interface CommandInfo {
	name: string;
	description?: string;
	source: string;
	sourceInfo?: { path: string; source: string; scope: string };
}

function isUnder(target: string, root: string): boolean {
	const path = resolve(target);
	const base = resolve(root);
	return path.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

function readSidecar(skillPath: string): { id?: string } | undefined {
	const file = join(dirname(skillPath), REGISTRY_SIDECAR);
	if (basename(skillPath) !== "SKILL.md" || !existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as { id?: string };
	} catch {
		return undefined;
	}
}

/**
 * Skills as the running agent loaded them (`get_commands`), which includes package and settings paths. Without a
 * running agent, falls back to scanning the default user and project folders.
 */
export async function listInstalledSkills(cwd: string, commands: () => Promise<{ commands: CommandInfo[] }>): Promise<{ skills: InstalledSkill[]; userDir: string }> {
	let found: Omit<InstalledSkill, "registryId" | "removable">[];
	try {
		found = (await commands()).commands
			.filter((command) => command.source === "skill" && command.sourceInfo)
			.map((command) => ({
				name: command.name.replace(/^skill:/, ""),
				description: command.description ?? "",
				path: command.sourceInfo!.path,
				scope: command.sourceInfo!.scope,
				source: command.sourceInfo!.source,
			}));
	} catch {
		found = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills.map((skill) => ({
			name: skill.name,
			description: skill.description,
			path: skill.filePath,
			scope: skill.sourceInfo.scope,
			source: skill.sourceInfo.source,
		}));
	}
	const skills = found
		.map((skill) => ({
			...skill,
			registryId: readSidecar(skill.path)?.id,
			removable: isUnder(skill.path, userSkillsDir()) || isUnder(skill.path, projectSkillsDir(cwd)),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { skills, userDir: userSkillsDir() };
}

export function readSkillFile(cwd: string, path: string, known: string[]): { text: string } {
	if (!known.includes(path) && !isUnder(path, userSkillsDir()) && !isUnder(path, projectSkillsDir(cwd))) {
		throw new Error("Not a loaded skill");
	}
	return { text: readFileSync(path, "utf8") };
}

/** Deletes a skill from the user or project skills folder: its directory for a SKILL.md, else the file. */
export function removeSkill(cwd: string, path: string): { removed: string } {
	const roots = [userSkillsDir(), projectSkillsDir(cwd)];
	const root = roots.find((dir) => isUnder(path, dir));
	if (!root) throw new Error("Only skills in the user or project skills folder can be removed");
	const target = basename(path) === "SKILL.md" ? dirname(path) : path;
	if (resolve(target) === resolve(root)) throw new Error("Refusing to remove the skills folder itself");
	rmSync(target, { recursive: true, force: true });
	return { removed: target };
}

// ---------- Registry ----------

interface RawEntry {
	name?: string;
	description?: string;
	overview?: string;
	category?: string;
	categoryLabel?: string;
	source?: string;
	tags?: string[];
	author?: string;
	version?: string;
	license?: string;
	docsPath?: string;
	identifier?: string;
	sourceUrl?: string;
}

export interface RegistryEntry {
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

interface HeldEntry extends RegistryEntry {
	overview: string;
	docsPath: string;
	identifier: string;
	/** Lower-cased name, for search. */
	key: string;
}

interface CacheMeta {
	etag?: string;
	lastModified?: string;
	fetchedAt: number;
}

/** Curated sources first; the large community indexes after. Unlisted sources sit in between. */
const SOURCE_ORDER = ["built-in", "optional", "Anthropic", "OpenAI", "HuggingFace", "NVIDIA", "GitHub", "skills.sh", "ClawHub", "LobeHub"];
const sourceRank = (source: string) => {
	const at = SOURCE_ORDER.indexOf(source);
	return at === -1 ? SOURCE_ORDER.indexOf("GitHub") : at;
};

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const safeSegment = (value: string) => SAFE_SEGMENT.test(value) && value !== "." && value !== "..";

/** Hermes' own skills: `bundled/<category>/<category>-<skill>` or `optional/...` in the hermes-agent repo. */
function docsPathUrl(docsPath: string): string | undefined {
	const [kind, category, slug, extra] = docsPath.split("/");
	const root = kind === "bundled" ? "skills" : kind === "optional" ? "optional-skills" : undefined;
	if (!root || !category || !slug || extra !== undefined) return undefined;
	const skill = slug.startsWith(`${category}-`) ? slug.slice(category.length + 1) : slug;
	if (!safeSegment(category) || !safeSegment(skill)) return undefined;
	return `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/${root}/${category}/${skill}/SKILL.md`;
}

/** A github.com blob or tree URL as the raw SKILL.md URL. */
function githubUrl(sourceUrl: string): string | undefined {
	const match = /^https?:\/\/github\.com\/([^?#]+)$/.exec(sourceUrl);
	if (!match) return undefined;
	const [owner, repo, kind, branch, ...rest] = match[1]!.replace(/\/+$/, "").split("/");
	if (!owner || !repo || !branch || rest.length === 0 || ![owner, repo, branch, ...rest].every(safeSegment)) return undefined;
	const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rest.join("/")}`;
	if (kind === "tree") return `${raw}/SKILL.md`;
	if (kind !== "blob") return undefined;
	const file = rest.at(-1)!;
	if (file === "SKILL.md") return raw;
	return /\.md$/i.test(file) ? `${raw.slice(0, raw.lastIndexOf("/"))}/SKILL.md` : `${raw}/SKILL.md`;
}

function skillsShRef(sourceUrl: string): { owner: string; repo: string; skill: string } | undefined {
	const match = /^https:\/\/skills\.sh\/([^/]+)\/([^/]+)\/([^/]+)\/?$/.exec(sourceUrl);
	if (!match || !match.slice(1).every(safeSegment)) return undefined;
	return { owner: match[1]!, repo: match[2]!, skill: match[3]! };
}

function directUrl(entry: HeldEntry): string | undefined {
	if (entry.docsPath) {
		const url = docsPathUrl(entry.docsPath);
		if (url) return url;
	}
	if (entry.sourceUrl) {
		const url = githubUrl(entry.sourceUrl);
		if (url) return url;
	}
	if (entry.source.toLowerCase() === "clawhub" && entry.identifier && safeSegment(entry.identifier)) {
		return `https://clawhub.ai/api/v1/skills/${entry.identifier}/file?path=SKILL.md`;
	}
	return undefined;
}

function toEntry(raw: RawEntry): HeldEntry | undefined {
	if (!raw.name) return undefined;
	const source = raw.source || "hermes";
	const identifier = raw.identifier?.trim() ?? "";
	const entry: HeldEntry = {
		id: identifier.includes("/") ? identifier : identifier ? `${source.toLowerCase()}/${identifier}` : raw.name,
		name: raw.name,
		description: raw.description ?? "",
		overview: raw.overview ?? "",
		source,
		category: raw.categoryLabel || raw.category || "",
		tags: raw.tags ?? [],
		author: raw.author ?? "",
		version: raw.version ?? "",
		license: raw.license ?? "",
		sourceUrl: raw.sourceUrl ?? "",
		docsPath: raw.docsPath ?? "",
		identifier,
		installable: false,
		key: raw.name.toLowerCase(),
	};
	entry.installable = directUrl(entry) !== undefined || skillsShRef(entry.sourceUrl) !== undefined;
	return entry;
}

const publicEntry = ({ overview: _overview, docsPath: _docsPath, identifier: _identifier, key: _key, ...entry }: HeldEntry): RegistryEntry => entry;

export class SkillRegistry {
	private entries: HeldEntry[] = [];
	private byId = new Map<string, HeldEntry>();
	private meta: CacheMeta | undefined;
	private refreshing: Promise<void> | undefined;
	private lastError: string | undefined;

	private load(text: string): void {
		const raw = JSON.parse(text) as RawEntry[];
		if (!Array.isArray(raw)) throw new Error("The skill index is not a list");
		const entries = raw.map(toEntry).filter((entry): entry is HeldEntry => entry !== undefined);
		entries.sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
		this.entries = entries;
		this.byId = new Map(entries.map((entry) => [entry.id, entry]));
	}

	private async fetchIndex(): Promise<void> {
		const headers: Record<string, string> = {};
		if (this.meta?.etag && this.entries.length > 0) headers["if-none-match"] = this.meta.etag;
		if (this.meta?.lastModified && this.entries.length > 0) headers["if-modified-since"] = this.meta.lastModified;
		const response = await fetch(INDEX_URL, { headers, signal: AbortSignal.timeout(120_000) });
		const meta: CacheMeta = {
			etag: response.headers.get("etag") ?? this.meta?.etag,
			lastModified: response.headers.get("last-modified") ?? this.meta?.lastModified,
			fetchedAt: Date.now(),
		};
		if (response.status === 304) {
			this.meta = meta;
		} else {
			if (!response.ok) throw new Error(`Skill index request failed (${response.status})`);
			const text = await response.text();
			this.load(text);
			this.meta = meta;
			mkdirSync(CACHE_DIR, { recursive: true });
			writeFileSync(CACHE_FILE, text);
		}
		writeFileSync(META_FILE, JSON.stringify(this.meta));
	}

	private refresh(): Promise<void> {
		this.refreshing ??= this.fetchIndex()
			.then(
				() => {
					this.lastError = undefined;
				},
				(error: unknown) => {
					this.lastError = error instanceof Error ? error.message : String(error);
				},
			)
			.finally(() => {
				this.refreshing = undefined;
			});
		return this.refreshing;
	}

	/** Loads the disk cache once, then refreshes: waiting when nothing is cached or on `force`, else in the background. */
	private async ready(force: boolean): Promise<void> {
		if (this.entries.length === 0 && existsSync(CACHE_FILE)) {
			try {
				this.meta = JSON.parse(readFileSync(META_FILE, "utf8")) as CacheMeta;
				this.load(readFileSync(CACHE_FILE, "utf8"));
			} catch {
				this.meta = undefined;
			}
		}
		const stale = !this.meta || Date.now() - this.meta.fetchedAt > MAX_AGE_MS;
		if (this.entries.length === 0 || force) await this.refresh();
		else if (stale) void this.refresh();
		if (this.entries.length === 0) throw new Error(this.lastError ?? "The skill index is empty");
	}

	async browse(options: { query: string; sources: string[]; page: number; pageSize: number; force: boolean }) {
		await this.ready(options.force);
		const query = options.query.trim().toLowerCase();
		const sources = new Set(options.sources);
		const counts = new Map<string, number>();
		const matches: { entry: HeldEntry; score: number }[] = [];
		for (const entry of this.entries) {
			let score = 1;
			if (query) {
				if (entry.key === query) score = 100;
				else if (entry.key.startsWith(query)) score = 60;
				else if (entry.key.includes(query)) score = 40;
				else if (entry.tags.some((tag) => tag.toLowerCase().includes(query))) score = 20;
				else if (entry.description.toLowerCase().includes(query)) score = 10;
				else continue;
			}
			counts.set(entry.source, (counts.get(entry.source) ?? 0) + 1);
			if (sources.size === 0 || sources.has(entry.source)) matches.push({ entry, score });
		}
		// Stable sort keeps the curated source order within a score.
		if (query) matches.sort((a, b) => b.score - a.score);
		const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
		const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
		const page = Math.min(Math.max(options.page, 1), totalPages);
		return {
			entries: matches.slice((page - 1) * pageSize, page * pageSize).map(({ entry }) => publicEntry(entry)),
			total: matches.length,
			page,
			pageSize,
			totalPages,
			sources: [...counts.entries()].sort((a, b) => sourceRank(a[0]) - sourceRank(b[0])).map(([name, count]) => ({ name, count })),
			fetchedAt: this.meta?.fetchedAt ?? null,
			refreshing: this.refreshing !== undefined,
			lastError: this.lastError ?? null,
		};
	}

	async detail(id: string): Promise<RegistryEntry & { overview: string }> {
		await this.ready(false);
		const entry = this.byId.get(id);
		if (!entry) throw new Error(`No registry entry ${id}`);
		return { ...publicEntry(entry), overview: entry.overview };
	}

	/** A skills.sh listing names a repo, not a path: try the usual folders, then search the repo tree. */
	private async resolveSkillsSh(entry: HeldEntry): Promise<string> {
		const ref = skillsShRef(entry.sourceUrl)!;
		const raw = (path: string) => `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/HEAD/${path}`;
		const candidates = ["", "skills/", ".agents/skills/", ".claude/skills/"].map((dir) => raw(`${dir}${ref.skill}/SKILL.md`));
		const probes = await Promise.all(
			candidates.map((url) =>
				fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) }).then(
					(response) => response.ok,
					() => false,
				),
			),
		);
		const hit = probes.indexOf(true);
		if (hit !== -1) return candidates[hit]!;
		const response = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/git/trees/HEAD?recursive=1`, {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`Could not list github.com/${ref.owner}/${ref.repo} (${response.status})`);
		const tree = (await response.json()) as { tree?: { path: string; type: string }[] };
		const paths = (tree.tree ?? []).filter((item) => item.type === "blob" && (item.path === `${ref.skill}/SKILL.md` || item.path.endsWith(`/${ref.skill}/SKILL.md`)));
		if (paths.length === 0) throw new Error(`'${ref.skill}' is listed on skills.sh, but github.com/${ref.owner}/${ref.repo} has no ${ref.skill}/SKILL.md`);
		if (paths.length > 1) throw new Error(`github.com/${ref.owner}/${ref.repo} has more than one ${ref.skill}/SKILL.md; install it from a URL instead`);
		return raw(paths[0]!.path);
	}

	async install(id: string, cwd: string, scope: "user" | "project"): Promise<{ name: string; path: string; url: string }> {
		await this.ready(false);
		const entry = this.byId.get(id);
		if (!entry) throw new Error(`No registry entry ${id}`);
		if (!entry.installable) {
			throw new Error(`${entry.name} has no SKILL.md to download${entry.sourceUrl ? `. See ${entry.sourceUrl}` : ""}`);
		}
		const url = directUrl(entry) ?? (await this.resolveSkillsSh(entry));
		const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
		if (response.status === 409 && entry.source.toLowerCase() === "clawhub") {
			throw new Error(`ClawHub has more than one skill named ${entry.name}; install it from its page instead`);
		}
		if (!response.ok) throw new Error(`Download failed (${response.status}) from ${url}`);
		const text = await response.text();
		if (text.length > MAX_DOCUMENT_BYTES) throw new Error("SKILL.md is larger than 1 MB");
		if (/^\s*<(!doctype|html)/i.test(text)) throw new Error(`${url} returned a web page, not a SKILL.md`);
		const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(text);
		if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) {
			throw new Error("The downloaded SKILL.md has no description in its frontmatter");
		}
		const declared = typeof frontmatter.name === "string" ? frontmatter.name : entry.name;
		const name = declared
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "");
		if (!name) throw new Error("Could not derive a folder name for this skill");
		const root = scope === "project" ? projectSkillsDir(cwd) : userSkillsDir();
		const dir = join(root, name);
		if (relative(root, dir).includes("..")) throw new Error("Invalid skill name");
		if (existsSync(join(dir, "SKILL.md"))) throw new Error(`A skill named ${name} is already installed in ${dir}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), text);
		writeFileSync(join(dir, REGISTRY_SIDECAR), `${JSON.stringify({ id: entry.id, source: entry.source, url, installedAt: new Date().toISOString() }, null, "\t")}\n`);
		return { name, path: join(dir, "SKILL.md"), url };
	}
}
