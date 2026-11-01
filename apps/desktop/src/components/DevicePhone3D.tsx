import { type KeyboardEvent, type MouseEvent, useEffect, useRef } from "react";
import { createPhoneInteraction } from "../device3d/phoneInteraction.ts";
import { createPhoneViewer, type PhoneViewer } from "../device3d/phoneViewer.ts";
import { bindPhoneTrackpad } from "../device3d/phoneTrackpad.ts";
import { resolveDeviceShape } from "../device3d/shapeProfile.ts";

type Point = { x: number; y: number };

/** Landscape frames turn the phone on its side, the way the emulator's rotate does. */
function screenOf(source: HTMLCanvasElement) {
	const { width, height } = source;
	return { width, height, orientation: width > height ? ("landscape_left" as const) : ("portrait" as const) };
}

/**
 * The device as a 3D phone, using t3code's viewer (src/device3d): the live screen is the phone's display texture.
 * Drag the screen to touch it; drag around the phone, or scroll with two fingers, to turn it a full 360 degrees with
 * momentum; it settles back toward the front. Double-click around the phone to face it again.
 */
export function Phone3D({
	source,
	name,
	frameListener,
	onTouch,
	onKeyDown,
	onPaste,
	onUnavailable,
}: {
	source: HTMLCanvasElement;
	name: string;
	frameListener: { current: (() => void) | null };
	onTouch: (phase: "begin" | "move" | "end", point: Point) => void;
	onKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => void;
	onPaste: (text: string) => void;
	onUnavailable: () => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const viewerRef = useRef<PhoneViewer | null>(null);
	const interactionRef = useRef<ReturnType<typeof createPhoneInteraction> | null>(null);
	// The latest callbacks, so the viewer is built once per canvas.
	const touchRef = useRef(onTouch);
	touchRef.current = onTouch;
	const unavailableRef = useRef(onUnavailable);
	unavailableRef.current = onUnavailable;

	useEffect(() => {
		const canvas = canvasRef.current;
		const host = canvas?.parentElement;
		if (!canvas || !host) return;
		let viewer: PhoneViewer;
		try {
			viewer = createPhoneViewer({ canvas, source, onUnavailable: () => unavailableRef.current() });
		} catch {
			unavailableRef.current();
			return;
		}
		viewerRef.current = viewer;
		let shapeAspect = 0;
		const syncScreen = () => {
			const aspect = Math.min(source.width, source.height) / Math.max(source.width, source.height || 1);
			if (aspect !== shapeAspect) {
				shapeAspect = aspect;
				viewer.setScreen(screenOf(source), resolveDeviceShape({ name, portraitAspect: aspect }));
			}
		};
		syncScreen();
		const interaction = createPhoneInteraction({
			screenPoint: (point, captured) => viewer.screenPoint(point.x, point.y, captured),
			touch: (phase, point) => touchRef.current(phase, point),
			orbit: viewer.orbit,
			zoomBy: () => {},
			onInteractionActive: viewer.setInteractionActive,
		});
		interactionRef.current = interaction;
		const resize = () => {
			const { width, height } = host.getBoundingClientRect();
			viewer.resize(width, height, window.devicePixelRatio);
		};
		const observer = new ResizeObserver(resize);
		observer.observe(host);
		resize();
		const trackpad = bindPhoneTrackpad(canvas, interaction);
		const blur = () => {
			interaction.end();
			trackpad.cancel();
		};
		window.addEventListener("blur", blur);
		frameListener.current = () => {
			syncScreen();
			viewer.frameUpdated();
		};
		viewer.frameUpdated();
		return () => {
			frameListener.current = null;
			window.removeEventListener("blur", blur);
			observer.disconnect();
			trackpad.dispose();
			interaction.end();
			interactionRef.current = null;
			viewer.dispose();
			viewerRef.current = null;
		};
	}, [source, name, frameListener]);

	const point = (event: MouseEvent<HTMLCanvasElement>): Point => {
		const rect = event.currentTarget.getBoundingClientRect();
		return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
	};

	return (
		<div className="device-3d">
			<div className="device-3d-shadow" aria-hidden="true" />
			<canvas
				ref={canvasRef}
				className="device-3d-canvas"
				tabIndex={0}
				aria-label={`${name} in 3D. Drag the screen to interact. Drag around the phone, or scroll with two fingers, to turn it.`}
				onPointerDown={(event) => {
					if (event.button !== 0) return;
					if (!interactionRef.current?.begin(event.pointerId, point(event), event.altKey)) return;
					event.preventDefault();
					event.currentTarget.setPointerCapture(event.pointerId);
					event.currentTarget.focus();
				}}
				onPointerMove={(event) => interactionRef.current?.move(event.pointerId, point(event))}
				onPointerUp={(event) => {
					interactionRef.current?.move(event.pointerId, point(event));
					interactionRef.current?.end(event.pointerId);
				}}
				onPointerCancel={(event) => interactionRef.current?.end(event.pointerId)}
				onLostPointerCapture={(event) => interactionRef.current?.end(event.pointerId)}
				onDoubleClick={(event) => {
					const at = point(event);
					if (!viewerRef.current?.screenPoint(at.x, at.y)) viewerRef.current?.resetPose();
				}}
				onKeyDown={onKeyDown}
				onPaste={(event) => {
					const text = event.clipboardData.getData("text");
					if (text) onPaste(text);
				}}
			/>
		</div>
	);
}
