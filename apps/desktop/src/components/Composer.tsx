import { AlertTriangle, Bot, Check, ChevronDown, FileText, Loader2, Mic, MicOff, Search, SendHorizonal, Shield, ShieldOff, ShieldQuestion, Square, VolumeX, X } from "lucide-react";
import {
	type ClipboardEvent,
	type CSSProperties,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FaShieldAlt } from "react-icons/fa";
import { ImAttachment } from "react-icons/im";
import { RiVoiceprintLine } from "react-icons/ri";
import { api } from "../api.ts";
import { allCommands, parseBuiltin } from "../commands.ts";
import { switchToLocalModel } from "../local.ts";
import { onComposerAttach } from "../composerInbox.ts";
import { compactNumber } from "../format.ts";
import type { Permission, SpeechEndpoint } from "../settings.ts";
import { type Attachment, type SorvexActions, currentMode, type Mode, type State } from "../store.ts";
import { speaker } from "../voice.ts";
import { AgentMonitor, collectRuns } from "./AgentMonitor.tsx";
import { ElementChip } from "./ElementChip.tsx";
import { ModelPicker, ProviderIcon } from "./ModelPicker.tsx";
import { FlameWaveform, VoiceWaveform } from "./Waveforms.tsx";

/** A trigger with a menu that opens above it and closes on outside click or Escape. */
function Dropdown({
	trigger,
	children,
	align = "left",
	width = 260,
}: {
	trigger: (open: boolean, toggle: () => void) => ReactNode;
	children: (close: () => void) => ReactNode;
	align?: "left" | "right";
	width?: number;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: MouseEvent) => {
			if (!ref.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => event.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return (
		<div ref={ref} style={{ position: "relative" }}>
			{trigger(open, () => setOpen(!open))}
			{open && (
				<div className="popover up" style={{ width, [align]: 0 }}>
					{children(() => setOpen(false))}
				</div>
			)}
		</div>
	);
}

const MODES: { mode: Mode; label: string; color?: string }[] = [
	{ mode: "build", label: "Build" },
	{ mode: "plan", label: "Plan", color: "var(--mode-plan)" },
	{ mode: "security", label: "Security", color: "var(--mode-security)" },
];

function ModeTabs({ mode, onMode, disabled }: { mode: Mode; onMode: (mode: Mode) => void; disabled: boolean }) {
	return (
		<div className="mode-tabs" role="tablist" aria-label="Agent mode">
			{MODES.map((entry) => {
				const active = entry.mode === mode;
				return (
					<button
						key={entry.mode}
						type="button"
						role="tab"
						aria-selected={active}
						disabled={disabled}
						className={`mode-tab${active ? " active" : ""}`}
						style={active && entry.color ? ({ "--tab-color": entry.color } as CSSProperties) : undefined}
						onClick={() => !active && onMode(entry.mode)}
					>
						{entry.label}
					</button>
				);
			})}
		</div>
	);
}

interface SshGuardState {
	hosts: { id: string; alias: string; policy: string }[];
	statuses: Record<string, string>;
	guardrails: { block: { id: string; name: string; enabled: boolean }[]; ask: { id: string; name: string; enabled: boolean }[]; readOnlyCommands: string[] };
}

/** A toggle row inside the guardrails menu. */
function GuardRow({ on, label, hint, tone, onToggle }: { on: boolean; label: string; hint?: string; tone?: "block" | "ask"; onToggle: () => void }) {
	return (
		<button type="button" className={`guard-row${on ? "" : " off"}`} onClick={onToggle} aria-pressed={on}>
			<span className={`guard-check${on ? " on" : ""}`}>{on && <Check size={10} />}</span>
			<span className="stack">
				<span>{label}</span>
				{hint && <small>{hint}</small>}
			</span>
			{tone && <span className={`badge ${tone === "block" ? "danger" : "warn"}`}>{tone}</span>}
		</button>
	);
}

/**
 * Every guardrail in one menu: LLM reviewers, the local safety rules (checked before each tool call), and the
 * SSH guardrails with each server's policy. Toggles apply at once; the links open the full editors.
 */
function GuardrailBadge({ state, actions, onOpen }: { state: State; actions: SorvexActions; onOpen: (target: "guardrails" | "ssh" | "local") => void }) {
	const [ssh, setSsh] = useState<SshGuardState | null>(null);
	// Loaded up front so the badge count includes the SSH rules before the menu is opened.
	useEffect(() => {
		void api<SshGuardState>("GET", "/api/ssh").then(setSsh).catch(() => undefined);
	}, []);
	const settings = state.settings;
	if (!settings) return null;
	const reviewers = settings.reviewers;
	const chatModel = state.session?.model ? `${state.session.model.provider}/${state.session.model.id}` : "";
	const warning = reviewers.some((reviewer) => reviewer.enabled && (!reviewer.model || reviewer.model === chatModel));
	const rulesOn = settings.rules.filter((rule) => rule.enabled).length;
	const reviewersOn = reviewers.filter((reviewer) => reviewer.enabled).length;
	const sshOn = ssh ? ssh.guardrails.block.filter((r) => r.enabled).length + ssh.guardrails.ask.filter((r) => r.enabled).length : 0;
	const total = rulesOn + reviewersOn + sshOn;

	const loadSsh = () => void api<SshGuardState>("GET", "/api/ssh").then(setSsh).catch(() => undefined);
	const saveSsh = (guardrails: SshGuardState["guardrails"]) => {
		if (!ssh) return;
		setSsh({ ...ssh, guardrails });
		void api("PUT", "/api/ssh/guardrails", guardrails).catch((error: unknown) => actions.toast("error", String(error)));
	};

	return (
		<Dropdown
			align="right"
			width={340}
			trigger={(open, toggle) => (
				<button
					type="button"
					className={`guard-badge${total > 0 ? " on" : ""}`}
					onClick={() => {
						if (!open) loadSsh();
						toggle();
					}}
					title="Guardrails"
				>
					{warning && <AlertTriangle size={12} color="var(--accent-yellow-strong)" />}
					<FaShieldAlt size={14} />
					<span>
						{total > 0 ? total : ""}
						<span className="guard-word">{total > 0 ? ` Guardrail${total > 1 ? "s" : ""}` : "Guardrails"}</span>
					</span>
					<ChevronDown size={12} />
				</button>
			)}
		>
			{(close) => (
				<div className="guard-menu">
					<div className="guard-section">
						<div className="popover-group">LLM reviewers · check each finished turn</div>
						{reviewers.length === 0 && <div className="panel-note guard-empty">None yet</div>}
						{reviewers.map((reviewer) => (
							<GuardRow
								key={reviewer.id}
								on={reviewer.enabled}
								label={reviewer.name}
								hint={!reviewer.model ? "No model set" : reviewer.model === chatModel ? `${reviewer.model} · same as chat` : reviewer.model}
								onToggle={() =>
									void actions.saveSettings({ ...settings, reviewers: reviewers.map((r) => (r.id === reviewer.id ? { ...r, enabled: !r.enabled } : r)) })
								}
							/>
						))}
					</div>
					<div className="guard-section">
						<div className="popover-group">
							Safety rules · {rulesOn}/{settings.rules.length} on · before each local tool call
						</div>
						{settings.rules.map((rule) => (
							<GuardRow
								key={rule.id}
								on={rule.enabled}
								label={rule.name}
								hint={rule.target === "bash" ? "shell commands" : "file paths"}
								tone={rule.action === "block" ? "block" : "ask"}
								onToggle={() => void actions.saveSettings({ ...settings, rules: settings.rules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) })}
							/>
						))}
					</div>
					<div className="guard-section">
						<div className="popover-group">SSH guardrails · every remote command</div>
						{!ssh && <div className="panel-note guard-empty dots">Loading</div>}
						{ssh && ssh.hosts.length > 0 && (
							<div className="guard-hosts">
								{ssh.hosts.map((host) => (
									<span key={host.id} className="mcp-badge" title={ssh.statuses[host.alias] ?? ""}>
										{host.alias}: {host.policy}
									</span>
								))}
							</div>
						)}
						{ssh?.guardrails.block.map((rule) => (
							<GuardRow
								key={rule.id}
								on={rule.enabled}
								label={rule.name}
								tone="block"
								onToggle={() => saveSsh({ ...ssh.guardrails, block: ssh.guardrails.block.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) })}
							/>
						))}
						{ssh?.guardrails.ask.map((rule) => (
							<GuardRow
								key={rule.id}
								on={rule.enabled}
								label={rule.name}
								tone="ask"
								onToggle={() => saveSsh({ ...ssh.guardrails, ask: ssh.guardrails.ask.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) })}
							/>
						))}
					</div>
					<div className="guard-links">
						<button
							type="button"
							className="btn-ghost"
							onClick={() => {
								close();
								onOpen("guardrails");
							}}
						>
							Edit rules and reviewers
						</button>
						<button
							type="button"
							className="btn-ghost"
							onClick={() => {
								close();
								onOpen("ssh");
							}}
						>
							SSH servers
						</button>
					</div>
				</div>
			)}
		</Dropdown>
	);
}

