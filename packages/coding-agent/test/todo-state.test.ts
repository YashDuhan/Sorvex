import { describe, expect, it } from "vitest";
import { commandLines, openTasksSection, widgetLines } from "../src/extensions/todo/render.ts";
import {
	EMPTY_TODO_STATE,
	parseTodoParams,
	reduce,
	TODO_STATUSES,
	type TodoOp,
	type TodoParams,
	type TodoState,
	type TodoStatus,
} from "../src/extensions/todo/state.ts";

function apply(state: TodoState, op: TodoOp): TodoState {
	const reduction = reduce(state, op);
	if (reduction.kind === "error") throw new Error(reduction.error);
	return reduction.state;
}

function seed(...subjects: string[]): TodoState {
	return apply(EMPTY_TODO_STATE, { kind: "create", items: subjects.map((subject) => ({ subject })) });
}

function statusOf(state: TodoState, id: number): TodoStatus {
	const todo = state.todos.find((candidate) => candidate.id === id);
	if (!todo) throw new Error(`no #${id}`);
	return todo.status;
}

function error(state: TodoState, op: TodoOp): string {
	const reduction = reduce(state, op);
	if (reduction.kind !== "error") throw new Error("expected an error");
	return reduction.error;
}

function moveTo(status: TodoStatus): TodoState {
	let state = seed("task");
	if (status === "pending") return state;
	if (status === "in_progress") return apply(state, { kind: "update", id: 1, status });
	state = apply(state, { kind: "update", id: 1, status: "completed" });
	return status === "completed" ? state : apply(state, { kind: "delete", id: 1 });
}

