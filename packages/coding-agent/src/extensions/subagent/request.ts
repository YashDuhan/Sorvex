export const SUBAGENT_TOOL_NAME = "subagent";
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CHAIN_STEPS = 8;
export const MAX_CONCURRENCY = 4;
export const PREVIOUS_PLACEHOLDER = "{previous}";

/**
 * - `fresh`: the child starts with an empty conversation and the agent's own system prompt and tools.
 * - `fork`: the child starts from a copy of this conversation, with this session's system prompt and
 *   tool declarations, so the provider's prompt cache hits. The agent's prompt goes into the task
 *   message, and calls to tools outside the agent's list are blocked.
 */
export type ChildContext = "fresh" | "fork";

export interface TaskSpec {
	agent: string;
	task: string;
	cwd?: string;
	/** Default: `fresh`. */
	context?: ChildContext;
}

export type SubagentRequest =
	| ({ kind: "single" } & TaskSpec)
	| { kind: "parallel"; tasks: TaskSpec[] }
	| { kind: "chain"; steps: TaskSpec[] };

export type SubagentKind = SubagentRequest["kind"];

/** What a call does with a background run, by its id. */
export type BackgroundAction = "status" | "wait" | "cancel";

/**
 * - `run`: start the children. With `background`, the call returns a run id at once, and the result
 *   arrives later as a follow-up message.
 * - `control`: act on a background run. `status` without an id lists every background run.
 */
export type SubagentCall =
	| { type: "run"; request: SubagentRequest; background: boolean }
	| { type: "control"; action: BackgroundAction; id?: string };

/** The tool parameters as the model sends them: single-mode fields, `tasks`, `chain`, or `action`. */
export interface SubagentParamsInput {
	agent?: string;
	task?: string;
	cwd?: string;
	context?: ChildContext;
	tasks?: TaskSpec[];
	chain?: TaskSpec[];
	background?: boolean;
	action?: BackgroundAction;
	id?: string;
}

const MODE_ERROR = "Provide exactly one mode: agent and task (single), tasks (parallel), or chain.";

/** Throws an error the model can act on when the parameters do not name exactly one valid call. */
export function parseSubagentCall(params: SubagentParamsInput): SubagentCall {
	const { action, id, background, ...modeParams } = params;
	if (action !== undefined) {
		const extra = Object.entries(modeParams).filter(([, value]) => value !== undefined);
		if (extra.length > 0 || background !== undefined) {
			const fields = [...extra.map(([key]) => key), ...(background !== undefined ? ["background"] : [])];
			throw new Error(`action takes only id. Remove ${fields.join(", ")}.`);
		}
		if (action !== "status" && id === undefined)
			throw new Error(`action "${action}" needs the id of a background run.`);
		return { type: "control", action, id };
	}
	if (id !== undefined) throw new Error('id goes with action: "status", "wait", or "cancel".');
	return { type: "run", request: parseSubagentParams(modeParams), background: background === true };
}

export function parseSubagentParams(
	params: Omit<SubagentParamsInput, "action" | "id" | "background">,
): SubagentRequest {
	const single =
		params.agent !== undefined ||
		params.task !== undefined ||
		params.cwd !== undefined ||
		params.context !== undefined;
	const modes = [single, params.tasks !== undefined, params.chain !== undefined].filter(Boolean).length;
	if (modes !== 1) throw new Error(`${MODE_ERROR} Got ${modes === 0 ? "none" : "more than one"}.`);

	if (params.tasks !== undefined) {
		if (params.tasks.length === 0) throw new Error("tasks is empty. Give at least one task.");
		if (params.tasks.length > MAX_PARALLEL_TASKS) {
			throw new Error(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
		}
		return { kind: "parallel", tasks: params.tasks };
	}
	if (params.chain !== undefined) {
		if (params.chain.length === 0) throw new Error("chain is empty. Give at least one step.");
		if (params.chain.length > MAX_CHAIN_STEPS) {
			throw new Error(`Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_STEPS}.`);
		}
		return { kind: "chain", steps: params.chain };
	}
	if (params.agent === undefined || params.task === undefined) {
		throw new Error("Single mode needs both agent and task.");
	}
	return { kind: "single", agent: params.agent, task: params.task, cwd: params.cwd, context: params.context };
}

export function requestSpecs(request: SubagentRequest): TaskSpec[] {
	switch (request.kind) {
		case "single":
			return [request];
		case "parallel":
			return request.tasks;
		case "chain":
			return request.steps;
	}
}

/** A replacer function, so `$&` and other replacement patterns in the output stay literal. */
export function substitutePrevious(task: string, previous: string): string {
	return task.replaceAll(PREVIOUS_PLACEHOLDER, () => previous);
}
