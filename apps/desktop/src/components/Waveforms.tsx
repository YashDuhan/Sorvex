import { useEffect, useRef } from "react";

function useAnimation(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void, active: boolean) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !active) return;
		const context = canvas.getContext("2d");
		if (!context) return;
		let frame = 0;
		const tick = () => {
			const ratio = window.devicePixelRatio || 1;
			const width = canvas.clientWidth;
			const height = canvas.clientHeight;
			if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
				canvas.width = width * ratio;
				canvas.height = height * ratio;
			}
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			context.clearRect(0, 0, width, height);
			draw(context, width, height);
			frame = requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [draw, active]);
	return canvasRef;
}

/** Microphone level meter: thin green bars mirrored around the centre line, like warpdrv's dictation meter. */
export function VoiceWaveform({ analyser }: { analyser: AnalyserNode }) {
	const canvasRef = useAnimation((context, width, height) => {
		const data = new Uint8Array(analyser.frequencyBinCount);
		analyser.getByteFrequencyData(data);
		const bins = data.slice(2, Math.floor(data.length * 0.6));
		const bar = 2;
		const gap = 1;
		const count = Math.floor(width / (bar + gap));
		context.fillStyle = "#10b981";
		for (let i = 0; i < count; i++) {
			// Mirror from the centre outwards so speech looks symmetrical.
			const fromCentre = Math.abs(i - count / 2) / (count / 2);
			const value = bins[Math.floor(fromCentre * (bins.length - 1))]! / 255;
			const barHeight = Math.max(1, value * height);
			context.fillRect(i * (bar + gap), (height - barHeight) / 2, bar, barHeight);
		}
	}, true);
	return <canvas ref={canvasRef} className="voice-waveform" aria-hidden="true" />;
}

/**
 * Glow that rises from the top of the composer while text-to-speech plays. Three blurred passes of a
 * hue-shifting gradient, each scaled by the playback level.
 */
export function FlameWaveform({ analyser, active }: { analyser: AnalyserNode | undefined; active: boolean }) {
	const phase = useRef(0);
	const canvasRef = useAnimation((context, width, height) => {
		const data = new Uint8Array(analyser?.frequencyBinCount ?? 64);
		analyser?.getByteFrequencyData(data);
		phase.current += 0.04;
		const points = 48;
		context.globalCompositeOperation = "lighter";
		for (const [blur, alpha] of [
			[14, 0.35],
			[7, 0.45],
			[2, 0.6],
		] as const) {
			const gradient = context.createLinearGradient(0, 0, width, 0);
			const hue = (phase.current * 40) % 360;
			gradient.addColorStop(0, `hsla(${190 + hue}, 90%, 65%, ${alpha})`);
			gradient.addColorStop(0.35, `hsla(${270 + hue}, 90%, 65%, ${alpha})`);
			gradient.addColorStop(0.7, `hsla(${320 + hue}, 90%, 65%, ${alpha})`);
			gradient.addColorStop(1, `hsla(${380 + hue}, 90%, 65%, ${alpha})`);
			context.filter = `blur(${blur}px)`;
			context.fillStyle = gradient;
			context.beginPath();
			context.moveTo(0, height);
			for (let i = 0; i <= points; i++) {
				const x = (i / points) * width;
				const bin = data[Math.floor((Math.abs(i - points / 2) / (points / 2)) * (data.length * 0.5))] ?? 0;
				const wobble = Math.sin(i * 0.45 + phase.current * 3) * 0.15 + 0.85;
				context.lineTo(x, height - (bin / 255) * height * wobble);
			}
			context.lineTo(width, height);
			context.closePath();
			context.fill();
		}
		context.filter = "none";
		context.globalCompositeOperation = "source-over";
	}, active);
	if (!active) return null;
	return <canvas ref={canvasRef} className="flame-waveform" aria-hidden="true" />;
}
