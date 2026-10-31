import type { SessionEntry } from "../../core/session-manager.ts";

export const TODO_TOOL_NAME = "todo";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "deleted"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TodoStatus;
	blockedBy: number[];
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

export const EMPTY_TODO_STATE: TodoState = { todos: [], nextId: 1 };

export interface TodoInput {
	subject: string;
	description?: string;
	activeForm?: string;
	blockedBy?: number[];
}

export type TodoOp =
	| { kind: "create"; items: TodoInput[] }
	| {
			kind: "update";
			id: number;
			subject?: string;
			description?: string;
			activeForm?: string;
			status?: TodoStatus;
			addBlockedBy?: number[];
			removeBlockedBy?: number[];
	  }
	| { kind: "list"; status?: TodoStatus; includeDeleted: boolean }
	| { kind: "get"; id: number }
	| { kind: "delete"; id: number }
	| { kind: "clear" };

export type TodoReduction =
	| { kind: "ok"; state: TodoState; result: string; changed: boolean }
	| { kind: "error"; error: string };

const TRANSITIONS: Record<TodoStatus, readonly TodoStatus[]> = {
	pending: ["in_progress", "completed", "deleted"],
	in_progress: ["pending", "completed", "deleted"],
	completed: ["deleted"],
	deleted: [],
};

export function visibleTodos(state: TodoState): Todo[] {
	return state.todos.filter((todo) => todo.status !== "deleted");
}

function fail(error: string): TodoReduction {
	return { kind: "error", error };
}

function ok(state: TodoState, result: string, changed: boolean): TodoReduction {
	return { kind: "ok", state, result, changed };
}

const ids = (list: readonly number[]): string => list.map((id) => `#${id}`).join(", ");

function formatTodoLine(todo: Todo): string {
	const form = todo.status === "in_progress" && todo.activeForm ? ` (${todo.activeForm})` : "";
	const blocked = todo.blockedBy.length > 0 ? ` blocked by ${ids(todo.blockedBy)}` : "";
	return `[${todo.status}] #${todo.id} ${todo.subject}${form}${blocked}`;
}

function formatTodoDetails(todo: Todo, state: TodoState): string {
	const lines = [`#${todo.id} [${todo.status}] ${todo.subject}`];
	if (todo.description) lines.push(`  description: ${todo.description}`);
	if (todo.activeForm) lines.push(`  activeForm: ${todo.activeForm}`);
	if (todo.blockedBy.length > 0) lines.push(`  blockedBy: ${ids(todo.blockedBy)}`);
	const blocks = state.todos.filter((other) => other.blockedBy.includes(todo.id)).map((other) => other.id);
	if (blocks.length > 0) lines.push(`  blocks: ${ids(blocks)}`);
	return lines.join("\n");
}

function findBlockedByPath(todos: readonly Todo[], from: number, to: number): number[] | undefined {
	const visited = new Set<number>();
	const walk = (id: number): number[] | undefined => {
		if (id === to) return [id];
		if (visited.has(id)) return undefined;
		visited.add(id);
		const todo = todos.find((candidate) => candidate.id === id);
		if (!todo || todo.status === "deleted") return undefined;
		for (const dep of todo.blockedBy) {
			const rest = walk(dep);
			if (rest) return [id, ...rest];
		}
		return undefined;
	};
	return walk(from);
}

function checkDependency(state: TodoState, dep: number, label: string): string | undefined {
	const target = state.todos.find((todo) => todo.id === dep);
	if (!target) return `${label}: #${dep} not found`;
	if (target.status === "deleted") return `${label}: #${dep} is deleted`;
	return undefined;
}

