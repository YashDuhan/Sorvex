import { ChevronDown, Circle, MousePointer2, MoveUpRight, Pencil, Redo2, Square, Trash2, Undo2, X } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { attachToComposer, type IncomingAttachment } from "../composerInbox.ts";

/**
 * What the annotation bar needs from the pane it sits on: the live view, its frames, and how to find and describe
 * the element under a point. Positions are in the live view's own pixels.
 */
export interface AnnotateSource {
	/** The element the live view is drawn on (an image or a canvas). */
	target: RefObject<HTMLElement | null>;
	/** The live view's pixel size, or null before the first frame. */
	size: () => { width: number; height: number } | null;
	/** The current frame as a data URL; drawing happens on a frozen copy. */
	snapshot: () => string | null;
	/** The element under a point, for the hover highlight. */
	inspect: (x: number, y: number) => Promise<{ rect: { x: number; y: number; width: number; height: number }; label: string } | null>;
	/** The composer attachment for the element under a clicked point. */
	select: (x: number, y: number) => Promise<IncomingAttachment | null>;
	/** Scrolling while picking, so the user can reach elements below the fold. */
	onWheel?: (deltaY: number) => void;
	/** File name of the drawing added to the chat. */
	fileName: string;
	/** Tooltip of the select tool, naming what it sends. */
	selectLabel: string;
	/** Shown when there is nothing to draw on yet. */
	emptyMessage: string;
}

type Point = [number, number];
type ShapeKind = "rect" | "ellipse" | "arrow";
type Tool = "select" | "pen" | "shape";

type Item =
	| { kind: "pen"; color: string; width: number; points: Point[] }
	| { kind: ShapeKind; color: string; width: number; from: Point; to: Point };

const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ffffff", "#111111"];
const WIDTHS = [2, 4, 8];
const SHAPES: { kind: ShapeKind; label: string; icon: ReactNode }[] = [
	{ kind: "rect", label: "Rectangle", icon: <Square size={15} /> },
	{ kind: "ellipse", label: "Ellipse", icon: <Circle size={15} /> },
	{ kind: "arrow", label: "Arrow", icon: <MoveUpRight size={15} /> },
];

function draw(ctx: CanvasRenderingContext2D, item: Item): void {
	ctx.strokeStyle = item.color;
	ctx.fillStyle = item.color;
	ctx.lineWidth = item.width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	if (item.kind === "pen") {
		ctx.beginPath();
		item.points.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
		if (item.points.length === 1) ctx.lineTo(item.points[0]![0] + 0.1, item.points[0]![1]);
		ctx.stroke();
	} else if (item.kind === "rect") {
		ctx.strokeRect(Math.min(item.from[0], item.to[0]), Math.min(item.from[1], item.to[1]), Math.abs(item.to[0] - item.from[0]), Math.abs(item.to[1] - item.from[1]));
	} else if (item.kind === "ellipse") {
		ctx.beginPath();
		ctx.ellipse((item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2, Math.abs(item.to[0] - item.from[0]) / 2, Math.abs(item.to[1] - item.from[1]) / 2, 0, 0, Math.PI * 2);
		ctx.stroke();
	} else {
		const [x1, y1] = item.from;
		const [x2, y2] = item.to;
		const angle = Math.atan2(y2 - y1, x2 - x1);
		const head = 10 + item.width * 2;
		ctx.beginPath();
		ctx.moveTo(x1, y1);
		ctx.lineTo(x2, y2);
		ctx.moveTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
		ctx.lineTo(x2, y2);
		ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
		ctx.stroke();
	}
}

function loadImage(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error("Could not load the screenshot"));
		image.src = src;
	});
}

/**
 * The annotation bar of the Browser and Device panes, like Claude Code's: pick an element to send its details to the
 * chat, or draw on a frozen copy of the view (pen, shapes) and add the result to the chat as an image.
 */
