import { AlertTriangle, CircleAlert, Info, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DialogRequest, ExtensionUIResponse } from "../rpc.ts";
import type { Toast } from "../store.ts";
import { Markdown } from "./Markdown.tsx";

/** Answers one blocking extension dialog (select, confirm, input, editor). Escape cancels. */
export function ExtensionDialog({
	request,
	onAnswer,
	onExpire,
}: {
	request: DialogRequest;
	onAnswer: (response: ExtensionUIResponse) => void;
	onExpire: () => void;
}) {
	const [value, setValue] = useState(request.method === "editor" ? (request.prefill ?? "") : "");
	const [highlight, setHighlight] = useState(0);
	const cancel = () => onAnswer({ type: "extension_ui_response", id: request.id, cancelled: true });

	// With a timeout, Sorvex resolves the dialog itself, so it only needs to disappear here.
	useEffect(() => {
		if (!("timeout" in request) || !request.timeout) return;
		const timer = setTimeout(onExpire, request.timeout);
		return () => clearTimeout(timer);
		// Keyed on the request only: the parent passes a fresh callback each render.
	}, [request]);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				cancel();
			}
			if (request.method !== "select") return;
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setHighlight((current) => (current + step + request.options.length) % request.options.length);
			} else if (event.key === "Enter") {
				event.preventDefault();
				const option = request.options[highlight];
				if (option !== undefined) onAnswer({ type: "extension_ui_response", id: request.id, value: option });
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	});

	const submitValue = () => onAnswer({ type: "extension_ui_response", id: request.id, value });
	const message = request.method === "select" || request.method === "confirm" ? request.message : undefined;

	return (
		<div className="modal-backdrop">
			<div className="modal" role="dialog" aria-modal="true" aria-label={request.title}>
				<div className="modal-head">{request.title}</div>
				{message && (
					<div className="modal-body">
						<Markdown text={message} />
					</div>
				)}
				{request.method === "select" && (
					<div className="modal-options">
						{request.options.map((option, index) => (
							<button
								key={option}
								type="button"
								className={`modal-option${index === highlight ? " highlight" : ""}`}
								onMouseEnter={() => setHighlight(index)}
								onClick={() => onAnswer({ type: "extension_ui_response", id: request.id, value: option })}
							>
								{option}
							</button>
						))}
					</div>
				)}
				{request.method === "input" && (
					<div className="modal-body">
						<input
							className="modal-input"
							autoFocus
							placeholder={request.placeholder}
							value={value}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => event.key === "Enter" && submitValue()}
						/>
					</div>
				)}
				{request.method === "editor" && (
					<div className="modal-body">
						<textarea className="modal-input" autoFocus value={value} onChange={(event) => setValue(event.target.value)} />
					</div>
				)}
				<div className="modal-foot">
					<button type="button" className="btn-ghost" onClick={cancel}>
						Cancel
					</button>
					{request.method === "confirm" && (
						<>
							<button type="button" className="btn-ghost" onClick={() => onAnswer({ type: "extension_ui_response", id: request.id, confirmed: false })}>
								No
							</button>
							<button
								type="button"
								className="btn-accent"
								autoFocus
								onClick={() => onAnswer({ type: "extension_ui_response", id: request.id, confirmed: true })}
							>
								Yes
							</button>
						</>
					)}
					{(request.method === "input" || request.method === "editor") && (
						<button type="button" className="btn-accent" onClick={submitValue}>
							Submit
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
	useEffect(() => {
		const timer = setTimeout(onDismiss, toast.kind === "error" ? 9000 : 5000);
		return () => clearTimeout(timer);
		// Keyed on the toast only: the parent passes a fresh callback each render, which would restart the timer.
	}, [toast]);
	const Icon = toast.kind === "error" ? CircleAlert : toast.kind === "warning" ? AlertTriangle : Info;
	return (
		<div className={`toast ${toast.kind}`} role="status">
			<Icon size={15} style={{ flexShrink: 0, marginTop: 2 }} />
			<span className="text">{toast.text}</span>
			<button type="button" className="icon-btn sm" aria-label="Dismiss" onClick={onDismiss}>
				<X size={13} />
			</button>
		</div>
	);
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
	if (toasts.length === 0) return null;
	return (
		<div className="toasts">
			{toasts.map((toast) => (
				<ToastItem key={toast.id} toast={toast} onDismiss={() => onDismiss(toast.id)} />
			))}
		</div>
	);
}
