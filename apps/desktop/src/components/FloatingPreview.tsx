import { GripHorizontal } from "lucide-react";
import { type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const GAP = 12;
const DRAG_SLOP = 4;
const DIRECTIONS = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Direction = (typeof DIRECTIONS)[number];

interface Frame {
	x: number;
	y: number;
	width: number;
	height: number;
}
interface Size {
	width: number;
	height: number;
}

function readFrame(key: string): Frame | null {
	try {
		const value = JSON.parse(localStorage.getItem(key) ?? "null") as Frame | null;
		return value && [value.x, value.y, value.width, value.height].every(Number.isFinite) ? value : null;
	} catch {
		return null;
	}
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * The largest the window may get: the chat area minus the composer, and at most 60% of the chat's width, so it stays a
 * preview beside the conversation rather than covering it.
 */
function maxSize(area: Size, min: Size): Size {
	return { width: Math.max(min.width, Math.min(area.width - GAP * 2, area.width * 0.6)), height: Math.max(min.height, area.height - GAP * 2) };
}

/** Fits a frame into the area: size within the limits (keeping `aspect` if given), then position inside the edges. */
function fit(frame: Frame, area: Size, min: Size, aspect: number | null): Frame {
	const max = maxSize(area, min);
	let width = clamp(frame.width, min.width, max.width);
	let height = clamp(frame.height, min.height, max.height);
	if (aspect) {
		width = clamp(width, Math.max(min.width, min.height * aspect), Math.min(max.width, max.height * aspect));
		height = width / aspect;
	}
	width = Math.round(width);
	height = Math.round(height);
	return { width, height, x: Math.round(clamp(frame.x, GAP, area.width - width - GAP)), y: Math.round(clamp(frame.y, GAP, area.height - height - GAP)) };
}

/** A resize from `start` by the pointer delta, anchoring the opposite edges. */
function resize(start: Frame, direction: Direction, dx: number, dy: number, aspect: number | null): Frame {
	const east = direction.includes("e");
	const west = direction.includes("w");
	const north = direction.startsWith("n");
	const south = direction.startsWith("s");
	let width = start.width + (east ? dx : west ? -dx : 0);
	let height = start.height + (south ? dy : north ? -dy : 0);
	if (aspect) {
		// Horizontal movement drives corners; a top or bottom edge alone drives the height.
		if (east || west) height = width / aspect;
		else width = height * aspect;
	}
	return {
		width,
		height,
		// Edges that do not move stay put; a top or bottom edge alone keeps the right edge (the window sits on the right).
		x: west || (!east && aspect) ? start.x + start.width - width : start.x,
		y: north ? start.y + start.height - height : start.y,
	};
}

/**
 * A picture-in-picture window over the chat: the live content only, no chrome. Drag it by the grip that appears on
 * hover, resize it from any edge or corner (within limits, keeping `aspect` when given). Its place and size are
 * remembered under `storageKey`. Docking it back into the side pane is done from the header, not from here.
 */
export function FloatingPreview({
	host,
	storageKey,
	label,
	defaultSize,
	minSize,
	aspect = null,
	radius = 12,
	children,
}: {
	/** The chat section it floats over. */
	host: HTMLElement;
	storageKey: string;
	label: string;
	defaultSize: Size;
	minSize: Size;
	/** width / height to keep, e.g. a phone screen's. */
	aspect?: number | null;
	radius?: number;
	children: ReactNode;
}) {
	const [area, setArea] = useState<Size>({ width: host.clientWidth, height: host.clientHeight });
	const [stored, setStored] = useState<Frame | null>(() => readFrame(storageKey));
	const gesture = useRef<{ id: number; x: number; y: number; start: Frame; direction: Direction | null; moved: boolean } | null>(null);
	const [active, setActive] = useState(false);

	// The area is the chat above the composer; both change as the window, sidebars and composer resize.
	useEffect(() => {
		const measure = () => {
			const footer = host.querySelector<HTMLElement>(":scope > .footer");
			setArea({ width: host.clientWidth, height: host.clientHeight - (footer?.offsetHeight ?? 0) });
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(host);
		const footer = host.querySelector(":scope > .footer");
		if (footer) observer.observe(footer);
		return () => observer.disconnect();
	}, [host]);

	const initial: Frame = stored ?? { ...defaultSize, x: area.width - defaultSize.width - GAP, y: GAP };
	const frame = fit(aspect ? { ...initial, height: initial.width / aspect } : initial, area, minSize, aspect);

	const begin = (direction: Direction | null) => (event: PointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: frame, direction, moved: false };
		setActive(true);
	};
	const move = (event: PointerEvent<HTMLElement>) => {
		const current = gesture.current;
		if (!current || current.id !== event.pointerId) return;
		const dx = event.clientX - current.x;
		const dy = event.clientY - current.y;
		if (!current.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
		current.moved = true;
		const { start, direction } = current;
		if (!direction) return setStored(fit({ ...start, x: start.x + dx, y: start.y + dy }, area, minSize, aspect));
		// Size within the limits first, then re-anchor, so a clamped size does not drag the fixed edges along.
		const raw = resize(start, direction, dx, dy, aspect);
		const sized = fit(raw, area, minSize, aspect);
		const right = raw.x !== start.x;
		const bottom = raw.y !== start.y;
		setStored(
			fit(
				{ ...sized, x: right ? start.x + start.width - sized.width : start.x, y: bottom ? start.y + start.height - sized.height : start.y },
				area,
				minSize,
				aspect,
			),
		);
	};
	const end = (event: PointerEvent<HTMLElement>) => {
		if (gesture.current?.id !== event.pointerId) return;
		gesture.current = null;
		setActive(false);
		try {
			localStorage.setItem(storageKey, JSON.stringify(frame));
		} catch {
			// Not remembered.
		}
	};
	const handlers = { onPointerMove: move, onPointerUp: end, onPointerCancel: end };

	return createPortal(
		<section
			className={`floating-preview${active ? " active" : ""}`}
			aria-label={label}
			style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, borderRadius: radius }}
		>
			<div className="fp-content" style={{ borderRadius: radius }}>
				{children}
			</div>
			<div className="fp-grip" title="Drag to move" onPointerDown={begin(null)} {...handlers}>
				<GripHorizontal size={14} />
			</div>
			{DIRECTIONS.map((direction) => (
				<div key={direction} role="presentation" className={`fp-resize ${direction}`} onPointerDown={begin(direction)} {...handlers} />
			))}
		</section>,
		host,
	);
}