/** "Effort <level>"; each click moves to the next thinking level the model supports. */
function EffortPill({ state, actions }: { state: State; actions: SorvexActions }) {
	const level = state.session?.thinkingLevel;
	const levels = state.thinkingLevels;
	if (!state.session?.model?.reasoning || !level || levels.length === 0) return null;
	const next = levels[(levels.indexOf(level) + 1) % levels.length]!;
	return (
		<button
			type="button"
			className="comp-pill"
			title={`Thinking effort: ${level}. Click for ${next}.`}
			onClick={() => void actions.setThinking(next)}
		>
			<span className="comp-pill-label">Effort</span> {level}
		</button>
	);
}

/** Tools grouped as built-in or per MCP server, each with its Ask / Allow / Deny permission. */
function ToolsPill({ state, actions }: { state: State; actions: SorvexActions }) {
	const settings = state.settings;
	const [query, setQuery] = useState("");
	const groups = useMemo(() => {
		const byGroup = new Map<string, string[]>();
		const needle = query.toLowerCase();
		for (const tool of state.tools) {
			if (needle && !tool.name.toLowerCase().includes(needle)) continue;
			const server = /^mcp__(.+?)__/.exec(tool.name)?.[1];
			const group = server ? `MCP · ${server}` : "Built-in";
			byGroup.set(group, [...(byGroup.get(group) ?? []), tool.name]);
		}
		return [...byGroup.entries()];
	}, [state.tools, query]);
	if (!settings) return null;
	const { permissions } = settings;
	const set = (name: string, permission: Permission) =>
		void actions.saveSettings({ ...settings, permissions: { ...permissions, tools: { ...permissions.tools, [name]: permission } } });
	const icons: Record<Permission, ReactNode> = {
		ask: <ShieldQuestion size={12} />,
		allow: <Shield size={12} />,
		deny: <ShieldOff size={12} />,
	};
	return (
		<Dropdown
			width={320}
			trigger={(_open, toggle) => (
				<button type="button" className={`comp-pill${state.tools.length > 0 ? " blue" : ""}`} onClick={toggle} title="Tools and permissions">
					{state.tools.length > 0 ? `${state.tools.length} Tools` : "Tools Off"}
				</button>
			)}
		>
			{() => (
				<>
					<div className="popover-search">
						<Search size={13} />
						<input autoFocus placeholder="Search tools" value={query} onChange={(event) => setQuery(event.target.value)} />
					</div>
					{groups.map(([group, names]) => (
						<div key={group}>
							<div className="popover-group">{group}</div>
							{names.map((name) => {
								const effective = permissions.tools[name] ?? permissions.default;
								return (
									<div key={name} className="tool-perm">
										<span title={name}>{name.replace(/^mcp__.+?__/, "")}</span>
										<div className="perm-chips">
											{(["ask", "allow", "deny"] as const).map((permission) => (
												<button
													key={permission}
													type="button"
													title={permission}
													aria-label={`${permission} ${name}`}
													className={`perm-chip ${permission}${effective === permission ? " on" : ""}`}
													onClick={() => set(name, permission)}
												>
													{icons[permission]}
												</button>
											))}
										</div>
									</div>
								);
							})}
						</div>
					))}
					{groups.length === 0 && <div className="empty-note">No tools</div>}
				</>
			)}
		</Dropdown>
	);
}

