import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 450;

/**
 * A small styled tooltip: a title line and an optional muted description, shown above the trigger after a short
 * hover or on keyboard focus. Rendered in a portal so scroll containers do not clip it. Use instead of a native
 * `title` when there is a description.
 */
export function Tooltip({ label, description, children }: { label: string; description?: ReactNode; children: ReactElement }) {
	const wrapRef = useRef<HTMLSpanElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const [at, setAt] = useState<{ x: number; y: number } | null>(null);

	const show = (delay: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			const rect = wrapRef.current?.getBoundingClientRect();
			if (rect) setAt({ x: rect.left + rect.width / 2, y: rect.top });
		}, delay);
	};
	const hide = () => {
		clearTimeout(timer.current);
		setAt(null);
	};
	useEffect(() => () => clearTimeout(timer.current), []);

	return (
		<span ref={wrapRef} className="tooltip-wrap" onMouseEnter={() => show(DELAY)} onMouseLeave={hide} onFocus={() => show(0)} onBlur={hide} onMouseDown={hide}>
			{children}
			{at &&
				createPortal(
					<div className="tooltip" role="tooltip" style={{ left: at.x, top: at.y }}>
						<div className="tooltip-label">{label}</div>
						{description && <div className="tooltip-desc">{description}</div>}
					</div>,
					document.body,
				)}
		</span>
	);
}
