import { AlertCircle, Brain, Check, ChevronRight, CornerDownRight, Hourglass, Loader, Maximize2, ShieldAlert, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";
import { duration, resultText, stringify } from "../format.ts";
import type { ThinkingContent, ToolCall, ToolResultMessage } from "../rpc.ts";
import type { ReviewIssue } from "../review.ts";
import type { RunningTool, ToolOutcome } from "../store.ts";
import { Markdown } from "./Markdown.tsx";

/** One-line summary of the most telling argument, so collapsed rows stay readable. */
function summarize(name: string, args: Record<string, unknown>): string {
	const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value) => typeof value === "string") as string | undefined;
	switch (name) {
		case "bash":
			return pick("command") ?? "";
		case "read":
		case "write":
		case "edit":
			return pick("path", "file_path") ?? "";
		case "browser_navigate":
			return pick("url") ?? "";
		case "browser_click":
			return args.ref !== undefined ? `[${String(args.ref)}]` : `${String(args.x)},${String(args.y)}`;
		case "browser_type":
			return `[${String(args.ref)}] ${JSON.stringify(pick("text") ?? "")}`;
		case "browser_press":
			return pick("key") ?? "";
		case "ssh_exec":
			return `${pick("host") ?? "?"}: ${pick("command") ?? ""}`;
		case "grep":
		case "find":
			return [pick("pattern"), pick("path")].filter(Boolean).join("  in ");
		default: {
			const first = pick("description", "prompt", "query", "path", "url", "command", "pattern", "task");
			return first ?? "";
		}
	}
}

