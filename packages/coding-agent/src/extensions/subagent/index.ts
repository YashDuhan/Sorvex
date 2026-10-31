import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum, type Usage } from "@sorvex/ai";
import { Type } from "typebox";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
} from "../../core/extensions/types.ts";
import { combineUsage } from "../../core/usage-totals.ts";
import { BUILTIN_PLAN_PATH, isReadOnlyChild, PLAN_MODE_EVENT, replayPlanMode } from "../plan/state.ts";
import { type AgentDefinition, type AgentDiscovery, BUILTIN_AGENTS, discoverAgents } from "./agents.ts";
import { FleetWidget } from "./fleet-widget.ts";
import { formatAgentList, formatTokens, renderSubagentCall, renderSubagentResult } from "./render.ts";
import {
	type BackgroundAction,
	type ChildContext,
	MAX_CHAIN_STEPS,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	PREVIOUS_PLACEHOLDER,
	parseSubagentCall,
	requestSpecs,
	SUBAGENT_TOOL_NAME,
	type SubagentKind,
	type SubagentRequest,
	substitutePrevious,
} from "./request.ts";
import {
	type BackgroundStatus,
	type ChildHandle,
	type ChildRun,
	EMPTY_USAGE,
	isSubagentChild,
	mapWithConcurrencyLimit,
	pendingRun,
	type ResolvedChildModel,
	resolveChildModel,
	runChild,
	type SubagentDetails,
} from "./run.ts";

const CONTEXT_DESCRIPTION =
	"fresh (default): the agent sees only task. fork: the agent starts from a copy of this conversation, which reuses the prompt cache, so task can refer to it.";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to run" }),
	task: Type.String({ description: "The task. A fresh agent sees only this text, not this conversation." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent. Default: the current one." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: CONTEXT_DESCRIPTION })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to run" }),
	task: Type.String({
		description: `The task. ${PREVIOUS_PLACEHOLDER} is replaced with the previous step's final answer.`,
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent. Default: the current one." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: CONTEXT_DESCRIPTION })),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Single mode: name of the agent to run" })),
	task: Type.Optional(
		Type.String({ description: "Single mode: the task. A fresh agent sees only this text, not this conversation." }),
	),
	cwd: Type.Optional(Type.String({ description: "Single mode: working directory for the agent" })),
	context: Type.Optional(
		StringEnum(["fresh", "fork"] as const, { description: `Single mode: ${CONTEXT_DESCRIPTION}` }),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: `Parallel mode: up to ${MAX_PARALLEL_TASKS} independent tasks, ${MAX_CONCURRENCY} running at a time`,
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: `Chain mode: up to ${MAX_CHAIN_STEPS} steps run in order; stops at the first failed step`,
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Run in the background: the call returns a run id at once, and the result arrives as a follow-up message when the run ends",
		}),
	),
	action: Type.Optional(
		StringEnum(["status", "wait", "cancel"] as const, {
			description:
				"Act on a background run instead of starting agents: status (without id, lists every background run), wait for its result, or cancel it",
		}),
	),
	id: Type.Optional(Type.String({ description: "With action: the background run id" })),
});

interface ChildSpec {
	id: string;
	agent: AgentDefinition;
	resolved: ResolvedChildModel;
	task: string;
	cwd: string;
	context: ChildContext;
}

/** Where a call's runs stand. A call is read-only from the first run that plan mode held to its rules. */
interface CallState {
	runs: ChildRun[];
	readOnly: boolean;
	/** Indexes of the runs that ran read-only, from their start or from when planning started. */
	readOnlyRuns: Set<number>;
	/** Plan mode held a run that was already running. */
	heldWhileRunning: boolean;
}

interface CallOutcome {
	details: SubagentDetails;
	text: string;
	usage: Usage;
	isError: boolean;
}

/** A child with a running session. When planning starts, it is held to the read-only rules or stopped. */
interface LiveChild {
	holdToPlan(): void;
}

/** A call made with `background: true`. It lives until it ends or the session shuts down. */
interface BackgroundRun {
	id: string;
	kind: SubagentKind;
	startedAt: number;
	status: BackgroundStatus;
	state: CallState;
	controller: AbortController;
	/** Resolves when the run ended and its outcome is recorded. */
	done: Promise<void>;
	outcome?: CallOutcome;
	/** A `wait` or `cancel` call took the result, so no follow-up message is sent. */
	settled: boolean;
	/** `wait` calls waiting for the run. When it ends while one waits, that call returns the result. */
	waiters: number;
}