describe("todo reducer", () => {
	describe("create", () => {
		it("creates one pending task", () => {
			const reduction = reduce(EMPTY_TODO_STATE, { kind: "create", items: [{ subject: "  write tests  " }] });
			expect(reduction).toEqual({
				kind: "ok",
				state: {
					todos: [{ id: 1, subject: "write tests", status: "pending", blockedBy: [] }],
					nextId: 2,
				},
				result: "Created #1: write tests (pending)",
				changed: true,
			});
		});

		it("creates a batch with consecutive ids and keeps optional fields", () => {
			const reduction = reduce(seed("existing"), {
				kind: "create",
				items: [
					{ subject: "a", description: "details", activeForm: "doing a", blockedBy: [1] },
					{ subject: "b" },
					{ subject: "c" },
				],
			});
			if (reduction.kind !== "ok") throw new Error(reduction.error);
			expect(reduction.result).toBe(
				"Created #2: a (pending, blocked by #1)\nCreated #3: b (pending)\nCreated #4: c (pending)",
			);
			expect(reduction.state.nextId).toBe(5);
			expect(reduction.state.todos[1]).toEqual({
				id: 2,
				subject: "a",
				description: "details",
				activeForm: "doing a",
				status: "pending",
				blockedBy: [1],
			});
		});

		it("commits nothing when one item of a batch is invalid", () => {
			const state = seed("existing");
			expect(error(state, { kind: "create", items: [{ subject: "ok" }, { subject: "  " }] })).toBe(
				"task 2: subject is required",
			);
			expect(error(state, { kind: "create", items: [] })).toBe("create needs at least one task");
		});

		it("rejects blockers that are missing or deleted", () => {
			const state = apply(seed("one", "two"), { kind: "delete", id: 2 });
			expect(error(state, { kind: "create", items: [{ subject: "x", blockedBy: [9] }] })).toBe(
				"blockedBy: #9 not found",
			);
			expect(error(state, { kind: "create", items: [{ subject: "x", blockedBy: [2] }] })).toBe(
				"blockedBy: #2 is deleted",
			);
			expect(error(state, { kind: "create", items: [{ subject: "x" }, { subject: "y", blockedBy: [9] }] })).toBe(
				"blockedBy: #9 not found",
			);
		});

		it("lets a task wait on earlier tasks of the same batch", () => {
			const reduction = reduce(EMPTY_TODO_STATE, {
				kind: "create",
				items: [{ subject: "a" }, { subject: "b", blockedBy: [1] }, { subject: "c", blockedBy: [1, 2, 1] }],
			});
			if (reduction.kind !== "ok") throw new Error(reduction.error);
			expect(reduction.state.todos.map((todo) => todo.blockedBy)).toEqual([[], [1], [1, 2]]);
			expect(reduction.result).toBe(
				"Created #1: a (pending)\nCreated #2: b (pending, blocked by #1)\nCreated #3: c (pending, blocked by #1, #2)",
			);
		});

		it("mixes existing and in-batch blockers", () => {
			const reduction = reduce(seed("existing one", "existing two"), {
				kind: "create",
				items: [
					{ subject: "a", blockedBy: [2] },
					{ subject: "b", blockedBy: [1, 3] },
				],
			});
			if (reduction.kind !== "ok") throw new Error(reduction.error);
			expect(reduction.state.todos.map((todo) => todo.blockedBy)).toEqual([[], [], [2], [1, 3]]);
		});

		it("rejects a blocker that comes later in the batch and commits nothing", () => {
			const state = seed("existing");
			expect(
				error(state, {
					kind: "create",
					items: [{ subject: "x" }, { subject: "y", blockedBy: [4] }, { subject: "z" }],
				}),
			).toBe("task 2: blockedBy #4 comes later in this call; list prerequisites first");
			expect(error(state, { kind: "create", items: [{ subject: "x", blockedBy: [3] }, { subject: "y" }] })).toBe(
				"task 1: blockedBy #3 comes later in this call; list prerequisites first",
			);
		});

		it("rejects a mutual dependency inside a batch", () => {
			expect(
				error(EMPTY_TODO_STATE, {
					kind: "create",
					items: [
						{ subject: "x", blockedBy: [2] },
						{ subject: "y", blockedBy: [1] },
					],
				}),
			).toBe("task 1: blockedBy #2 comes later in this call; list prerequisites first");
		});

		it("rejects a task blocked by itself", () => {
			expect(error(seed("existing"), { kind: "create", items: [{ subject: "x", blockedBy: [2] }] })).toBe(
				"task 1: #2 cannot be blocked by itself",
			);
		});

		it("rejects a blocker beyond the ids the batch assigns", () => {
			expect(
				error(EMPTY_TODO_STATE, { kind: "create", items: [{ subject: "x" }, { subject: "y", blockedBy: [3] }] }),
			).toBe("blockedBy: #3 not found");
		});
	});

	describe("status transitions", () => {
		const allowed: Record<TodoStatus, TodoStatus[]> = {
			pending: ["in_progress", "completed", "deleted"],
			in_progress: ["pending", "completed", "deleted"],
			completed: ["deleted"],
			deleted: [],
		};

		for (const from of TODO_STATUSES) {
			for (const to of TODO_STATUSES) {
				if (from === to || from === "deleted") continue;
				const legal = allowed[from].includes(to);
				it(`${from} -> ${to} is ${legal ? "allowed" : "rejected"}`, () => {
					const state = moveTo(from);
					const op: TodoOp = to === "deleted" ? { kind: "delete", id: 1 } : { kind: "update", id: 1, status: to };
					if (legal) {
						expect(statusOf(apply(state, op), 1)).toBe(to);
					} else {
						expect(error(state, op)).toBe(`illegal transition ${from} -> ${to}`);
					}
				});
			}
		}

		it("makes deleted terminal", () => {
			const state = moveTo("deleted");
			expect(error(state, { kind: "update", id: 1, status: "pending" })).toBe("#1 is deleted");
			expect(error(state, { kind: "update", id: 1, subject: "renamed" })).toBe("#1 is deleted");
		});

		it("reports a transition in the result", () => {
			const reduction = reduce(seed("a"), { kind: "update", id: 1, status: "in_progress", activeForm: "working" });
			expect(reduction).toMatchObject({ kind: "ok", result: "Updated #1 (pending -> in_progress)", changed: true });
		});
	});

	describe("update", () => {
		it("returns No change and the same state for an update that changes nothing", () => {
			const state = apply(seed("a"), { kind: "update", id: 1, status: "in_progress", activeForm: "working" });
			for (const op of [
				{ kind: "update", id: 1, status: "in_progress" },
				{ kind: "update", id: 1, subject: "a", activeForm: "working" },
				{ kind: "update", id: 1, removeBlockedBy: [7] },
			] satisfies TodoOp[]) {
				const reduction = reduce(state, op);
				expect(reduction).toEqual({
					kind: "ok",
					state,
					result: "No change: #1 already matches the requested values",
					changed: false,
				});
			}
		});

		it("rejects an update without a field and an unknown id", () => {
			const state = seed("a");
			expect(error(state, { kind: "update", id: 1 })).toContain("update needs at least one of");
			expect(error(state, { kind: "update", id: 5, status: "completed" })).toBe("#5 not found");
			expect(error(state, { kind: "update", id: 1, subject: " " })).toBe("subject must not be empty");
		});

		it("does not mutate the previous state", () => {
			const before = seed("a", "b");
			const snapshot = structuredClone(before);
			apply(before, { kind: "update", id: 1, status: "completed", addBlockedBy: [2] });
			expect(before).toEqual(snapshot);
		});
	});

	describe("blockedBy", () => {
		it("adds and removes blockers", () => {
			let state = seed("a", "b", "c");
			state = apply(state, { kind: "update", id: 3, addBlockedBy: [1, 2, 1] });
			expect(state.todos[2]?.blockedBy).toEqual([1, 2]);
			state = apply(state, { kind: "update", id: 3, removeBlockedBy: [1] });
			expect(state.todos[2]?.blockedBy).toEqual([2]);
		});

		it("rejects a task blocked by itself", () => {
			expect(error(seed("a"), { kind: "update", id: 1, addBlockedBy: [1] })).toBe("#1 cannot be blocked by itself");
		});

		it("rejects a missing blocker", () => {
			expect(error(seed("a"), { kind: "update", id: 1, addBlockedBy: [4] })).toBe("addBlockedBy: #4 not found");
		});

		it("rejects a deleted blocker", () => {
			const state = apply(seed("a", "b"), { kind: "delete", id: 2 });
			expect(error(state, { kind: "update", id: 1, addBlockedBy: [2] })).toBe("addBlockedBy: #2 is deleted");
		});

		it("rejects a direct cycle and names it", () => {
			const state = apply(seed("a", "b"), { kind: "update", id: 1, addBlockedBy: [2] });
			expect(error(state, { kind: "update", id: 2, addBlockedBy: [1] })).toBe(
				"addBlockedBy would create a cycle: #2 -> #1 -> #2",
			);
		});

		it("rejects a longer cycle and leaves the state unchanged", () => {
			let state = seed("a", "b", "c");
			state = apply(state, { kind: "update", id: 1, addBlockedBy: [2] });
			state = apply(state, { kind: "update", id: 2, addBlockedBy: [3] });
			const reduction = reduce(state, { kind: "update", id: 3, addBlockedBy: [1] });
			expect(reduction).toEqual({
				kind: "error",
				error: "addBlockedBy would create a cycle: #3 -> #1 -> #2 -> #3",
			});
			expect(state.todos[2]?.blockedBy).toEqual([]);
		});

		it("ignores links through a deleted task when checking for a cycle", () => {
			let state = seed("a", "b", "c");
			state = apply(state, { kind: "update", id: 1, addBlockedBy: [2] });
			state = apply(state, { kind: "update", id: 2, addBlockedBy: [3] });
			state = apply(state, { kind: "delete", id: 2 });
			const reduction = reduce(state, { kind: "update", id: 3, addBlockedBy: [1] });
			expect(reduction).toMatchObject({ kind: "ok", result: "Updated #3", changed: true });
			if (reduction.kind !== "ok") return;
			expect(reduction.state.todos[2]?.blockedBy).toEqual([1]);
		});
	});

	describe("delete, clear, list, get", () => {
		it("deletes a task and treats a repeat as No change", () => {
			const state = seed("a");
			const deleted = reduce(state, { kind: "delete", id: 1 });
			expect(deleted).toMatchObject({ kind: "ok", result: "Deleted #1: a", changed: true });
			if (deleted.kind !== "ok") return;
			expect(reduce(deleted.state, { kind: "delete", id: 1 })).toMatchObject({
				result: "No change: #1 is already deleted",
				changed: false,
			});
			expect(error(state, { kind: "delete", id: 4 })).toBe("#4 not found");
		});

		it("clears every task and restarts ids", () => {
			const reduction = reduce(seed("a", "b"), { kind: "clear" });
			expect(reduction).toEqual({ kind: "ok", state: EMPTY_TODO_STATE, result: "Cleared 2 tasks", changed: true });
			expect(reduce(EMPTY_TODO_STATE, { kind: "clear" })).toMatchObject({ changed: false });
		});

		it("lists tasks, hiding deleted ones unless asked, and filters by status", () => {
			let state = seed("a", "b", "c");
			state = apply(state, { kind: "update", id: 1, status: "in_progress", activeForm: "doing a" });
			state = apply(state, { kind: "update", id: 3, addBlockedBy: [1] });
			state = apply(state, { kind: "delete", id: 2 });

			const text = (op: TodoOp): string => {
				const reduction = reduce(state, op);
				if (reduction.kind !== "ok") throw new Error(reduction.error);
				expect(reduction.changed).toBe(false);
				return reduction.result;
			};
			expect(text({ kind: "list", includeDeleted: false })).toBe(
				"[in_progress] #1 a (doing a)\n[pending] #3 c blocked by #1",
			);
			expect(text({ kind: "list", includeDeleted: true })).toContain("[deleted] #2 b");
			expect(text({ kind: "list", status: "pending", includeDeleted: false })).toBe("[pending] #3 c blocked by #1");
			expect(text({ kind: "list", status: "completed", includeDeleted: false })).toBe("No tasks");
		});

		it("gets one task with what it blocks", () => {
			const state = apply(seed("a", "b"), { kind: "update", id: 2, addBlockedBy: [1] });
			expect(reduce(state, { kind: "get", id: 1 })).toMatchObject({
				result: "#1 [pending] a\n  blocks: #2",
			});
			expect(error(state, { kind: "get", id: 9 })).toBe("#9 not found");
		});
	});
});

