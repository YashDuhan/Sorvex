import { Download, FolderOpen, Loader2, Mic, RotateCw, Trash2, Volume2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, serverEvents } from "../api.ts";
import type { DesktopSettings, SpeechEndpoint, VoiceSettings } from "../settings.ts";
import type { SorvexActions, State } from "../store.ts";
import { Mic as Microphone } from "../voice.ts";
import { Select } from "./Select.tsx";
import { VoiceWaveform } from "./Waveforms.tsx";

export type Theme = "dark" | "light" | "system";

export function Setting({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
	return (
		<div className="setting">
			<div className="label">
				{label}
				{hint && <small>{hint}</small>}
			</div>
			{children}
		</div>
	);
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
	return (
		<button
			type="button"
			className={`switch${on ? " on" : ""}`}
			role="switch"
			aria-checked={on}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!on)}
		/>
	);
}

function TextField({ value, onChange, placeholder, width = 220 }: { value: string; onChange: (value: string) => void; placeholder?: string; width?: number }) {
	const [draft, setDraft] = useState(value);
	useEffect(() => setDraft(value), [value]);
	return (
		<input
			className="modal-input"
			style={{ width }}
			value={draft}
			placeholder={placeholder}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => draft !== value && onChange(draft)}
			onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
		/>
	);
}

const STT_PRESETS: Record<string, SpeechEndpoint> = {
	OpenAI: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", keyProvider: "openai" },
	Groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", keyProvider: "groq" },
	Gemini: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", keyProvider: "google" },
	"Local whisper.cpp": { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "whisper-1", keyProvider: "" },
};

const TTS_PRESETS: Record<string, SpeechEndpoint> = {
	Gemini: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash-preview-tts", keyProvider: "google", voice: "Kore", speed: 1 },
	OpenAI: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", keyProvider: "openai", voice: "alloy", speed: 1 },
};

const KOKORO_VOICES = ["af_heart", "af_bella", "af_nicole", "af_sky", "am_michael", "am_fenrir", "bf_emma", "bm_george"];

