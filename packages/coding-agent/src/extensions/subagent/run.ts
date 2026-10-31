import type { ThinkingLevel } from "@sorvex/agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@sorvex/ai";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { resolveModelReference } from "../../core/model-resolver.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { BUILTIN_PLAN_PATH, isReadOnlyChild, READ_ONLY_CHILD_ENTRY } from "../plan/state.ts";
import type { AgentDefinition, AgentSource } from "./agents.ts";
import type { BackgroundAction, ChildContext, SubagentKind } from "./request.ts";

/** `pending` is a run that has not started: queued behind the concurrency cap, or after a failed chain step. */
export type ChildRunStatus = "pending" | "running" | "done" | "failed" | "aborted";

export interface ChildToolCall {
	name: string;
	/** One-line summary of the arguments, such as a command or a path. */
	summary: string;
}

export interface ChildRun {
	/** The run's id: the background run's id, with `.<n>` for the nth child of a parallel or chain call. */
	id: string;
	/** When the run started, or for a pending run when the call was made, in epoch milliseconds. */
	startedAt: number;
	context: ChildContext;
	agent: string;
	source: AgentSource;
	task: string;
	status: ChildRunStatus;
	/** The child's last assistant text, or its error message when it failed. */
	output: string;
	usage: Usage;
	/** Assistant messages the child produced. */
	turns: number;
	model?: string;
	toolCalls: ChildToolCall[];
}

export interface SubagentDetails {
	kind: SubagentKind;
	/** One run per task or chain step, in request order. */
	runs: ChildRun[];
	/**
	 * Plan mode was on when a run started, so that run and every run after it had only read-only tools
	 * and read-only shell commands.
	 */
	readOnly: boolean;
	/** Set for a call that started a background run or acted on one. */
	background?: BackgroundRunDetails;
}

/** A background run's state as of the result. */
export type BackgroundStatus = "running" | "done" | "failed" | "aborted";

export interface BackgroundRunDetails {
	id: string;
	status: BackgroundStatus;
	/** The action of a call that acted on the run. Absent for the call that started it. */
	action?: BackgroundAction;
}

export const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const SUMMARY_LIMIT = 80;

function truncate(text: string, limit: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > limit ? `${line.slice(0, limit)}...` : line;
}

export function summarizeToolCall(name: string, args: Record<string, unknown>): string {
	const pick = (...keys: string[]) => {
		for (const key of keys) {
			const value = args[key];
			if (typeof value === "string" && value) return value;
		}
		return undefined;
	};
	const primary = pick("command", "file_path", "path", "pattern", "query", "url");
	if (primary) {
		const where = name === "grep" || name === "find" ? pick("path") : undefined;
		return truncate(where && where !== primary ? `${primary} in ${where}` : primary, SUMMARY_LIMIT);
	}
	return truncate(JSON.stringify(args), SUMMARY_LIMIT);
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export interface ResolvedChildModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

/** Bare ids prefer the parent's provider, then any provider with configured auth. */
export function resolveChildModel(
	agent: AgentDefinition,
	parentModel: Model<Api> | undefined,
	registry: ModelRegistry,
): ResolvedChildModel {
	if (!agent.model) {
		if (!parentModel) throw new Error(`Agent "${agent.name}" names no model and no model is selected.`);
		return { model: parentModel };
	}
	const models = registry.getAll();
	const usable = (provider: string) =>
		models.some((model) => model.provider === provider && registry.hasConfiguredAuth(model));
	const request = { text: agent.model, thinkingSuffix: "strict", fuzzy: false } as const;
	const preferred = parentModel
		? resolveModelReference({ ...request, provider: parentModel.provider }, models, usable)
		: undefined;
	const result = preferred?.status === "resolved" ? preferred : resolveModelReference(request, models, usable);
	if (result.status === "resolved") return { model: result.model, thinkingLevel: result.thinkingLevel };
	if (result.status === "ambiguous") {
		const candidates = result.candidates.map((model) => `${model.provider}/${model.id}`).join(", ");
		throw new Error(`Agent "${agent.name}" model "${agent.model}" is ambiguous: ${candidates}. Use provider/id.`);
	}
	throw new Error(`Agent "${agent.name}" model "${agent.model}" was not found.`);
}

export function pendingRun(
	id: string,
	agent: AgentDefinition,
	task: string,
	context: ChildContext,
	resolved: ResolvedChildModel,
): ChildRun {
	return {
		id,
		startedAt: Date.now(),
		context,
		agent: agent.name,
		source: agent.source,
		task,
		status: "pending",
		output: "",
		usage: EMPTY_USAGE,
		turns: 0,
		model: `${resolved.model.provider}/${resolved.model.id}`,
		toolCalls: [],
	};
}

/** Tools of an agent whose file has no `tools` list. */
export const DEFAULT_AGENT_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * Custom entry that marks a session as a subagent's. Its background runs end with it, and plan mode
 * held to it holds its own running subagents too.
 */
export const SUBAGENT_CHILD_ENTRY = "subagent-child";

export function isSubagentChild(branch: readonly SessionEntry[]): boolean {
	return branch.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_CHILD_ENTRY);
}