describe("parseTodoParams", () => {
	const parse = (params: Partial<TodoParams> & Pick<TodoParams, "action">) => parseTodoParams(params);

	it("turns a single create into a one-item batch", () => {
		expect(parse({ action: "create", subject: "a", activeForm: "doing a" })).toEqual({
			kind: "create",
			items: [{ subject: "a", activeForm: "doing a", description: undefined, blockedBy: undefined }],
		});
	});

	it("passes a tasks batch through", () => {
		expect(parse({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] })).toEqual({
			kind: "create",
			items: [{ subject: "a" }, { subject: "b" }],
		});
	});

	it("rejects invalid create shapes", () => {
		expect(parse({ action: "create" })).toEqual({ kind: "error", error: "create needs subject or tasks" });
		expect(parse({ action: "create", subject: "a", tasks: [{ subject: "b" }] })).toEqual({
			kind: "error",
			error: "create takes subject or tasks, not both",
		});
		expect(parse({ action: "create", tasks: [{ subject: "b" }], blockedBy: [1], description: "x" })).toEqual({
			kind: "error",
			error: "create with tasks takes description, blockedBy on each task, not at the top level",
		});
	});

	it("requires an id for update, get, and delete", () => {
		for (const action of ["update", "get", "delete"] as const) {
			expect(parse({ action })).toEqual({ kind: "error", error: `id is required for ${action}` });
		}
		expect(parse({ action: "get", id: 3 })).toEqual({ kind: "get", id: 3 });
	});

	it("rejects blockedBy on update and names the update fields", () => {
		expect(parse({ action: "update", id: 3, status: "in_progress", blockedBy: [1] })).toEqual({
			kind: "error",
			error: "update takes addBlockedBy or removeBlockedBy, not blockedBy",
		});
	});

	it("maps list and clear", () => {
		expect(parse({ action: "list", status: "pending" })).toEqual({
			kind: "list",
			status: "pending",
			includeDeleted: false,
		});
		expect(parse({ action: "clear" })).toEqual({ kind: "clear" });
	});
});

