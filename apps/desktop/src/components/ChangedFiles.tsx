import { Braces, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileCode2, FileDiff, FileText, Folder } from "lucide-react";
import { useMemo, useState } from "react";
import type { AgentMessage } from "../rpc.ts";
import { indexToolResults, isToolCall } from "../store.ts";

export interface FileChange {
	path: string;
	added: number;
	removed: number;
}

/** Counts a unified patch's added and removed lines, skipping the ---/+++ file headers. */
function patchCounts(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/**
 * Files the agent changed between two user messages, from its successful edit and write calls. Edits count the
 * lines of their patch; a write counts the lines of the file it wrote. Paths are shown relative to the working folder.
 */
export function turnChanges(messages: AgentMessage[], from: number, to: number, cwd: string): FileChange[] {
	const results = indexToolResults(messages);
	const byPath = new Map<string, FileChange>();
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	for (let index = from; index <= to; index++) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) {
			if (!isToolCall(block) || (block.name !== "edit" && block.name !== "write")) continue;
			const result = results.get(block.id);
			const raw = block.arguments.path;
			if (!result || result.isError || typeof raw !== "string") continue;
			const path = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw.replace(/^\.\//, "");
			const entry = byPath.get(path) ?? { path, added: 0, removed: 0 };
			if (block.name === "edit") {
				const patch = (result.details as { patch?: unknown } | undefined)?.patch;
				const counts = typeof patch === "string" ? patchCounts(patch) : { added: 0, removed: 0 };
				entry.added += counts.added;
				entry.removed += counts.removed;
			} else if (typeof block.arguments.content === "string") {
				// A write replaces the whole file, so it resets what earlier calls in the turn counted.
				entry.added = block.arguments.content.split("\n").length;
				entry.removed = 0;
			}
			byPath.set(path, entry);
		}
	}
	return [...byPath.values()];
}

interface Node {
	name: string;
	path: string;
	added: number;
	removed: number;
	children: Node[];
	file?: FileChange;
}

/** A folder tree with single-child folder chains joined ("functions/src"), folders first, then by name. */
function buildTree(changes: FileChange[]): Node[] {
	const root: Node = { name: "", path: "", added: 0, removed: 0, children: [] };
	for (const change of changes) {
		const parts = change.path.split("/");
		let node = root;
		parts.forEach((part, index) => {
			node.added += change.added;
			node.removed += change.removed;
			const path = parts.slice(0, index + 1).join("/");
			let child = node.children.find((entry) => entry.name === part && !entry.file === index < parts.length - 1);
			if (!child) {
				child = { name: part, path, added: 0, removed: 0, children: [] };
				node.children.push(child);
			}
			if (index === parts.length - 1) {
				child.file = change;
				child.added = change.added;
				child.removed = change.removed;
			}
			node = child;
		});
	}
	const compact = (node: Node): Node => {
		let current = node;
		while (!current.file && current.children.length === 1 && !current.children[0]!.file) {
			const only = current.children[0]!;
			current = { ...only, name: `${current.name}/${only.name}` };
		}
		const children = current.children.map(compact).sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
		return { ...current, children };
	};
	return compact(root).children;
}

function fileIcon(name: string) {
	if (/\.(json|jsonc|ya?ml|toml)$/i.test(name)) return <Braces size={13} />;
	if (/\.(md|mdx|txt|rst)$/i.test(name)) return <FileText size={13} />;
	return <FileCode2 size={13} />;
}

function Counts({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="cf-counts">
			<span className="cf-add">+{added.toLocaleString()}</span>
			<span className="cf-del">-{removed.toLocaleString()}</span>
		</span>
	);
}

const compactCount = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(value));

/** The summary under a finished turn: how many files changed, the totals, and a tree you can open files from. */
export function ChangedFilesCard({ changes, onOpenDiff, onOpenFile }: { changes: FileChange[]; onOpenDiff?: () => void; onOpenFile?: (path: string) => void }) {
	const tree = useMemo(() => buildTree(changes), [changes]);
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	const totals = changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
	const folders = useMemo(() => {
		const all: string[] = [];
		const walk = (nodes: Node[]) => {
			for (const node of nodes) {
				if (!node.file) {
					all.push(node.path);
					walk(node.children);
				}
			}
		};
		walk(tree);
		return all;
	}, [tree]);
	const allOpen = folders.length > 0 && folders.every((path) => open.has(path));

	const toggle = (path: string) =>
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	const render = (nodes: Node[], depth: number) =>
		nodes.map((node) =>
			node.file ? (
				<button key={node.path} type="button" className="cf-row file" style={{ paddingLeft: 10 + depth * 16 + 18 }} title={node.path} onClick={() => onOpenFile?.(node.path)}>
					<span className="cf-icon">{fileIcon(node.name)}</span>
					<span className="cf-name">{node.name}</span>
					<Counts added={node.added} removed={node.removed} />
				</button>
			) : (
				<div key={node.path}>
					<button type="button" className="cf-row" style={{ paddingLeft: 10 + depth * 16 }} aria-expanded={open.has(node.path)} onClick={() => toggle(node.path)}>
						<ChevronRight size={13} className={`cf-chev${open.has(node.path) ? " open" : ""}`} />
						<span className="cf-icon">
							<Folder size={13} />
						</span>
						<span className="cf-name">{node.name}</span>
						<Counts added={node.added} removed={node.removed} />
					</button>
					{open.has(node.path) && render(node.children, depth + 1)}
				</div>
			),
		);

	return (
		<div className="cf-card">
			<div className="cf-head">
				<span className="cf-title">
					{changes.length} changed file{changes.length === 1 ? "" : "s"}
				</span>
				<span className="cf-counts">
					<span className="cf-add">+{compactCount(totals.added)}</span>
					<span className="cf-del">-{compactCount(totals.removed)}</span>
				</span>
				<span className="grow" />
				{folders.length > 0 && (
					<button
						type="button"
						className="icon-btn sm"
						title={allOpen ? "Collapse all" : "Expand all"}
						aria-label={allOpen ? "Collapse all folders" : "Expand all folders"}
						onClick={() => setOpen(allOpen ? new Set() : new Set(folders))}
					>
						{allOpen ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
					</button>
				)}
				{onOpenDiff && (
					<button type="button" className="cf-open" onClick={onOpenDiff}>
						<FileDiff size={13} /> Open diff
					</button>
				)}
			</div>
			<div className="cf-tree">{render(tree, 0)}</div>
		</div>
	);
}