const STT_PRESETS: { name: string; endpoint: SpeechEndpoint }[] = [
	{ name: "Gemini", endpoint: { kind: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash", keyProvider: "google" } },
	{ name: "OpenAI", endpoint: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-transcribe", keyProvider: "openai" } },
	{ name: "Groq", endpoint: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", keyProvider: "groq" } },
	{ name: "Local whisper.cpp", endpoint: { kind: "openai", baseUrl: "http://127.0.0.1:8080/v1", model: "whisper-1", keyProvider: "" } },
];

/** Mic dropdown: read-aloud speed, then the speech-to-text engines. Green when an engine is set up. */
function VoiceDropdown({ state, actions }: { state: State; actions: SorvexActions }) {
	const settings = state.settings;
	if (!settings) return null;
	const voice = settings.voice;
	const ready = Boolean(voice.stt.model);
	const speed = voice.tts.engine === "kokoro" ? voice.tts.kokoro.speed : (voice.tts.api.speed ?? 1);
	const setSpeed = (value: number) =>
		void actions.saveSettings({
			...settings,
			voice: {
				...voice,
				tts:
					voice.tts.engine === "kokoro"
						? { ...voice.tts, kokoro: { ...voice.tts.kokoro, speed: value } }
						: { ...voice.tts, api: { ...voice.tts.api, speed: value } },
			},
		});
	return (
		<Dropdown
			align="right"
			width={220}
			trigger={(_open, toggle) => (
				<button type="button" className="voice-select" onClick={toggle} title="Voice settings" aria-label="Voice settings">
					{ready ? <Mic size={14} /> : <MicOff size={14} color="var(--text-faint)" />}
					<ChevronDown size={12} style={{ opacity: 0.4 }} />
				</button>
			)}
		>
			{() => (
				<>
					<div className="popover-group">TTS speed · {speed.toFixed(1)}x</div>
					<div style={{ padding: "0 8px 6px" }}>
						<input type="range" min={0.5} max={3} step={0.1} value={speed} style={{ width: "100%" }} onChange={(event) => setSpeed(Number(event.target.value))} />
					</div>
					<div className="menu-divider" />
					<div className="popover-group">Speech-to-text</div>
					{STT_PRESETS.map((preset) => {
						const active = preset.endpoint.kind === voice.stt.kind && preset.endpoint.baseUrl === voice.stt.baseUrl;
						return (
							<button
								key={preset.name}
								type="button"
								className={`menu-item${active ? " selected" : ""}`}
								onClick={() => void actions.saveSettings({ ...settings, voice: { ...voice, stt: { ...preset.endpoint, language: voice.stt.language } } })}
							>
								<span className="status-dot" style={{ background: active ? "var(--accent-green-icon)" : "var(--text-disabled)" }} />
								<span>{preset.name}</span>
							</button>
						);
					})}
				</>
			)}
		</Dropdown>
	);
}

function ModelSelect({ state, actions, onSetupLocal }: { state: State; actions: SorvexActions; onSetupLocal: () => void }) {
	const current = state.session?.model;
	return (
		<Dropdown
			align="right"
			width={460}
			trigger={(_open, toggle) => (
				<button type="button" className={`model-select${state.isStreaming ? " busy" : ""}`} onClick={toggle} title={current ? `${current.provider}/${current.id}` : "Choose a model"}>
					{current ? <ProviderIcon provider={current.provider} size={13} /> : <span className="status-dot" style={{ background: "var(--text-disabled)" }} />}
					<span className={current ? "name" : "name placeholder"}>{current ? current.name || current.id : "Select"}</span>
					<ChevronDown size={12} style={{ opacity: 0.4 }} />
				</button>
			)}
		>
			{(close) => (
				<ModelPicker
					models={state.models}
					current={current}
					onPick={(model) => {
						close();
						void actions.setModel(model);
					}}
					local={{
						onUse: async (id) => {
							await switchToLocalModel(actions, id);
							close();
						},
						onSetup: () => {
							close();
							onSetupLocal();
						},
					}}
				/>
			)}
		</Dropdown>
	);
}

function ContextBar({ state }: { state: State }) {
	const usage = state.stats?.contextUsage;
	const contextWindow = usage?.contextWindow ?? state.session?.model?.contextWindow;
	const total = usage?.tokens ?? 0;
	const percent = usage?.percent ?? (contextWindow ? (total / contextWindow) * 100 : 0);
	const color = percent > 90 ? "var(--accent-red)" : percent > 70 ? "var(--accent-yellow-strong)" : "var(--text-muted)";
	const statuses = Object.entries(state.statuses).filter(([key]) => key !== "mode" && key !== "plan" && !key.startsWith("sorvex-gui:"));
	const tokens = state.stats?.tokens;
	const reads = tokens?.cacheRead ?? 0;
	const hit = tokens && tokens.input + reads > 0 ? Math.round((reads / (tokens.input + reads)) * 100) : undefined;
	return (
		<div className="context-bar">
			{tokens && tokens.total > 0 && (
				<span className="context-status tokens" title="Input, output, cache read, cache write, cache hit rate">
					↑{compactNumber(tokens.input)} ↓{compactNumber(tokens.output)} R{compactNumber(reads)} W{compactNumber(tokens.cacheWrite)}
					{hit !== undefined ? ` CH${hit}%` : ""}
				</span>
			)}
			{state.stats && state.stats.cost > 0 && <span className="context-status">${state.stats.cost.toFixed(3)}</span>}
			{statuses.map(([key, value]) => (
				<span key={key} className="context-status">
					{value}
				</span>
			))}
			<div className="context-track">
				<div style={{ width: `${Math.min(100, percent)}%`, background: color }} />
			</div>
			<span className="context-text">
				{compactNumber(total)} / {contextWindow ? compactNumber(contextWindow) : "?"}
				{state.session?.autoCompactionEnabled ? " (auto)" : ""}
			</span>
		</div>
	);
}

const TEXT_EXTENSIONS =
	/\.(txt|md|markdown|json|jsonl|ya?ml|toml|ini|env|csv|tsv|xml|html?|css|scss|less|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|proto|lua|r|scala|dart|vue|svelte|log|diff|patch|dockerfile|gitignore|makefile)$/i;
const MAX_TEXT = 512 * 1024;
let attachmentId = 0;

function readBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}

/** Images go to the model as images, PDFs as extracted text, and text or code files as their contents. */
async function toAttachment(file: File): Promise<Attachment> {
	const base = { id: ++attachmentId, name: file.name, size: file.size, mimeType: file.type || "text/plain" };
	if (file.type.startsWith("image/")) return { ...base, kind: "image", data: await readBase64(file) };
	if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
		const { text } = await api<{ text: string }>("POST", "/api/extract-pdf", { data: await readBase64(file) });
		return { ...base, kind: "text", data: text.slice(0, MAX_TEXT) };
	}
	if (file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name) || file.size < MAX_TEXT) {
		const text = await file.text();
		if (text.includes("\u0000")) throw new Error(`${file.name} looks binary; only images, PDFs and text files can be attached`);
		return { ...base, kind: "text", data: text.slice(0, MAX_TEXT) };
	}
	throw new Error(`${file.name} is too large or not a supported type`);
}

const HISTORY_KEY = "promptHistory";

function loadHistory(): string[] {
	try {
		return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as string[];
	} catch {
		return [];
	}
}

/** The `@word` being typed at the cursor, for file completion. */
function atToken(text: string, cursor: number): { start: number; query: string } | undefined {
	const match = /(^|\s)@("?)([^\s"]*)$/.exec(text.slice(0, cursor));
	if (!match) return undefined;
	return { start: cursor - match[3]!.length - match[2]!.length - 1, query: match[3]! };
}

