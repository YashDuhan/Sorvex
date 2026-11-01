import {
	Box,
	PenTool,
	Camera,
	ChevronLeft,
	Ellipsis,
	Expand,
	House,
	Loader2,
	Moon,
	Power,
	RotateCw,
	SlidersHorizontal,
	Smartphone,
	Square,
	Sun,
	Type,
	Volume1,
	Volume2,
} from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, type WheelEvent } from "react";
import { api, serverEvents } from "../api.ts";
import type { SelectedElement } from "../element.ts";
import { Annotate, type AnnotateSource } from "./Annotate.tsx";
import { Phone3D } from "./DevicePhone3D.tsx";

/**
 * The device itself: Expo Device Hub's H.264 stream decoded with WebCodecs onto a canvas (screenshots every quarter
 * second where WebCodecs is missing), touch, keyboard and scroll input over the same socket, a controls rail, and
 * live CPU, memory and network graphs above the screen.
 */

const SEMU_MAGIC = 0x53454d55;
const SEMU_HEADER = 16;
const HISTORY = 60;

/** Android keycodes for keys that are not typed as text. */
const KEYCODES: Record<string, number> = {
	Enter: 66,
	Backspace: 67,
	Delete: 112,
	Tab: 61,
	ArrowUp: 19,
	ArrowDown: 20,
	ArrowLeft: 21,
	ArrowRight: 22,
	Home: 122,
	End: 123,
	PageUp: 92,
	PageDown: 93,
};

const FONT_SCALES: [number, string][] = [
	[0.85, "Small"],
	[1, "Default"],
	[1.15, "Large"],
	[1.3, "Largest"],
];

interface Sample {
	cpuPct: number;
	memBytes: number;
	netInBytesPerSec: number;
	netOutBytesPerSec: number;
	bundleId?: string;
}

const hub = <T,>(serial: string, path: string, body?: unknown) =>
	api<T>("POST", "/api/device/hub", { serial, path, method: body === undefined ? "GET" : "POST", body });

