import { useEffect, useRef, type ReactNode } from "react";
import { PaneFrame, PaneHeader } from "./PaneFrame.tsx";

export interface Surface {
	id: string;
	label: string;
	icon: ReactNode;
	/** One letter that opens it while the launcher has focus. */
	key: string;
	hint?: string;
	disabled?: boolean;
}

/**
 * What the header's right-panel button opens when no pane is showing: the panes and sidebar panels worth a quick
 * launch. Click one, or press its letter, to open it in place of this list.
 */
export function SurfaceLauncher({
	surfaces,
	onPick,
	expanded,
	onToggleExpand,
	width,
	onResize,
	onClose,
}: {
	surfaces: Surface[];
	onPick: (id: string) => void;
	expanded: boolean;
	onToggleExpand: () => void;
	width: number;
	onResize: (width: number) => void;
	onClose: () => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => listRef.current?.focus(), []);
	const byKey = new Map(surfaces.filter((surface) => !surface.disabled).map((surface) => [surface.key.toLowerCase(), surface.id] as const));

	return (
		<PaneFrame expanded={expanded} width={width} onResize={onResize}>
			<PaneHeader expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose}>
				<span className="pane-title">Open</span>
			</PaneHeader>
			<div className="pane-body launcher-body">
				<div
					ref={listRef}
					className="launcher"
					role="menu"
					aria-label="Open a surface"
					tabIndex={-1}
					onKeyDown={(event) => {
						if (event.ctrlKey || event.metaKey || event.altKey) return;
						const id = byKey.get(event.key.toLowerCase());
						if (id) {
							event.preventDefault();
							onPick(id);
						} else if (event.key === "Escape") {
							event.stopPropagation();
							onClose();
						}
					}}
				>
					<div className="launcher-title">Open a surface</div>
					<div className="launcher-group">
						{surfaces.map((surface) => (
							<button
								key={surface.id}
								type="button"
								role="menuitem"
								className="launcher-item"
								title={surface.hint}
								disabled={surface.disabled}
								onClick={() => onPick(surface.id)}
							>
								{surface.icon}
								<span className="launcher-label">{surface.label}</span>
								<kbd>{surface.key}</kbd>
							</button>
						))}
					</div>
				</div>
			</div>
		</PaneFrame>
	);
}