function create(state: TodoState, items: readonly TodoInput[]): TodoReduction {
	if (items.length === 0) return fail("create needs at least one task");
	const firstNewId = state.nextId;
	const created: Todo[] = [];
	for (const [index, item] of items.entries()) {
		const subject = item.subject.trim();
		if (!subject) return fail(`task ${index + 1}: subject is required`);
		const id = firstNewId + index;
		const blockedBy = [...new Set(item.blockedBy ?? [])];
		for (const dep of blockedBy) {
			if (dep === id) return fail(`task ${index + 1}: #${id} cannot be blocked by itself`);
			if (dep > id && dep < firstNewId + items.length) {
				return fail(`task ${index + 1}: blockedBy #${dep} comes later in this call; list prerequisites first`);
			}
			if (dep >= firstNewId && dep < id) continue;
			const problem = checkDependency(state, dep, "blockedBy");
			if (problem) return fail(problem);
		}
		const todo: Todo = { id, subject, status: "pending", blockedBy };
		if (item.description) todo.description = item.description;
		if (item.activeForm) todo.activeForm = item.activeForm;
		created.push(todo);
	}
	return ok(
		{ todos: [...state.todos, ...created], nextId: firstNewId + created.length },
		created
			.map((todo) => {
				const blocked = todo.blockedBy.length > 0 ? `, blocked by ${ids(todo.blockedBy)}` : "";
				return `Created #${todo.id}: ${todo.subject} (pending${blocked})`;
			})
			.join("\n"),
		true,
	);
}