function avcCodec(sps: Uint8Array): string {
	const hex = (byte: number | undefined) => (byte ?? 0).toString(16).padStart(2, "0");
	return sps.length < 4 ? "avc1.42E01E" : `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** Whether an Annex B access unit holds an IDR slice, and its SPS (NAL type 7) if any. */
function scanUnit(buf: Uint8Array): { key: boolean; sps: Uint8Array | null } {
	let key = false;
	let sps: Uint8Array | null = null;
	for (let i = 0; i + 3 < buf.length; i++) {
		if (buf[i] !== 0 || buf[i + 1] !== 0) continue;
		const start = buf[i + 2] === 1 ? 3 : buf[i + 2] === 0 && buf[i + 3] === 1 ? 4 : 0;
		if (!start) continue;
		const type = buf[i + start]! & 0x1f;
		if (type === 7 && !sps) sps = buf.subarray(i + start);
		if (type === 5) key = true;
		i += start;
	}
	return { key, sps };
}

type StreamState = "connecting" | "streaming" | "error";

/** Connects to the hub's Android socket and paints frames onto the canvas. Returns the socket sender. */
function useDeviceStream(canvas: HTMLCanvasElement | null, port: number, token: string, serial: string, onFrame: { current: (() => void) | null }) {
	const [state, setState] = useState<StreamState>("connecting");
	const [error, setError] = useState("");
	const socketRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!canvas) return;
		let stopped = false;
		let decoder: VideoDecoder | null = null;
		let configuring = false;
		let waitingKey = true;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let poll: ReturnType<typeof setTimeout> | undefined;
		let frameCount = 0;
		const context = canvas.getContext("2d");

		const paint = (source: CanvasImageSource, width: number, height: number) => {
			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
				canvas.dispatchEvent(new Event("framesize"));
			}
			context?.drawImage(source, 0, 0, width, height);
			onFrame.current?.();
			setState("streaming");
		};

		// Without WebCodecs (or when it cannot decode H.264), poll screenshots instead. Input still uses the socket.
		const pollScreenshots = () => {
			if (stopped) return;
			void hub<{ image: string; mimeType: string }>(serial, "/api/screenshot", {})
				.then(async (shot) => {
					const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(shot.image), (c) => c.charCodeAt(0))], { type: shot.mimeType }));
					if (!stopped) paint(bitmap, bitmap.width, bitmap.height);
					bitmap.close();
				})
				.catch(() => undefined)
				.finally(() => {
					if (!stopped) poll = setTimeout(pollScreenshots, 250);
				});
		};
		const fallBack = () => {
			decoder?.close();
			decoder = null;
			if (poll === undefined) pollScreenshots();
		};

		const send = (payload: unknown) => {
			if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(payload));
		};
		const requestKeyframe = () => send({ type: "reset-video", ack: false });

		const configure = async (sps: Uint8Array) => {
			if (typeof VideoDecoder === "undefined") return fallBack();
			configuring = true;
			const config: VideoDecoderConfig = { codec: avcCodec(sps), optimizeForLatency: true };
			const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
			configuring = false;
			if (stopped) return;
			if (!support.supported) return fallBack();
			decoder = new VideoDecoder({
				output: (frame) => {
					if (!stopped) paint(frame, frame.displayWidth, frame.displayHeight);
					frame.close();
				},
				error: () => {
					decoder = null;
					waitingKey = true;
					requestKeyframe();
				},
			});
			decoder.configure(config);
			waitingKey = true;
			requestKeyframe();
		};

		const connect = () => {
			if (stopped) return;
			setState((current) => (current === "streaming" ? current : "connecting"));
			const ws = new WebSocket(`ws://${window.location.hostname}:${port}/vendor/serve-emu/ws?device=${encodeURIComponent(serial)}&frame-meta=1`, [`serve-emu.token.${token}`]);
			ws.binaryType = "arraybuffer";
			socketRef.current = ws;
			ws.onopen = () => {
				if (typeof VideoDecoder === "undefined") fallBack();
				else requestKeyframe();
			};
			ws.onmessage = (event) => {
				if (stopped || socketRef.current !== ws) return;
				if (typeof event.data === "string") {
					// The encoder restarts at a new size after a rotation; rebuild the decoder from the next SPS.
					if (event.data.includes('"video-session"')) {
						decoder?.close();
						decoder = null;
						requestKeyframe();
					}
					return;
				}
				if (poll !== undefined) return;
				let data = new Uint8Array(event.data as ArrayBuffer);
				let key: boolean | null = null;
				let timestamp = frameCount++ * 16667;
				if (data.byteLength > SEMU_HEADER) {
					const view = new DataView(event.data as ArrayBuffer, 0, SEMU_HEADER);
					if (view.getUint32(0, false) === SEMU_MAGIC && view.getUint8(4) === 1) {
						key = (view.getUint8(5) & 1) !== 0;
						const pts = view.getBigUint64(8, false);
						if (pts <= BigInt(Number.MAX_SAFE_INTEGER)) timestamp = Number(pts);
						data = data.subarray(SEMU_HEADER);
					}
				}
				const scanned = key === null || !decoder ? scanUnit(data) : null;
				const isKey = key ?? scanned?.key ?? false;
				if (!decoder || decoder.state !== "configured") {
					if (scanned?.sps && !configuring) void configure(scanned.sps);
					else if (!configuring) requestKeyframe();
					return;
				}
				if (waitingKey && !isKey) return;
				waitingKey = false;
				try {
					decoder.decode(new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp, data }));
				} catch {
					waitingKey = true;
					requestKeyframe();
				}
			};
			ws.onclose = (event) => {
				if (socketRef.current !== ws) return;
				socketRef.current = null;
				if (stopped) return;
				if (event.code === 1008) {
					setState("error");
					setError("The device hub refused the connection. Restart the hub.");
					return;
				}
				retry = setTimeout(connect, 1000);
			};
			ws.onerror = () => ws.close();
		};

		setState("connecting");
		setError("");
		connect();
		return () => {
			stopped = true;
			clearTimeout(retry);
			clearTimeout(poll);
			const ws = socketRef.current;
			socketRef.current = null;
			ws?.close();
			decoder?.close();
		};
	}, [canvas, port, token, serial, onFrame]);

	const send = useCallback((payload: unknown) => {
		if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(payload));
	}, []);
	return { state, error, send };
}

