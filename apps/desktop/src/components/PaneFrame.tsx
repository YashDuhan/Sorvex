import { Maximize2, Minimize2, X } from "lucide-react";
import { type MouseEvent, type ReactNode, useRef } from "react";

/**
 * The resizable pane to the right of the chat (Browser, Files, Changes, Terminal). Drag its left edge to resize;
 * expanded, it covers the whole window.
 */
export function PaneFrame({
	expanded,
	width,
	onResize,
	hidden,
	className = "",
	children,
}: {
	expanded: boolean;
	width: number;
	onResize: (width: number) => void;
	/** Kept mounted but not shown, so terminals and open files survive switching panes. */
	hidden?: boolean;
	className?: string;
	children: ReactNode;
}) {
	const paneRef = useRef<HTMLElement>(null);
	// The pane's right edge stays put while its left edge follows the pointer.
	const startResize = (event: MouseEvent) => {
		event.preventDefault();
		const right = paneRef.current?.getBoundingClientRect().right ?? window.innerWidth;
		const onMove = (move: globalThis.MouseEvent) => onResize(Math.round(right - move.clientX));
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			document.body.classList.remove("resizing");
		};
		document.body.classList.add("resizing");
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};
	return (
		<section ref={paneRef} className={`browser-pane side-pane ${className}${expanded ? " expanded" : ""}`} style={expanded ? undefined : { width }} hidden={hidden}>
			{!expanded && (
				// biome-ignore lint/a11y/noStaticElementInteractions: a drag handle; the pane width is also restorable via expand/collapse.
				<div className="browser-resize" onMouseDown={startResize} title="Drag to resize" />
			)}
			{children}
		</section>
	);
}

/** Header row for the Files, Changes and Terminal panes: content on the left, actions and expand/close on the right. */
export function PaneHeader({
	children,
	actions,
	expanded,
	onToggleExpand,
	onClose,
}: {
	children: ReactNode;
	actions?: ReactNode;
	expanded: boolean;
	onToggleExpand: () => void;
	onClose: () => void;
}) {
	return (
		<div className="pane-header">
			<div className="pane-header-main">{children}</div>
			<div className="pane-header-actions">
				{actions}
				<button type="button" className="icon-btn sm" aria-label={expanded ? "Collapse pane" : "Expand pane"} title={expanded ? "Collapse" : "Expand"} onClick={onToggleExpand}>
					{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
				</button>
				<button type="button" className="icon-btn sm" aria-label="Close pane" title="Close" onClick={onClose}>
					<X size={15} />
				</button>
			</div>
		</div>
	);
}