export function Annotate({
	source,
	className = "",
	onClose,
	onActiveChange,
	onAttached,
	toast,
}: {
	source: AnnotateSource;
	className?: string;
	onClose: () => void;
	/** True while a tool is active, so the pane stops forwarding clicks and keys to the page. */
	onActiveChange: (active: boolean) => void;
	onAttached: () => void;
	toast: (kind: "info" | "error" | "warning", message: string) => void;
}) {
	const [tool, setTool] = useState<Tool | null>(null);
	const [shape, setShape] = useState<ShapeKind>("rect");
	const [color, setColor] = useState(COLORS[0]!);
	const [width, setWidth] = useState(WIDTHS[1]!);
	const [menu, setMenu] = useState<"shape" | "color" | "width" | null>(null);
	// Drawing happens on a frozen copy of the frame, at the view's own resolution, laid exactly over the live view.
	const [frozen, setFrozen] = useState<{ src: string; width: number; height: number } | null>(null);
	const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
	const [items, setItems] = useState<Item[]>([]);
	const [past, setPast] = useState<Item[][]>([]);
	const [future, setFuture] = useState<Item[][]>([]);
	const [draft, setDraft] = useState<Item | null>(null);
	const [hover, setHover] = useState<{ box: { left: number; top: number; width: number; height: number }; label: string } | null>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const layerRef = useRef<HTMLDivElement>(null);
	const inspecting = useRef<{ busy: boolean; next?: { x: number; y: number } }>({ busy: false });

	useEffect(() => onActiveChange(tool !== null), [tool, onActiveChange]);
	useEffect(() => {
		if (tool) layerRef.current?.focus();
	}, [tool]);
	// Keep the drawing surface on top of the live view as the pane resizes.
	useEffect(() => {
		const layer = layerRef.current;
		if (!tool || !layer) return;
		const measure = () => {
			const target = source.target.current?.getBoundingClientRect();
			const outer = layer.getBoundingClientRect();
			if (target?.width) setBox({ left: target.left - outer.left, top: target.top - outer.top, width: target.width, height: target.height });
		};
		measure();
		// The pane may relayout right after a tool starts (the Device pane leaves 3D), so measure again once it has.
		const frame = requestAnimationFrame(() => requestAnimationFrame(measure));
		const observer = new ResizeObserver(measure);
		observer.observe(layer);
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
		};
	}, [tool, source.target]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const ctx = canvas?.getContext("2d");
		if (!canvas || !ctx) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		for (const item of draft ? [...items, draft] : items) draw(ctx, item);
	}, [items, draft, frozen]);

	const commit = (next: Item[]) => {
		setPast((current) => [...current, items]);
		setFuture([]);
		setItems(next);
	};
	const undo = () => {
		const previous = past.at(-1);
		if (!previous) return;
		setFuture((current) => [items, ...current]);
		setPast(past.slice(0, -1));
		setItems(previous);
	};
	const redo = () => {
		const next = future[0];
		if (!next) return;
		setPast((current) => [...current, items]);
		setFuture(future.slice(1));
		setItems(next);
	};

	const reset = () => {
		setTool(null);
		setFrozen(null);
		setItems([]);
		setPast([]);
		setFuture([]);
		setDraft(null);
		setHover(null);
		setMenu(null);
	};

	const pick = (next: Tool) => {
		setMenu(null);
		if (next === "select") {
			reset();
			setTool(tool === "select" ? null : "select");
			return;
		}
		if (!frozen) {
			const size = source.size();
			const src = source.snapshot();
			if (!size || !src) return toast("info", source.emptyMessage);
			setFrozen({ src, width: size.width, height: size.height });
		}
		setHover(null);
		setTool(next);
	};

	/** Pointer position in view pixels on the live view (select) or the canvas (drawing); undefined outside it. */
	const toPage = (event: MouseEvent, target: HTMLElement | null, naturalWidth: number, naturalHeight: number, clamp = false): Point | undefined => {
		const rect = target?.getBoundingClientRect();
		if (!rect?.width) return undefined;
		const x = (event.clientX - rect.left) / rect.width;
		const y = (event.clientY - rect.top) / rect.height;
		if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return undefined;
		return [x * naturalWidth, y * naturalHeight];
	};
	const livePoint = (event: MouseEvent) => {
		const size = source.size();
		return size ? toPage(event, source.target.current, size.width, size.height) : undefined;
	};

	// Select element: hover highlights through one request at a time; click sends the element to the chat.
	const inspectAt = (x: number, y: number) => {
		const state = inspecting.current;
		if (state.busy) {
			state.next = { x, y };
			return;
		}
		state.busy = true;
		void source
			.inspect(x, y)
			.then((found) => {
				const target = source.target.current;
				const layer = layerRef.current;
				const size = source.size();
				if (!found || !target || !layer || !size) return setHover(null);
				const imageRect = target.getBoundingClientRect();
				const layerRect = layer.getBoundingClientRect();
				const scale = imageRect.width / size.width;
				setHover({
					label: found.label,
					box: {
						left: imageRect.left - layerRect.left + found.rect.x * scale,
						top: imageRect.top - layerRect.top + found.rect.y * scale,
						width: found.rect.width * scale,
						height: found.rect.height * scale,
					},
				});
			})
			.catch(() => setHover(null))
			.finally(() => {
				state.busy = false;
				const next = state.next;
				state.next = undefined;
				if (next) inspectAt(next.x, next.y);
			});
	};

	const selectElement = async (x: number, y: number) => {
		try {
			const attachment = await source.select(x, y);
			if (!attachment) return;
			attachToComposer([attachment]);
			reset();
			onAttached();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	};

	const addToChat = async () => {
		if (!frozen) return;
		try {
			const canvas = document.createElement("canvas");
			canvas.width = frozen.width;
			canvas.height = frozen.height;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(await loadImage(frozen.src), 0, 0, frozen.width, frozen.height);
			for (const item of items) draw(ctx, item);
			const data = canvas.toDataURL("image/jpeg", 0.88).replace(/^data:[^,]*,/, "");
			attachToComposer([{ name: source.fileName, kind: "image", mimeType: "image/jpeg", data, size: data.length }]);
			reset();
			onAttached();
		} catch (error) {
			toast("error", error instanceof Error ? error.message : String(error));
		}
	};

	const onDrawDown = (event: PointerEvent<HTMLCanvasElement>) => {
		if (!frozen) return;
		const point = toPage(event, event.currentTarget, frozen.width, frozen.height, true);
		if (!point) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		setDraft(tool === "pen" ? { kind: "pen", color, width, points: [point] } : { kind: shape, color, width, from: point, to: point });
	};
	const onDrawMove = (event: PointerEvent<HTMLCanvasElement>) => {
		if (!draft || !frozen) return;
		const point = toPage(event, event.currentTarget, frozen.width, frozen.height, true);
		if (!point) return;
		setDraft(draft.kind === "pen" ? { ...draft, points: [...draft.points, point] } : { ...draft, to: point });
	};
	const onDrawUp = () => {
		if (!draft) return;
		const tiny = draft.kind !== "pen" && Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) < 3;
		if (!tiny) commit([...items, draft]);
		setDraft(null);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// Keys stay in the annotation layer instead of going to the page.
		event.stopPropagation();
		const mod = event.ctrlKey || event.metaKey;
		if (event.key === "Escape") reset();
		else if (mod && event.key.toLowerCase() === "z" && !event.shiftKey) undo();
		else if (mod && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) redo();
		else return;
		event.preventDefault();
	};

	const drawing = tool !== null && tool !== "select";
	const shapeIcon = SHAPES.find((entry) => entry.kind === shape)!.icon;
	const button = (label: string, active: boolean, onClick: () => void, icon: ReactNode, disabled = false) => (
		<button type="button" className={`annotate-btn${active ? " active" : ""}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}>
			{icon}
		</button>
	);

	return (
		<>
			{tool && (
				// biome-ignore lint/a11y/noStaticElementInteractions: captures pointer and keys while an annotation tool is active.
				<div ref={layerRef} className={`annotate-layer${tool === "select" ? " selecting" : ""}`} tabIndex={-1} onKeyDown={onKeyDown}>
					{tool === "select" && (
						// biome-ignore lint/a11y/noStaticElementInteractions: element picker surface over the live page.
						<div
							className="annotate-pick"
							onPointerMove={(event) => {
								const point = livePoint(event);
								if (point) inspectAt(Math.round(point[0]), Math.round(point[1]));
								else setHover(null);
							}}
							onPointerLeave={() => setHover(null)}
							onWheel={(event) => {
								if (!source.onWheel) return;
								setHover(null);
								source.onWheel(event.deltaY);
							}}
							onClick={(event) => {
								const point = livePoint(event);
								if (point) void selectElement(Math.round(point[0]), Math.round(point[1]));
							}}
						>
							{hover && (
								<div className="annotate-hover" style={hover.box}>
									<span>{hover.label}</span>
								</div>
							)}
						</div>
					)}
					{drawing && frozen && (
						<div className="annotate-canvas-wrap" style={box ?? undefined}>
							<img src={frozen.src} alt="Frozen page to draw on" draggable={false} />
							<canvas
								ref={canvasRef}
								width={frozen.width}
								height={frozen.height}
								className={`annotate-canvas tool-${tool}`}
								onPointerDown={onDrawDown}
								onPointerMove={onDrawMove}
								onPointerUp={onDrawUp}
								onPointerCancel={onDrawUp}
							/>
						</div>
					)}
				</div>
			)}
			<div className={`annotate-bar ${className}`} onKeyDown={(event) => event.stopPropagation()}>
				{button(source.selectLabel, tool === "select", () => pick("select"), <MousePointer2 size={15} />)}
				{button("Pen", tool === "pen", () => pick("pen"), <Pencil size={15} />)}
				<div className="annotate-group">
					{button(SHAPES.find((entry) => entry.kind === shape)!.label, tool === "shape", () => pick("shape"), shapeIcon)}
					<button type="button" className="annotate-caret" aria-label="Choose shape" onClick={() => setMenu(menu === "shape" ? null : "shape")}>
						<ChevronDown size={12} />
					</button>
					{menu === "shape" && (
						<div className="annotate-menu">
							{SHAPES.map((entry) => (
								<button
									key={entry.kind}
									type="button"
									className={`annotate-menu-item${entry.kind === shape ? " active" : ""}`}
									onClick={() => {
										setShape(entry.kind);
										pick("shape");
									}}
								>
									{entry.icon}
									{entry.label}
								</button>
							))}
						</div>
					)}
				</div>
				{drawing && (
					<>
						<span className="annotate-sep" />
						<div className="annotate-group">
							<button type="button" className="annotate-btn" aria-label="Color" title="Color" onClick={() => setMenu(menu === "color" ? null : "color")}>
								<span className="annotate-swatch" style={{ background: color }} />
								<ChevronDown size={12} />
							</button>
							{menu === "color" && (
								<div className="annotate-menu colors">
									{COLORS.map((value) => (
										<button
											key={value}
											type="button"
											className={`annotate-color${value === color ? " active" : ""}`}
											aria-label={`Color ${value}`}
											style={{ background: value }}
											onClick={() => {
												setColor(value);
												setMenu(null);
											}}
										/>
									))}
								</div>
							)}
						</div>
						<div className="annotate-group">
							<button type="button" className="annotate-btn" aria-label="Thickness" title="Thickness" onClick={() => setMenu(menu === "width" ? null : "width")}>
								<span className="annotate-line" style={{ height: Math.max(2, width / 2) }} />
								<ChevronDown size={12} />
							</button>
							{menu === "width" && (
								<div className="annotate-menu">
									{WIDTHS.map((value) => (
										<button
											key={value}
											type="button"
											className={`annotate-menu-item${value === width ? " active" : ""}`}
											onClick={() => {
												setWidth(value);
												setMenu(null);
											}}
										>
											<span className="annotate-line wide" style={{ height: value }} />
										</button>
									))}
								</div>
							)}
						</div>
						<span className="annotate-sep" />
						{button("Undo (Ctrl+Z)", false, undo, <Undo2 size={15} />, past.length === 0)}
						{button("Redo (Ctrl+Shift+Z)", false, redo, <Redo2 size={15} />, future.length === 0)}
						{button("Clear drawing", false, () => items.length > 0 && commit([]), <Trash2 size={15} />, items.length === 0)}
						<button type="button" className="annotate-add" onClick={() => void addToChat()}>
							Add to chat
						</button>
					</>
				)}
				{button(tool ? "Cancel (Esc)" : "Hide toolbar", false, () => (tool ? reset() : onClose()), <X size={15} />)}
			</div>
		</>
	);
}