function Sparkline({ values, max, color, fill }: { values: number[]; max: number; color: string; fill?: boolean }) {
	const width = 100;
	const height = 28;
	const top = Math.max(max, ...values, 1e-9);
	// The line spans the card from the first sample; once the history is full it scrolls.
	const points = values.map((value, index) => `${values.length === 1 ? width : (index / (values.length - 1)) * width},${height - 1 - (value / top) * (height - 3)}`);
	if (points.length === 0) return <svg className="dm-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" />;
	const line = points.join(" ");
	const first = points[0]!.split(",")[0];
	return (
		<svg className="dm-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
			{fill && <polygon points={`${first},${height} ${line} ${width},${height}`} fill={color} opacity="0.18" />}
			<polyline points={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
		</svg>
	);
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6).toLocaleString()} MB`;
const rate = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB/s` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(0)} kB/s` : `${Math.round(bytes)} B/s`);

/** CPU, memory and network of the foreground app, from the hub's metrics sampler. */
function Metrics({ serial }: { serial: string }) {
	const [samples, setSamples] = useState<Sample[]>([]);
	const [app, setApp] = useState<{ label?: string | null; packageName?: string; versionName?: string } | null>(null);

	useEffect(() => {
		setSamples([]);
		const watch = () => void api("POST", "/api/device/metrics/watch", { serial }).catch(() => undefined);
		watch();
		const renew = setInterval(watch, 15000);
		const off = serverEvents.on<Sample & { serial: string }>("device-metrics", (sample) => {
			if (sample.serial === serial) setSamples((current) => [...current.slice(-(HISTORY - 1)), sample]);
		});
		return () => {
			clearInterval(renew);
			off();
		};
	}, [serial]);

	const bundle = samples.at(-1)?.bundleId;
	useEffect(() => {
		if (!bundle) return;
		void hub<{ app: { label?: string | null; packageName?: string; versionName?: string } }>(serial, "/api/foreground").then((result) => setApp(result.app), () => undefined);
	}, [serial, bundle]);

	const last = samples.at(-1);
	return (
		<div className="dm-strip">
			<div className="dm-app" title={app?.packageName ?? bundle}>
				<span>{app?.label || app?.packageName || bundle || "Waiting for samples"}</span>
				{app?.versionName && <small>v{app.versionName}</small>}
			</div>
			<div className="dm-cards">
				<div className="dm-card">
					<Sparkline values={samples.map((s) => s.cpuPct)} max={100} color="var(--accent-green)" />
					<div className="dm-label">
						<span>CPU</span>
						<b>{last ? `${Math.round(last.cpuPct)}%` : "–"}</b>
					</div>
				</div>
				<div className="dm-card">
					<Sparkline values={samples.map((s) => s.memBytes)} max={0} color="var(--accent-blue)" fill />
					<div className="dm-label">
						<span>Memory</span>
						<b>{last ? megabytes(last.memBytes) : "–"}</b>
					</div>
				</div>
				<div className="dm-card">
					<Sparkline values={samples.map((s) => s.netInBytesPerSec + s.netOutBytesPerSec)} max={1024} color="var(--accent-purple)" />
					<div className="dm-label">
						<span>Network</span>
						<b>{last ? `↑${rate(last.netOutBytesPerSec)} ↓${rate(last.netInBytesPerSec)}` : "–"}</b>
					</div>
				</div>
			</div>
		</div>
	);
}

function RailButton({ label, onClick, active, role, children }: { label: string; onClick: () => void; active?: boolean; role?: "radio"; children: ReactNode }) {
	return (
		<button
			type="button"
			className={`dr-btn${active ? " on" : ""}`}
			title={label}
			aria-label={label}
			role={role}
			aria-pressed={role ? undefined : active}
			aria-checked={role ? active : undefined}
			onClick={onClick}
		>
			{children}
		</button>
	);
}

/** A popover beside the rail. */
function RailMenu({ label, icon, onOpen, children }: { label: string; icon: ReactNode; onOpen?: () => void; children: (close: () => void) => ReactNode }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);
	return (
		<div className="dr-menu-wrap" ref={ref}>
			<RailButton
				label={label}
				active={open}
				onClick={() => {
					if (!open) onOpen?.();
					setOpen(!open);
				}}
			>
				{icon}
			</RailButton>
			{open && (
				<div className="dr-menu" role="menu">
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}

interface Toggles {
	softwareKeyboard: boolean;
	highTextContrast: boolean;
	reduceMotion: boolean;
	fontWeight: boolean;
	network: boolean;
}

/** From POST /api/device/inspect (server/devices.ts); rect is in fractions of the screen. */
interface DeviceElement {
	rect: { x: number; y: number; width: number; height: number };
	label: string;
	className: string;
	text: string;
	contentDescription: string;
	resourceId: string;
	packageName: string;
	clickable: boolean;
	enabled: boolean;
	bounds: { left: number; top: number; right: number; bottom: number };
	nearby: string[];
}

/** A JPEG of part of the screen, base64 without the data: prefix. */
function crop(canvas: HTMLCanvasElement, rect: DeviceElement["rect"]): string | undefined {
	const width = Math.round(rect.width * canvas.width);
	const height = Math.round(rect.height * canvas.height);
	if (width < 2 || height < 2) return undefined;
	const out = document.createElement("canvas");
	out.width = width;
	out.height = height;
	out.getContext("2d")?.drawImage(canvas, rect.x * canvas.width, rect.y * canvas.height, width, height, 0, 0, width, height);
	return out.toDataURL("image/jpeg", 0.9).replace(/^data:[^,]*,/, "");
}

/** The device's annotation source: its live screen canvas, and elements from the accessibility tree. */
function useDeviceAnnotateSource(canvas: HTMLCanvasElement | null, serial: string): AnnotateSource {
	return useMemo(() => {
		const target = { current: canvas };
		const inspect = (x: number, y: number, full: boolean) =>
			canvas?.width ? api<DeviceElement | null>("POST", "/api/device/inspect", { serial, x: x / canvas.width, y: y / canvas.height, full }) : Promise.resolve(null);
		return {
			target,
			size: () => (canvas?.width ? { width: canvas.width, height: canvas.height } : null),
			snapshot: () => (canvas?.width ? canvas.toDataURL("image/jpeg", 0.92) : null),
			inspect: async (x, y) => {
				const found = await inspect(x, y, false);
				if (!found || !canvas) return null;
				const { rect } = found;
				return { label: found.label, rect: { x: rect.x * canvas.width, y: rect.y * canvas.height, width: rect.width * canvas.width, height: rect.height * canvas.height } };
			},
			select: async (x, y) => {
				const found = await inspect(x, y, true);
				if (!found || !canvas) return null;
				const { left, top, right, bottom } = found.bounds;
				const kind = found.className.split(".").pop() || "View";
				const attribute = (name: string, value: string | boolean) => (value === "" ? "" : ` ${name}="${String(value).replace(/"/g, "&quot;")}"`);
				const image = crop(canvas, found.rect);
				const element: SelectedElement = {
					tag: kind,
					label: found.label,
					text: found.text || found.contentDescription,
					path: found.resourceId,
					styles: {
						class: found.className,
						bounds: `[${left},${top}][${right},${bottom}]`,
						clickable: String(found.clickable),
						enabled: String(found.enabled),
						...(found.contentDescription && found.text ? { "content-desc": found.contentDescription } : {}),
					},
					html: `<node${attribute("class", found.className)}${attribute("text", found.text)}${attribute("content-desc", found.contentDescription)}${attribute("resource-id", found.resourceId)}${attribute("package", found.packageName)} bounds="[${left},${top}][${right},${bottom}]"${attribute("clickable", found.clickable)}${attribute("enabled", found.enabled)} />`,
					siblings: found.nearby.join(" | "),
					url: `android-app://${found.packageName}`,
					hasScreenshot: Boolean(image),
				};
				return { name: found.label, kind: "element", mimeType: "text/plain", data: "", size: element.html.length, element, image };
			},
			fileName: "device-annotation.jpg",
			selectLabel: "Select element: sends its class, text, resource id and a screenshot to the chat",
			emptyMessage: "Wait for the screen to appear",
		};
	}, [canvas, serial]);
}

