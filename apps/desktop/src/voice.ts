import { api, serverEvents } from "./api.ts";
import type { VoiceSettings } from "./settings.ts";

const TARGET_RATE = 16000;

/** Mono 16-bit PCM WAV at 16 kHz, accepted by OpenAI, Groq, whisper.cpp and Gemini alike. */
function encodeWav(samples: Float32Array, sampleRate: number): string {
	const ratio = sampleRate / TARGET_RATE;
	const length = Math.floor(samples.length / ratio);
	const buffer = new ArrayBuffer(44 + length * 2);
	const view = new DataView(buffer);
	const text = (offset: number, value: string) => {
		for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
	};
	text(0, "RIFF");
	view.setUint32(4, 36 + length * 2, true);
	text(8, "WAVE");
	text(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, TARGET_RATE, true);
	view.setUint32(28, TARGET_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, "data");
	view.setUint32(40, length * 2, true);
	for (let i = 0; i < length; i++) {
		// Average the source samples that fall into this output sample (a simple low-pass before decimation).
		const start = Math.floor(i * ratio);
		const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
		let sum = 0;
		for (let j = start; j < end; j++) sum += samples[j]!;
		const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
		view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
	}
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

function concat(chunks: Float32Array[]): Float32Array {
	const out = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export interface MicCallbacks {
	/** Voice-chat mode only: the user started talking (used to barge in over speech). */
	onSpeechStart?: () => void;
	/** Voice-chat mode only: one utterance finished. */
	onUtterance?: (wavBase64: string) => void;
}

/**
 * Microphone capture. In "dictation" mode it records until `stop()` and returns one WAV. In "voice" mode it
 * listens continuously and cuts utterances with a simple energy detector: speech starts after a few frames
 * above the threshold and ends after ~0.9s below it, keeping a short pre-roll so first syllables survive.
 */
export class Mic {
	readonly analyser: AnalyserNode;
	private readonly context: AudioContext;
	private readonly stream: MediaStream;
	private readonly processor: ScriptProcessorNode;
	private chunks: Float32Array[] = [];
	private preRoll: Float32Array[] = [];
	private speaking = false;
	private loudFrames = 0;
	private quietSince = 0;

	private constructor(context: AudioContext, stream: MediaStream, mode: "dictation" | "voice", threshold: number, callbacks: MicCallbacks) {
		this.context = context;
		this.stream = stream;
		const source = context.createMediaStreamSource(stream);
		this.analyser = context.createAnalyser();
		this.analyser.fftSize = 256;
		source.connect(this.analyser);
		this.processor = context.createScriptProcessor(4096, 1, 1);
		source.connect(this.processor);
		this.processor.connect(context.destination);
		const frameMs = (4096 / context.sampleRate) * 1000;

		this.processor.onaudioprocess = (event) => {
			const frame = new Float32Array(event.inputBuffer.getChannelData(0));
			if (mode === "dictation") {
				this.chunks.push(frame);
				return;
			}
			let energy = 0;
			for (const sample of frame) energy += sample * sample;
			const rms = Math.sqrt(energy / frame.length);
			const now = performance.now();
			if (!this.speaking) {
				this.preRoll.push(frame);
				if (this.preRoll.length > Math.ceil(300 / frameMs)) this.preRoll.shift();
				this.loudFrames = rms > threshold ? this.loudFrames + 1 : 0;
				if (this.loudFrames >= 2) {
					this.speaking = true;
					this.chunks = [...this.preRoll];
					this.preRoll = [];
					this.quietSince = 0;
					callbacks.onSpeechStart?.();
				}
				return;
			}
			this.chunks.push(frame);
			if (rms > threshold * 0.7) {
				this.quietSince = 0;
			} else if (!this.quietSince) {
				this.quietSince = now;
			} else if (now - this.quietSince > 900) {
				this.speaking = false;
				const audio = concat(this.chunks);
				this.chunks = [];
				// Ignore blips shorter than ~0.4s of audio.
				if (audio.length > this.context.sampleRate * 0.4) callbacks.onUtterance?.(encodeWav(audio, this.context.sampleRate));
			}
		};
	}

	static async open(mode: "dictation" | "voice", threshold = 0.02, callbacks: MicCallbacks = {}): Promise<Mic> {
		const stream = await navigator.mediaDevices.getUserMedia({
			audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
		});
		const context = new AudioContext();
		return new Mic(context, stream, mode, threshold, callbacks);
	}

	/** Stops capture and returns the dictation recording (empty string in voice mode). */
	stop(): string {
		this.processor.disconnect();
		for (const track of this.stream.getTracks()) track.stop();
		void this.context.close();
		const audio = concat(this.chunks);
		return audio.length > 0 ? encodeWav(audio, this.context.sampleRate) : "";
	}
}

export function transcribe(settings: VoiceSettings, audio: string): Promise<string> {
	return api<{ text: string }>("POST", "/api/voice/transcribe", { endpoint: settings.stt, audio, mimeType: "audio/wav" }).then(
		(result) => result.text,
	);
}

/** Markdown and code are noise when spoken. */
export function speakableText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " (code omitted) ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.|>)\s+/gm, "")
		.replace(/[*_~|]/g, "")
		.replace(/\n{2,}/g, "\n")
		.trim();
}

type SpeakerListener = (speaking: boolean) => void;

/**
 * Plays text-to-speech. Kokoro audio streams in chunks over server events and plays in order; the API engine
 * returns one clip. All playback goes through one AnalyserNode so the composer can draw the flame waveform.
 */
class Speaker {
	analyser: AnalyserNode | undefined;
	private context: AudioContext | undefined;
	private queue: string[] = [];
	private current: HTMLAudioElement | undefined;
	private streamId: string | undefined;
	private streamDone = true;
	private listeners = new Set<SpeakerListener>();
	private token = 0;

	constructor() {
		serverEvents.on<{ streamId: string; audio?: string; done?: boolean; error?: string }>("kokoro", (event) => {
			if (event.streamId !== this.streamId) return;
			if (event.audio) {
				this.queue.push(event.audio);
				if (!this.current) this.playNext();
			}
			if (event.done) {
				this.streamDone = true;
				if (event.error) console.error("Kokoro:", event.error);
				if (!this.current && this.queue.length === 0) this.setSpeaking(false);
			}
		});
	}

	get speaking(): boolean {
		return this.current !== undefined || !this.streamDone;
	}

	subscribe(listener: SpeakerListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async speak(text: string, settings: VoiceSettings): Promise<void> {
		this.stop();
		const spoken = speakableText(text);
		if (!spoken) return;
		const token = ++this.token;
		this.setSpeaking(true);
		try {
			if (settings.tts.engine === "kokoro") {
				const { voice, speed, dtype } = settings.tts.kokoro;
				this.streamDone = false;
				const { streamId } = await api<{ streamId: string }>("POST", "/api/kokoro/speak", { text: spoken, voice, speed, dtype });
				if (token !== this.token) return;
				this.streamId = streamId;
			} else {
				const { audio } = await api<{ audio: string }>("POST", "/api/voice/speak", { endpoint: settings.tts.api, text: spoken });
				if (token !== this.token) return;
				this.streamDone = true;
				this.queue.push(audio);
				this.playNext();
			}
		} catch (error) {
			this.streamDone = true;
			this.setSpeaking(false);
			throw error;
		}
	}

	stop(): void {
		this.token++;
		if (this.streamId) void api("POST", "/api/kokoro/abort", { streamId: this.streamId }).catch(() => undefined);
		this.streamId = undefined;
		this.streamDone = true;
		this.queue = [];
		this.current?.pause();
		this.current = undefined;
		this.setSpeaking(false);
	}

	private playNext(): void {
		const next = this.queue.shift();
		if (!next) {
			this.current = undefined;
			if (this.streamDone) this.setSpeaking(false);
			return;
		}
		if (!this.context) {
			this.context = new AudioContext();
			this.analyser = this.context.createAnalyser();
			this.analyser.fftSize = 256;
			this.analyser.connect(this.context.destination);
		}
		const audio = new Audio(`data:audio/wav;base64,${next}`);
		this.context.createMediaElementSource(audio).connect(this.analyser!);
		this.current = audio;
		audio.onended = () => this.playNext();
		audio.onerror = () => this.playNext();
		void this.context.resume().then(() => audio.play()).catch(() => this.playNext());
	}

	private setSpeaking(speaking: boolean): void {
		for (const listener of this.listeners) listener(speaking);
	}
}

export const speaker = new Speaker();