/** Custom message type of the follow-up that delivers a background run's result. */
export const BACKGROUND_RESULT_MESSAGE = "subagent-result";

const SHUTDOWN_WAIT_MS = 1500;

const READ_ONLY_NOTE =
	"Plan mode is on, so the subagents ran read-only: they had only read-only tools and read-only shell commands.";
const LATE_READ_ONLY_NOTE =
	"Plan mode turned on during this call, so from then on the subagents ran read-only: they had only read-only tools and read-only shell commands.";

const NO_PLAN_EXTENSION =
	"Plan mode is on in this session, but the built-in plan extension (builtin:plan) is not loaded, so a subagent cannot run read-only and did not run. " +
	"An extension that replaces plan mode must enforce its own rules on subagent. " +
	'To run subagents, enable builtin:plan in the "extensions" setting and turn plan mode off with /plan, or start a new session.';

function findAgent(discovery: AgentDiscovery, name: string): AgentDefinition {
	const agent = discovery.agents.find((candidate) => candidate.name === name);
	if (agent) return agent;
	const available = discovery.agents.map((entry) => `${entry.name} (${entry.source}): ${entry.description}`);
	const skipped = discovery.diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`);
	throw new Error(
		[
			`Unknown agent "${name}". Available agents:`,
			...available,
			...(skipped.length > 0 ? ["Skipped invalid agent files:", ...skipped] : []),
		].join("\n"),
	);
}

/** Whether `cwd` is `sessionCwd` or below it, after resolving symlinks in both. */
export function isInsideDirectory(sessionCwd: string, cwd: string): boolean {
	const relative = path.relative(fs.realpathSync(sessionCwd), fs.realpathSync(cwd));
	return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function newRunId(): string {
	return `sub_${randomBytes(3).toString("hex")}`;
}

/** Wait for `done`, or until one of `signals` aborts. Returns whether `done` settled first. */
async function waitUnlessAborted(
	done: Promise<unknown>,
	signals: ReadonlyArray<AbortSignal | undefined>,
): Promise<boolean> {
	const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (active.some((signal) => signal.aborted)) return false;
	let onAbort!: () => void;
	const aborted = new Promise<false>((resolve) => {
		onAbort = () => resolve(false);
	});
	for (const signal of active) signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([done.then(() => true), aborted]);
	} finally {
		for (const signal of active) signal.removeEventListener("abort", onAbort);
	}
}

function progressText(kind: SubagentKind, runs: ChildRun[]): string {
	switch (kind) {
		case "single":
			return runs[0].output || "(running...)";
		case "parallel": {
			const done = runs.filter((run) => run.status !== "pending" && run.status !== "running").length;
			const running = runs.filter((run) => run.status === "running").length;
			return `Parallel: ${done}/${runs.length} done, ${running} running...`;
		}
		case "chain": {
			const index = runs.findIndex((run) => run.status === "running");
			const current = runs[index];
			return current ? `Chain step ${index + 1}/${runs.length}: ${current.output || "(running...)"}` : "";
		}
	}
}

function resultText(kind: SubagentKind, runs: ChildRun[]): string {
	switch (kind) {
		case "single": {
			const [run] = runs;
			return run.status === "done" ? run.output : `Agent ${run.status}: ${run.output}`;
		}
		case "parallel": {
			const succeeded = runs.filter((run) => run.status === "done").length;
			const sections = runs.map((run) => `### [${run.agent}] ${run.status}\n\n${run.output}`);
			return `Parallel: ${succeeded}/${runs.length} succeeded\n\n${sections.join("\n\n---\n\n")}`;
		}
		case "chain": {
			const index = runs.findIndex((run) => run.status !== "done");
			if (index === -1) return runs[runs.length - 1].output;
			const run = runs[index];
			return `Chain stopped at step ${index + 1} of ${runs.length} (agent ${run.agent} ${run.status}): ${run.output}`;
		}
	}
}

