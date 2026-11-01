// Ported from t3code (https://github.com/pingdotgg/t3code), packages/client-runtime/src/device/phoneViewer.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see LICENSE-t3code in this folder.
// Changes: only the procedural phone. Imported device models, accessories and foldables are left out.
import {
	AmbientLight,
	Box3,
	CanvasTexture,
	DirectionalLight,
	LinearFilter,
	PerspectiveCamera,
	Quaternion,
	Scene,
	SRGBColorSpace,
	WebGLRenderer,
} from "three";
import { createDeviceFraming } from "./deviceFraming.ts";
import { createDeviceMotion } from "./deviceMotion.ts";
import { nearestDeviceView } from "./deviceViewSnap.ts";
import { createPhoneScene, type DeviceScreenSize, phoneDisplayLayout } from "./phoneScene.ts";
import { createRenderScheduler } from "./renderScheduler.ts";
import { ANDROID_PHONE_SHAPE, type DeviceShapeProfile } from "./shapeProfile.ts";

export interface PhoneViewer {
	readonly frameUpdated: () => void;
	readonly setScreen: (screen: DeviceScreenSize | null, profile?: DeviceShapeProfile) => void;
	readonly resize: (width: number, height: number, pixelRatio: number) => void;
	readonly screenPoint: (x: number, y: number, captured?: boolean) => { x: number; y: number } | null;
	readonly orbit: (deltaX: number, deltaY: number) => void;
	readonly setInteractionActive: (active: boolean, mode: "touch" | "orbit") => void;
	readonly resetPose: () => void;
	readonly dispose: () => void;
}

const ANDROID_ORIENTATION_TURN_MS = 450;

