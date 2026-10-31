import { Check, ChevronDown, Clock, Lock, MessageSquareQuote, Pencil, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { stringify } from "../format.ts";
import type { Annotation, Approval, SorvexActions, ReviewResult } from "../store.ts";

/** Tool calls waiting for approval, shown above the composer like warpdrv's pending tool calls box. */
export function PendingApprovals({ approvals, actions }: { approvals: Approval[]; actions: SorvexActions }) {
	if (approvals.length === 0) return null;
	const answer = (approval: Approval, value: string) =>
		void actions.answerDialog({ type: "extension_ui_response", id: approval.requestId, value });
	return (
		<div className="pending-box">
			<div className="pending-head">
				<ShieldAlert size={14} />
				Tool calls ({approvals.length} pending)
			</div>
			{approvals.map((approval) => {
				const command = typeof approval.input.command === "string" ? approval.input.command : undefined;
				const path = typeof approval.input.path === "string" ? approval.input.path : undefined;
				return (
					<div key={approval.requestId} className="pending-item">
						<div className="pending-title">
							<span className="tool-name">{approval.toolName}</span>
							{approval.reason && <span className="pending-reason">{approval.reason}</span>}
						</div>
						{typeof approval.input.host === "string" && <div className="pending-reason">on server {approval.input.host}</div>}
						<pre className="tool-pre">{command ?? path ?? stringify(approval.input)}</pre>
						<div className="pending-actions">
							{approval.options.includes("Allow once") && (
								<button type="button" className="approve once" onClick={() => answer(approval, "Allow once")}>
									<Check size={12} /> Allow once
								</button>
							)}
							{approval.options.includes("Allow for this session") && (
								<button
									type="button"
									className="approve session"
									title="Allow this kind of action without asking until you start a new chat, switch sessions, or restart"
									onClick={() => answer(approval, "Allow for this session")}
								>
									<Clock size={12} /> Allow for this session
								</button>
							)}
							{approval.options.includes("Allow always") && (
								<button type="button" className="approve always" onClick={() => answer(approval, "Allow always")}>
									<Lock size={12} /> Allow always
								</button>
							)}
							<button type="button" className="approve deny" onClick={() => answer(approval, "Deny")}>
								<X size={12} /> Deny
							</button>
						</div>
					</div>
				);
			})}
		</div>
	);
}

/** Selected quotes with comments that get prepended to the next message. */
export function AnnotationsBox({ annotations, actions }: { annotations: Annotation[]; actions: SorvexActions }) {
	const [editing, setEditing] = useState<number | null>(null);
	if (annotations.length === 0) return null;
	return (
		<div className="annotations-box">
			<div className="pending-head">
				<MessageSquareQuote size={14} />
				Annotations ({annotations.length}) · sent with your next message
				<span className="grow" />
				<button type="button" className="icon-btn sm" aria-label="Clear annotations" onClick={actions.clearAnnotations}>
					<Trash2 size={12} />
				</button>
			</div>
			{annotations.map((annotation) => (
				<div key={annotation.id} className="annotation">
					<div className="annotation-quote">“{annotation.quote}”</div>
					{editing === annotation.id ? (
						<input
							className="modal-input"
							autoFocus
							defaultValue={annotation.comment}
							onBlur={(event) => {
								actions.updateAnnotation(annotation.id, event.target.value);
								setEditing(null);
							}}
							onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
						/>
					) : (
						<div className="annotation-comment">{annotation.comment || <em>No comment</em>}</div>
					)}
					<div className="annotation-actions">
						<button type="button" className="icon-btn sm" aria-label="Edit comment" onClick={() => setEditing(annotation.id)}>
							<Pencil size={12} />
						</button>
						<button type="button" className="icon-btn sm" aria-label="Remove annotation" onClick={() => actions.removeAnnotation(annotation.id)}>
							<X size={12} />
						</button>
					</div>
				</div>
			))}
		</div>
	);
}

/**
 * A popover over selected message text: add a comment and it becomes an annotation. Listens to selections
 * inside `.messages` only.
 */
export function SelectionPopover({ onAnnotate }: { onAnnotate: (quote: string, comment: string) => void }) {
	const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null);
	const [comment, setComment] = useState("");
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const onUp = (event: MouseEvent) => {
			if (ref.current?.contains(event.target as Node)) return;
			setTimeout(() => {
				const current = window.getSelection();
				const text = current?.toString().trim() ?? "";
				const anchor = current?.anchorNode?.parentElement;
				if (!text || !anchor?.closest(".messages") || !current || current.rangeCount === 0) {
					setSelection(null);
					return;
				}
				const rect = current.getRangeAt(0).getBoundingClientRect();
				setSelection({ text: text.slice(0, 600), x: rect.left + rect.width / 2, y: rect.top });
				setComment("");
			}, 0);
		};
		document.addEventListener("mouseup", onUp);
		return () => document.removeEventListener("mouseup", onUp);
	}, []);

	if (!selection) return null;
	const done = () => {
		onAnnotate(selection.text, comment.trim());
		window.getSelection()?.removeAllRanges();
		setSelection(null);
	};
	return (
		<div ref={ref} className="selection-popover" style={{ left: selection.x, top: selection.y }}>
			<input
				className="modal-input"
				placeholder="Comment on this (optional)"
				value={comment}
				onChange={(event) => setComment(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") done();
					if (event.key === "Escape") setSelection(null);
				}}
			/>
			<button type="button" className="btn-accent" onClick={done}>
				<MessageSquareQuote size={13} /> Annotate
			</button>
		</div>
	);
}

