// Sorvex Desktop local text-to-speech server. The app copies this file into ~/.sorvex/agent/desktop/kokoro,
// installs kokoro-js next to it, and runs it with plain `node`. JSONL on stdin/stdout:
//   {"id":"1","type":"speak","text":"...","voice":"af_heart","speed":1,"dtype":"q8"}
//   -> {"type":"chunk","id":"1","audio":"<base64 wav>"} ... then {"type":"response","id":"1","success":true}
//   {"type":"abort","id":"1"} stops an utterance between chunks.
// The model (Kokoro-82M ONNX) downloads from Hugging Face on first use and is cached by transformers.js.

import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const models = new Map();
const aborted = new Set();

function write(record) {
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

function load(dtype) {
	if (!models.has(dtype)) models.set(dtype, KokoroTTS.from_pretrained(MODEL_ID, { dtype, device: "cpu" }));
	return models.get(dtype);
}

async function speak(request) {
	const tts = await load(request.dtype || "q8");
	const splitter = new TextSplitterStream();
	const stream = tts.stream(splitter, { voice: request.voice || "af_heart", speed: request.speed || 1 });
	splitter.push(request.text);
	splitter.close();
	for await (const { audio } of stream) {
		if (aborted.has(request.id)) break;
		write({ type: "chunk", id: request.id, audio: Buffer.from(audio.toWav()).toString("base64") });
	}
	aborted.delete(request.id);
}

async function handle(request) {
	if (request.type === "abort") {
		aborted.add(request.id);
		return;
	}
	try {
		if (request.type === "voices") {
			const tts = await load(request.dtype || "q8");
			write({ type: "response", id: request.id, success: true, data: Object.keys(tts.voices) });
		} else if (request.type === "speak") {
			await speak(request);
			write({ type: "response", id: request.id, success: true });
		} else {
			throw new Error(`Unknown request ${request.type}`);
		}
	} catch (error) {
		write({ type: "response", id: request.id, success: false, error: String(error?.message ?? error) });
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).replace(/\r$/, "");
		buffer = buffer.slice(newline + 1);
		if (line.trim()) void handle(JSON.parse(line));
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
write({ type: "ready" });