function parsePartial(partialJson: string | undefined): Record<string, unknown> {
	if (!partialJson) return {};
	try {
		return JSON.parse(partialJson) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** The edit tool's replacements as a red/green line diff, like the TUI's edit renderer. */
function EditDiff({ args }: { args: Record<string, unknown> }) {
	const edits = Array.isArray(args.edits)
		? (args.edits as { oldText?: unknown; newText?: unknown }[])
		: typeof args.oldText === "string"
			? [{ oldText: args.oldText, newText: args.newText }]
			: [];
	if (edits.length === 0) return null;
	return (
		<div className="diff">
			{edits.map((edit, index) => (
				<div key={index} className="diff-hunk">
					{String(edit.oldText ?? "")
						.split("\n")
						.map((line, i) => (
							<div key={`o${i}`} className="diff-line del">
								<span>-</span>
								{line}
							</div>
						))}
					{String(edit.newText ?? "")
						.split("\n")
						.map((line, i) => (
							<div key={`n${i}`} className="diff-line add">
								<span>+</span>
								{line}
							</div>
						))}
				</div>
			))}
		</div>
	);
}

/** Image blocks in a tool result, e.g. browser_screenshot or an MCP tool that returns pictures. */
function resultImages(result: unknown): { data: string; mimeType: string }[] {
	const content = result && typeof result === "object" && "content" in result ? (result as { content: unknown }).content : undefined;
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is { type: "image"; data: string; mimeType: string } =>
			typeof block === "object" && block !== null && (block as { type?: string }).type === "image" && typeof (block as { data?: unknown }).data === "string",
	);
}

/** Result images as small thumbnails in the tool row; click one (or press Enter on it) to see it full size. */
function ResultImages({ images }: { images: { data: string; mimeType: string }[] }) {
	const [zoomed, setZoomed] = useState<string | null>(null);
	useEffect(() => {
		if (!zoomed) return;
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setZoomed(null);
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [zoomed]);
	if (images.length === 0) return null;
	return (
		<>
			<div className="tool-images">
				{images.map((image, index) => {
					const src = `data:${image.mimeType};base64,${image.data}`;
					return (
						<button key={index} type="button" className="tool-image" title="Open full size" onClick={() => setZoomed(src)}>
							<img src={src} alt={`Tool result ${index + 1}`} />
							<span className="tool-image-expand" aria-hidden="true">
								<Maximize2 size={12} />
							</span>
						</button>
					);
				})}
			</div>
			{zoomed && (
				<div className="modal-backdrop image-zoom" role="dialog" aria-modal="true" aria-label="Tool result, full size" onMouseDown={() => setZoomed(null)}>
					<img src={zoomed} alt="Tool result, full size" />
					<button type="button" className="icon-btn image-zoom-close" aria-label="Close" onClick={() => setZoomed(null)}>
						<X size={16} />
					</button>
				</div>
			)}
		</>
	);
}

export function ToolCallBlock({
	call,
	result,
	outcome,
	running,
	nested,
	streaming,
	awaitingApproval,
	issues,
	expanded,
}: {
	call: ToolCall;
	result?: ToolResultMessage;
	outcome?: ToolOutcome;
	running?: RunningTool;
	nested?: RunningTool[];
	streaming: boolean;
	awaitingApproval?: boolean;
	issues?: ReviewIssue[];
	/** Ctrl+O: forces every tool call open. */
	expanded?: boolean;
}) {
	const [localOpen, setOpen] = useState(false);
	const open = localOpen || Boolean(expanded);
	const args = call.partialJson !== undefined && Object.keys(call.arguments).length === 0 ? parsePartial(call.partialJson) : call.arguments;
	const isError = result?.isError ?? outcome?.isError ?? false;
	const done = result !== undefined || outcome !== undefined;
	const isRunning = !done && (running !== undefined || streaming);
	const blocked = isError && /Blocked by (SSH )?guardrail|user denied this (tool call|remote command)|denied by the user's tool permissions|user did not approve|host is read-only/i.test(result ? resultText(result) : "");
	const violation = issues?.some((issue) => issue.type === "violation");
	const output = result ? resultText(result) : outcome ? resultText(outcome.result) : running?.partial ? resultText(running.partial) : "";
	const images = resultImages(result ?? outcome?.result);
	// Images show inline only when the tool marked them for the user (browser_screenshot with show: true); others stay in the expanded body.
	const details = (result ?? (outcome?.result as { details?: unknown } | undefined))?.details;
	const showImages = typeof details === "object" && details !== null && (details as { show?: unknown }).show === true;
	const summary = summarize(call.name, args);
	const time = duration(result?.durationMs ?? outcome?.durationMs);

	return (
		<div className={`tool${open ? " open" : ""}${isError ? " errored" : ""}`}>
			<button type="button" className="tool-row" onClick={() => setOpen(!open)} aria-expanded={open}>
				<ChevronRight size={13} className="chev" />
				<Wrench size={13} />
				<span className="tool-name">{call.name || "tool"}</span>
				<span className="tool-summary">{summary}</span>
				{issues && issues.length > 0 && (
					<span className={violation ? "g-violation" : "g-warning"} title={issues.map((issue) => issue.issue).join("\n")}>
						<ShieldAlert size={13} />
					</span>
				)}
				{awaitingApproval ? (
					<span className="tool-status waiting">
						<Hourglass size={13} />
						Awaiting approval
					</span>
				) : blocked ? (
					<span className="tool-status error">
						<ShieldAlert size={13} />
						Blocked
					</span>
				) : isRunning ? (
					<span className="tool-status running">
						<Loader size={13} className="spin" />
						Running
					</span>
				) : isError ? (
					<span className="tool-status error">
						<AlertCircle size={13} />
						Error
					</span>
				) : done ? (
					<span className="tool-status done">
						<Check size={13} />
						{time}
					</span>
				) : null}
			</button>
			{showImages && <ResultImages images={images} />}
			{nested && nested.length > 0 && (
				<div className="tool-children">
					{nested.slice(-6).map((child) => (
						<div key={child.id} className="tool-child">
							<CornerDownRight size={11} />
							<span>{child.name}</span>
							<span className="tool-summary">{summarize(child.name, (child.args ?? {}) as Record<string, unknown>)}</span>
						</div>
					))}
				</div>
			)}
			{open && (
				<div className="tool-body">
					{call.argumentsError && <pre className="tool-pre error">{call.argumentsError}</pre>}
					{call.name === "edit" && <EditDiff args={args} />}
					<div>
						<div className="tool-section-label">Arguments</div>
						<pre className="tool-pre">{call.partialJson && Object.keys(call.arguments).length === 0 ? call.partialJson : stringify(args)}</pre>
					</div>
					{output && (
						<div>
							<div className="tool-section-label">Result</div>
							<pre className={`tool-pre${isError ? " error" : ""}`}>{output}</pre>
						</div>
					)}
					{!showImages && <ResultImages images={images} />}
				</div>
			)}
		</div>
	);
}

export function Reasoning({ block, live }: { block: ThinkingContent; live: boolean }) {
	const [open, setOpen] = useState(false);
	if (block.redacted) return null;
	return (
		<div className="reasoning">
			<button type="button" className={`reasoning-toggle${live ? " live" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
				<Brain size={13} />
				<span>{live ? "Thinking" : "Thought"}</span>
				<ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform .15s" }} />
			</button>
			{open && (
				<div className="reasoning-body">
					<Markdown text={block.thinking} />
				</div>
			)}
		</div>
	);
}
