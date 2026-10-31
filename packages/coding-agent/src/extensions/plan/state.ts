import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { BUILTIN_PATH_PREFIX } from "../../core/source-info.ts";
import { SUBAGENT_TOOL_NAME } from "../subagent/request.ts";
import { TODO_TOOL_NAME } from "../todo/state.ts";

/** Extension paths of the built-in plan and subagent extensions, which rely on each other. */
export const BUILTIN_PLAN_PATH = `${BUILTIN_PATH_PREFIX}plan`;
export const BUILTIN_SUBAGENT_PATH = `${BUILTIN_PATH_PREFIX}subagent`;

export const PLAN_MODE_ENTRY = "plan-mode";
export const PLAN_ON_NOTICE = "Plan mode on. Only read-only tools run until you approve a plan.";
export const PLAN_OFF_NOTICE = "Plan mode off. Every tool is available again.";
export const EXIT_PLAN_MODE_TOOL = "exit_plan_mode";
/**
 * Marks a subagent session started while its parent was planning. The subagent tool appends it before
 * the subagent's first prompt, and plan mode then holds every tool call in that session to its
 * read-only rules. Nothing removes it, so the subagent cannot turn the rules off.
 */
export const READ_ONLY_CHILD_ENTRY = "plan-read-only-child";
/**
 * Event-bus channel on which plan mode announces its mode, a {@link PlanMode}, each time it applies
 * it. The subagent extension holds subagents that are running when planning starts to the read-only
 * rules.
 */
export const PLAN_MODE_EVENT = "plan:mode";
/**
 * Event-bus channel on which plan mode announces a {@link PlanTransition} each time the user or the
 * model turns it on or off. Unlike {@link PLAN_MODE_EVENT}, replaying a session does not emit it, so a
 * listener may write to the session.
 */
export const PLAN_TRANSITION_EVENT = "plan:transition";
/** Event-bus channel on which another extension asks plan mode to turn on or off, with a {@link PlanSetRequest}. */
export const PLAN_SET_EVENT = "plan:set";

export interface PlanTransition {
	mode: PlanMode;
	ctx: ExtensionContext;
}

export interface PlanSetRequest {
	planning: boolean;
	ctx: ExtensionContext;
}

export function isPlanTransition(value: unknown): value is PlanTransition {
	return (
		typeof value === "object" &&
		value !== null &&
		"mode" in value &&
		isPlanMode(value.mode) &&
		"ctx" in value &&
		typeof value.ctx === "object" &&
		value.ctx !== null
	);
}

export function isPlanSetRequest(value: unknown): value is PlanSetRequest {
	return (
		typeof value === "object" &&
		value !== null &&
		"planning" in value &&
		typeof value.planning === "boolean" &&
		"ctx" in value &&
		typeof value.ctx === "object" &&
		value.ctx !== null
	);
}

/**
 * - `off`: plan mode did not run on this branch, or a run recorded the restored tools after it ended.
 * - `planning`: only read-only tools run until plan mode ends and restores `restoreTools`.
 * - `ended`: plan mode ended and restored `restoreTools`, and no run has recorded them in the
 *   transcript since. A resumed session restores the tools the transcript recorded last, which are
 *   the planning tools, so replaying this entry restores `restoreTools` again.
 */
export type PlanMode =
	| { kind: "off" }
	| { kind: "planning"; restoreTools: string[] }
	| { kind: "ended"; restoreTools: string[] };

export const PLAN_OFF: PlanMode = { kind: "off" };

function isPlanMode(value: unknown): value is PlanMode {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	if (value.kind === "off") return true;
	return (
		(value.kind === "planning" || value.kind === "ended") &&
		"restoreTools" in value &&
		Array.isArray(value.restoreTools) &&
		value.restoreTools.every((name) => typeof name === "string")
	);
}

export function replayPlanMode(branch: readonly SessionEntry[]): PlanMode {
	let loadoutRecorded = false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		// Each run records the active tools in a system message when they changed.
		if (entry.type === "message" && entry.message.role === "system") loadoutRecorded = true;
		if (entry.type === "custom" && entry.customType === PLAN_MODE_ENTRY && isPlanMode(entry.data)) {
			return entry.data.kind === "ended" && loadoutRecorded ? PLAN_OFF : entry.data;
		}
	}
	return PLAN_OFF;
}

export function isReadOnlyChild(branch: readonly SessionEntry[]): boolean {
	return branch.some((entry) => entry.type === "custom" && entry.customType === READ_ONLY_CHILD_ENTRY);
}

/** An active built-in subagent tool stays active, because it runs its agents read-only while planning. */
export function planningTools(
	restoreTools: readonly string[],
	readOnlyTools: ReadonlySet<string>,
	builtinSubagent: boolean,
): string[] {
	const shells = restoreTools.includes("powershell") ? ["bash", "powershell"] : ["bash"];
	return [
		...new Set([
			...restoreTools.filter((name) => readOnlyTools.has(name)),
			TODO_TOOL_NAME,
			EXIT_PLAN_MODE_TOOL,
			...(builtinSubagent && restoreTools.includes(SUBAGENT_TOOL_NAME) ? [SUBAGENT_TOOL_NAME] : []),
			...shells,
		]),
	];
}