/** A child whose session exists, so it can be held to plan mode while it runs. */
export interface ChildHandle {
	/** Hold the child to plan mode's rules from its next tool call on. Throws when nothing would enforce them. */
	holdReadOnly(): void;
}

export interface RunChildOptions {
	id: string;
	agent: AgentDefinition;
	resolved: ResolvedChildModel;
	task: string;
	cwd: string;
	context: ChildContext;
	/** The `subagent` tool call that starts the child. A fork child starts from the context before it. */
	toolCallId: string;
	/** Hold the child to plan mode's rules: read-only tools, and shell commands on the plan-mode allowlist. */
	readOnly: boolean;
	/** Record the child's usage in the parent session as it happens, because no tool result returns it. */
	recordUsage: boolean;
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
	onProgress: (run: ChildRun) => void;
	/** Called once the child's session exists, before its first prompt. */
	onStarted?: (handle: ChildHandle) => void;
}

const FORK_READ_ONLY =
	"Plan mode is on in the session that started you, so you are read-only: only read-only tools and read-only shell commands run. Do not change anything.";

/**
 * The first message of a fork child. The child keeps its parent's system prompt, so the agent's
 * prompt and its tool limits go here.
 */
export function forkTaskMessage(options: {
	agent: AgentDefinition;
	task: string;
	tools: readonly string[];
	cwd: string;
	parentCwd: string;
	readOnly: boolean;
}): string {
	const { agent, task, tools, cwd, parentCwd, readOnly } = options;
	const lines = [
		"<subagent_instructions>",
		`You are now the subagent "${agent.name}", started by the conversation above to do one task. The conversation is context only: do the task below, then answer with your result. Your last message is all the session that started you sees.`,
		`You can call only these tools: ${tools.join(", ")}. Calls to other tools are blocked.`,
	];
	if (cwd !== parentCwd) lines.push(`Your working directory is ${cwd}.`);
	if (readOnly) lines.push(FORK_READ_ONLY);
	lines.push("", agent.systemPrompt.trim(), "</subagent_instructions>", "", task);
	return lines.join("\n");
}

/**
 * Run one child agent in-process through `ctx.createChildSession()`. The child has an in-memory session,
 * the built-in extensions but no user or project extensions, skills, prompt templates, or context files,
 * and the agent body appended to the default system prompt. A fork child instead starts from a copy of
 * the parent's context with the parent's system prompt and tool declarations, and gets the agent body
 * and its tool limits in the task message. A read-only child keeps only its read-only
 * tools and shells, and its plan-mode extension blocks every other call. Never throws: a failure to start
 * is a failed run.
 */