function update(state: TodoState, op: Extract<TodoOp, { kind: "update" }>): TodoReduction {
	const current = state.todos.find((todo) => todo.id === op.id);
	if (!current) return fail(`#${op.id} not found`);
	if (current.status === "deleted") return fail(`#${op.id} is deleted`);

	const addBlockedBy = op.addBlockedBy ?? [];
	const removeBlockedBy = op.removeBlockedBy ?? [];
	const touchesAnything =
		op.subject !== undefined ||
		op.description !== undefined ||
		op.activeForm !== undefined ||
		op.status !== undefined ||
		addBlockedBy.length > 0 ||
		removeBlockedBy.length > 0;
	if (!touchesAnything) {
		return fail(
			"update needs at least one of subject, description, activeForm, status, addBlockedBy, removeBlockedBy",
		);
	}

	const status = op.status ?? current.status;
	if (status !== current.status && !TRANSITIONS[current.status].includes(status)) {
		return fail(`illegal transition ${current.status} -> ${status}`);
	}

	const subject = op.subject === undefined ? current.subject : op.subject.trim();
	if (!subject) return fail("subject must not be empty");

	let blockedBy = current.blockedBy.filter((dep) => !removeBlockedBy.includes(dep));
	for (const dep of addBlockedBy) {
		if (dep === current.id) return fail(`#${current.id} cannot be blocked by itself`);
		const problem = checkDependency(state, dep, "addBlockedBy");
		if (problem) return fail(problem);
		const back = findBlockedByPath(state.todos, dep, current.id);
		if (back)
			return fail(`addBlockedBy would create a cycle: ${[current.id, ...back].map((id) => `#${id}`).join(" -> ")}`);
		if (!blockedBy.includes(dep)) blockedBy = [...blockedBy, dep];
	}

	const updated: Todo = { ...current, subject, status, blockedBy };
	if (op.description !== undefined) updated.description = op.description;
	if (op.activeForm !== undefined) updated.activeForm = op.activeForm;

	const changed =
		updated.subject !== current.subject ||
		updated.status !== current.status ||
		updated.description !== current.description ||
		updated.activeForm !== current.activeForm ||
		updated.blockedBy.length !== current.blockedBy.length ||
		updated.blockedBy.some((dep, index) => dep !== current.blockedBy[index]);
	if (!changed) return ok(state, `No change: #${op.id} already matches the requested values`, false);

	const next = { todos: state.todos.map((todo) => (todo.id === op.id ? updated : todo)), nextId: state.nextId };
	const move = status === current.status ? "" : ` (${current.status} -> ${status})`;
	return ok(next, `Updated #${op.id}${move}`, true);
}

function remove(state: TodoState, id: number): TodoReduction {
	const current = state.todos.find((todo) => todo.id === id);
	if (!current) return fail(`#${id} not found`);
	if (current.status === "deleted") return ok(state, `No change: #${id} is already deleted`, false);
	const next = {
		todos: state.todos.map((todo) => (todo.id === id ? { ...todo, status: "deleted" as const } : todo)),
		nextId: state.nextId,
	};
	return ok(next, `Deleted #${id}: ${current.subject}`, true);
}

export function reduce(state: TodoState, op: TodoOp): TodoReduction {
	switch (op.kind) {
		case "create":
			return create(state, op.items);
		case "update":
			return update(state, op);
		case "list": {
			const shown = state.todos.filter(
				(todo) => (op.includeDeleted || todo.status !== "deleted") && (!op.status || todo.status === op.status),
			);
			return ok(state, shown.length === 0 ? "No tasks" : shown.map(formatTodoLine).join("\n"), false);
		}
		case "get": {
			const todo = state.todos.find((candidate) => candidate.id === op.id);
			return todo ? ok(state, formatTodoDetails(todo, state), false) : fail(`#${op.id} not found`);
		}
		case "delete":
			return remove(state, op.id);
		case "clear": {
			const changed = state.todos.length > 0 || state.nextId !== 1;
			return ok(EMPTY_TODO_STATE, `Cleared ${state.todos.length} tasks`, changed);
		}
	}
}

export interface TodoParseError {
	kind: "error";
	error: string;
}

export interface TodoParams {
	action: "create" | "update" | "list" | "get" | "delete" | "clear";
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TodoStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	id?: number;
	includeDeleted?: boolean;
	tasks?: TodoInput[];
}

export function parseTodoParams(params: TodoParams): TodoOp | TodoParseError {
	const error = (message: string): TodoParseError => ({ kind: "error", error: message });
	const { id, subject, description, activeForm, status, blockedBy, addBlockedBy, removeBlockedBy } = params;

	switch (params.action) {
		case "create": {
			if (params.tasks === undefined) {
				if (subject === undefined) return error("create needs subject or tasks");
				return { kind: "create", items: [{ subject, description, activeForm, blockedBy }] };
			}
			if (subject !== undefined) return error("create takes subject or tasks, not both");
			const topLevel = Object.entries({ description, activeForm, blockedBy })
				.filter(([, value]) => value !== undefined)
				.map(([name]) => name);
			if (topLevel.length > 0) {
				return error(`create with tasks takes ${topLevel.join(", ")} on each task, not at the top level`);
			}
			return { kind: "create", items: params.tasks };
		}
		case "update":
			if (id === undefined) return error("id is required for update");
			if (blockedBy !== undefined) return error("update takes addBlockedBy or removeBlockedBy, not blockedBy");
			return { kind: "update", id, subject, description, activeForm, status, addBlockedBy, removeBlockedBy };
		case "get":
		case "delete":
			if (id === undefined) return error(`id is required for ${params.action}`);
			return { kind: params.action, id };
		case "list":
			return { kind: "list", status, includeDeleted: params.includeDeleted === true };
		case "clear":
			return { kind: "clear" };
	}
}

function isTodo(value: unknown): value is Todo {
	if (typeof value !== "object" || value === null) return false;
	const todo = value as Record<string, unknown>;
	return (
		Number.isSafeInteger(todo.id) &&
		typeof todo.subject === "string" &&
		(TODO_STATUSES as readonly unknown[]).includes(todo.status) &&
		(todo.description === undefined || typeof todo.description === "string") &&
		(todo.activeForm === undefined || typeof todo.activeForm === "string") &&
		Array.isArray(todo.blockedBy) &&
		todo.blockedBy.every((dep) => Number.isSafeInteger(dep))
	);
}

export function isTodoState(value: unknown): value is TodoState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Record<string, unknown>;
	return Number.isSafeInteger(state.nextId) && Array.isArray(state.todos) && state.todos.every(isTodo);
}

export function replayTodoState(branch: readonly SessionEntry[]): TodoState {
	let state = EMPTY_TODO_STATE;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== TODO_TOOL_NAME || !isTodoState(entry.message.details)) continue;
		state = entry.message.details;
	}
	return state;
}