/** Owns only presentation resources. The caller retains the decoded canvas and the stream connection. */
export function createPhoneViewer(options: {
	readonly canvas: HTMLCanvasElement;
	readonly source: HTMLCanvasElement;
	readonly onUnavailable: () => void;
	readonly profile?: DeviceShapeProfile;
}): PhoneViewer {
	const renderer = new WebGLRenderer({
		canvas: options.canvas,
		alpha: true,
		antialias: true,
		powerPreference: "low-power",
	});
	renderer.outputColorSpace = SRGBColorSpace;
	const makeTexture = () => {
		const next = new CanvasTexture(options.source);
		next.colorSpace = SRGBColorSpace;
		next.minFilter = LinearFilter;
		next.magFilter = LinearFilter;
		next.generateMipmaps = false;
		return next;
	};
	let texture = makeTexture();
	let textureWidth = options.source.width;
	let textureHeight = options.source.height;
	const scene = new Scene();
	const camera = new PerspectiveCamera(32, 1, 0.1, 30);
	camera.position.z = 5.5;
	const ambient = new AmbientLight(0xffffff, 2.4);
	const key = new DirectionalLight(0xe4edff, 5);
	key.position.set(-3, 4, 5);
	const rim = new DirectionalLight(0xffffff, 4);
	rim.position.set(3, 1, -3);
	const fill = new DirectionalLight(0x9facd4, 2);
	fill.position.set(-2, -2, -4);
	scene.add(ambient, key, rim, fill);

	let screen: DeviceScreenSize | null = null;
	let layout = phoneDisplayLayout(screen, options.source.width, options.source.height);
	let profile = options.profile ?? ANDROID_PHONE_SHAPE;
	let orientationAngle = layout.rotation;
	let orientationTurn: { from: number; to: number; startedAt: number } | null = null;
	let phone = createPhoneScene(texture, layout, profile);
	scene.add(phone.root);
	let disposed = false;
	const rest = new Quaternion();
	const motion = createDeviceMotion({
		choose: (rotation) => nearestDeviceView(rotation, [{ rotation: new Quaternion(), yawLimit: Math.PI / 3 }])!.rotation,
	});
	motion.setPose(rest, performance.now(), true);
	const framing = createDeviceFraming();
	const reducedMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	let viewport = { width: 0, height: 0, pixelRatio: 1 };
	let drawingBuffer = { width: 0, height: 0, pixelRatio: 0 };

	const fit = (immediate = false) => {
		if (!viewport.width || !viewport.height) return;
		camera.aspect = viewport.width / viewport.height;
		phone.root.updateMatrixWorld(true);
		framing.setBounds(new Box3().setFromObject(phone.root), (camera.fov * Math.PI) / 360, camera.aspect, performance.now(), immediate);
		applyCamera();
	};
	const applyCamera = () => {
		camera.position.set(framing.center.x, framing.center.y, framing.distance());
		camera.lookAt(framing.center.x, framing.center.y, 0);
		camera.updateProjectionMatrix();
	};
	const applyPose = () => {
		phone.root.quaternion.copy(motion.rotation);
		phone.orientation.rotation.z = orientationAngle;
	};
	const scheduler = createRenderScheduler(() => {
		if (disposed || !viewport.width || !viewport.height) return;
		try {
			if (drawingBuffer.width !== viewport.width || drawingBuffer.height !== viewport.height || drawingBuffer.pixelRatio !== viewport.pixelRatio) {
				// Canvas allocation clears the previous image. Commit it with the redraw,
				// rather than exposing an empty buffer between ResizeObserver and the next frame.
				renderer.setDrawingBufferSize(viewport.width, viewport.height, viewport.pixelRatio);
				drawingBuffer = viewport;
			}
			const now = performance.now();
			if (motion.advance(now, reducedMotion())) {
				applyPose();
				fit(reducedMotion());
			}
			if (orientationTurn) {
				const progress = Math.min(1, (now - orientationTurn.startedAt) / ANDROID_ORIENTATION_TURN_MS);
				const eased = progress * progress * (3 - 2 * progress);
				orientationAngle = orientationTurn.from + (orientationTurn.to - orientationTurn.from) * eased;
				if (progress === 1) orientationTurn = null;
				applyPose();
				fit(reducedMotion());
			}
			framing.advance(now, reducedMotion());
			applyCamera();
			renderer.render(scene, camera);
			if (motion.needsFrame() || framing.needsFrame() || orientationTurn) scheduler.invalidate();
		} catch {
			options.onUnavailable();
		}
	});
	const updateLayout = (nextProfile = profile) => {
		const next = phoneDisplayLayout(screen, options.source.width, options.source.height);
		const resized = textureWidth !== options.source.width || textureHeight !== options.source.height;
		if (resized || nextProfile !== profile || next.aspect !== layout.aspect || next.rawLandscape !== layout.rawLandscape || next.rotation !== layout.rotation) {
			if (resized) {
				const previous = texture;
				texture = makeTexture();
				textureWidth = options.source.width;
				textureHeight = options.source.height;
				phone.setDisplay(texture, next);
				previous.dispose();
			}
			if (nextProfile !== profile || next.aspect !== layout.aspect) {
				scene.remove(phone.root);
				phone.dispose();
				phone = createPhoneScene(texture, next, nextProfile);
				scene.add(phone.root);
			} else {
				phone.setDisplay(texture, next);
			}
			if (next.rotation !== layout.rotation) {
				if (!reducedMotion()) {
					const difference = Math.atan2(Math.sin(next.rotation - orientationAngle), Math.cos(next.rotation - orientationAngle));
					orientationTurn = { from: orientationAngle, to: orientationAngle + difference, startedAt: performance.now() };
				} else {
					orientationTurn = null;
					orientationAngle = next.rotation;
				}
			}
			layout = next;
			profile = nextProfile;
			applyPose();
			fit(!orientationTurn);
		}
		applyPose();
	};
	const contextLost = (event: Event) => {
		event.preventDefault();
		options.onUnavailable();
	};
	options.canvas.addEventListener("webglcontextlost", contextLost);
	applyPose();
	return {
		frameUpdated() {
			if (disposed) return;
			updateLayout();
			texture.needsUpdate = true;
			scheduler.invalidate();
		},
		setScreen(next, nextProfile = profile) {
			if (disposed) return;
			screen = next;
			updateLayout(nextProfile);
			scheduler.invalidate();
		},
		resize(width, height, pixelRatio) {
			if (disposed) return;
			if (![width, height, pixelRatio].every(Number.isFinite) || width <= 0 || height <= 0) return;
			const ratio = Math.min(2, Math.max(1, pixelRatio));
			if (viewport.width === width && viewport.height === height && viewport.pixelRatio === ratio) return;
			viewport = { width, height, pixelRatio: ratio };
			fit(true);
			scheduler.invalidate();
		},
		screenPoint(x, y, captured = false) {
			if (disposed) return null;
			applyPose();
			return phone.screenPoint(x, y, camera, captured);
		},
		orbit(deltaX, deltaY) {
			if (disposed) return;
			motion.orbit(deltaX * viewport.width, deltaY * viewport.height, performance.now());
			scheduler.invalidate();
		},
		setInteractionActive(active, mode) {
			if (disposed) return;
			const now = performance.now();
			if (mode === "orbit") motion.dragActive(active, now);
			else {
				motion.hold(active, now);
				framing.hold(active, now);
			}
			scheduler.invalidate();
		},
		resetPose() {
			if (disposed) return;
			motion.reset(rest, performance.now());
			scheduler.invalidate();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			scheduler.dispose();
			options.canvas.removeEventListener("webglcontextlost", contextLost);
			scene.remove(phone.root);
			phone.dispose();
			texture.dispose();
			renderer.dispose();
			renderer.forceContextLoss();
		},
	};
}