export async function runChild(options: RunChildOptions): Promise<ChildRun> {
	const { id, agent, task, context, resolved } = options;
	const run: ChildRun = { ...pendingRun(id, agent, task, context, resolved), status: "running" };
	if (options.signal?.aborted) return { ...run, status: "aborted", output: "Aborted." };
	try {
		return await runChildSession(options, run);
	} catch (error) {
		return { ...run, status: "failed", output: error instanceof Error ? error.message : String(error) };
	}
}

async function runChildSession(options: RunChildOptions, run: ChildRun): Promise<ChildRun> {
	const { agent, resolved, task, cwd, context, readOnly, ctx, signal, onProgress } = options;
	const tools = agent.tools ?? [...DEFAULT_AGENT_TOOLS];
	const child = await ctx.createChildSession({
		cwd,
		systemPrompt: agent.systemPrompt,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel ?? agent.thinking ?? ctx.thinkingLevel,
		tools,
		signal,
		...(context === "fork" ? { forkFrom: { toolCallId: options.toolCallId } } : {}),
		...(options.recordUsage ? { recordUsage: true } : {}),
	});
	const { session } = child;
	try {
		session.sessionManager.appendCustomEntry(SUBAGENT_CHILD_ENTRY);
		if (readOnly) holdReadOnly(session);
		options.onStarted?.({ holdReadOnly: () => holdReadOnly(session) });
	} catch (error) {
		await child.dispose();
		throw error;
	}
	const prompt =
		context === "fork" ? forkTaskMessage({ agent, task, tools, cwd, parentCwd: ctx.cwd, readOnly }) : task;

	let lastAssistant: AssistantMessage | undefined;
	const unsubscribe = session.subscribe((event) => {
		// Usage of the child's own subagents: a tool result carries a foreground run's, and a usage
		// entry each response of a background run.
		if (event.type === "entry_appended") {
			const { entry } = event;
			if (entry.type === "usage" && entry.kind === "subagent") {
				run.usage = combineUsage(run.usage, entry.usage);
				onProgress({ ...run, toolCalls: [...run.toolCalls] });
			}
			return;
		}
		if (event.type !== "message_end") return;
		if (event.message.role === "toolResult" && event.message.usage) {
			run.usage = combineUsage(run.usage, event.message.usage);
			onProgress({ ...run, toolCalls: [...run.toolCalls] });
			return;
		}
		if (event.message.role !== "assistant") return;
		const message = event.message;
		lastAssistant = message;
		run.turns++;
		run.usage = combineUsage(run.usage, message.usage);
		for (const part of message.content) {
			if (part.type === "toolCall")
				run.toolCalls.push({ name: part.name, summary: summarizeToolCall(part.name, part.arguments) });
		}
		const text = assistantText(message);
		if (text) run.output = text;
		onProgress({ ...run, toolCalls: [...run.toolCalls] });
	});
	try {
		if (!signal?.aborted) await session.prompt(prompt, { expandPromptTemplates: false });
	} finally {
		unsubscribe();
		await child.dispose();
	}

	if (signal?.aborted || lastAssistant?.stopReason === "aborted") {
		return { ...run, status: "aborted", output: run.output || "Aborted." };
	}
	if (!lastAssistant || lastAssistant.stopReason === "error") {
		return { ...run, status: "failed", output: lastAssistant?.errorMessage || "The agent did not answer." };
	}
	return { ...run, status: "done", output: run.output || "(no output)" };
}

/** The child's plan extension narrows its tools and blocks every call that is not read-only. Idempotent. */
function holdReadOnly(session: AgentSession): void {
	// Without the plan extension nothing enforces the rules, so the child must not run.
	if (!session.extensionRunner.getExtensionPaths().includes(BUILTIN_PLAN_PATH)) {
		throw new Error(
			"Plan mode is on, but the subagent could not load plan mode to stay read-only, so it did not run.",
		);
	}
	if (!isReadOnlyChild(session.sessionManager.getBranch()))
		session.sessionManager.appendCustomEntry(READ_ONLY_CHILD_ENTRY);
}

/** Run `fn` over `items` with at most `limit` calls in flight. Results keep the order of `items`. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: readonly TIn[],
	limit: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
