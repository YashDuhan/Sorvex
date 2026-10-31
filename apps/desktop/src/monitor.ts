import type { AgentMessage } from "./rpc.ts";
import type { State } from "./store.ts";

/** A subagent run as Sorvex's subagent extension reports it (extensions/subagent/run.ts `ChildRun`). */
interface ChildRun {
	id: string;
	startedAt: number;
	agent: string;
	task: string;
	status: "pending" | "running" | "done" | "failed" | "aborted";
	output: string;
	usage?: { totalTokens?: number; cost?: { total?: number } };
	turns: number;
	model?: string;
	toolCalls?: { name: string; summary: string }[];
}

interface SubagentDetails {
	kind?: string;
	runs?: ChildRun[];
	background?: { id: string; status: string; action?: string };
}

export interface MonitorRun extends ChildRun {
	/** The parent `subagent` tool call. */
	toolCallId: string;
	/** Set when the call ran with `background: true`. */
	backgroundId?: string;
	/** The parent call is still running in the foreground (Stop aborts the agent's run). */
	foreground: boolean;
}

function detailsOf(value: unknown): SubagentDetails | undefined {
	if (!value || typeof value !== "object") return undefined;
	const details = (value as { details?: unknown }).details ?? value;
	return details && typeof details === "object" && Array.isArray((details as SubagentDetails).runs) ? (details as SubagentDetails) : undefined;
}

/**
 * Every subagent run in the session. Live progress comes from the running tool call's partial result; finished
 * foreground runs from the tool result; background runs from the `subagent-result` follow-up message.
 */
export function collectRuns(state: Pick<State, "messages" | "running" | "outcomes">): MonitorRun[] {
	const results = new Map<string, Extract<AgentMessage, { role: "toolResult" }>>();
	const backgroundResults = new Map<string, SubagentDetails>();
	for (const message of state.messages) {
		if (message.role === "toolResult") results.set(message.toolCallId, message);
		if (message.role === "custom" && message.customType === "subagent-result") {
			const details = detailsOf((message as { details?: unknown }).details);
			if (details?.background?.id) backgroundResults.set(details.background.id, details);
		}
	}
	const runs = new Map<string, MonitorRun>();
	for (const message of state.messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "subagent") continue;
			const running = state.running[block.id];
			const details =
				detailsOf(running?.partial) ?? detailsOf(results.get(block.id)?.details) ?? detailsOf(state.outcomes[block.id]?.result);
			// Calls that only act on an existing background run (status, wait, cancel) are not runs themselves.
			if (!details || details.background?.action) continue;
			const backgroundId = details.background?.id;
			const final = backgroundId ? backgroundResults.get(backgroundId) : undefined;
			for (const run of final?.runs ?? details.runs ?? []) {
				runs.set(run.id, { ...run, toolCallId: block.id, backgroundId, foreground: Boolean(running) && !backgroundId });
			}
		}
	}
	return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

