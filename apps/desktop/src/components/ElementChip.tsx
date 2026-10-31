import { ChevronRight, MousePointer2, X } from "lucide-react";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { describeElement, type SelectedElement } from "../element.ts";

function Code({ children }: { children: string }) {
	return <pre className="element-card-code">{children}</pre>;
}

/**
 * A Browser pane element attached to a message, shown as one chip like Claude Code's. Hovering it shows what the AI
 * receives: the screenshot, the element and its text, and on demand the selector, computed styles, HTML, siblings and
 * the exact text sent.
 */
export function ElementChip({ element, image, onRemove, align = "left" }: { element: SelectedElement; image?: string; onRemove?: () => void; align?: "left" | "right" }) {
	const [open, setOpen] = useState(false);
	const [more, setMore] = useState(false);
	const [position, setPosition] = useState<CSSProperties>({});
	const chipRef = useRef<HTMLButtonElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// The card is fixed-positioned above the chip, because the composer's attachment row clips overflow.
	const show = () => {
		clearTimeout(timer.current);
		const rect = chipRef.current?.getBoundingClientRect();
		if (rect) {
			const width = Math.min(420, window.innerWidth - 24);
			const left = align === "right" ? rect.right - width : rect.left;
			setPosition({ width, left: Math.max(12, Math.min(left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 8, maxHeight: rect.top - 24 });
		}
		setOpen(true);
	};
	const hide = () => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(false), 180);
	};

	const details: [string, ReactNode][] = [];
	if (element.path) details.push(["Selector", <Code key="path">{element.path}</Code>]);
	if (element.react) details.push(["React components", <Code key="react">{element.react}</Code>]);
	if (Object.keys(element.styles).length > 0) {
		details.push([
			"Computed styles",
			<dl key="styles" className="element-card-styles">
				{Object.entries(element.styles).map(([key, value]) => (
					<div key={key}>
						<dt>{key}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>,
		]);
	}
	if (element.html) details.push(["HTML", <Code key="html">{element.html}</Code>]);
	if (element.siblings) details.push(["Siblings", <Code key="siblings">{element.siblings}</Code>]);
	details.push(["Exact text sent", <Code key="exact">{describeElement({ ...element, hasScreenshot: Boolean(image) || element.hasScreenshot })}</Code>]);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: hover only reveals a details card; the chip is also focusable.
		<span className="element-chip-wrap" onMouseEnter={show} onMouseLeave={hide}>
			<button ref={chipRef} type="button" className="element-chip" onFocus={show} onBlur={hide} onClick={() => (open ? setOpen(false) : show())} aria-expanded={open}>
				<MousePointer2 size={13} />
				<code>{`<${element.tag} />`}</code>
				<span className="element-chip-text">{element.text || element.label}</span>
			</button>
			{onRemove && (
				<button type="button" className="attachment-remove" aria-label={`Remove <${element.tag} />`} onClick={onRemove}>
					<X size={10} />
				</button>
			)}
			{open && (
				<div className="element-card" style={position}>
					<div className="element-card-head">
						<MousePointer2 size={13} />
						Included with your message
					</div>
					{image && <img className="element-card-shot" src={`data:image/jpeg;base64,${image}`} alt={`Screenshot of <${element.tag} />`} />}
					<div className="element-card-row">
						<span>Element</span>
						<code>{`<${element.tag} />`}</code>
					</div>
					{element.text && (
						<div className="element-card-row">
							<span>Text</span>
							<p className={more ? "" : "clamp"}>{element.text}</p>
						</div>
					)}
					<button type="button" className="element-card-more" onClick={() => setMore(!more)}>
						<ChevronRight size={13} style={{ transform: more ? "rotate(90deg)" : undefined }} />
						{more ? "Hide details" : `Show ${details.length} more details`}
					</button>
					{more &&
						details.map(([label, body]) => (
							<div key={label} className="element-card-section">
								<div className="element-card-label">{label}</div>
								{body}
							</div>
						))}
				</div>
			)}
		</span>
	);
}
