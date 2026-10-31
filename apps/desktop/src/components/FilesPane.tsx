import { ChevronRight, FileText, Folder, FolderOpen, ListTree, Loader2, Search, TextWrap, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { api } from "../api.ts";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";

interface Entry {
	name: string;
	path: string;
	dir: boolean;
}

interface OpenFile {
	path: string;
	content: string;
	size: number;
	binary: boolean;
	truncated: boolean;
}

/** File extension to highlight.js language. Unknown ones render as plain text. */
const LANGUAGES: Record<string, string> = {
	ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
	js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
	json: "json", md: "markdown", css: "css", scss: "scss", html: "xml", xml: "xml", svg: "xml",
	rs: "rust", py: "python", sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
	go: "go", java: "java", kt: "kotlin", c: "c", h: "c", cpp: "cpp", hpp: "cpp", rb: "ruby", php: "php", sql: "sql",
	swift: "swift", lua: "lua", diff: "diff", nix: "nix", ps1: "powershell", bat: "dos",
};
/** Larger files skip syntax highlighting, which is slow on big inputs. */
const HIGHLIGHT_LIMIT = 300 * 1024;

function language(path: string): string {
	const name = path.split("/").pop() ?? path;
	if (/^dockerfile$/i.test(name)) return "dockerfile";
	return LANGUAGES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
}

interface HastText {
	type: "text";
	value: string;
}
interface HastElement {
	type: "element";
	tagName: string;
	properties: Record<string, unknown>;
	children: HastChild[];
}
type HastChild = HastText | HastElement;

/** Splits highlighted nodes at newlines; a token span that crosses a line break is cloned onto each line. */
function splitLines(children: HastChild[]): HastChild[][] {
	const lines: HastChild[][] = [[]];
	for (const child of children) {
		const parts: HastChild[][] =
			child.type === "text"
				? child.value.split("\n").map((value) => (value ? [{ type: "text", value }] : []))
				: child.type === "element"
					? splitLines(child.children).map((part) => (part.length ? [{ ...child, children: part }] : []))
					: [];
		parts.forEach((part, index) => {
			if (index > 0) lines.push([]);
			lines.at(-1)!.push(...part);
		});
	}
	return lines;
}

function lineElement(number: number, content: HastChild[], current: boolean): HastElement {
	const span = (className: string, children: HastChild[]): HastElement => ({ type: "element", tagName: "span", properties: { className: [className] }, children });
	return {
		type: "element",
		tagName: "span",
		properties: { className: current ? ["code-line", "current"] : ["code-line"], dataLine: number },
		children: [span("code-ln", [{ type: "text", value: String(number) }]), span("code-lc", content.length ? content : [{ type: "text", value: " " }])],
	};
}

/**
 * Rehype plugin, run after highlighting: wraps each source line in its own row with its line number, so long lines
 * can wrap without the numbers drifting out of line with the code.
 */
function rehypeCodeLines(options: { current?: number }) {
	return (tree: { type: string }) => {
		const find = (node: { children?: unknown[] }): HastElement | undefined => {
			for (const child of (node.children ?? []) as HastChild[]) {
				if (child.type !== "element") continue;
				if (child.tagName === "code") return child;
				const found = find(child);
				if (found) return found;
			}
			return undefined;
		};
		const code = find(tree as { children?: unknown[] });
		if (!code) return;
		const lines = splitLines(code.children);
		// The code block's own trailing newline adds an empty last line.
		if (lines.length > 1 && lines.at(-1)!.length === 0) lines.pop();
		code.children = lines.map((line, index) => lineElement(index + 1, line, index + 1 === options.current));
	};
}

/** Code with line numbers, optionally wrapped. Highlighting reuses the chat's rehype-highlight through a fenced block. */
function CodeView({ file, line, wrap }: { file: OpenFile; line?: number; wrap: boolean }) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const lines = file.content.split("\n");
	const fence = "`".repeat(Math.max(3, ...[...file.content.matchAll(/`+/g)].map((match) => match[0].length + 1)));
	const highlighted = file.content.length <= HIGHLIGHT_LIMIT;

	useEffect(() => {
		if (line) scrollRef.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
	}, [line]);

	if (file.binary) return <div className="empty-note">Binary file, not shown ({file.size.toLocaleString()} bytes)</div>;
	return (
		<div ref={scrollRef} className={`code-view${wrap ? " wrap" : ""}`} style={{ "--ln-width": `${String(lines.length).length + 3}ch` } as CSSProperties}>
			{highlighted ? (
				<ReactMarkdown
					rehypePlugins={[
						[rehypeHighlight, { detect: false }],
						[rehypeCodeLines, { current: line }],
					]}
					components={{ pre: ({ children }) => <pre className="code-lines">{children}</pre> }}
				>
					{`${fence}${language(file.path)}\n${file.content}\n${fence}`}
				</ReactMarkdown>
			) : (
				<pre className="code-lines">
					<code>
						{lines.map((text, index) => (
							<span key={index} className={`code-line${index + 1 === line ? " current" : ""}`} data-line={index + 1}>
								<span className="code-ln">{index + 1}</span>
								<span className="code-lc">{text || " "}</span>
							</span>
						))}
					</code>
				</pre>
			)}
			{file.truncated && <div className="diff-note">Showing the first 1 MB of {file.size.toLocaleString()} bytes</div>}
		</div>
	);
}

function TreeNode({
	entry,
	depth,
	children,
	expanded,
	active,
	onToggle,
	onOpen,
}: {
	entry: Entry;
	depth: number;
	children: Record<string, Entry[] | undefined>;
	expanded: Set<string>;
	active?: string;
	onToggle: (path: string) => void;
	onOpen: (path: string) => void;
}) {
	const isOpen = expanded.has(entry.path);
	const kids = children[entry.path];
	return (
		<>
			<button
				type="button"
				className={`tree-row${active === entry.path ? " active" : ""}`}
				style={{ paddingLeft: 8 + depth * 14 }}
				title={entry.path}
				onClick={() => (entry.dir ? onToggle(entry.path) : onOpen(entry.path))}
			>
				{entry.dir ? <ChevronRight size={12} className={`chev${isOpen ? " open" : ""}`} /> : <span className="tree-spacer" />}
				{entry.dir ? isOpen ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileText size={14} />}
				<span>{entry.name}</span>
			</button>
			{entry.dir && isOpen && !kids && (
				<div className="tree-row muted" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
					<Loader2 size={12} className="spin" />
				</div>
			)}
			{entry.dir &&
				isOpen &&
				kids?.map((child) => (
					<TreeNode key={child.path} entry={child} depth={depth + 1} children={children} expanded={expanded} active={active} onToggle={onToggle} onOpen={onOpen} />
				))}
		</>
	);
}

/**
 * The Files pane: the working directory as a tree, a filter (or "?" to search inside files), and open files as tabs
 * with syntax highlighting and line numbers.
 */
export function FilesPane({
	target,
	refreshKey,
	hidden,
	expanded,
	width,
	onResize,
	onToggleExpand,
	onClose,
	toast,
}: {
	/** A file to open, e.g. from the Changes pane. */
	target: { path: string; line?: number; nonce: number } | null;
	refreshKey: number;
	hidden: boolean;
	expanded: boolean;
	width: number;
	onResize: (width: number) => void;
	onToggleExpand: () => void;
	onClose: () => void;
	toast: (kind: "error", text: string) => void;
}) {
	const [children, setChildren] = useState<Record<string, Entry[] | undefined>>({});
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const [tabs, setTabs] = useState<OpenFile[]>([]);
	const [active, setActive] = useState<string | undefined>();
	const [line, setLine] = useState<number | undefined>();
	const [treeOpen, setTreeOpen] = useState(true);
	const [wrap, setWrap] = useState(() => {
		try {
			return localStorage.getItem("filesWrap") !== "0";
		} catch {
			return true;
		}
	});
	const toggleWrap = () => {
		setWrap(!wrap);
		try {
			localStorage.setItem("filesWrap", wrap ? "0" : "1");
		} catch {}
	};
	const [filter, setFilter] = useState("");
	const [allFiles, setAllFiles] = useState<string[] | null>(null);
	const [results, setResults] = useState<{ path: string; line: number; text: string }[] | null>(null);
	const filterRef = useRef<HTMLInputElement>(null);

	const loadDir = useCallback(
		async (path: string) => {
			try {
				const { entries } = await api<{ entries: Entry[] }>("POST", "/api/fs/list", { path });
				setChildren((current) => ({ ...current, [path]: entries }));
			} catch (error) {
				toast("error", error instanceof Error ? error.message : String(error));
			}
		},
		[toast],
	);

	// Reload the root and every open folder when the agent may have changed files.
	useEffect(() => {
		void loadDir("");
		for (const path of expandedDirs) void loadDir(path);
		setAllFiles(null);
		// Deliberately not keyed on expandedDirs: opening a folder loads just that folder.
	}, [refreshKey, loadDir]);

	const openFile = useCallback(
		async (path: string, at?: number) => {
			setLine(at);
			setActive(path);
			try {
				const file = await api<OpenFile>("POST", "/api/fs/read", { path });
				setTabs((current) => (current.some((tab) => tab.path === path) ? current.map((tab) => (tab.path === path ? file : tab)) : [...current, file]));
			} catch (error) {
				toast("error", error instanceof Error ? error.message : String(error));
			}
		},
		[toast],
	);

	useEffect(() => {
		if (target) void openFile(target.path, target.line);
	}, [target, openFile]);

	// Plain text filters file names; "?text" searches file contents.
	const searching = filter.startsWith("?");
	useEffect(() => {
		if (!filter) return setResults(null);
		if (!searching) {
			if (!allFiles) void api<{ files: string[] }>("GET", "/api/files").then(({ files }) => setAllFiles(files), () => setAllFiles([]));
			return;
		}
		const timer = setTimeout(() => {
			void api<{ results: { path: string; line: number; text: string }[] }>("POST", "/api/fs/search", { query: filter.slice(1) }).then(({ results }) => setResults(results), () => setResults([]));
		}, 250);
		return () => clearTimeout(timer);
	}, [filter, searching, allFiles]);

	const nameMatches = useMemo(() => {
		if (!filter || searching || !allFiles) return [];
		const query = filter.toLowerCase();
		return allFiles.filter((path) => path.toLowerCase().includes(query)).slice(0, 300);
	}, [filter, searching, allFiles]);

	const toggleDir = (path: string) =>
		setExpandedDirs((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else {
				next.add(path);
				if (!children[path]) void loadDir(path);
			}
			return next;
		});

	const closeTab = (path: string) => {
		const index = tabs.findIndex((tab) => tab.path === path);
		const next = tabs.filter((tab) => tab.path !== path);
		setTabs(next);
		if (active === path) setActive(next[Math.min(index, next.length - 1)]?.path);
	};

	const current = tabs.find((tab) => tab.path === active);

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize} hidden={hidden}>
			<PaneHeader
				expanded={expanded}
				onToggleExpand={onToggleExpand}
				onClose={onClose}
				actions={
					<>
						<button
							type="button"
							className="icon-btn sm"
							aria-label="Search files"
							title="Filter files, or ? to search in files"
							onClick={() => {
								setTreeOpen(true);
								requestAnimationFrame(() => filterRef.current?.focus());
							}}
						>
							<Search size={14} />
						</button>
						<button type="button" className={`icon-btn sm${wrap ? " active" : ""}`} aria-label="Toggle word wrap" aria-pressed={wrap} title="Word wrap" onClick={toggleWrap}>
							<TextWrap size={15} />
						</button>
						<button type="button" className={`icon-btn sm${treeOpen ? " active" : ""}`} aria-label="Toggle file tree" title="File tree" onClick={() => setTreeOpen(!treeOpen)}>
							<ListTree size={15} />
						</button>
					</>
				}
			>
				<div className="file-tabs">
					{tabs.map((tab) => (
						<div key={tab.path} className={`file-tab${tab.path === active ? " active" : ""}`} title={tab.path}>
							<button type="button" className="file-tab-main" onClick={() => setActive(tab.path)}>
								{tab.path.split("/").pop()}
							</button>
							<button type="button" className="file-tab-close" aria-label={`Close ${tab.path}`} onClick={() => closeTab(tab.path)}>
								<X size={12} />
							</button>
						</div>
					))}
				</div>
			</PaneHeader>
			<div className="pane-body files-body">
				<div className="files-viewer">
					{current ? (
						<>
							<div className="files-path">{current.path}</div>
							<CodeView key={current.path} file={current} line={line} wrap={wrap} />
						</>
					) : (
						<div className="empty-note">Select a file to view it.</div>
					)}
				</div>
				{treeOpen && (
					<div className="files-tree">
						<input
							ref={filterRef}
							className="files-filter"
							value={filter}
							placeholder="Filter, or ? to search in files"
							spellCheck={false}
							onChange={(event) => setFilter(event.target.value)}
							onKeyDown={(event) => event.key === "Escape" && setFilter("")}
						/>
						<div className="files-list">
							{!filter &&
								children[""]?.map((entry) => (
									<TreeNode key={entry.path} entry={entry} depth={0} children={children} expanded={expandedDirs} active={active} onToggle={toggleDir} onOpen={(path) => void openFile(path)} />
								))}
							{filter && !searching && (
								<>
									{!allFiles && <Loader2 size={13} className="spin" />}
									{nameMatches.map((path) => (
										<button key={path} type="button" className={`tree-row result${active === path ? " active" : ""}`} title={path} onClick={() => void openFile(path)}>
											<FileText size={14} />
											<span>{path}</span>
										</button>
									))}
									{allFiles && nameMatches.length === 0 && <div className="empty-note">No matching files</div>}
								</>
							)}
							{searching &&
								results?.map((result) => (
									<button key={`${result.path}:${result.line}`} type="button" className="tree-row result search" title={`${result.path}:${result.line}`} onClick={() => void openFile(result.path, result.line)}>
										<span className="search-path">
											{result.path}:{result.line}
										</span>
										<span className="search-text">{result.text}</span>
									</button>
								))}
							{searching && results?.length === 0 && filter.length > 1 && <div className="empty-note">No matches</div>}
						</div>
					</div>
				)}
			</div>
		</PaneFrame>
	);
}
