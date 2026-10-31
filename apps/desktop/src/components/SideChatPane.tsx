import { CornerDownLeft, FileSearch, Loader2, Square, X } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, serverEvents } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";

type Part = { kind: "text"; text: string } | { kind: "tool"; label: string };
type Item = { role: "user"; text: string } | { role: "assistant"; parts: Part[]; error?: string };

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * The side chat (/btw), like Claude's: a conversation next to the main one. It sees the main chat as it is when
 * each message is sent (including what the agent is running), uses the same model, can read the project, and is never saved; follow-ups stay in this chat.
 * Closing its tab ends it; the next /btw starts a new one.
 */
export function SideChatPane({
	request,
	model,
	transcript,
	hidden,
	expanded,
	width,
	onResize,
	onToggleExpand,
	onClose,
}: {
	/** A message from `/btw <text>` in the main composer. */
	request: { text: string; nonce: number } | null;
	/** "provider/id" of the main chat's model, or undefined when none is selected. */
	model: string | undefined;
	/** The main chat as text plus what the agent is doing now, read on every message. */
	transcript: () => string;
	hidden: boolean;
	expanded: boolean;
	width: number;
	onResize: (width: number) => void;
	onToggleExpand: () => void;
	onClose: () => void;
}) {
	const [id, setId] = useState(newId);
	const [items, setItems] = useState<Item[]>([]);
	const [busy, setBusy] = useState(false);
	const [draft, setDraft] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		const update = (change: (last: Extract<Item, { role: "assistant" }>) => Extract<Item, { role: "assistant" }>) =>
			setItems((current) => {
				const last = current.at(-1);
				return last?.role === "assistant" ? [...current.slice(0, -1), change(last)] : current;
			});
		const offDelta = serverEvents.on<{ id: string; delta: string }>("side-delta", (event) => {
			if (event.id !== id) return;
			update((last) => {
				const tail = last.parts.at(-1);
				return tail?.kind === "text"
					? { ...last, parts: [...last.parts.slice(0, -1), { kind: "text", text: tail.text + event.delta }] }
					: { ...last, parts: [...last.parts, { kind: "text", text: event.delta }] };
			});
		});
		const offTool = serverEvents.on<{ id: string; label: string }>("side-tool", (event) => {
			if (event.id === id) update((last) => ({ ...last, parts: [...last.parts, { kind: "tool", label: event.label }] }));
		});
		const offDone = serverEvents.on<{ id: string; error?: string }>("side-done", (event) => {
			if (event.id !== id) return;
			setBusy(false);
			if (event.error) update((last) => ({ ...last, error: event.error }));
		});
		return () => {
			offDelta();
			offTool();
			offDone();
		};
	}, [id]);

	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [items]);

	const send = (text: string) => {
		const message = text.trim();
		if (!message || busy) return;
		if (!model) {
			setItems((current) => [...current, { role: "user", text: message }, { role: "assistant", parts: [], error: "Pick a model in the main chat first." }]);
			return;
		}
		setItems((current) => [...current, { role: "user", text: message }, { role: "assistant", parts: [] }]);
		setBusy(true);
		void api("POST", "/api/sidechat/send", { id, model, text: message, transcript: transcript() }).catch((error: unknown) => {
			setBusy(false);
			setItems((current) => {
				const last = current.at(-1);
				return last?.role === "assistant" ? [...current.slice(0, -1), { ...last, error: error instanceof Error ? error.message : String(error) }] : current;
			});
		});
	};

	// `/btw <text>` from the main composer goes into this chat.
	useEffect(() => {
		if (request) send(request.text);
		// Only new requests; `send` reads current state.
	}, [request]);

	useEffect(() => {
		if (!hidden) requestAnimationFrame(() => inputRef.current?.focus());
	}, [hidden]);

	const end = () => {
		void api("POST", "/api/sidechat/close", { id }).catch(() => undefined);
		setId(newId());
		setItems([]);
		setBusy(false);
		onClose();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send(draft);
			setDraft("");
		} else if (event.key === "Escape" && busy) {
			event.preventDefault();
			void api("POST", "/api/sidechat/stop", { id }).catch(() => undefined);
		}
	};

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize} hidden={hidden} className="sidechat">
			<PaneHeader expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose}>
				<div className="file-tabs">
					<div className="file-tab active" title="Not saved to the session. The main agent does not see it.">
						<span className="file-tab-main">Side chat</span>
						<button type="button" className="file-tab-close" aria-label="End side chat" title="End side chat" onClick={end}>
							<X size={12} />
						</button>
					</div>
				</div>
			</PaneHeader>
			<div className="pane-body sidechat-body">
				<div ref={listRef} className="sidechat-list">
					{items.length === 0 && (
						<div className="empty-note">Ask about this chat or the project. Side chats can read files but not change anything, and they are not saved.</div>
					)}
					{items.map((item, index) =>
						item.role === "user" ? (
							<div key={index} className="sidechat-user">
								{item.text}
							</div>
						) : (
							<div key={index} className="sidechat-assistant">
								{item.parts.map((part, partIndex) =>
									part.kind === "tool" ? (
										<div key={partIndex} className="sidechat-tool">
											<FileSearch size={12} />
											{part.label}
										</div>
									) : (
										<Markdown key={partIndex} text={part.text} />
									),
								)}
								{busy && index === items.length - 1 && (
									<div className="sidechat-wait">
										<Loader2 size={13} className="spin" />
									</div>
								)}
								{item.error && <div className="sidechat-error">{item.error}</div>}
							</div>
						),
					)}
				</div>
				<div className="sidechat-input">
					<textarea
						ref={inputRef}
						rows={1}
						value={draft}
						placeholder={items.length ? "Follow up..." : "Ask a side question..."}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={onKeyDown}
					/>
					{busy ? (
						<button type="button" className="icon-btn sm" aria-label="Stop" title="Stop (Esc)" onClick={() => void api("POST", "/api/sidechat/stop", { id }).catch(() => undefined)}>
							<Square size={13} />
						</button>
					) : (
						<button
							type="button"
							className="icon-btn sm"
							aria-label="Send"
							title="Send (Enter)"
							disabled={!draft.trim()}
							onClick={() => {
								send(draft);
								setDraft("");
							}}
						>
							<CornerDownLeft size={15} />
						</button>
					)}
				</div>
			</div>
		</PaneFrame>
	);
}
