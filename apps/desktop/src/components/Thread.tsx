import { AlertCircle, BarChart3, Pencil, RotateCcw, Square, Terminal, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { parseElements } from "../element.ts";
import { compactNumber, duration } from "../format.ts";
import type { AgentMessage, AssistantMessage, ImageContent, TextContent } from "../rpc.ts";
import { type SorvexActions, indexToolResults, isToolCall, type State } from "../store.ts";
import { ChangedFilesCard, type FileChange, turnChanges } from "./ChangedFiles.tsx";
import { GuardrailResults } from "./Harness.tsx";
import { PendingReply } from "./PendingReply.tsx";
import { ElementChip } from "./ElementChip.tsx";
import { CopyButton, Markdown } from "./Markdown.tsx";
import { Reasoning, ToolCallBlock } from "./ToolCall.tsx";

function contentText(content: string | (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function contentImages(content: string | (TextContent | ImageContent)[]): ImageContent[] {
	return typeof content === "string" ? [] : content.filter((block): block is ImageContent => block.type === "image");
}

function Stats({ message }: { message: AssistantMessage }) {
	const usage = message.usage;
	const lines = [
		`model  ${message.provider}/${message.model}`,
		usage ? `in     ${compactNumber(usage.input)} (+${compactNumber(usage.cacheRead)} cached)` : "",
		usage ? `out    ${compactNumber(usage.output)}` : "",
		usage && usage.cost.total > 0 ? `cost   $${usage.cost.total.toFixed(4)}` : "",
		message.durationMs !== undefined ? `time   ${duration(message.durationMs)}` : "",
		`stop   ${message.stopReason}`,
	].filter(Boolean);
	return (
		<span className="stats" tabIndex={0}>
			<BarChart3 size={12} />
			<span className="stats-tip">{lines.join("\n")}</span>
		</span>
	);
}

function AssistantView({ message, state, actions, live }: { message: AssistantMessage; state: State; actions: SorvexActions; live: boolean }) {
	const results = useMemo(() => indexToolResults(state.messages), [state.messages]);
	const text = message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
	const lastIndex = message.content.length - 1;
	const reviews = state.reviews[message.timestamp];
	const reviewIssues = Object.values(reviews ?? {}).flatMap((result) => (result.status === "done" ? result.issues : []));
	const pendingIds = new Set(state.approvals.map((approval) => approval.toolCallId));

	return (
		<div className="msg-group">
			<div className="msg-assistant">
				{message.content.map((block, index) => {
					if (block.type === "text") return block.text ? <Markdown key={index} text={block.text} /> : null;
					if (block.type === "thinking") return state.hideThinking ? null : <Reasoning key={index} block={block} live={live && index === lastIndex} />;
					if (isToolCall(block)) {
						return (
							<ToolCallBlock
								key={block.id || index}
								call={block}
								result={results.get(block.id)}
								outcome={state.outcomes[block.id]}
								running={state.running[block.id]}
								nested={state.children[block.id]}
								streaming={state.isStreaming && (live || message.stopReason === "toolUse")}
								awaitingApproval={pendingIds.has(block.id)}
								issues={reviewIssues.filter((issue) => issue.toolCallId === block.id)}
								expanded={state.expandTools}
							/>
						);
					}
					return null;
				})}
				{message.stopReason === "error" && message.errorMessage && (
					<div className="msg-error">
						<AlertCircle size={15} style={{ flexShrink: 0, marginTop: 2 }} />
						<span>{message.errorMessage}</span>
					</div>
				)}
				{message.stopReason === "aborted" && <div className="msg-divider">Stopped</div>}
			</div>
			{reviews && <GuardrailResults results={reviews} onAnnotate={actions.addAnnotation} />}
			{!live && (
				<div className="msg-meta">
					{text && <CopyButton text={text} size={12} />}
					{text && (
						<button
							type="button"
							className="icon-btn sm"
							aria-label={state.voice.speaking ? "Stop reading" : "Read aloud"}
							title={state.voice.speaking ? "Stop reading" : "Read aloud"}
							onClick={() => (state.voice.speaking ? actions.stopSpeaking() : actions.speak(text))}
						>
							{state.voice.speaking ? <Square size={11} /> : <Volume2 size={13} />}
						</button>
					)}
					<Stats message={message} />
					<span>{message.model}</span>
					{message.usage && <span>{compactNumber(message.usage.totalTokens)} tokens</span>}
				</div>
			)}
		</div>
	);
}

function UserView({ message, userIndex, state, actions }: { message: Extract<AgentMessage, { role: "user" }>; userIndex: number; state: State; actions: SorvexActions }) {
	const busy = state.isStreaming || state.connection !== "ready";
	// Browser pane elements are sent as <element> blocks with their screenshots first; show them as chips again.
	const { elements, rest } = parseElements(contentText(message.content));
	const images = [...contentImages(message.content)];
	const chips = elements.map(({ element }) => ({ element, image: element.hasScreenshot ? images.shift()?.data : undefined }));
	return (
		<div className="msg-group user">
			{chips.length > 0 && (
				<div className="msg-elements">
					{chips.map((chip, index) => (
						<ElementChip key={index} element={chip.element} image={chip.image} align="right" />
					))}
				</div>
			)}
			{(rest || images.length > 0) && (
				<div className="msg-user">
					{rest}
					{images.map((image, index) => (
						<img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt="" />
					))}
				</div>
			)}
			<div className="msg-meta right">
				<CopyButton text={rest} size={12} />
				<button type="button" className="icon-btn sm" title="Edit (branches the session here)" aria-label="Edit message" disabled={busy} onClick={() => void actions.editMessage(userIndex)}>
					<Pencil size={12} />
				</button>
				<button type="button" className="icon-btn sm" title="Retry from here (branches the session)" aria-label="Retry" disabled={busy} onClick={() => void actions.regenerate(userIndex)}>
					<RotateCcw size={12} />
				</button>
			</div>
		</div>
	);
}

function MessageView({ message, userIndex, state, actions, live }: { message: AgentMessage; userIndex: number; state: State; actions: SorvexActions; live: boolean }) {
	switch (message.role) {
		case "user":
			return <UserView message={message} userIndex={userIndex} state={state} actions={actions} />;
		case "assistant":
			return <AssistantView message={message} state={state} actions={actions} live={live} />;
		case "bashExecution":
			return (
				<div className="tool open">
					<div className="tool-row">
						<Terminal size={13} />
						<span className="tool-name">$</span>
						<span className="tool-summary">{message.command}</span>
						<span className={`tool-status ${message.exitCode ? "error" : "done"}`}>exit {message.exitCode ?? "?"}</span>
					</div>
					{message.output && (
						<div className="tool-body">
							<pre className="tool-pre">{message.output}</pre>
						</div>
					)}
				</div>
			);
		case "custom":
			return message.display ? (
				<div className="msg-assistant">
					<Markdown text={contentText(message.content)} />
				</div>
			) : null;
		case "compactionSummary":
			return <div className="msg-divider compaction">Compaction</div>;
		case "branchSummary":
			return <div className="msg-divider">Branch summary</div>;
		default:
			return null;
	}
}

const SUGGESTIONS = [
	{ title: "Explain this codebase", hint: "packages and entry points", prompt: "Give me a tour of this codebase: the main packages, entry points, and how they fit together." },
	{ title: "Find a bug in recent changes", hint: "reads the git history", prompt: "Look through the recent changes in this repo and point out anything that looks like a bug." },
	{ title: "Plan a change", hint: "switches to plan mode", prompt: "/mode plan" },
	{ title: "Run a security review", hint: "switches to security mode", prompt: "/mode security" },
];

/** Changed files per finished turn, keyed by the index of the turn's last assistant message. */
function useTurnChanges(state: State): Map<number, FileChange[]> {
	const { messages, isStreaming, cwd } = state;
	return useMemo(() => {
		const byEnd = new Map<number, FileChange[]>();
		let start = -1;
		let lastAssistant = -1;
		const close = (end: number, finished: boolean) => {
			if (start < 0 || lastAssistant < 0 || !finished) return;
			const changes = turnChanges(messages, start, end, cwd);
			if (changes.length > 0) byEnd.set(lastAssistant, changes);
		};
		messages.forEach((message, index) => {
			if (message.role === "user") {
				close(index - 1, true);
				start = index;
				lastAssistant = -1;
			} else if (message.role === "assistant") {
				lastAssistant = index;
			}
		});
		close(messages.length - 1, !isStreaming);
		return byEnd;
	}, [messages, isStreaming, cwd]);
}

export function Thread({
	state,
	actions,
	onOpenDiff,
	onOpenFile,
}: {
	state: State;
	actions: SorvexActions;
	onOpenDiff?: () => void;
	onOpenFile?: (path: string) => void;
}) {
	const changesByTurn = useTurnChanges(state);
	const viewportRef = useRef<HTMLDivElement>(null);
	const pinnedRef = useRef(true);

	// Follow new output only while the user is already at the bottom.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (viewport && pinnedRef.current) viewport.scrollTop = viewport.scrollHeight;
	});

	const lastAssistant = state.streamingIndex !== null ? state.messages[state.streamingIndex] : undefined;
	// A reply is pending but shows nothing yet: before it starts, or started but still empty (local models open the
	// reply at once, then read the whole prompt before the first word).
	const shown =
		lastAssistant?.role === "assistant" &&
		lastAssistant.content.some((block) => (block.type === "text" && block.text.trim()) || (block.type === "thinking" && block.thinking.trim()) || block.type === "toolCall");
	const waiting = state.isStreaming && !shown && Object.keys(state.running).length === 0 && state.approvals.length === 0;
	const visible = state.messages.some((message) => message.role !== "toolResult" && message.role !== "system");
	let userCount = -1;

	return (
		<div
			className="viewport"
			ref={viewportRef}
			onScroll={(event) => {
				const el = event.currentTarget;
				pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
			}}
		>
			{!visible && state.connection === "ready" ? (
				<div className="welcome">
					<h1>What should we work on in {state.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? state.cwd}?</h1>
					<p className="cwd">{state.cwd}</p>
					<div className="suggestions">
						{SUGGESTIONS.map((suggestion) => (
							<button key={suggestion.title} type="button" className="suggestion" onClick={() => void actions.send(suggestion.prompt, false)}>
								{suggestion.title}
								<small>{suggestion.hint}</small>
							</button>
						))}
					</div>
				</div>
			) : (
				<div className="messages">
					{state.messages.map((message, index) => {
						if (message.role === "toolResult" || message.role === "system") return null;
						if (message.role === "user") userCount++;
						const changes = changesByTurn.get(index);
						return (
							<div key={`${message.timestamp}-${index}`} data-msg-index={index}>
								<MessageView message={message} userIndex={userCount} state={state} actions={actions} live={message === lastAssistant} />
								{changes && <ChangedFilesCard changes={changes} onOpenDiff={onOpenDiff} onOpenFile={onOpenFile} />}
							</div>
						);
					})}
					{waiting && (
						// Keyed by where the reply will appear, so the timer runs from the request, not from the empty reply.
						<PendingReply key={state.streamingIndex ?? state.messages.length} provider={state.session?.model?.provider} />
					)}
					{state.isCompacting && <div className="msg-divider compaction dots">Compacting context</div>}
				</div>
			)}
		</div>
	);
}
