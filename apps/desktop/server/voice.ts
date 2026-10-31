import type { Credentials } from "./credentials.ts";

/**
 * A speech endpoint. "openai" covers any OpenAI-compatible server: OpenAI, Groq, or a local whisper.cpp
 * `whisper-server`. "gemini" sends the audio to Gemini's generateContent and asks for a transcript.
 */
export interface SpeechEndpoint {
	kind: "openai" | "gemini";
	baseUrl?: string;
	model: string;
	/** Provider id whose stored credential supplies the key, e.g. "openai", "groq", "google". Empty for none. */
	keyProvider?: string;
	voice?: string;
	speed?: number;
	language?: string;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

export async function transcribe(
	credentials: Credentials,
	endpoint: SpeechEndpoint,
	audioBase64: string,
	mimeType: string,
): Promise<string> {
	if (endpoint.kind === "gemini") {
		const apiKey = await credentials.keyFor(endpoint.keyProvider || "google");
		const base = trimSlash(endpoint.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
		const response = await fetch(`${base}/models/${encodeURIComponent(endpoint.model)}:generateContent`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{
								text: "Transcribe the speech in this audio verbatim. Put only the spoken words in `transcript`. If there is no intelligible speech, return an empty transcript.",
							},
							{ inline_data: { mime_type: mimeType, data: audioBase64 } },
						],
					},
				],
				// A JSON schema keeps commentary such as "I cannot hear anything" out of the transcript.
				generationConfig: {
					temperature: 0,
					responseMimeType: "application/json",
					responseSchema: { type: "OBJECT", properties: { transcript: { type: "STRING" } }, required: ["transcript"] },
				},
			}),
		});
		if (!response.ok) throw new Error(`Gemini transcription failed (${response.status}): ${await response.text()}`);
		const body = (await response.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
		const raw = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
		try {
			return String((JSON.parse(raw) as { transcript?: unknown }).transcript ?? "").trim();
		} catch {
			return "";
		}
	}

	const apiKey = await credentials.keyFor(endpoint.keyProvider);
	const form = new FormData();
	const audio = Buffer.from(audioBase64, "base64");
	form.append("file", new Blob([audio], { type: mimeType }), mimeType.includes("wav") ? "audio.wav" : "audio.webm");
	form.append("model", endpoint.model);
	form.append("response_format", "json");
	if (endpoint.language) form.append("language", endpoint.language);
	const response = await fetch(`${trimSlash(endpoint.baseUrl || "https://api.openai.com/v1")}/audio/transcriptions`, {
		method: "POST",
		headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
		body: form,
	});
	if (!response.ok) throw new Error(`Transcription failed (${response.status}): ${await response.text()}`);
	return (((await response.json()) as { text?: string }).text ?? "").trim();
}

/** Wraps raw 16-bit little-endian mono PCM in a WAV header. */
function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** Gemini's TTS models return raw PCM (audio/L16, usually 24 kHz) through generateContent. */
async function speakGemini(credentials: Credentials, endpoint: SpeechEndpoint, text: string): Promise<string> {
	const apiKey = await credentials.keyFor(endpoint.keyProvider || "google");
	const base = trimSlash(endpoint.baseUrl || "https://generativelanguage.googleapis.com/v1beta");
	const response = await fetch(`${base}/models/${encodeURIComponent(endpoint.model)}:generateContent`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-goog-api-key": apiKey ?? "" },
		body: JSON.stringify({
			contents: [{ parts: [{ text }] }],
			generationConfig: {
				responseModalities: ["AUDIO"],
				speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: endpoint.voice || "Kore" } } },
			},
		}),
	});
	if (!response.ok) throw new Error(`Gemini speech failed (${response.status}): ${await response.text()}`);
	const body = (await response.json()) as {
		candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
	};
	const audio = body.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
	if (!audio?.data) throw new Error(`Gemini returned no audio: ${JSON.stringify(body).slice(0, 300)}`);
	const rate = Number(/rate=(\d+)/.exec(audio.mimeType ?? "")?.[1] ?? 24000);
	return pcmToWav(Buffer.from(audio.data, "base64"), rate).toString("base64");
}

/** OpenAI-compatible `/audio/speech`, or Gemini TTS. Returns base64 WAV. */
export async function speak(credentials: Credentials, endpoint: SpeechEndpoint, text: string): Promise<string> {
	// Gemini's preview TTS model occasionally answers with no audio part; one retry covers it.
	if (endpoint.kind === "gemini") return speakGemini(credentials, endpoint, text).catch(() => speakGemini(credentials, endpoint, text));
	const apiKey = await credentials.keyFor(endpoint.keyProvider);
	const response = await fetch(`${trimSlash(endpoint.baseUrl || "https://api.openai.com/v1")}/audio/speech`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
		body: JSON.stringify({
			model: endpoint.model,
			voice: endpoint.voice || "alloy",
			input: text,
			response_format: "wav",
			speed: endpoint.speed ?? 1,
		}),
	});
	if (!response.ok) throw new Error(`Speech failed (${response.status}): ${await response.text()}`);
	return Buffer.from(await response.arrayBuffer()).toString("base64");
}
