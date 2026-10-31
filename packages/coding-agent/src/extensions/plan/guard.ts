import { isToolCallEventType, type ToolCallEvent, type ToolInfo } from "../../core/extensions/types.ts";
import { isReadOnlyShellCommand } from "./bash-allowlist.ts";

export type PlanViolation = { kind: "command"; command: string } | { kind: "tool"; toolName: string };

export const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

export function readOnlyToolNames(tools: readonly ToolInfo[]): Set<string> {
	return new Set(tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((tool) => tool.name));
}

/** Why a call may not run while planning: a shell command off the allowlist, or a tool that is not read-only. */
export function planViolation(event: ToolCallEvent, readOnlyTools: ReadonlySet<string>): PlanViolation | undefined {
	if (isToolCallEventType("bash", event) || isToolCallEventType("powershell", event)) {
		return isReadOnlyShellCommand(event.input.command, event.toolName)
			? undefined
			: { kind: "command", command: event.input.command };
	}
	return readOnlyTools.has(event.toolName) ? undefined : { kind: "tool", toolName: event.toolName };
}
