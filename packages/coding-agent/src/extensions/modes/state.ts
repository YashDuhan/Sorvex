import type { SessionEntry } from "../../core/session-manager.ts";
import { BUILTIN_PATH_PREFIX } from "../../core/source-info.ts";
import { PLAN_MODE_ENTRY } from "../plan/state.ts";
import { SECURITY_PROMPT, SECURITY_SUBAGENT_RULE } from "./prompt.ts";

/** The name of the security mode. Renaming the mode, its command, its footer label, and its prompt section is this line. */
export const SECURITY_MODE = "security";

/**
 * The primary modes the user switches between, in cycle order. `build` is normal coding, `plan` is the
 * plan extension's read-only plan mode, and the security mode is security work with every tool.
 */
export const PRIMARY_MODES = ["build", "plan", SECURITY_MODE] as const;
export type PrimaryMode = (typeof PRIMARY_MODES)[number];

/** A mode this extension owns. The plan extension owns plan mode and records it itself. */
export type OwnedMode = Exclude<PrimaryMode, "plan">;

/** A mode this extension owns. Plan mode's notices, prompt, and footer come from the plan extension. */
export interface ModeSpec {
	description: string;
	/** Shown when the user switches to the mode. */
	notice: string;
	/** Footer status text. Undefined shows nothing. */
	label: string | undefined;
	/** System prompt section, keyed by `sectionName`. */
	prompt: string | undefined;
	/** Appended to `prompt` when the built-in subagent tool is active. */
	subagentPrompt: string | undefined;
}

export const MODES: Record<OwnedMode, ModeSpec> = {
	build: {
		description: "Write and change code with every tool",
		notice: "Build mode. Every tool is available.",
		label: undefined,
		prompt: undefined,
		subagentPrompt: undefined,
	},
	[SECURITY_MODE]: {
		description: "Vulnerability triage, recon, code audit, red team, and hardening",
		notice: "Security mode on. Every tool is available, with security guidance and subagents.",
		label: SECURITY_MODE,
		prompt: SECURITY_PROMPT,
		subagentPrompt: SECURITY_SUBAGENT_RULE,
	},
};

export const modeDescription = (mode: PrimaryMode): string =>
	mode === "plan" ? "Explore read-only and write a plan for approval" : MODES[mode].description;

export const MODE_STATUS_KEY = "mode";
export const MODE_ENTRY = "agent-mode";
/**
 * Event-bus channel on which the modes extension announces the current {@link PrimaryMode}: once when a
 * session starts or the session tree changes branch, then once each time the mode changes.
 */
export const MODE_EVENT = "mode:change";

export const sectionName = (mode: PrimaryMode): string => `${mode}_mode`;

export function isPrimaryMode(value: string): value is PrimaryMode {
	return (PRIMARY_MODES as readonly string[]).includes(value);
}

/** Extension path of the built-in modes extension, which registers {@link AGENT_MODE_FLAG}. */
export const BUILTIN_MODES_PATH = `${BUILTIN_PATH_PREFIX}modes`;
export const AGENT_MODE_FLAG = "agent-mode";

/** The mode a `--agent-mode` value names, in any case, or undefined. */
export function parseAgentMode(value: string): PrimaryMode | undefined {
	const mode = value.trim().toLowerCase();
	return isPrimaryMode(mode) ? mode : undefined;
}

export const unknownAgentModeMessage = (value: string): string =>
	`Unknown --${AGENT_MODE_FLAG} "${value}". Use ${PRIMARY_MODES.join(", ")}.`;

export function isOwnedMode(value: unknown): value is OwnedMode {
	return typeof value === "string" && value !== "plan" && isPrimaryMode(value);
}

export function nextPrimaryMode(mode: PrimaryMode): PrimaryMode {
	return PRIMARY_MODES[(PRIMARY_MODES.indexOf(mode) + 1) % PRIMARY_MODES.length];
}

/**
 * The mode of the last `agent-mode` entry on the branch, or `build`. Plan mode turning on ends the owned
 * mode, so a `plan-mode` entry that starts planning after the last `agent-mode` entry means `build`, even
 * when the plan extension wrote it before this extension could record the change.
 */
export function replayOwnedMode(branch: readonly SessionEntry[]): OwnedMode {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "custom") continue;
		const data: unknown = entry.data;
		if (typeof data !== "object" || data === null) continue;
		if (entry.customType === PLAN_MODE_ENTRY && "kind" in data && data.kind === "planning") return "build";
		if (entry.customType === MODE_ENTRY && "mode" in data && isOwnedMode(data.mode)) return data.mode;
	}
	return "build";
}
