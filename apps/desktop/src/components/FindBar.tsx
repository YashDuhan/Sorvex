import { ArrowDown, ArrowUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const MATCH = "find-match";
const CURRENT = "find-current";
/** CSS Custom Highlight API; without it matches still scroll into view, just unhighlighted. */
const highlights = typeof CSS !== "undefined" && "highlights" in CSS ? CSS.highlights : null;

function clearHighlights() {
	highlights?.delete(MATCH);
	highlights?.delete(CURRENT);
}

/** Every case-insensitive occurrence of `needle` inside one text node under `root`. */
function findRanges(root: Element, needle: string): Range[] {
	const ranges: Range[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
		acceptNode: (node) => (node.parentElement?.closest("[hidden], script, style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
	});
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const text = node.textContent?.toLowerCase() ?? "";
		for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
			const range = document.createRange();
			range.setStart(node, at);
			range.setEnd(node, at + needle.length);
			ranges.push(range);
		}
	}
	return ranges;
}

/**
 * Ctrl+F find bar over the thread: highlights every match in the rendered messages and steps through them. Enter or
 * the down arrow goes to the next match, Shift+Enter or the up arrow to the previous one, Escape closes. Text inside
 * collapsed tool output is not searched until it is expanded.
 */
export function FindBar({ open, focusNonce, version, onClose }: { open: boolean; focusNonce: number; version: unknown; onClose: () => void }) {
	const [query, setQuery] = useState("");
	const [ranges, setRanges] = useState<Range[]>([]);
	const [index, setIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);

	// Ctrl+F again while open selects the query, like a browser.
	useEffect(() => {
		if (open) inputRef.current?.select();
	}, [open, focusNonce]);

	// Re-runs when the query or the thread changes (new messages, streaming).
	useEffect(() => {
		const needle = query.trim().toLowerCase();
		const root = document.querySelector(".thread .messages");
		if (!open || !needle || !root) {
			setRanges([]);
			clearHighlights();
			return;
		}
		const found = findRanges(root, needle);
		setRanges(found);
		setIndex((current) => (current < found.length ? current : 0));
		highlights?.set(MATCH, new Highlight(...found));
	}, [open, query, version]);

	useEffect(() => {
		const range = ranges[index];
		if (!range) {
			highlights?.delete(CURRENT);
			return;
		}
		highlights?.set(CURRENT, new Highlight(range));
		range.startContainer.parentElement?.scrollIntoView({ block: "center" });
	}, [ranges, index]);

	useEffect(() => clearHighlights, []);

	const step = useCallback((delta: number) => ranges.length > 0 && setIndex((current) => (current + delta + ranges.length) % ranges.length), [ranges.length]);

	if (!open) return null;
	return (
		<div className="find-bar" role="search">
			<input
				ref={inputRef}
				autoFocus
				aria-label="Find in conversation"
				placeholder="Find in conversation"
				value={query}
				onChange={(event) => {
					setQuery(event.target.value);
					setIndex(0);
				}}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						step(event.shiftKey ? -1 : 1);
					} else if (event.key === "Escape") {
						// Keeps the app's Escape (stop the run) from firing.
						event.stopPropagation();
						onClose();
					}
				}}
			/>
			{query.trim() && <span className="find-count">{ranges.length > 0 ? `${index + 1}/${ranges.length}` : "No results"}</span>}
			<button type="button" className="icon-btn sm" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={ranges.length === 0} onClick={() => step(-1)}>
				<ArrowUp size={14} />
			</button>
			<button type="button" className="icon-btn sm" aria-label="Next match" title="Next (Enter)" disabled={ranges.length === 0} onClick={() => step(1)}>
				<ArrowDown size={14} />
			</button>
			<button type="button" className="icon-btn sm find-close" aria-label="Close find" title="Close (Escape)" onClick={onClose}>
				<X size={14} />
			</button>
		</div>
	);
}