function formatElapsedSeconds(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

function backgroundSummary(run: BackgroundRun, now: number): string {
	const agents = run.state.runs.map((child) => child.agent).join(", ");
	const tokens = run.state.runs.reduce((total, child) => total + child.usage.totalTokens, 0);
	const usage = tokens > 0 ? `, ${formatTokens(tokens)} tokens` : "";
	return `${run.id}: ${run.status}, ${run.kind} (${agents}), ${formatElapsedSeconds(now - run.startedAt)}${usage}`;
}

function textResult(text: string, details: SubagentDetails | undefined, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details: details ?? { kind: "single" as const, runs: [], readOnly: false },
		isError,
	};
}

export default function subagentExtension(pi: ExtensionAPI): void {
	const backgroundRuns = new Map<string, BackgroundRun>();
	const liveChildren = new Set<LiveChild>();
	let shuttingDown = false;
	const shutdown = new AbortController();
	const widget = new FleetWidget(() =>
		[...backgroundRuns.values()].flatMap((run) => (run.status === "running" ? run.state.runs : [])),
	);
	let widgetUi: ExtensionUIContext | undefined;
	const refreshWidget = () => {
		if (widgetUi) widget.update(widgetUi);
	};

	// Plan mode can turn on while children run, also while the session is idle with background runs.
	pi.events.on(PLAN_MODE_EVENT, (mode) => {
		if (typeof mode !== "object" || mode === null || !("kind" in mode) || mode.kind !== "planning") return;
		for (const child of liveChildren) child.holdToPlan();
	});

	// Why a read-only run may not start: nothing in this session enforces plan mode, or the working
	// directory is outside this session's, where another project's MCP servers could start.
	const readOnlyRefusal = (ctx: ExtensionContext, cwd: string): string | undefined => {
		const planLoaded = pi
			.getCommands()
			.some((command) => command.name === "plan" && command.sourceInfo.path === BUILTIN_PLAN_PATH);
		if (!planLoaded) return NO_PLAN_EXTENSION;
		if (!isInsideDirectory(ctx.cwd, cwd)) {
			return `Plan mode is on, so a subagent runs only in this session's directory or below it, and ${cwd} is outside ${ctx.cwd}. It did not run.`;
		}
		return undefined;
	};

	/** Resolve every child of a request, so a bad agent, directory, or model fails the call before any child starts. */
	const prepare = (request: SubagentRequest, ctx: ExtensionContext, callId: string): ChildSpec[] => {
		const specs = requestSpecs(request);
		const discovery = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
		const agents = specs.map((spec) => findAgent(discovery, spec.agent));
		return specs.map((spec, index) => {
			const cwd = path.resolve(ctx.cwd, spec.cwd ?? ".");
			if (!fs.existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}`);
			const agent = agents[index];
			return {
				id: specs.length === 1 ? callId : `${callId}.${index + 1}`,
				agent,
				resolved: resolveChildModel(agent, ctx.model, ctx.modelRegistry),
				task: spec.task,
				cwd,
				context: spec.context ?? "fresh",
			};
		});
	};

	/** Run a request's children and return the outcome. Never throws: a child that cannot run is a failed run. */
	const runCall = async (options: {
		kind: SubagentKind;
		children: ChildSpec[];
		state: CallState;
		toolCallId: string;
		ctx: ExtensionContext;
		signal: AbortSignal | undefined;
		background: boolean;
		onUpdate: () => void;
	}): Promise<CallOutcome> => {
		const { kind, children, state, toolCallId, ctx, signal, background, onUpdate } = options;
		const { runs, readOnlyRuns } = state;

		const start = async (index: number, task: string): Promise<ChildRun> => {
			// A run queued behind the concurrency cap or a chain step can start after the call was
			// cancelled or the session ended, when ctx may be stale.
			if (signal?.aborted) {
				runs[index] = { ...runs[index], status: "aborted", output: "Aborted." };
				onUpdate();
				return runs[index];
			}
			// Plan mode can turn on while the call runs, so each run checks it when it starts. Once a run
			// is read-only, every later run is too.
			const branch = ctx.sessionManager.getBranch();
			state.readOnly ||= replayPlanMode(branch).kind === "planning" || isReadOnlyChild(branch);
			if (state.readOnly) readOnlyRuns.add(index);
			let refusal: string | undefined;
			try {
				refusal = state.readOnly ? readOnlyRefusal(ctx, children[index].cwd) : undefined;
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			runs[index] = {
				...runs[index],
				task,
				startedAt: Date.now(),
				status: refusal ? "failed" : "running",
				output: refusal ?? "",
			};
			onUpdate();
			if (refusal) return runs[index];

			const controller = new AbortController();
			const abort = () => controller.abort();
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) controller.abort();
			let handle: ChildHandle | undefined;
			let holdPending = false;
			let stopped: string | undefined;
			const live: LiveChild = {
				holdToPlan: () => {
					if (readOnlyRuns.has(index)) return;
					state.readOnly = true;
					state.heldWhileRunning = true;
					readOnlyRuns.add(index);
					try {
						const reason = readOnlyRefusal(ctx, children[index].cwd);
						if (reason) throw new Error(reason);
						if (handle) handle.holdReadOnly();
						else holdPending = true;
					} catch (error) {
						stopped = `Plan mode turned on, and this subagent could not be held read-only, so it was stopped. ${error instanceof Error ? error.message : String(error)}`;
						controller.abort();
					}
				},
			};
			liveChildren.add(live);
			try {
				const run = await runChild({
					...children[index],
					task,
					toolCallId,
					readOnly: state.readOnly,
					recordUsage: background,
					ctx,
					signal: controller.signal,
					onProgress: (progress) => {
						runs[index] = progress;
						// This session is a subagent that plan mode held: hold its running subagent too, from
						// its next tool call.
						if (
							!controller.signal.aborted &&
							!readOnlyRuns.has(index) &&
							isReadOnlyChild(ctx.sessionManager.getBranch())
						)
							live.holdToPlan();
						onUpdate();
					},
					onStarted: (started) => {
						handle = started;
						if (holdPending) started.holdReadOnly();
					},
				});
				runs[index] = stopped && run.status === "aborted" ? { ...run, status: "failed", output: stopped } : run;
			} finally {
				liveChildren.delete(live);
				signal?.removeEventListener("abort", abort);
			}
			onUpdate();
			return runs[index];
		};

		switch (kind) {
			case "single":
				await start(0, children[0].task);
				break;
			case "parallel":
				await mapWithConcurrencyLimit(children, MAX_CONCURRENCY, (child, index) => start(index, child.task));
				break;
			case "chain": {
				let previous = "";
				for (const [index, child] of children.entries()) {
					const run = await start(index, substitutePrevious(child.task, previous));
					if (run.status !== "done") break;
					previous = run.output;
				}
				break;
			}
		}

		const text = resultText(kind, runs);
		const started = runs.filter((run) => run.status !== "pending").length;
		const late = state.heldWhileRunning || readOnlyRuns.size < started;
		const note = readOnlyRuns.size === 0 ? "" : late ? LATE_READ_ONLY_NOTE : READ_ONLY_NOTE;
		return {
			details: { kind, runs: [...runs], readOnly: state.readOnly },
			text: note ? `${text}\n\n${note}` : text,
			usage: runs.reduce((total, run) => combineUsage(total, run.usage), EMPTY_USAGE),
			isError: runs.some((run) => run.status !== "done"),
		};
	};

	const backgroundDetails = (run: BackgroundRun, action?: BackgroundAction): SubagentDetails => ({
		kind: run.kind,
		runs: [...run.state.runs],
		readOnly: run.state.readOnly,
		background: { id: run.id, status: run.status, ...(action ? { action } : {}) },
	});

	const followUpMessage = (run: BackgroundRun, outcome: CallOutcome) => ({
		customType: BACKGROUND_RESULT_MESSAGE,
		content: [{ type: "text" as const, text: `Background subagent run ${run.id} ${run.status}.\n\n${outcome.text}` }],
		display: true,
		details: backgroundDetails(run),
	});

	/** Send an ended run's result as a follow-up, unless a `wait` or `cancel` call took it. */
	const deliver = (run: BackgroundRun) => {
		if (run.settled || !run.outcome || shuttingDown) return;
		run.settled = true;
		pi.sendMessage(followUpMessage(run, run.outcome), { deliverAs: "followUp", triggerTurn: true });
	};

	const startBackground = (
		kind: SubagentKind,
		children: ChildSpec[],
		id: string,
		toolCallId: string,
		ctx: ExtensionContext,
	): AgentToolResult<SubagentDetails> => {
		const state: CallState = {
			runs: children.map((child) => pendingRun(child.id, child.agent, child.task, child.context, child.resolved)),
			readOnly: false,
			readOnlyRuns: new Set(),
			heldWhileRunning: false,
		};
		const controller = new AbortController();
		const run: BackgroundRun = {
			id,
			kind,
			startedAt: Date.now(),
			status: "running",
			state,
			controller,
			done: Promise.resolve(),
			settled: false,
			waiters: 0,
		};
		backgroundRuns.set(id, run);
		run.done = runCall({
			kind,
			children,
			state,
			toolCallId,
			ctx,
			signal: controller.signal,
			background: true,
			onUpdate: refreshWidget,
		})
			.catch(
				(error): CallOutcome => ({
					details: { kind, runs: [...state.runs], readOnly: state.readOnly },
					text: `The background run failed: ${error instanceof Error ? error.message : String(error)}`,
					usage: EMPTY_USAGE,
					isError: true,
				}),
			)
			.then((outcome) => {
				run.outcome = outcome;
				run.status = controller.signal.aborted ? "aborted" : outcome.isError ? "failed" : "done";
				if (shuttingDown) return;
				refreshWidget();
				if (run.waiters === 0) deliver(run);
			});
		if (ctx.hasUI) widgetUi = ctx.ui;
		refreshWidget();
		const agents = children.map((child) => child.agent.name).join(", ");
		const ends = isSubagentChild(ctx.sessionManager.getBranch())
			? `You are a subagent, so the run is cancelled when you finish: its result arrives as a follow-up message only if it ends before you do. To use its result, get it with action "wait" before you answer.`
			: "Its result arrives as a follow-up message when it ends; keep working meanwhile.";
		return textResult(
			[
				`Started background run ${id} (${agents}). ${ends}`,
				`Check it with subagent action "status", get its result now with action "wait", or stop it with action "cancel", each with id "${id}".`,
			].join("\n"),
			backgroundDetails(run),
		);
	};

	const control = async (
		action: BackgroundAction,
		id: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<AgentToolResult<SubagentDetails>> => {
		const now = Date.now();
		if (id === undefined) {
			const lines = [...backgroundRuns.values()].map((run) => `- ${backgroundSummary(run, now)}`);
			return textResult(
				lines.length > 0 ? `Background runs:\n${lines.join("\n")}` : "No background runs.",
				undefined,
			);
		}
		const run = backgroundRuns.get(id);
		if (!run) {
			const known = [...backgroundRuns.keys()];
			throw new Error(
				`No background run "${id}".${known.length > 0 ? ` Background runs: ${known.join(", ")}.` : " There are no background runs."}`,
			);
		}
		switch (action) {
			case "status": {
				const lines = run.state.runs.map((child) => {
					const output = child.output.split("\n")[0];
					return `- ${child.id} ${child.agent}: ${child.status}${output ? `: ${output}` : ""}`;
				});
				return textResult([backgroundSummary(run, now), ...lines].join("\n"), backgroundDetails(run, "status"));
			}
			case "wait": {
				if (run.status === "running") {
					run.waiters++;
					try {
						await waitUnlessAborted(run.done, [signal]);
					} finally {
						run.waiters--;
					}
				}
				// An aborted turn still records this call's result, so a run that ended meanwhile is settled here.
				if (!run.outcome) {
					return textResult(
						`Stopped waiting. Background run ${id} is still running.`,
						backgroundDetails(run, "wait"),
					);
				}
				run.settled = true;
				return textResult(
					`Background run ${id} ${run.status}.\n\n${run.outcome.text}`,
					backgroundDetails(run, "wait"),
					run.status !== "done",
				);
			}
			case "cancel": {
				if (run.status !== "running") {
					return textResult(
						`Background run ${id} already ended: ${run.status}.`,
						backgroundDetails(run, "cancel"),
					);
				}
				run.settled = true;
				run.controller.abort();
				await run.done;
				return textResult(`Cancelled background run ${id}.`, backgroundDetails(run, "cancel"));
			}
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const { diagnostics } = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
		for (const diagnostic of diagnostics) {
			ctx.ui.notify(`Skipped agent file ${diagnostic.path}: ${diagnostic.message}`, "warning");
		}
	});

	// Print and JSON mode exit after the last prompt, and exiting cancels background runs. So there a
	// run waits for the background runs before it settles, and continues with their results.
	// A subagent does not wait: its background runs end with it, when its session ends.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (ctx.mode !== "print" && ctx.mode !== "json") return;
		if (isSubagentChild(ctx.sessionManager.getBranch())) return;
		const pending = [...backgroundRuns.values()].filter((run) => !run.settled);
		if (pending.length === 0) return;
		for (const run of pending) run.waiters++;
		let ended: boolean;
		try {
			ended = await waitUnlessAborted(Promise.all(pending.map((run) => run.done)), [ctx.signal, shutdown.signal]);
		} finally {
			for (const run of pending) run.waiters--;
		}
		// Aborted: runs that ended stay unsettled, so the next prompt's settle picks them up.
		if (!ended) return undefined;
		const entries = pending.flatMap((run) => {
			if (run.settled || !run.outcome || shuttingDown) return [];
			run.settled = true;
			return [{ type: "custom_message" as const, ...followUpMessage(run, run.outcome) }];
		});
		return entries.length > 0 ? { entries, continue: true } : undefined;
	});

	pi.on("session_shutdown", async () => {
		shuttingDown = true;
		shutdown.abort();
		const running = [...backgroundRuns.values()].filter((run) => run.status === "running");
		for (const run of running) run.controller.abort();
		widget.clear();
		if (running.length === 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled(running.map((run) => run.done)),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
	});

	pi.registerTool<typeof SubagentParams, SubagentDetails>({
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent",
		description: [
			"Run tasks in subagents, each with its own context window, and return their final answers.",
			"Modes: single (agent + task), parallel (tasks array), chain (chain array, run in order, with",
			`${PREVIOUS_PLACEHOLDER} in a step's task replaced by the previous step's answer). Give exactly one mode.`,
			'A task with context "fork" starts from a copy of this conversation instead of an empty one.',
			"With background: true the call returns a run id at once and the result arrives later as a follow-up message;",
			'action "status", "wait", or "cancel" with that id acts on the run.',
			`Built-in agents: ${BUILTIN_AGENTS.map((agent) => agent.name).join(", ")}.`,
			`User agents are Markdown files in ${path.join(getAgentDir(), "agents")}, project agents in ${CONFIG_DIR_NAME}/agents.`,
			"An unknown agent name lists every available agent.",
		].join(" "),
		promptSnippet: "Delegate self-contained tasks to subagents with their own context",
		promptGuidelines: [
			'Use subagent for self-contained work whose intermediate output would crowd this conversation, such as broad codebase searches. A fresh agent does not see this conversation, so put everything it needs in task, or use context "fork" when it needs this conversation.',
			"Use subagent tasks for independent work that can run at the same time, and subagent chain when a step needs the previous step's answer.",
			"Use subagent background: true for long work you do not need to wait for. Do not poll its status: the result arrives as a follow-up message.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const call = parseSubagentCall(params);
			if (call.type === "control") return control(call.action, call.id, signal);

			const { request } = call;
			const id = newRunId();
			const children = prepare(request, ctx, id);
			if (call.background) return startBackground(request.kind, children, id, toolCallId, ctx);

			const state: CallState = {
				runs: children.map((child) => pendingRun(child.id, child.agent, child.task, child.context, child.resolved)),
				readOnly: false,
				readOnlyRuns: new Set(),
				heldWhileRunning: false,
			};
			const outcome = await runCall({
				kind: request.kind,
				children,
				state,
				toolCallId,
				ctx,
				signal,
				background: false,
				onUpdate: () =>
					onUpdate?.({
						content: [{ type: "text", text: progressText(request.kind, state.runs) }],
						details: { kind: request.kind, runs: [...state.runs], readOnly: state.readOnly },
					}),
			});
			return {
				content: [{ type: "text", text: outcome.text }],
				details: outcome.details,
				usage: outcome.usage,
				isError: outcome.isError,
			};
		},

		renderCall(args, theme) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, { expanded }, theme) {
			const text = result.content[0];
			return renderSubagentResult(result.details, text?.type === "text" ? text.text : "", expanded, theme);
		},
	});

	pi.registerMessageRenderer<SubagentDetails>(BACKGROUND_RESULT_MESSAGE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : message.content[0];
		const text = typeof content === "string" ? content : content?.type === "text" ? content.text : "";
		return renderSubagentResult(message.details, text, expanded, theme);
	});

	pi.registerCommand("agents", {
		description: "List the agents the subagent tool can run",
		handler: async (_args, ctx) => {
			const projectTrusted = ctx.isProjectTrusted();
			ctx.ui.notify(formatAgentList(discoverAgents(ctx.cwd, { projectTrusted }), projectTrusted), "info");
		},
	});
}