export function DeviceStage({
	serial,
	name,
	port,
	token,
	onToggleExpand,
	onShutDown,
	onAttached,
	toast,
}: {
	serial: string;
	name: string;
	port: number;
	token: string;
	onToggleExpand: () => void;
	onShutDown: () => void;
	/** After an element or drawing went to the composer, so a full-window pane can step aside. */
	onAttached: () => void;
	toast: (kind: "info" | "error", text: string) => void;
}) {
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
	const annotateSource = useDeviceAnnotateSource(canvas, serial);
	const [annotateBar, setAnnotateBar] = useState(true);
	// While an annotation tool is active the screen shows flat, so picks and drawings line up with it.
	const [annotating, setAnnotating] = useState(false);
	const frameListener = useRef<(() => void) | null>(null);
	const { state, error, send } = useDeviceStream(canvas, port, token, serial, frameListener);
	// 3D or flat (framed): one view at a time, 3D unless the user last picked flat.
	const [threeD, setThreeDState] = useState(() => {
		try {
			return localStorage.getItem("deviceView") !== "flat";
		} catch {
			return true;
		}
	});
	const showThreeD = threeD && !annotating;
	const viewportRef = useRef<HTMLDivElement>(null);
	// The screen keeps its proportions inside the viewport: as large as fits, inside the frame's 10px padding.
	useEffect(() => {
		const viewport = viewportRef.current;
		if (!canvas || !viewport) return;
		const fit = () => {
			if (!canvas.width || !canvas.height) return;
			const style = getComputedStyle(viewport);
			const frame = 20;
			const width = viewport.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - frame;
			const height = viewport.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom) - frame;
			const scale = Math.max(0, Math.min(width / canvas.width, height / canvas.height));
			canvas.style.width = `${Math.floor(canvas.width * scale)}px`;
			canvas.style.height = `${Math.floor(canvas.height * scale)}px`;
		};
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(viewport);
		canvas.addEventListener("framesize", fit);
		return () => {
			observer.disconnect();
			canvas.removeEventListener("framesize", fit);
		};
	}, [canvas]);
	const setThreeD = useCallback((next: boolean) => {
		setThreeDState(next);
		try {
			localStorage.setItem("deviceView", next ? "3d" : "flat");
		} catch {
			// Not remembered.
		}
	}, []);
	const [night, setNight] = useState<boolean | null>(null);
	const [fontScale, setFontScale] = useState(1);
	const [toggles, setToggles] = useState<Partial<Toggles>>({});
	const stageRef = useRef<HTMLDivElement>(null);
	const pointerDown = useRef(false);
	const wheel = useRef({ dy: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined, x: 0.5, y: 0.5 });

	const fail = useCallback((reason: unknown) => toast("error", reason instanceof Error ? reason.message : String(reason)), [toast]);

	useEffect(() => {
		setNight(null);
		void hub<{ night: string }>(serial, "/api/uimode").then((result) => setNight(result.night === "yes"), () => undefined);
		void hub<{ fontScale: { scale: number } }>(serial, "/api/font-scale").then((result) => setFontScale(result.fontScale.scale), () => undefined);
	}, [serial]);

	const loadToggles = () => {
		const read = <K extends keyof Toggles>(key: K, path: string, pick: (result: Record<string, { enabled: boolean }>) => boolean) =>
			void hub<Record<string, { enabled: boolean }>>(serial, path).then((result) => setToggles((current) => ({ ...current, [key]: pick(result) })), () => undefined);
		read("softwareKeyboard", "/api/software-keyboard", (r) => r.softwareKeyboard!.enabled);
		read("highTextContrast", "/api/high-text-contrast", (r) => r.highTextContrast!.enabled);
		read("reduceMotion", "/api/reduce-motion", (r) => r.reduceMotion!.enabled);
		read("fontWeight", "/api/font-weight", (r) => r.fontWeight!.enabled);
		read("network", "/api/network", (r) => r.network!.enabled);
	};

	const setToggle = (key: keyof Toggles, path: string, enabled: boolean) => {
		setToggles((current) => ({ ...current, [key]: enabled }));
		void hub(serial, path, { enabled }).catch((reason: unknown) => {
			setToggles((current) => ({ ...current, [key]: !enabled }));
			fail(reason);
		});
	};

	const point = (event: PointerEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => {
		const target = event.currentTarget;
		const x = event.nativeEvent.offsetX / target.clientWidth;
		const y = event.nativeEvent.offsetY / target.clientHeight;
		return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
	};

	const onPointer = (action: "down" | "move" | "up") => (event: PointerEvent<HTMLCanvasElement>) => {
		if (action === "down") {
			event.currentTarget.setPointerCapture(event.pointerId);
			event.currentTarget.focus();
			pointerDown.current = true;
		} else if (!pointerDown.current) return;
		if (action === "up") pointerDown.current = false;
		send({ type: "touch", action, ...point(event) });
	};

	// Scrolling becomes a short swipe at the pointer, batched so a wheel flick is one gesture.
	const onWheel = (event: WheelEvent<HTMLCanvasElement>) => {
		const state = wheel.current;
		if (state.timer === undefined) Object.assign(state, point(event));
		state.dy += event.deltaY;
		clearTimeout(state.timer);
		state.timer = setTimeout(() => {
			const distance = Math.max(-0.45, Math.min(0.45, -state.dy / 1200));
			const y2 = Math.min(0.97, Math.max(0.03, state.y + distance));
			send({ type: "swipe", x1: state.x, y1: state.y, x2: state.x, y2, durationMs: 160 });
			state.dy = 0;
			state.timer = undefined;
		}, 60);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
		// Shortcuts (Ctrl+V pastes through onPaste) stay with the app.
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		event.preventDefault();
		if (event.key === "Escape") return send({ type: "back" });
		const keycode = KEYCODES[event.key];
		if (keycode !== undefined) return send({ type: "key", keycode });
		if (event.key.length === 1) send({ type: "text", text: event.key });
	};

	const screenshot = () =>
		void hub<{ image: string; mimeType: string }>(serial, "/api/screenshot", {}).then((shot) => {
			const link = document.createElement("a");
			link.href = `data:${shot.mimeType};base64,${shot.image}`;
			link.download = `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
			link.click();
			toast("info", "Screenshot saved to your downloads");
		}, fail);

	return (
		<div className="device-stage-wrap">
			<Metrics serial={serial} />
			<div className="device-stage" ref={stageRef}>
				<div ref={viewportRef} className={`device-viewport${showThreeD ? " three-d" : ""}${annotateBar && state === "streaming" ? " with-annotate" : ""}`}>
					{/* In 3D the decoded screen stays here, hidden, as the texture of the 3D phone. */}
					<div className={`device-shell${showThreeD ? "" : " framed"}`} aria-hidden={showThreeD}>
						<canvas
							ref={setCanvas}
							className="device-screen"
							tabIndex={0}
							aria-label={`${name} screen. Click to interact; type when focused.`}
							onPointerDown={onPointer("down")}
							onPointerMove={onPointer("move")}
							onPointerUp={onPointer("up")}
							onPointerCancel={onPointer("up")}
							onWheel={onWheel}
							onKeyDown={onKeyDown}
							onPaste={(event) => {
								const text = event.clipboardData.getData("text");
								if (text) send({ type: "text", text });
							}}
						/>
						{state !== "streaming" && (
							<div className="device-screen-overlay">
								{state === "error" ? <span>{error}</span> : <Loader2 size={18} className="spin" />}
							</div>
						)}
					</div>
					{showThreeD && canvas && state === "streaming" && (
						<Phone3D
							source={canvas}
							name={name}
							frameListener={frameListener}
							onTouch={(phase, point) => send({ type: "touch", action: phase === "begin" ? "down" : phase === "move" ? "move" : "up", x: point.x, y: point.y })}
							onKeyDown={onKeyDown}
							onPaste={(text) => send({ type: "text", text })}
							onUnavailable={() => {
								setThreeD(false);
								toast("error", "3D view is not available here (WebGL could not start)");
							}}
						/>
					)}
					{annotateBar && state === "streaming" && (
						<Annotate
							source={annotateSource}
							className="device-annotate-bar"
							onClose={() => setAnnotateBar(false)}
							onActiveChange={setAnnotating}
							onAttached={() => {
								onAttached();
								toast("info", "Added to the chat");
							}}
							toast={(kind, message) => toast(kind === "warning" ? "info" : kind, message)}
						/>
					)}
				</div>
				<div className="device-rail" role="toolbar" aria-label="Device controls" aria-orientation="vertical">
					<RailButton label="Home" onClick={() => send({ type: "home" })}>
						<House size={16} />
					</RailButton>
					<RailButton label="Back" onClick={() => send({ type: "back" })}>
						<ChevronLeft size={17} />
					</RailButton>
					<RailButton label="Recent apps" onClick={() => send({ type: "recents" })}>
						<Square size={14} />
					</RailButton>
					<RailButton label="Rotate" onClick={() => void api("POST", "/api/device/rotate", { serial }).catch(fail)}>
						<RotateCw size={15} />
					</RailButton>
					<div className="dr-sep" />
					<RailButton
						label={night ? "Switch the device to light theme" : "Switch the device to dark theme"}
						active={night === true}
						onClick={() => {
							const next = !night;
							setNight(next);
							void hub(serial, "/api/uimode", { night: next ? "yes" : "no" }).catch((reason: unknown) => {
								setNight(!next);
								fail(reason);
							});
						}}
					>
						{night ? <Sun size={15} /> : <Moon size={15} />}
					</RailButton>
					<RailMenu label="Text size" icon={<Type size={15} />}>
						{(close) =>
							FONT_SCALES.map(([scale, label]) => (
								<button
									key={scale}
									type="button"
									role="menuitemradio"
									aria-checked={Math.abs(fontScale - scale) < 0.01}
									className={`dr-item${Math.abs(fontScale - scale) < 0.01 ? " on" : ""}`}
									onClick={() => {
										setFontScale(scale);
										close();
										void hub(serial, "/api/font-scale", { scale }).catch(fail);
									}}
								>
									<span>{label}</span>
									<small>{Math.round(scale * 100)}%</small>
								</button>
							))
						}
					</RailMenu>
					<RailMenu label="Device settings" icon={<SlidersHorizontal size={15} />} onOpen={loadToggles}>
						{() => {
							const row = (key: keyof Toggles, path: string, label: string) => (
								<button
									key={key}
									type="button"
									role="menuitemcheckbox"
									aria-checked={toggles[key] === true}
									className="dr-item"
									disabled={toggles[key] === undefined}
									onClick={() => setToggle(key, path, !toggles[key])}
								>
									<span>{label}</span>
									<span className={`dr-check${toggles[key] ? " on" : ""}`} />
								</button>
							);
							return (
								<>
									{row("softwareKeyboard", "/api/software-keyboard", "On-screen keyboard")}
									{row("fontWeight", "/api/font-weight", "Bold text")}
									{row("highTextContrast", "/api/high-text-contrast", "High-contrast text")}
									{row("reduceMotion", "/api/reduce-motion", "Remove animations")}
									{row("network", "/api/network", "Wi-Fi and mobile data")}
								</>
							);
						}}
					</RailMenu>
					<RailButton label={annotateBar ? "Hide the annotation bar" : "Annotate: select an element or draw"} active={annotateBar} onClick={() => setAnnotateBar(!annotateBar)}>
						<PenTool size={15} />
					</RailButton>
					<RailButton label="Save a screenshot" onClick={screenshot}>
						<Camera size={15} />
					</RailButton>
					<RailMenu label="More" icon={<Ellipsis size={16} />}>
						{(close) => (
							<>
								<button type="button" className="dr-item" onClick={() => send({ type: "key", keycode: 24 })}>
									<span>Volume up</span>
									<Volume2 size={13} />
								</button>
								<button type="button" className="dr-item" onClick={() => send({ type: "key", keycode: 25 })}>
									<span>Volume down</span>
									<Volume1 size={13} />
								</button>
								<button type="button" className="dr-item" onClick={() => send({ type: "power" })}>
									<span>Power button</span>
									<Power size={13} />
								</button>
								<div className="dr-item-sep" />
								<button
									type="button"
									className="dr-item danger"
									onClick={() => {
										close();
										onShutDown();
									}}
								>
									<span>Shut down {name}</span>
								</button>
							</>
						)}
					</RailMenu>
					<div className="dr-sep" />
					<div className="dr-pair" role="radiogroup" aria-label="View">
						<RailButton label="3D view" active={threeD} role="radio" onClick={() => setThreeD(true)}>
							<Box size={15} />
						</RailButton>
						<RailButton label="Flat view" active={!threeD} role="radio" onClick={() => setThreeD(false)}>
							<Smartphone size={15} />
						</RailButton>
					</div>
					<RailButton label="Fill the window" onClick={onToggleExpand}>
						<Expand size={15} />
					</RailButton>
				</div>
			</div>
		</div>
	);
}
