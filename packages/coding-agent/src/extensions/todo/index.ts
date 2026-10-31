import { StringEnum } from "@sorvex/ai";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { commandLines, openTasksSection, TODOS_SECTION } from "./render.ts";
import {
	EMPTY_TODO_STATE,
	parseTodoParams,
	reduce,
	replayTodoState,
	TODO_STATUSES,
	TODO_TOOL_NAME,
	type TodoParams,
	type TodoState,
} from "./state.ts";
import { createTodoWidget } from "./widget.ts";

const detailSchema = Type.String({ description: "Long-form detail" });
const activeFormSchema = Type.String({
	description: "Present-continuous label shown while the task is in progress, such as 'writing tests'",
});
const idListSchema = (description: string) => Type.Array(Type.Integer(), { description });

const TaskInputSchema = Type.Object({
	subject: Type.String({ description: "Short imperative task title" }),
	description: Type.Optional(detailSchema),
	activeForm: Type.Optional(activeFormSchema),
	blockedBy: Type.Optional(
		idListSchema(
			"Ids of tasks this task waits on: existing tasks, or earlier tasks of this call by the id they get (new ids count up from the next free id; a new list starts at 1). Not later tasks.",
		),
	),
});

const TodoParamsSchema = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(Type.String({ description: "Task title (create, or rename on update)" })),
	description: Type.Optional(detailSchema),
	activeForm: Type.Optional(activeFormSchema),
	status: Type.Optional(
		StringEnum(TODO_STATUSES, {
			description: "New status on update. On list, filters tasks by this status.",
		}),
	),
	blockedBy: Type.Optional(idListSchema("Initial blockers (create only)")),
	addBlockedBy: Type.Optional(idListSchema("Blocker ids to add (update only)")),
	removeBlockedBy: Type.Optional(idListSchema("Blocker ids to remove (update only)")),
	id: Type.Optional(Type.Integer({ description: "Task id (update, get, delete)" })),
	includeDeleted: Type.Optional(Type.Boolean({ description: "List deleted tasks too. Default: false." })),
	tasks: Type.Optional(
		Type.Array(TaskInputSchema, {
			description: "Create several tasks in one call, in dependency order. Use instead of subject.",
		}),
	),
});

type TodoToolParams = Static<typeof TodoParamsSchema>;

/** Some models send `tasks`, or its items, as JSON strings. Decode them before validation. */
function decodeJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function prepareTodoArguments(args: unknown): TodoToolParams {
	if (typeof args !== "object" || args === null || !("tasks" in args)) return args as TodoToolParams;
	const tasks = decodeJson(args.tasks);
	return { ...args, tasks: Array.isArray(tasks) ? tasks.map(decodeJson) : tasks } as TodoToolParams;
}

function readMaxLines(pi: ExtensionAPI): number {
	const configured = pi.getSettings().todo?.widgetMaxLines;
	return typeof configured === "number" && Number.isInteger(configured) && configured >= 1
		? configured
		: SETTINGS_DEFAULTS.todo.widgetMaxLines;
}

export default function todoExtension(pi: ExtensionAPI): void {
	let state: TodoState = EMPTY_TODO_STATE;
	let openTasksSnapshot: string | undefined;
	const widget = createTodoWidget(() => readMaxLines(pi));

	const restore = (ctx: ExtensionContext): void => {
		state = replayTodoState(ctx.sessionManager.getBranch());
	};

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description:
			"Track multi-step work in a task list. Actions: create (one task, or several via tasks; a task may be blocked by earlier tasks of the same call), update (status, text, blockers), list, get, delete, clear. Status moves pending, in_progress, completed; completed tasks can only be deleted.",
		promptSnippet: "Track multi-step work in a task list",
		promptGuidelines: [
			"Use todo for work with three or more steps or when the user gives you a list. Skip it for trivial single-step requests.",
			"Keep exactly one task in progress. Mark a task in_progress before you start it, with an activeForm label.",
			"Mark a task completed only after its checks pass. If tests fail or the work is partial, keep it in_progress and create a task for the blocker.",
			"Create several tasks with one create call and tasks. List prerequisites first and name them in blockedBy of later tasks by id (a new list numbers its tasks from 1). Use addBlockedBy on update for dependencies found later.",
		],
		parameters: TodoParamsSchema,
		prepareArguments: prepareTodoArguments,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const op = parseTodoParams(params as TodoParams);
			if (op.kind === "error") throw new Error(op.error);
			const reduction = reduce(state, op);
			if (reduction.kind === "error") throw new Error(reduction.error);
			state = reduction.state;
			if (reduction.changed) widget.refresh(ctx.ui, state);
			return {
				content: [{ type: "text", text: reduction.result }],
				details: reduction.changed ? state : undefined,
			};
		},
	});

	pi.registerCommand("todos", {
		description: "Show the todo list of the current branch",
		handler: async (_args, ctx) => {
			ctx.ui.notify(commandLines(state).join("\n"), "info");
		},
	});

	pi.registerShortcut(
		{ keybinding: "app.todos.toggle" },
		{
			description: "Collapse or expand the todo list",
			handler: (ctx) => widget.toggleCollapsed(ctx.ui, state),
		},
	);

	pi.on("session_start", async (_event, ctx) => {
		restore(ctx);
		openTasksSnapshot = openTasksSection(state);
		widget.dismissFinished(ctx.ui, state);
	});

	pi.on("session_compact", async (event, ctx) => {
		restore(ctx);
		openTasksSnapshot = openTasksSection(state);
		widget.refresh(ctx.ui, state);
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		if (openTasksSnapshot === undefined) delete sections[TODOS_SECTION];
		else sections[TODOS_SECTION] = openTasksSnapshot;
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		if (openTasksSnapshot !== undefined) openTasksSnapshot = openTasksSection(state);
		widget.refresh(ctx.ui, state);
	});

	pi.on("agent_start", async (_event, ctx) => {
		widget.dismissFinished(ctx.ui, state);
	});

	pi.on("before_agent_start", async (event) => {
		if (openTasksSnapshot !== undefined) event.systemPromptOptions.sections[TODOS_SECTION] = openTasksSnapshot;
	});
}