/** Subsequence match, so "srvidx" finds "server/index.ts"; shorter paths and basename hits rank first. */
function fuzzyFiles(files: string[], query: string): string[] {
	if (!query) return files.slice(0, 8);
	const needle = query.toLowerCase();
	const scored: [number, string][] = [];
	for (const file of files) {
		const hay = file.toLowerCase();
		let at = -1;
		let ok = true;
		for (const char of needle) {
			at = hay.indexOf(char, at + 1);
			if (at === -1) {
				ok = false;
				break;
			}
		}
		if (!ok) continue;
		const base = hay.slice(hay.lastIndexOf("/") + 1);
		scored.push([(hay.includes(needle) ? 0 : 100) + (base.includes(needle) ? 0 : 50) + file.length, file]);
	}
	return scored
		.sort((a, b) => a[0] - b[0])
		.slice(0, 8)
		.map(([, file]) => file);
}

export function Composer({
	state,
	actions,
	onCommand,
	onOpen,
}: {
	state: State;
	actions: SorvexActions;
	onCommand: (name: string, args: string) => void;
	onOpen: (target: "guardrails" | "ssh" | "local") => void;
}) {
	const [text, setText] = useState("");
	const [cursor, setCursor] = useState(0);
	const [files, setFiles] = useState<string[] | null>(null);
	const historyRef = useRef<string[]>(loadHistory());
	const historyIndex = useRef(-1);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [dragging, setDragging] = useState(false);
	const [monitorOpen, setMonitorOpen] = useState(false);
	const subagentRuns = useMemo(() => collectRuns(state), [state]);
	const activeAgents = subagentRuns.filter((run) => run.status === "running" || run.status === "pending").length;
	const [highlight, setHighlight] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const mode = currentMode(state.statuses);
	const ready = state.connection === "ready";
	const { voice } = state;
	const supportsImages = state.session?.model?.input?.includes("image") ?? false;

	// Attachments from the Browser pane (selected elements, annotated screenshots).
	const supportsImagesRef = useRef(supportsImages);
	supportsImagesRef.current = supportsImages;
	useEffect(
		() =>
			onComposerAttach((items) => {
				const images = supportsImagesRef.current;
				const accepted = items.filter((item) => item.kind !== "image" || images).map((item) => (images ? item : { ...item, image: undefined }));
				if (!images && items.some((item) => item.kind === "image" || item.image)) actions.toast("warning", "This model does not accept images; only the text was attached");
				setAttachments((current) => [...current, ...accepted.map((item) => ({ ...item, id: ++attachmentId }))]);
				textareaRef.current?.focus();
			}),
		[actions],
	);

	useEffect(() => {
		if (!state.editorText) return;
		const { text: incoming, append } = state.editorText;
		setText((current) => (append && current.trim() ? `${current.replace(/\s+$/, "")} ${incoming}` : incoming));
		textareaRef.current?.focus();
	}, [state.editorText]);

	const fitHeight = () => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes.
	useEffect(fitHeight, [text]);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		let width = 0;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry || entry.contentRect.width === width) return;
			width = entry.contentRect.width;
			fitHeight();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, []);

	const slashMatches = useMemo(() => {
		const match = /^\/(\S*)$/.exec(text);
		if (!match) return [];
		const needle = match[1]!.toLowerCase();
		return allCommands(state.commands)
			.filter((command) => command.name.toLowerCase().includes(needle))
			.sort((a, b) => Number(!a.name.toLowerCase().startsWith(needle)) - Number(!b.name.toLowerCase().startsWith(needle)))
			.slice(0, 10);
	}, [text, state.commands]);

	const at = atToken(text, cursor);
	useEffect(() => {
		if (at && files === null) void api<{ files: string[] }>("GET", `/api/files?cwd=${encodeURIComponent(state.cwd)}`).then((result) => setFiles(result.files));
	}, [at, files, state.cwd]);
	useEffect(() => setFiles(null), [state.cwd]);
	const fileMatches = useMemo(() => (at && files ? fuzzyFiles(files, at.query) : []), [at, files]);
	const suggestions = slashMatches.length > 0 ? slashMatches.length : fileMatches.length;
	useEffect(() => setHighlight(0), [suggestions, at?.query]);

	const insertFile = (file: string) => {
		if (!at) return;
		const quoted = /\s/.test(file) ? `@"${file}"` : `@${file}`;
		const next = `${text.slice(0, at.start)}${quoted} ${text.slice(cursor)}`;
		setText(next);
		const position = at.start + quoted.length + 1;
		setCursor(position);
		requestAnimationFrame(() => textareaRef.current?.setSelectionRange(position, position));
	};

	const addFiles = async (files: FileList | File[]) => {
		for (const file of Array.from(files)) {
			try {
				const attachment = await toAttachment(file);
				if (attachment.kind === "image" && !supportsImages) {
					actions.toast("warning", `${state.session?.model?.name ?? "This model"} does not accept images`);
					continue;
				}
				setAttachments((current) => [...current, attachment]);
			} catch (error) {
				actions.toast("error", error instanceof Error ? error.message : String(error));
			}
		}
	};

	const remember = (message: string) => {
		const history = [message, ...historyRef.current.filter((entry) => entry !== message)].slice(0, 100);
		historyRef.current = history;
		historyIndex.current = -1;
		try {
			localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
		} catch {
			// History just will not persist.
		}
	};

	const submit = (followUp = false) => {
		const message = text.trim();
		if ((!message && attachments.length === 0 && state.annotations.length === 0) || !ready) return;
		if (message) remember(message);
		setText("");
		const builtin = parseBuiltin(message);
		if (builtin && attachments.length === 0) return onCommand(builtin.name, builtin.args);
		// `!cmd` runs in the shell with output added to context; `!!cmd` keeps the output out of context.
		const bash = /^(!!?)\s*([\s\S]+)$/.exec(message);
		if (bash && attachments.length === 0) return void actions.bash(bash[2]!, bash[1] === "!!");
		setAttachments([]);
		if (followUp && state.isStreaming) return void actions.followUp(message);
		void actions.send(message, state.isStreaming, attachments);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (suggestions > 0) {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const step = event.key === "ArrowDown" ? 1 : -1;
				setHighlight((highlight + step + suggestions) % suggestions);
				return;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				if (slashMatches.length > 0) {
					const pick = slashMatches[highlight];
					if (pick && `/${pick.name}` !== text) {
						event.preventDefault();
						setText(`/${pick.name} `);
						return;
					}
				} else if (fileMatches[highlight]) {
					event.preventDefault();
					insertFile(fileMatches[highlight]!);
					return;
				}
			}
		}
		if (event.key === "ArrowUp" && event.altKey) {
			event.preventDefault();
			void actions.restoreQueue();
			return;
		}
		// Prompt history when the cursor is at the very start (Up) or end (Down), like the TUI editor.
		const el = event.currentTarget;
		if (event.key === "ArrowUp" && !event.shiftKey && el.selectionStart === 0 && el.selectionEnd === 0 && historyRef.current.length > 0) {
			event.preventDefault();
			historyIndex.current = Math.min(historyIndex.current + 1, historyRef.current.length - 1);
			setText(historyRef.current[historyIndex.current]!);
			return;
		}
		if (event.key === "ArrowDown" && !event.shiftKey && el.selectionStart === text.length && historyIndex.current >= 0) {
			event.preventDefault();
			historyIndex.current -= 1;
			setText(historyIndex.current >= 0 ? historyRef.current[historyIndex.current]! : "");
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit(event.altKey);
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		setDragging(false);
		if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files);
	};
	const onPaste = (event: ClipboardEvent) => {
		const files = Array.from(event.clipboardData.files);
		if (files.length > 0) {
			event.preventDefault();
			void addFiles(files);
		}
	};

	const modeColor = MODES.find((entry) => entry.mode === mode)?.color;
	const bashMode = text.startsWith("!");
	const borderState = bashMode
		? " bash-mode"
		: voice.dictating
			? " recording"
			: voice.voiceChat
				? " voice-chat"
				: state.isStreaming
					? " running"
					: "";
	const canSend = ready && Boolean(text.trim() || attachments.length > 0 || state.annotations.length > 0);

	return (
		<div className="composer-root">
			<AgentMonitor state={state} actions={actions} open={monitorOpen} onClose={() => setMonitorOpen(false)} />
			{!monitorOpen && activeAgents > 0 && (
				<button type="button" className="monitor-mini" onClick={() => setMonitorOpen(true)}>
					<span className="monitor-mini-dot" />
					{activeAgents} agent{activeAgents === 1 ? "" : "s"} running
				</button>
			)}
			<FlameWaveform analyser={speaker.analyser} active={voice.speaking} />
			<div
				className={`composer${borderState}${dragging ? " dragging" : ""}`}
				style={modeColor ? ({ "--composer-border": modeColor } as CSSProperties) : undefined}
				onDragOver={(event) => {
					if (!event.dataTransfer.types.includes("Files")) return;
					event.preventDefault();
					setDragging(true);
				}}
				onDragLeave={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
				}}
				onDrop={onDrop}
			>
				{attachments.length > 0 && (
					<div className="attachments">
						{attachments.map((attachment) =>
							attachment.kind === "element" && attachment.element ? (
								<ElementChip
									key={attachment.id}
									element={attachment.element}
									image={attachment.image}
									onRemove={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
								/>
							) : (
							<div
								key={attachment.id}
								className={`attachment${attachments.length === 1 && attachment.kind === "image" ? " large" : ""}`}
								title={`${attachment.name} (${compactNumber(attachment.size)} bytes)`}
							>
								{attachment.kind === "image" ? (
									<img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
								) : (
									<div className="attachment-file">
										<FileText size={22} />
										<span>{attachment.name}</span>
									</div>
								)}
								<button
									type="button"
									className="attachment-remove"
									aria-label={`Remove ${attachment.name}`}
									onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
								>
									<X size={10} />
								</button>
							</div>
							),
						)}
					</div>
				)}
				<div className="composer-top">
					<ModeTabs mode={mode} onMode={(next) => void actions.setMode(next)} disabled={!ready} />
					<div className="composer-group">
						<GuardrailBadge state={state} actions={actions} onOpen={onOpen} />
						<button
							type="button"
							className={`monitor-btn${monitorOpen ? " on" : ""}${activeAgents > 0 ? " busy" : ""}`}
							title="Agent Monitor"
							aria-label="Agent Monitor"
							aria-pressed={monitorOpen}
							onClick={() => setMonitorOpen(!monitorOpen)}
						>
							<Bot size={16} />
							{subagentRuns.length > 0 && <span className="monitor-count">{subagentRuns.length}</span>}
						</button>
					</div>
				</div>
				{slashMatches.length > 0 && (
					<div className="popover up" style={{ left: 8 }}>
						{slashMatches.map((command, index) => (
							<button
								key={`${command.source}-${command.name}`}
								type="button"
								className={`menu-item${index === highlight ? " highlight" : ""}`}
								onMouseDown={(event) => {
									event.preventDefault();
									setText(`/${command.name} `);
									textareaRef.current?.focus();
								}}
							>
								<span>/{command.name}</span>
								{command.description && <span className="desc">{command.description}</span>}
							</button>
						))}
					</div>
				)}
				{slashMatches.length === 0 && fileMatches.length > 0 && (
					<div className="popover up" style={{ left: 8 }}>
						<div className="popover-group">Files</div>
						{fileMatches.map((file, index) => (
							<button
								key={file}
								type="button"
								className={`menu-item${index === highlight ? " highlight" : ""}`}
								onMouseDown={(event) => {
									event.preventDefault();
									insertFile(file);
									textareaRef.current?.focus();
								}}
							>
								<FileText size={13} />
								<span className="mono">{file}</span>
							</button>
						))}
					</div>
				)}
				<textarea
					ref={textareaRef}
					rows={1}
					value={text}
					placeholder={
						!ready
							? "Waiting for Sorvex..."
							: state.isStreaming
								? "Steer (Enter), follow up (Alt+Enter), or Esc to stop..."
								: "Send a message, / for commands, @ for files, ! for shell..."
					}
					disabled={!ready}
					onChange={(event) => {
						setText(event.target.value);
						setCursor(event.target.selectionStart);
					}}
					onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
				/>
				<div className="composer-actions">
					<div className="composer-group">
						<button type="button" className="attach-btn" title="Attach files" aria-label="Attach files" disabled={!ready} onClick={() => fileRef.current?.click()}>
							<ImAttachment size={16} color="var(--text-muted)" />
						</button>
						<input
							ref={fileRef}
							type="file"
							multiple
							hidden
							onChange={(event) => {
								if (event.target.files) void addFiles(event.target.files);
								event.target.value = "";
							}}
						/>
						<EffortPill state={state} actions={actions} />
						<ToolsPill state={state} actions={actions} />
					</div>
					<div className="composer-group">
						{voice.speaking && (
							<button type="button" className="voice-btn" title="Stop speaking" aria-label="Stop speaking" onClick={actions.stopSpeaking}>
								<VolumeX size={16} />
							</button>
						)}
						<button
							type="button"
							className={`voice-btn${voice.dictating ? " active-red" : ""}`}
							title={voice.dictating ? "Stop dictation and transcribe" : "Dictate"}
							aria-label="Dictate"
							disabled={!ready || voice.voiceChat || (voice.transcribing && !voice.dictating)}
							onClick={() => void actions.toggleDictation()}
						>
							{voice.transcribing && !voice.voiceChat ? (
								<Loader2 size={16} className="spin" color="var(--accent-blue)" />
							) : voice.dictating ? (
								<Square size={13} fill="currentColor" />
							) : (
								<Mic size={16} />
							)}
						</button>
						<button
							type="button"
							className={`voice-btn${voice.voiceChat ? " active-green" : ""}`}
							title={voice.voiceChat ? "End voice chat" : "Voice chat (hands-free)"}
							aria-label="Voice chat"
							disabled={!ready || voice.dictating}
							onClick={() => void actions.toggleVoiceChat()}
						>
							{voice.voiceChat && voice.transcribing ? <Loader2 size={16} className="spin" /> : <RiVoiceprintLine size={16} />}
						</button>
						<VoiceDropdown state={state} actions={actions} />
						<ModelSelect state={state} actions={actions} onSetupLocal={() => onOpen("local")} />
						{state.isStreaming && !text.trim() ? (
							<button type="button" className="send-btn stop" aria-label="Stop" title="Stop (Esc)" onClick={() => void actions.abort()}>
								<Square size={16} fill="currentColor" />
							</button>
						) : (
							<button type="button" className={`send-btn${canSend ? " valid" : ""}`} aria-label="Send" title="Send (Enter)" disabled={!canSend} onClick={() => submit()}>
								<SendHorizonal size={16} />
							</button>
						)}
					</div>
				</div>
				{state.micAnalyser ? <VoiceWaveform analyser={state.micAnalyser} /> : <ContextBar state={state} />}
			</div>
		</div>
	);
}