describe("todo rendering", () => {
	function stateWith(statuses: TodoStatus[]): TodoState {
		let state = seed(...statuses.map((_, index) => `task ${index + 1}`));
		for (const [index, status] of statuses.entries()) {
			if (status === "pending") continue;
			const id = index + 1;
			state = apply(state, {
				kind: "update",
				id,
				status: status === "deleted" ? "completed" : status,
				activeForm: `doing ${id}`,
			});
			if (status === "deleted") state = apply(state, { kind: "delete", id });
		}
		return state;
	}

	it("counts completed over visible tasks and shows the active form of the task in progress", () => {
		const lines = widgetLines(stateWith(["pending", "in_progress", "completed", "deleted"]), {
			collapsed: false,
			maxLines: 10,
		});
		expect(lines).toEqual(["Todos (1/3)", "○ #1 task 1", "◐ #2 doing 2", "✓ #3 task 3"]);
	});

	it("collapses to one line", () => {
		const state = stateWith(["pending", "in_progress"]);
		expect(widgetLines(state, { collapsed: true, maxLines: 10 })).toEqual(["Todos (0/2) · doing 2"]);
		expect(widgetLines(stateWith(["pending"]), { collapsed: true, maxLines: 10 })).toEqual(["Todos (0/1)"]);
	});

	it("marks tasks that wait on unfinished blockers", () => {
		const state = apply(stateWith(["completed", "pending", "pending"]), {
			kind: "update",
			id: 3,
			addBlockedBy: [1, 2],
		});
		expect(widgetLines(state, { collapsed: false, maxLines: 10 }).at(-1)).toBe("○ #3 task 3 (blocked by #2)");
	});

	it("shows in-batch blockers until the prerequisite completes", () => {
		let state = apply(EMPTY_TODO_STATE, {
			kind: "create",
			items: [{ subject: "a" }, { subject: "b", blockedBy: [1] }, { subject: "c", blockedBy: [1, 2] }],
		});
		const view = { collapsed: false, maxLines: 10 };
		expect(widgetLines(state, view)).toEqual([
			"Todos (0/3)",
			"○ #1 a",
			"○ #2 b (blocked by #1)",
			"○ #3 c (blocked by #1, #2)",
		]);
		state = apply(state, { kind: "update", id: 1, status: "completed" });
		expect(widgetLines(state, view).slice(2)).toEqual(["○ #2 b", "○ #3 c (blocked by #2)"]);
	});

	it("drops completed tasks first and counts hidden ones when the list overflows", () => {
		const statuses: TodoStatus[] = ["completed", "completed", "in_progress", "pending", "pending", "pending"];
		const lines = widgetLines(stateWith(statuses), { collapsed: false, maxLines: 5 });
		expect(lines).toEqual(["Todos (2/6)", "◐ #3 doing 3", "○ #4 task 4", "○ #5 task 5", "... +3 more"]);
	});

	it("never exceeds maxLines", () => {
		const state = stateWith(Array.from({ length: 20 }, () => "pending"));
		for (const maxLines of [1, 2, 3, 5, 12, 25]) {
			expect(widgetLines(state, { collapsed: false, maxLines }).length).toBeLessThanOrEqual(maxLines);
		}
		expect(widgetLines(state, { collapsed: false, maxLines: 1 })).toEqual(["Todos (0/20)"]);
	});

	it("strips control characters from model text", () => {
		const state = apply(EMPTY_TODO_STATE, { kind: "create", items: [{ subject: "a\u001b[31m\nb" }] });
		expect(widgetLines(state, { collapsed: false, maxLines: 10 })[1]).toBe("○ #1 a [31m b");
	});

	it("groups the /todos output by status", () => {
		const lines = commandLines(stateWith(["completed", "in_progress", "pending"]));
		expect(lines).toEqual([
			"Todos (1/3)",
			"In progress:",
			"  ◐ #2 doing 2",
			"Pending:",
			"  ○ #3 task 3",
			"Completed:",
			"  ✓ #1 task 1",
		]);
		expect(commandLines(EMPTY_TODO_STATE)).toEqual(["No todos yet. Ask the agent to add some!"]);
	});

	it("lists only open tasks in the system prompt section", () => {
		expect(openTasksSection(EMPTY_TODO_STATE)).toBeUndefined();
		expect(openTasksSection(stateWith(["completed", "deleted"]))).toBeUndefined();
		expect(openTasksSection(stateWith(["completed", "in_progress", "pending"]))).toContain(
			"- #2 [in_progress] task 2\n- #3 [pending] task 3",
		);
		expect(openTasksSection(stateWith(["completed", "in_progress", "pending"]))).not.toContain("task 1");
	});
});