function VoiceSection({ settings, onChange, actions }: { settings: DesktopSettings; onChange: (voice: VoiceSettings) => void; actions: SorvexActions }) {
	const voice = settings.voice;
	const [kokoro, setKokoro] = useState<{ installed: boolean; installing: boolean }>({ installed: false, installing: false });
	const [testMic, setTestMic] = useState<Microphone | null>(null);
	const setStt = (patch: Partial<SpeechEndpoint>) => onChange({ ...voice, stt: { ...voice.stt, ...patch } });
	const setTts = (patch: Partial<VoiceSettings["tts"]>) => onChange({ ...voice, tts: { ...voice.tts, ...patch } });

	useEffect(() => {
		void api<{ installed: boolean; installing: boolean }>("GET", "/api/kokoro").then(setKokoro).catch(() => undefined);
		return serverEvents.on<{ state: string; error?: string }>("kokoro-install", (event) => {
			if (event.state === "running") setKokoro((current) => ({ ...current, installing: true }));
			if (event.state === "done") setKokoro({ installed: true, installing: false });
			if (event.state === "error") {
				setKokoro((current) => ({ ...current, installing: false }));
				actions.toast("error", `Kokoro install failed: ${event.error}`);
			}
		});
	}, [actions]);

	useEffect(() => () => void testMic?.stop(), [testMic]);

	const preset = Object.entries(STT_PRESETS).find(([, value]) => value.kind === voice.stt.kind && value.baseUrl === voice.stt.baseUrl)?.[0];

	return (
		<section className="card">
			<h2>Voice</h2>
			<p>Dictation (mic button), hands-free voice chat, and read-aloud. Keys come from the Providers page.</p>
			<Setting label="Speech-to-text" hint="Any OpenAI-compatible /audio/transcriptions endpoint, or Gemini">
				<Select
					ariaLabel="Speech-to-text engine"
					value={preset ?? "Custom"}
					options={[
						...Object.entries(STT_PRESETS).map(([name, endpoint]) => ({ value: name, label: name, hint: endpoint.model })),
						...(preset ? [] : [{ value: "Custom", label: "Custom" }]),
					]}
					onChange={(name) => STT_PRESETS[name] && setStt(STT_PRESETS[name]!)}
				/>
			</Setting>
			<Setting label="Endpoint">
				<TextField value={voice.stt.baseUrl ?? ""} onChange={(baseUrl) => setStt({ baseUrl })} width={300} />
			</Setting>
			<Setting label="Model" hint="e.g. gpt-4o-mini-transcribe, whisper-large-v3-turbo, gemini-2.5-flash">
				<TextField value={voice.stt.model} onChange={(model) => setStt({ model })} />
			</Setting>
			<Setting label="Key from provider" hint="Provider id whose stored key to use; empty for a keyless local server">
				<TextField value={voice.stt.keyProvider ?? ""} onChange={(keyProvider) => setStt({ keyProvider })} placeholder="openai" />
			</Setting>
			<Setting label="Language" hint="Optional ISO code, e.g. en">
				<TextField value={voice.stt.language ?? ""} onChange={(language) => setStt({ language })} width={80} />
			</Setting>
			<Setting label="Voice chat sensitivity" hint={`Speech threshold ${voice.micThreshold.toFixed(3)}. Lower picks up quieter speech.`}>
				<input
					type="range"
					min={0.005}
					max={0.08}
					step={0.001}
					value={voice.micThreshold}
					onChange={(event) => onChange({ ...voice, micThreshold: Number(event.target.value) })}
				/>
			</Setting>
			<Setting label="Test microphone">
				<button
					type="button"
					className="btn-ghost"
					onClick={() =>
						testMic
							? (testMic.stop(), setTestMic(null))
							: void Microphone.open("dictation").then(setTestMic, (error: unknown) => actions.toast("error", `Microphone: ${String(error)}`))
					}
				>
					<Mic size={14} /> {testMic ? "Stop" : "Start"}
				</button>
			</Setting>
			{testMic && <VoiceWaveform analyser={testMic.analyser} />}

			<Setting label="Text-to-speech engine">
				<div className="segmented">
					<button type="button" className={voice.tts.engine === "kokoro" ? "on" : ""} onClick={() => setTts({ engine: "kokoro" })}>
						Kokoro (local)
					</button>
					<button type="button" className={voice.tts.engine === "api" ? "on" : ""} onClick={() => setTts({ engine: "api" })}>
						Cloud API
					</button>
				</div>
			</Setting>
			{voice.tts.engine === "kokoro" ? (
				<>
					<Setting
						label="Kokoro"
						hint={
							kokoro.installed
								? "Installed in ~/.sorvex/agent/desktop/kokoro. The model (~90MB at q8) downloads on first use."
								: "Installs kokoro-js (~250MB with its ONNX runtime) into ~/.sorvex/agent/desktop/kokoro."
						}
					>
						{kokoro.installed ? (
							<span className="badge ok">Installed</span>
						) : (
							<button type="button" className="btn-accent" disabled={kokoro.installing} onClick={() => void api("POST", "/api/kokoro/install")}>
								{kokoro.installing ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
								{kokoro.installing ? "Installing..." : "Install"}
							</button>
						)}
					</Setting>
					<Setting label="Voice">
						<Select
							ariaLabel="Kokoro voice"
							width={180}
							value={voice.tts.kokoro.voice}
							options={KOKORO_VOICES.map((name) => ({ value: name, label: name }))}
							onChange={(name) => setTts({ kokoro: { ...voice.tts.kokoro, voice: name } })}
						/>
					</Setting>
					<Setting label="Quality" hint="q8 is fast on CPU; fp32 is the highest quality and largest">
						<Select
							ariaLabel="Kokoro quality"
							width={140}
							value={voice.tts.kokoro.dtype}
							options={["q8", "q4", "fp16", "fp32"].map((dtype) => ({ value: dtype, label: dtype }))}
							onChange={(dtype) => setTts({ kokoro: { ...voice.tts.kokoro, dtype: dtype as VoiceSettings["tts"]["kokoro"]["dtype"] } })}
						/>
					</Setting>
					<Setting label="Speed">
						<input
							type="range"
							min={0.5}
							max={2}
							step={0.05}
							value={voice.tts.kokoro.speed}
							onChange={(event) => setTts({ kokoro: { ...voice.tts.kokoro, speed: Number(event.target.value) } })}
						/>
					</Setting>
				</>
			) : (
				<>
					<Setting label="Service" hint="Gemini TTS, or any OpenAI-compatible /audio/speech endpoint">
						<Select
							ariaLabel="Speech service"
							value={Object.entries(TTS_PRESETS).find(([, preset]) => preset.kind === voice.tts.api.kind && preset.baseUrl === voice.tts.api.baseUrl)?.[0] ?? "Custom"}
							options={[...Object.entries(TTS_PRESETS).map(([name, preset]) => ({ value: name, label: name, hint: preset.model })), { value: "Custom", label: "Custom" }]}
							onChange={(name) => TTS_PRESETS[name] && setTts({ api: TTS_PRESETS[name]! })}
						/>
					</Setting>
					<Setting label="Endpoint">
						<TextField value={voice.tts.api.baseUrl ?? ""} onChange={(baseUrl) => setTts({ api: { ...voice.tts.api, baseUrl } })} width={300} />
					</Setting>
					<Setting label="Model">
						<TextField value={voice.tts.api.model} onChange={(model) => setTts({ api: { ...voice.tts.api, model } })} />
					</Setting>
					<Setting label="Voice" hint="Gemini: Kore, Puck, Charon, Aoede... OpenAI: alloy, nova, shimmer...">
						<TextField value={voice.tts.api.voice ?? ""} onChange={(name) => setTts({ api: { ...voice.tts.api, voice: name } })} />
					</Setting>
					<Setting label="Key from provider">
						<TextField value={voice.tts.api.keyProvider ?? ""} onChange={(keyProvider) => setTts({ api: { ...voice.tts.api, keyProvider } })} />
					</Setting>
				</>
			)}
			<Setting label="Read every reply aloud" hint="Speaks each finished reply, even when you typed the message">
				<Switch on={voice.speakReplies} label="Read every reply aloud" onChange={(speakReplies) => onChange({ ...voice, speakReplies })} />
			</Setting>
			<Setting label="Read replies aloud in voice chat">
				<Switch on={voice.autoSpeak} label="Read replies aloud in voice chat" onChange={(autoSpeak) => onChange({ ...voice, autoSpeak })} />
			</Setting>
			<Setting label="Test voice">
				<button type="button" className="btn-ghost" onClick={() => actions.speak("Hello. This is Sorvex, ready when you are.")}>
					<Volume2 size={14} /> Speak
				</button>
			</Setting>
		</section>
	);
}

interface SorvexSettings {
	steeringMode: string;
	followUpMode: string;
	transport: string;
	cacheWarming: string;
	hideThinking: boolean;
	defaultProjectTrust: string;
	doubleEscapeAction: string;
	compactionEnabled: boolean;
	defaultThinkingLevel: string | null;
	projectTrust: boolean | null;
}

/** The TUI's /settings items that change agent behavior, saved to ~/.sorvex/agent/settings.json. */
function SorvexSettingsSection({ state, actions }: { state: State; actions: SorvexActions }) {
	const [settings, setSettings] = useState<SorvexSettings | null>(null);
	useEffect(() => {
		void api<SorvexSettings>("GET", `/api/sorvex-settings?cwd=${encodeURIComponent(state.cwd)}`).then(setSettings);
	}, [state.cwd]);
	if (!settings) return null;
	const set = (key: keyof SorvexSettings, value: unknown) =>
		void api<SorvexSettings>("PUT", "/api/sorvex-settings", { cwd: state.cwd, key, value }).then(setSettings, (error: unknown) =>
			actions.toast("error", String(error)),
		);
	const choice = (key: keyof SorvexSettings, values: string[], labels?: string[]) => (
		<Select
			width={200}
			value={String(settings[key] ?? "")}
			options={values.map((value, index) => ({ value, label: labels?.[index] ?? value }))}
			onChange={(value) => set(key, value || null)}
		/>
	);
	return (
		<section className="card">
			<h2>Sorvex</h2>
			<p>Shared with the terminal app. Most changes apply to the next session or after Restart.</p>
			<Setting label="Auto-compact" hint="Summarize older context when the window fills up">
				<Switch on={settings.compactionEnabled} label="Auto-compact" onChange={(on) => set("compactionEnabled", on)} />
			</Setting>
			<Setting label="Steering mode" hint="How messages sent while the agent runs are delivered">
				{choice("steeringMode", ["one-at-a-time", "all"])}
			</Setting>
			<Setting label="Follow-up mode" hint="How Alt+Enter follow-ups are delivered">
				{choice("followUpMode", ["one-at-a-time", "all"])}
			</Setting>
			<Setting label="Default thinking level">
				{choice("defaultThinkingLevel", ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"], ["Model default", "off", "minimal", "low", "medium", "high", "xhigh", "max"])}
			</Setting>
			<Setting label="Hide thinking" hint="Also toggled for this window with Ctrl+T">
				<Switch
					on={settings.hideThinking}
					label="Hide thinking"
					onChange={(on) => {
						set("hideThinking", on);
						actions.setUi({ hideThinking: on });
					}}
				/>
			</Setting>
			<Setting label="Transport">{choice("transport", ["auto", "sse", "websocket", "websocket-cached"])}</Setting>
			<Setting label="Cache warming" hint="Keep the prompt cache warm between turns">
				{choice("cacheWarming", ["off", "streaming", "idle"])}
			</Setting>
			<Setting label="Double Escape" hint="What pressing Esc twice opens">
				{choice("doubleEscapeAction", ["tree", "fork", "none"])}
			</Setting>
			<Setting label="Default project trust" hint="Whether new folders may load their .sorvex extensions and MCP servers">
				{choice("defaultProjectTrust", ["ask", "always", "never"])}
			</Setting>
			<Setting label="Trust this folder" hint={<span className="mono">{state.cwd}</span>}>
				<Switch on={settings.projectTrust === true} label="Trust this folder" onChange={(on) => set("projectTrust", on)} />
			</Setting>
		</section>
	);
}

export function SettingsPage({
	state,
	actions,
	theme,
	onTheme,
	onChangeCwd,
}: {
	state: State;
	actions: SorvexActions;
	theme: Theme;
	onTheme: (theme: Theme) => void;
	onChangeCwd: () => void;
}) {
	const autoCompaction = state.session?.autoCompactionEnabled ?? false;
	const settings = state.settings;
	return (
		<div className="page">
			<div className="page-inner">
				<section className="card">
					<h2>Agent</h2>
					<p>The desktop server runs Sorvex in RPC mode with the desktop bridge extension.</p>
					<Setting label="Working directory" hint={<span className="mono">{state.cwd}</span>}>
						<button type="button" className="btn-ghost" onClick={onChangeCwd}>
							<FolderOpen size={14} />
							Change
						</button>
					</Setting>
					<Setting label="Launcher" hint={<span className="mono">{state.launcher ?? "not started"}</span>}>
						<button type="button" className="btn-ghost" onClick={() => void actions.connect(state.cwd)}>
							<RotateCw size={14} />
							Restart
						</button>
					</Setting>
					<Setting label="Auto-compaction" hint="Summarize older context when the window fills up">
						<Switch
							on={autoCompaction}
							label="Auto-compaction"
							disabled={state.connection !== "ready"}
							onChange={(enabled) => void actions.sessionCommand({ type: "set_auto_compaction", enabled })}
						/>
					</Setting>
				</section>
				<SorvexSettingsSection state={state} actions={actions} />
				{settings && <VoiceSection settings={settings} actions={actions} onChange={(voice) => void actions.saveSettings({ ...settings, voice })} />}
				{settings && (
					<section className="card">
						<h2>Notifications</h2>
						<Setting label="Response completions" hint="Get notified when Sorvex has finished a response while the window is in the background. Useful for long-running tasks.">
							<Switch
								on={settings.notifications?.completions !== false}
								label="Response completions"
								onChange={(completions) => void actions.saveSettings({ ...settings, notifications: { ...settings.notifications, completions } })}
							/>
						</Setting>
					</section>
				)}
				<section className="card">
					<h2>Appearance</h2>
					<Setting label="Theme">
						<div className="segmented">
							{(["dark", "light", "system"] as const).map((value) => (
								<button key={value} type="button" className={theme === value ? "on" : ""} onClick={() => onTheme(value)}>
									{value === "dark" ? "Dark" : value === "light" ? "Light" : "System"}
								</button>
							))}
						</div>
					</Setting>
				</section>
			</div>
		</div>
	);
}

export function LogsPage({ state, onClear }: { state: State; onClear: () => void }) {
	return (
		<div className="page">
			<div className="page-inner" style={{ maxWidth: "60rem" }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span className="mono" style={{ flex: 1 }}>
						stderr from {state.launcher ?? "Sorvex"}
					</span>
					<button type="button" className="btn-ghost" onClick={onClear}>
						<Trash2 size={14} />
						Clear
					</button>
				</div>
				<pre className="log">{state.logs.length > 0 ? state.logs.join("\n") : "No output."}</pre>
			</div>
		</div>
	);
}

export function AboutPage() {
	return (
		<div className="page">
			<div className="page-inner" style={{ alignItems: "center", textAlign: "center", paddingTop: "10vh" }}>
				<img src="/logo.svg" alt="" width={72} height={72} style={{ borderRadius: 16 }} />
				<h1 style={{ margin: "8px 0 0", fontSize: 22, color: "var(--text-heading)" }}>Sorvex Desktop</h1>
				<p style={{ margin: 0, color: "var(--text-tertiary)", maxWidth: 420 }}>
					Experimental desktop client for Sorvex, the coding and security agent. A Node server drives the Sorvex CLI over its
					JSONL RPC protocol; the Tauri shell only hosts the window.
				</p>
			</div>
		</div>
	);
}
