// Shape of ~/.sorvex/agent/desktop/settings.json. The server fills in defaults (server/settings.ts), and the
// bridge extension reads `permissions` and `rules` on every tool call.

export type Permission = "allow" | "ask" | "deny";

export interface SafetyRule {
	id: string;
	name: string;
	enabled: boolean;
	target: "bash" | "path";
	pattern: string;
	action: "ask" | "block";
}

export interface Reviewer {
	id: string;
	name: string;
	enabled: boolean;
	/** "provider/modelId"; empty means not configured. */
	model: string;
	/** Run only when the turn called one of these tools; empty means every turn. */
	triggerOnTools: string[];
	/** Earlier messages to include as context. */
	messagesCount: number;
	prompt: string;
}

export interface SpeechEndpoint {
	kind: "openai" | "gemini";
	baseUrl?: string;
	model: string;
	keyProvider?: string;
	voice?: string;
	speed?: number;
	language?: string;
}

export interface VoiceSettings {
	stt: SpeechEndpoint;
	tts: {
		engine: "kokoro" | "api";
		kokoro: { voice: string; speed: number; dtype: "fp32" | "fp16" | "q8" | "q4" };
		api: SpeechEndpoint;
	};
	/** Read replies aloud while voice chat is on. */
	autoSpeak: boolean;
	/** Read every finished reply aloud, also without voice chat. */
	speakReplies: boolean;
	/** RMS level that counts as speech in voice chat. */
	micThreshold: number;
}

export interface SavedPrompt {
	id: string;
	name: string;
	content: string;
}

export interface DesktopSettings {
	permissions: { default: Permission; tools: Record<string, Permission> };
	rules: SafetyRule[];
	reviewers: Reviewer[];
	voice: VoiceSettings;
	prompts: SavedPrompt[];
	notifications: { completions: boolean };
}

export const newId = () => Math.random().toString(36).slice(2, 10);