/** Reviewer results under an assistant message: spinner while running, then issues sorted violations first. */
export function GuardrailResults({ results, onAnnotate }: { results: Record<string, ReviewResult>; onAnnotate: (quote: string, comment: string) => void }) {
	const [open, setOpen] = useState(false);
	const entries = Object.entries(results);
	const running = entries.some(([, result]) => result.status === "running");
	const issues = entries.flatMap(([name, result]) => (result.status === "done" ? result.issues.map((issue) => ({ ...issue, name })) : []));
	const errors = entries.filter(([, result]) => result.status === "error") as [string, Extract<ReviewResult, { status: "error" }>][];
	const violations = issues.filter((issue) => issue.type === "violation").length;
	const warnings = issues.length - violations;

	if (!running && issues.length === 0 && errors.length === 0) {
		return (
			<div className="guardrail-ok" title="All guardrail reviews passed">
				<ShieldCheck size={13} /> Guardrails passed
			</div>
		);
	}

	return (
		<div className={`guardrails${open ? " open" : ""}`}>
			<button type="button" className="guardrails-head" onClick={() => setOpen(!open)}>
				{running ? <span className="dots">Reviewing</span> : null}
				{violations > 0 && (
					<span className="g-violation">
						<ShieldAlert size={13} /> {violations} violation{violations > 1 ? "s" : ""}
					</span>
				)}
				{warnings > 0 && (
					<span className="g-warning">
						<ShieldAlert size={13} /> {warnings} warning{warnings > 1 ? "s" : ""}
					</span>
				)}
				{errors.length > 0 && <span className="g-violation">{errors.length} reviewer error{errors.length > 1 ? "s" : ""}</span>}
				<ChevronDown size={13} className="chev" />
			</button>
			{open && (
				<div className="guardrails-body">
					{[...issues]
						.sort((a, b) => (a.type === b.type ? 0 : a.type === "violation" ? -1 : 1))
						.map((issue, index) => (
							<div key={index} className={`g-issue ${issue.type}`}>
								<div className="g-issue-head">
									<span>{issue.name}</span>
									<span className="g-type">{issue.type}</span>
									<span className="grow" />
									<button type="button" className="icon-btn sm" title="Add to annotations" onClick={() => onAnnotate(issue.quote, issue.issue)}>
										<MessageSquareQuote size={12} />
									</button>
								</div>
								{issue.quote && <div className="annotation-quote">“{issue.quote}”</div>}
								<div>{issue.issue}</div>
							</div>
						))}
					{errors.map(([name, error]) => (
						<div key={name} className="g-issue violation">
							<div className="g-issue-head">
								<span>{name}</span>
								<span className="g-type">error</span>
							</div>
							<div>{error.error}</div>
							{error.raw && <pre className="tool-pre">{error.raw}</pre>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
