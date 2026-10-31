import { ChevronRight, FileText, Loader2, RotateCw, SquareArrowOutUpRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { type Hunk, parseDiff } from "../diff.ts";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";
import { Select } from "./Select.tsx";

interface ChangedFile {
	path: string;
	oldPath?: string;
	status: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

interface Summary {
	branch: string;
	base: string;
	bases: string[];
	files: ChangedFile[];
}

/** Above this, files start collapsed and the user opens the ones they want. */
const AUTO_EXPAND = { files: 8, lines: 1500 };
/** Lines rendered for one file before asking, so a lockfile diff does not freeze the window. */
const RENDER_LIMIT = 3000;

const STATUS: Record<string, string> = { A: "Added", D: "Deleted", R: "Renamed", C: "Copied", "?": "Untracked", M: "Modified" };

function splitPath(path: string): { name: string; dir: string } {
	const index = path.lastIndexOf("/");
	return index === -1 ? { name: path, dir: "" } : { name: path.slice(index + 1), dir: path.slice(0, index) };
}

/** One file's diff, loaded when it is first expanded. "N unmodified lines" rows load the full file as context. */
function FileDiff({ base, file }: { base: string; file: ChangedFile }) {
	const [hunks, setHunks] = useState<Hunk[] | null>(null);
	const [binary, setBinary] = useState(false);
	const [full, setFull] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showAll, setShowAll] = useState(false);

	useEffect(() => {
		let cancelled = false;
		api<{ diff: string }>("POST", "/api/git/diff", { base, file, full }).then(
			({ diff }) => {
				if (cancelled) return;
				const parsed = parseDiff(diff);
				setHunks(parsed.hunks);
				setBinary(parsed.binary);
			},
			(reason: unknown) => !cancelled && setError(reason instanceof Error ? reason.message : String(reason)),
		);
		return () => {
			cancelled = true;
		};
	}, [base, file, full]);

	if (error) return <div className="diff-note error">{error}</div>;
	if (!hunks) {
		return (
			<div className="diff-note">
				<Loader2 size={13} className="spin" /> Loading diff
			</div>
		);
	}
	if (binary || file.binary) return <div className="diff-note">Binary file, not shown</div>;
	if (hunks.length === 0) return <div className="diff-note">No content changes</div>;

	const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	let budget = showAll ? Number.POSITIVE_INFINITY : RENDER_LIMIT;
	const gap = (count: number, key: string) =>
		count > 0 && !full ? (
			<tr key={key} className="diff-gap">
				<td colSpan={3}>
					<button type="button" onClick={() => setFull(true)}>
						<ChevronRight size={12} /> {count} unmodified {count === 1 ? "line" : "lines"}
					</button>
				</td>
			</tr>
		) : null;

	return (
		<div className="diff-scroll">
			<table className="diff-table">
				<tbody>
					{hunks.map((hunk, index) => {
						const previous = hunks[index - 1];
						const before = previous ? hunk.newStart - (previous.newStart + previous.newLines) : hunk.newStart - 1;
						const lines = budget > 0 ? hunk.lines.slice(0, budget) : [];
						budget -= lines.length;
						return (
							<Fragment key={`${hunk.oldStart}-${hunk.newStart}`}>
								{gap(before, `gap-${index}`)}
								{lines.map((line, row) => (
									<tr key={row} className={`diff-line ${line.kind}`}>
										<td className="diff-num">{line.old ?? ""}</td>
										<td className="diff-num">{line.new ?? ""}</td>
										<td className="diff-text">{line.text || " "}</td>
									</tr>
								))}
							</Fragment>
						);
					})}
				</tbody>
			</table>
			{!full && (
				<button type="button" className="diff-full" onClick={() => setFull(true)}>
					Show full file
				</button>
			)}
			{total > RENDER_LIMIT && !showAll && (
				<div className="diff-note">
					Showing {RENDER_LIMIT.toLocaleString()} of {total.toLocaleString()} lines.{" "}
					<button type="button" className="link-btn" onClick={() => setShowAll(true)}>
						Show all
					</button>
				</div>
			)}
		</div>
	);
}

/**
 * The Changes pane: what changed on this branch since its base (all of it: committed, staged, unstaged and
 * untracked), or only uncommitted changes. Each file expands to a unified diff with old and new line numbers.
 */
export function ChangesPane({
	refreshKey,
	expanded,
	width,
	onResize,
	onToggleExpand,
	onClose,
	onOpenFile,
}: {
	/** Changes when the agent may have edited files, to refresh the list. */
	refreshKey: number;
	expanded: boolean;
	width: number;
	onResize: (width: number) => void;
	onToggleExpand: () => void;
	onClose: () => void;
	onOpenFile: (path: string) => void;
}) {
	const [summary, setSummary] = useState<Summary | null>(null);
	const [base, setBase] = useState<string | undefined>();
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const next = await api<Summary>("POST", "/api/git/changes", { base });
			setSummary(next);
			setError(null);
			const lines = next.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
			if (next.files.length <= AUTO_EXPAND.files && lines <= AUTO_EXPAND.lines) setOpen(new Set(next.files.map((file) => file.path)));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoading(false);
		}
	}, [base]);

	useEffect(() => {
		void load();
	}, [load, refreshKey]);

	const files = summary?.files ?? [];
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
	const collapsedForSize = files.length > AUTO_EXPAND.files || additions + deletions > AUTO_EXPAND.lines;
	const toggle = (path: string) =>
		setOpen((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize}>
			<PaneHeader
				expanded={expanded}
				onToggleExpand={onToggleExpand}
				onClose={onClose}
				actions={
					<button type="button" className="icon-btn sm" aria-label="Refresh changes" title="Refresh" onClick={() => void load()}>
						{loading ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
					</button>
				}
			>
				{summary && (
					<Select
						ariaLabel="Compare against"
						width={240}
						value={summary.base}
						options={summary.bases.map((name) => ({
							value: name,
							label: name === "HEAD" ? "Uncommitted changes" : `${name} → ${summary.branch}`,
						}))}
						onChange={(value) => {
							setOpen(new Set());
							setBase(value);
						}}
					/>
				)}
			</PaneHeader>
			<div className="pane-body changes-body">
				{error && <div className="diff-note error">{error}</div>}
				{summary && files.length === 0 && <div className="empty-note">No changes</div>}
				{files.length > 0 && (
					<div className="changes-summary">
						{files.length} {files.length === 1 ? "file" : "files"} changed
						<span className="diff-add">+{additions.toLocaleString()}</span>
						<span className="diff-del">-{deletions.toLocaleString()}</span>
					</div>
				)}
				{collapsedForSize && <div className="changes-note">Files are collapsed for large diffs. Select a file to expand it.</div>}
				{files.map((file) => {
					const { name, dir } = splitPath(file.path);
					const isOpen = open.has(file.path);
					return (
						<div key={file.path} className={`change-file${isOpen ? " open" : ""}`}>
							<div className="change-row">
								<button type="button" className="change-toggle" onClick={() => toggle(file.path)} aria-expanded={isOpen} title={`${STATUS[file.status] ?? "Modified"}: ${file.oldPath ? `${file.oldPath} → ` : ""}${file.path}`}>
									<ChevronRight size={13} className="chev" />
									<FileText size={13} />
									<span className="change-name">{name}</span>
									{dir && <span className="change-dir">{dir}</span>}
									{file.status !== "M" && <span className={`change-status s-${file.status === "?" ? "u" : file.status.toLowerCase()}`}>{STATUS[file.status] ?? file.status}</span>}
									<span className="grow" />
									{file.binary ? (
										<span className="change-dir">binary</span>
									) : (
										<>
											{file.additions > 0 && <span className="diff-add">+{file.additions}</span>}
											{file.deletions > 0 && <span className="diff-del">-{file.deletions}</span>}
										</>
									)}
								</button>
								{file.status !== "D" && (
									<button type="button" className="icon-btn sm" aria-label={`Open ${file.path}`} title="Open in Files" onClick={() => onOpenFile(file.path)}>
										<SquareArrowOutUpRight size={13} />
									</button>
								)}
							</div>
							{isOpen && summary && <FileDiff base={summary.base} file={file} />}
						</div>
					);
				})}
			</div>
		</PaneFrame>
	);
}
